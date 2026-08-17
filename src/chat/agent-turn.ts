import type { ChatEngine } from "./engine.js";
import type { ChatMessage, ChatReceipt } from "./types.js";
import { CHAT_ROLE_META, normalizeChatRole, type ChatRoleSlug } from "./roles.js";
import type { ChatBindingRole, SubagentTask } from "../coding/types.js";
import { StructuredAgentLoop, type AgentCompletionClient, type AgentLoopEvent } from "../coding/agent-loop.js";
import { createReadOnlyToolExecutor, describeReadOnlyTools } from "./agent-tools.js";
import { compactHistory, HISTORY_CHAR_BUDGET } from "./history.js";

export interface ChatAgentTurnInput {
  cwd: string;
  engine: ChatEngine;
  role: ChatRoleSlug;
  message: string;
  history: ChatMessage[];
  override?: { providerId?: string; model?: string };
  grounding?: string;
  signal?: AbortSignal;
}

export interface ChatAgentTurnHooks {
  /** Mirrors StructuredAgentLoop events (tool calls + progress) for live UI feeds. */
  onEvent?: (event: AgentLoopEvent) => void;
}

export interface ChatAgentTurnResult {
  output: string;
  receipt: ChatReceipt;
  turns: number;
  toolCalls: number;
}

function slugToBinding(slug: ChatRoleSlug): ChatBindingRole {
  return normalizeChatRole(slug) ?? "coding";
}

function renderHistory(history: ChatMessage[]): string {
  return history
    .map((m) => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
    .join("\n\n");
}

function systemPromptFor(role: ChatRoleSlug, grounding?: string): string {
  const persona = CHAT_ROLE_META[role].systemPrompt;
  return grounding ? `${grounding}\n\n---\n\n${persona}` : persona;
}

/**
 * Agentic chat turn driven by StructuredAgentLoop with the READ-ONLY tool
 * executor. Shared by the CLI REPL (`/agent on`) and the desktop chat service
 * so both surfaces behave identically. Never grants write or exec tools.
 */
export async function runChatAgentTurn(
  input: ChatAgentTurnInput,
  hooks: ChatAgentTurnHooks = {},
): Promise<ChatAgentTurnResult> {
  const binding = slugToBinding(input.role);
  const persona = systemPromptFor(input.role, input.grounding);
  const toolsDesc = describeReadOnlyTools();

  let lastReceipt: ChatReceipt | undefined;
  const completionClient: AgentCompletionClient = {
    complete(request) {
      const systemPrompt = [
        persona,
        toolsDesc,
        "You may use tools to ground answers; you cannot modify anything.",
        'Return exactly one JSON object per turn: {"done":false,"toolCalls":[{"id":"call-1","name":"read_file","arguments":{"path":"src/foo.ts"}}]}',
        'or {"done":true,"summary":"..."}.',
      ].join("\n");
      return input.engine
        .complete({
          role: binding,
          prompt: request.prompt,
          systemPrompt,
          providerId: request.providerId || input.override?.providerId,
          model: request.model || input.override?.model,
          signal: request.signal ?? input.signal,
        })
        .then((result) => {
          lastReceipt = result.receipt;
          return {
            output: result.output,
            usage: {
              input: result.receipt.promptTokens,
              output: result.receipt.completionTokens,
              total: result.receipt.totalTokens,
            },
          };
        });
    },
  };

  const task: SubagentTask = {
    id: `chat-${Date.now()}`,
    sessionId: "",
    role: "scout",
    title: input.message,
    objective: input.message,
    status: "created",
    providerId: input.override?.providerId ?? "",
    model: input.override?.model,
    dependencies: [],
    fileScope: [],
    expectedOutput: input.message,
    completionCriteria: [],
    validationCommands: [],
    depth: 0,
    attempt: 1,
    maxAttempts: 1,
    createdAt: new Date().toISOString(),
  };

  const loop = new StructuredAgentLoop();
  const result = await loop.run({
    task,
    cwd: input.cwd,
    sharedContext: renderHistory(compactHistory(input.history, HISTORY_CHAR_BUDGET).kept),
    completionClient,
    tools: createReadOnlyToolExecutor(input.cwd),
    signal: input.signal ?? new AbortController().signal,
    onEvent: hooks.onEvent,
    maxTurns: 8,
    maxToolCalls: 24,
  });

  const receipt: ChatReceipt = lastReceipt
    ? { degraded: false, ...lastReceipt }
    : { role: input.role, providerId: "", model: "", degraded: false };
  return { output: result.summary, receipt, turns: result.turns, toolCalls: result.toolCalls };
}
