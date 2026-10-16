import { object, string } from "./io.js";

export type McpTaskStatus = "working" | "input_required" | "completed" | "failed" | "cancelled";
export interface McpLegacyTask {
  taskId: string;
  status: McpTaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttl: number | null;
  pollInterval?: number;
}
export const MCP_TASK_EXTENSION = "io.modelcontextprotocol/tasks";
export interface McpModernTaskHandle {
  protocolVersion: "2026-07-28";
  taskId: string;
  status: McpTaskStatus;
  statusMessage?: string;
  createdAt: string;
  lastUpdatedAt: string;
  ttlMs: number | null;
  pollIntervalMs?: number;
}
export interface McpTaskInputRequest { method: "roots/list" | "sampling/createMessage" | "elicitation/create"; params: Record<string, unknown> }
export type McpTaskInputRequests = Record<string, McpTaskInputRequest>;
export type McpModernTask = McpModernTaskHandle & (
  | { status: "working" | "cancelled" }
  | { status: "input_required"; inputRequests: McpTaskInputRequests }
  | { status: "completed"; result: Record<string, unknown> }
  | { status: "failed"; error: { code: number; message: string; data?: unknown } }
);
export type McpTaskHandle = McpLegacyTask | McpModernTaskHandle;
export type McpTask = McpLegacyTask | McpModernTask;
export interface McpTaskList { tasks: McpLegacyTask[]; nextCursor?: string }
export interface McpTaskCapabilities {
  list?: Record<string, never>;
  cancel?: Record<string, never>;
  requests?: { tools?: { call?: Record<string, never> } };
}
export function taskId(value: unknown): string { return string(value, "task id", 1024); }
export function taskTtl(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("MCP task TTL must be a nonnegative safe integer");
  return value;
}
export function parseTask(value: unknown): McpLegacyTask {
  const raw = object(value, "MCP task");
  const id = taskId(raw.taskId);
  if (typeof raw.status !== "string" || !["working", "input_required", "completed", "failed", "cancelled"].includes(raw.status)) throw new Error("Invalid MCP task status");
  const timestamp = (input: unknown, label: string) => {
    const result = string(input, label, 64);
    if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d+)?(?:Z|[+-]\d\d:\d\d)$/u.test(result) || !Number.isFinite(Date.parse(result))) throw new Error(`${label} must use an ISO 8601 timestamp`);
    return result;
  };
  const createdAt = timestamp(raw.createdAt, "task createdAt"); const lastUpdatedAt = timestamp(raw.lastUpdatedAt, "task lastUpdatedAt");
  if (Date.parse(lastUpdatedAt) < Date.parse(createdAt)) throw new Error("MCP task update precedes creation");
  const ttl = raw.ttl === null ? null : taskTtl(raw.ttl);
  const pollInterval = raw.pollInterval === undefined ? undefined : taskTtl(raw.pollInterval);
  if (raw.statusMessage !== undefined && (typeof raw.statusMessage !== "string" || raw.statusMessage.length > 16_384 || raw.statusMessage.includes("\0"))) throw new Error("MCP task status message must be a bounded string without NUL characters");
  const statusMessage = raw.statusMessage as string | undefined;
  return { taskId: id, status: raw.status as McpTaskStatus, createdAt, lastUpdatedAt, ttl, ...(pollInterval === undefined ? {} : { pollInterval }), ...(statusMessage === undefined ? {} : { statusMessage }) };
}
export function parseTaskInputRequests(value: unknown): McpTaskInputRequests {
  const raw = object(value, "MCP task input requests");
  const entries = Object.entries(raw);
  if (entries.length > 16 || Buffer.byteLength(JSON.stringify(raw)) > 65_536) throw new Error("MCP task input requests exceed limits");
  return Object.fromEntries(entries.map(([key, input]) => {
    string(key, "MCP task input request key", 256);
    const request = object(input, "MCP task input request");
    const method = request.method;
    if (method !== "roots/list" && method !== "sampling/createMessage" && method !== "elicitation/create") throw new Error("Unsupported MCP task input request method");
    return [key, { method, params: structuredClone(request.params === undefined ? {} : object(request.params, "MCP task input parameters")) }];
  }));
}
export function parseModernTaskHandle(value: unknown): McpModernTaskHandle {
  const raw = object(value, "MCP modern task");
  const legacy = parseTask({ ...raw, ttl: raw.ttlMs, pollInterval: raw.pollIntervalMs });
  return { protocolVersion: "2026-07-28", taskId: legacy.taskId, status: legacy.status, createdAt: legacy.createdAt, lastUpdatedAt: legacy.lastUpdatedAt, ttlMs: legacy.ttl, ...(legacy.pollInterval === undefined ? {} : { pollIntervalMs: legacy.pollInterval }), ...(legacy.statusMessage === undefined ? {} : { statusMessage: legacy.statusMessage }) };
}
export function parseModernTask(value: unknown): McpModernTask {
  const raw = object(value, "MCP modern task"); const task = parseModernTaskHandle(raw);
  switch (task.status) {
    case "input_required": return { ...task, status: task.status, inputRequests: parseTaskInputRequests(raw.inputRequests) };
    case "completed": return { ...task, status: task.status, result: structuredClone(object(raw.result, "MCP completed task result")) };
    case "failed": {
      const error = object(raw.error, "MCP task error");
      if (typeof error.code !== "number" || !Number.isSafeInteger(error.code) || typeof error.message !== "string" || error.message.length > 16_384 || error.message.includes("\0")) throw new Error("MCP failed task must contain a bounded JSON-RPC error");
      return { ...task, status: task.status, error: { code: error.code, message: error.message, ...(error.data === undefined ? {} : { data: structuredClone(error.data) }) } };
    }
    case "working": case "cancelled": return { ...task, status: task.status };
    default: { const exhaustive: never = task.status; throw new Error(`Unknown MCP task status: ${exhaustive}`); }
  }
}
export function parseTaskList(value: unknown): McpTaskList {
  const raw = object(value, "tasks/list result");
  if (!Array.isArray(raw.tasks) || raw.tasks.length > 256) throw new Error("MCP tasks/list must return at most 256 tasks per page");
  const tasks = raw.tasks.map(parseTask);
  if (new Set(tasks.map((task) => task.taskId)).size !== tasks.length) throw new Error("MCP tasks/list returned duplicate tasks");
  return { tasks, ...(raw.nextCursor === undefined ? {} : { nextCursor: string(raw.nextCursor, "tasks cursor", 4096) }) };
}
