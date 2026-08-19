/**
 * HIVE Desktop Kernel Types & Contracts
 * Shared across Desktop IPC, Worker, and future CLI loops.
 */

export type SurfaceMode = "chat" | "codex";
export type ApprovalPosture = "ask" | "auto" | "yolo";

export interface KernelReceipt {
  model: string;
  providerId: string;
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  latencyMs?: number;
  costEstimate?: number;
}

export interface KernelToolCall {
  id: string;
  name: string;
  arguments: string; // Raw JSON string from model
}

export interface KernelToolResult {
  toolCallId: string;
  name: string;
  result: string;
  error?: string;
  durationMs?: number;
}

export type KernelMessageRole = "user" | "assistant" | "system" | "tool";

export interface KernelMessage {
  id: string;
  role: KernelMessageRole;
  content: string;
  at: string;
  thinking?: string; // DeepSeek reasoning_content (kept private, for UI thinking block only)
  toolCalls?: KernelToolCall[];
  toolCallId?: string; // For role === 'tool'
  toolResult?: KernelToolResult;
  receipt?: KernelReceipt;
}

export interface KernelCheckpointFile {
  relativePath: string;
  beforeContent: string | null; // null if newly created
  afterContent?: string | null;  // null if deleted
}

export interface KernelCheckpoint {
  id: string;
  sessionId: string;
  timestamp: string;
  description: string;
  files: KernelCheckpointFile[];
}

export interface KernelSession {
  id: string;
  surface: SurfaceMode;
  title: string;
  createdAt: string;
  updatedAt: string;
  workspaceRoot?: string;
  groundedPath?: string;
  posture: ApprovalPosture;
  providerId?: string;
  model?: string;
  archived: boolean;
  messages: KernelMessage[];
  checkpoints: KernelCheckpoint[];
}

export interface KernelTurnInput {
  sessionId: string;
  content: string;
  images?: string[]; // base64 or file paths
  posture?: ApprovalPosture;
  providerId?: string;
  model?: string;
}

export interface ToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>; // JSON Schema
  readOnly: boolean;
}

export interface ToolExecutionContext {
  workspaceRoot?: string;
  sessionId?: string;
  surface: SurfaceMode;
  posture: ApprovalPosture;
  requestApproval?: (toolName: string, args: Record<string, unknown>) => Promise<boolean>;
  recordCheckpoint?: (description: string, files: KernelCheckpointFile[]) => Promise<KernelCheckpoint>;
}

export interface KernelTool {
  definition: ToolDefinition;
  execute: (args: Record<string, unknown>, context: ToolExecutionContext) => Promise<string>;
}
