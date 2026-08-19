import crypto from "node:crypto";
import type {
  ApprovalPosture,
  KernelCheckpoint,
  KernelCheckpointFile,
  KernelMessage,
  KernelReceipt,
  KernelSession,
  KernelToolCall,
  KernelToolResult,
  SurfaceMode,
  ToolExecutionContext,
} from "./types.js";
import { evaluateToolPermission } from "./permissions.js";
import { ToolRegistry } from "../tools/registry.js";
import { CheckpointManager } from "./checkpoints.js";

export interface StreamCallbacks {
  onChunk?: (chunk: string) => void;
  onThinking?: (thinking: string) => void;
  onToolStart?: (toolCall: KernelToolCall) => void;
  onToolFinish?: (result: KernelToolResult) => void;
  onRequestApproval?: (toolName: string, args: Record<string, unknown>, reason?: string) => Promise<boolean>;
  onCheckpointCreated?: (checkpoint: KernelCheckpoint) => void;
}

export interface ProviderStreamingOptions {
  model?: string;
  providerId?: string;
  messages: Array<{ role: string; content: string; tool_call_id?: string; tool_calls?: unknown[] }>;
  tools?: Array<{ type: "function"; function: { name: string; description: string; parameters: Record<string, unknown> } }>;
  signal?: AbortSignal;
}

export interface ProviderStreamChunk {
  content?: string;
  reasoningContent?: string;
  toolCalls?: Array<{ id: string; name: string; argumentsDelta: string }>;
  usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number };
}

export type ProviderStreamFunction = (
  options: ProviderStreamingOptions,
  onDelta: (chunk: ProviderStreamChunk) => void
) => Promise<{ content: string; reasoningContent?: string; toolCalls?: KernelToolCall[]; usage?: { promptTokens?: number; completionTokens?: number; totalTokens?: number } }>;

export class AgentLoop {
  public static async executeTurn(
    session: KernelSession,
    userContent: string,
    providerStream: ProviderStreamFunction,
    callbacks: StreamCallbacks = {},
    signal?: AbortSignal
  ): Promise<{ userMessage: KernelMessage; assistantMessage: KernelMessage; checkpoints: KernelCheckpoint[] }> {
    const startTime = Date.now();
    const newCheckpoints: KernelCheckpoint[] = [];

    // 1. User Message
    const userMessage: KernelMessage = {
      id: `msg_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
      role: "user",
      content: userContent,
      at: new Date().toISOString(),
    };
    session.messages.push(userMessage);

    const tools = ToolRegistry.getToolsForSurface(session.surface);
    const toolDefs = tools.map((t) => ({
      type: "function" as const,
      function: {
        name: t.definition.name,
        description: t.definition.description,
        parameters: t.definition.parameters,
      },
    }));

    let loopCount = 0;
    const maxLoops = 10;
    let finalContent = "";
    let finalThinking = "";
    let accumulatedPromptTokens = 0;
    let accumulatedCompletionTokens = 0;

    const toolExecutionContext: ToolExecutionContext = {
      workspaceRoot: session.workspaceRoot,
      sessionId: session.id,
      surface: session.surface,
      posture: session.posture,
      requestApproval: async (name, args) => {
        if (callbacks.onRequestApproval) {
          return callbacks.onRequestApproval(name, args);
        }
        return false;
      },
      recordCheckpoint: async (desc, files) => {
        const chk: KernelCheckpoint = {
          id: `chk_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
          sessionId: session.id,
          timestamp: new Date().toISOString(),
          description: desc,
          files,
        };
        session.checkpoints.push(chk);
        newCheckpoints.push(chk);
        callbacks.onCheckpointCreated?.(chk);
        return chk;
      },
    };

    while (loopCount < maxLoops) {
      if (signal?.aborted) throw new Error("Turn execution aborted.");
      loopCount++;

      // Build message payload for provider
      const providerMessages = session.messages.map((m) => {
        if (m.role === "tool") {
          return { role: "tool", content: m.content, tool_call_id: m.toolCallId };
        }
        if (m.role === "assistant" && m.toolCalls) {
          return {
            role: "assistant",
            content: m.content || "",
            tool_calls: m.toolCalls.map((tc) => ({
              id: tc.id,
              type: "function",
              function: { name: tc.name, arguments: tc.arguments },
            })),
          };
        }
        return { role: m.role, content: m.content };
      });

      let turnContent = "";
      let turnThinking = "";

      const providerResult = await providerStream(
        {
          model: session.model,
          providerId: session.providerId,
          messages: providerMessages,
          tools: toolDefs.length > 0 ? toolDefs : undefined,
          signal,
        },
        (delta) => {
          if (delta.content) {
            turnContent += delta.content;
            callbacks.onChunk?.(delta.content);
          }
          if (delta.reasoningContent) {
            turnThinking += delta.reasoningContent;
            callbacks.onThinking?.(delta.reasoningContent);
          }
        }
      );

      finalContent += turnContent;
      finalThinking += turnThinking;

      if (providerResult.usage) {
        accumulatedPromptTokens += providerResult.usage.promptTokens || 0;
        accumulatedCompletionTokens += providerResult.usage.completionTokens || 0;
      }

      // Check if tool calls were requested
      if (providerResult.toolCalls && providerResult.toolCalls.length > 0) {
        // Record assistant turn with tool calls
        const assistantToolMsg: KernelMessage = {
          id: `msg_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
          role: "assistant",
          content: turnContent,
          thinking: turnThinking || undefined,
          at: new Date().toISOString(),
          toolCalls: providerResult.toolCalls,
        };
        session.messages.push(assistantToolMsg);

        // Execute each tool call
        for (const tc of providerResult.toolCalls) {
          callbacks.onToolStart?.(tc);
          const tool = ToolRegistry.getTool(tc.name);

          let args: Record<string, unknown> = {};
          try {
            args = JSON.parse(tc.arguments || "{}");
          } catch {
            args = {};
          }

          const toolStart = Date.now();
          let toolOutput = "";
          let toolError: string | undefined;

          if (!tool) {
            toolError = `Tool '${tc.name}' not found.`;
            toolOutput = toolError;
          } else {
            const perm = evaluateToolPermission(tool.definition, session.surface, session.posture);
            if (!perm.allowed) {
              toolError = perm.reason || `Tool '${tc.name}' not permitted on surface '${session.surface}'.`;
              toolOutput = toolError;
            } else if (perm.requiresApproval) {
              const approved = await toolExecutionContext.requestApproval!(tc.name, args);
              if (!approved) {
                toolError = `Execution of '${tc.name}' was rejected by user.`;
                toolOutput = toolError;
              } else {
                try {
                  toolOutput = await tool.execute(args, toolExecutionContext);
                } catch (err: unknown) {
                  toolError = (err as Error).message || String(err);
                  toolOutput = `Error executing ${tc.name}: ${toolError}`;
                }
              }
            } else {
              try {
                toolOutput = await tool.execute(args, toolExecutionContext);
              } catch (err: unknown) {
                toolError = (err as Error).message || String(err);
                toolOutput = `Error executing ${tc.name}: ${toolError}`;
              }
            }
          }

          const toolDuration = Date.now() - toolStart;
          const resultObj: KernelToolResult = {
            toolCallId: tc.id,
            name: tc.name,
            result: toolOutput,
            error: toolError,
            durationMs: toolDuration,
          };
          callbacks.onToolFinish?.(resultObj);

          // Append tool result message
          const toolMsg: KernelMessage = {
            id: `msg_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
            role: "tool",
            content: toolOutput,
            toolCallId: tc.id,
            toolResult: resultObj,
            at: new Date().toISOString(),
          };
          session.messages.push(toolMsg);
        }

        // Loop to allow assistant to consume tool results
        continue;
      }

      // No tool calls — turn is completed
      break;
    }

    const totalDuration = Date.now() - startTime;
    const receipt: KernelReceipt = {
      model: session.model || "deepseek-v4-flash",
      providerId: session.providerId || "deepseek",
      promptTokens: accumulatedPromptTokens,
      completionTokens: accumulatedCompletionTokens,
      totalTokens: accumulatedPromptTokens + accumulatedCompletionTokens,
      latencyMs: totalDuration,
    };

    const finalAssistantMessage: KernelMessage = {
      id: `msg_${Date.now()}_${crypto.randomBytes(3).toString("hex")}`,
      role: "assistant",
      content: finalContent,
      thinking: finalThinking || undefined,
      at: new Date().toISOString(),
      receipt,
    };
    session.messages.push(finalAssistantMessage);
    session.updatedAt = new Date().toISOString();

    return {
      userMessage,
      assistantMessage: finalAssistantMessage,
      checkpoints: newCheckpoints,
    };
  }
}
