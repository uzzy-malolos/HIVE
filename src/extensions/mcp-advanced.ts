import { MAX_MESSAGE_BYTES, object, string } from "./io.js";
import type { RequestOptions } from "./types.js";
import type { McpTaskCapabilities } from "./mcp-tasks.js";
import { MCP_TASK_EXTENSION } from "./mcp-tasks.js";

export type McpListKind = "tools" | "resources" | "prompts";
export interface McpCapabilities {
  tools?: { listChanged?: boolean };
  resources?: { listChanged?: boolean; subscribe?: boolean };
  prompts?: { listChanged?: boolean };
  completions?: Record<string, never>;
  tasks?: McpTaskCapabilities;
  /** Advertisements only; an extension is usable only when HIVE implements it. */
  extensions?: Record<string, Record<string, unknown>>;
}
export interface McpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
}
export interface McpResourceTemplate extends Omit<McpResource, "uri" | "size"> { uriTemplate: string }
export type McpResourceContent = { uri: string; mimeType?: string } & ({ text: string; blob?: never } | { blob: string; text?: never });
export interface McpResourceResult { contents: McpResourceContent[] }
export interface McpPromptArgument { name: string; description?: string; required?: boolean }
export interface McpPrompt { name: string; title?: string; description?: string; arguments?: McpPromptArgument[] }
export type McpPromptContent =
  | { type: "text"; text: string }
  | { type: "image" | "audio"; data: string; mimeType: string }
  | { type: "resource"; resource: McpResourceContent }
  | ({ type: "resource_link" } & McpResource);
export interface McpPromptMessage { role: "user" | "assistant"; content: McpPromptContent }
export interface McpPromptResult { description?: string; messages: McpPromptMessage[] }
export type McpCompletionReference = { type: "ref/prompt"; name: string } | { type: "ref/resource"; uri: string };
export interface McpCompletionOptions extends RequestOptions { context?: { arguments: Record<string, string> } }
export interface McpCompletionResult { completion: { values: string[]; total?: number; hasMore?: boolean } }

function optionalString(value: unknown, label: string, max = 4096): string | undefined {
  return value === undefined ? undefined : string(value, label, max);
}
function text(value: unknown, label: string, maximum = MAX_MESSAGE_BYTES): string {
  if (typeof value !== "string" || value.length > maximum || value.includes("\0")) throw new Error(`${label} must be a bounded string without NUL characters`);
  return value;
}
export function mcpUri(value: unknown, label = "resource URI"): string {
  const uri = string(value, label, 4096);
  if (!/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(uri) || /\s/u.test(uri)) throw new Error(`${label} must be an absolute URI`);
  return uri;
}
function metadata(raw: Record<string, unknown>): Omit<McpResource, "uri" | "name" | "size"> {
  const title = optionalString(raw.title, "title", 1024);
  const description = raw.description === undefined ? undefined : text(raw.description, "description", 16_384);
  const mimeType = optionalString(raw.mimeType, "mimeType", 256);
  return { ...(title === undefined ? {} : { title }), ...(description === undefined ? {} : { description }), ...(mimeType === undefined ? {} : { mimeType }) };
}
export function parseCapabilities(value: unknown): McpCapabilities {
  const raw = object(value, "server capabilities");
  const capability = (name: string): { listChanged?: boolean; subscribe?: boolean } | undefined => {
    if (raw[name] === undefined) return undefined;
    const entry = object(raw[name], `${name} capability`);
    for (const field of ["listChanged", ...(name === "resources" ? ["subscribe"] : [])]) {
      if (entry[field] !== undefined && typeof entry[field] !== "boolean") throw new Error(`MCP ${name}.${field} must be a boolean`);
    }
    return { ...(typeof entry.listChanged === "boolean" ? { listChanged: entry.listChanged } : {}), ...(name === "resources" && typeof entry.subscribe === "boolean" ? { subscribe: entry.subscribe } : {}) };
  };
  const tools = capability("tools"); const resources = capability("resources"); const prompts = capability("prompts");
  if (raw.completions !== undefined) object(raw.completions, "completions capability");
  let tasks: McpTaskCapabilities | undefined;
  if (raw.tasks !== undefined) {
    const entry = object(raw.tasks, "tasks capability");
    if (entry.list !== undefined) object(entry.list, "tasks.list capability");
    if (entry.cancel !== undefined) object(entry.cancel, "tasks.cancel capability");
    let call = false;
    if (entry.requests !== undefined) {
      const requests = object(entry.requests, "tasks.requests capability");
      if (requests.tools !== undefined) {
        const toolRequests = object(requests.tools, "tasks.requests.tools capability");
        if (toolRequests.call !== undefined) { object(toolRequests.call, "tasks.requests.tools.call capability"); call = true; }
      }
    }
    tasks = { ...(entry.list === undefined ? {} : { list: {} }), ...(entry.cancel === undefined ? {} : { cancel: {} }), ...(call ? { requests: { tools: { call: {} } } } : {}) };
  }
  let extensions: McpCapabilities["extensions"];
  if (raw.extensions !== undefined) {
    const entries = Object.entries(object(raw.extensions, "protocol extensions"));
    if (entries.length > 64 || Buffer.byteLength(JSON.stringify(raw.extensions)) > 65_536) throw new Error("MCP extension advertisements exceed limits");
    extensions = Object.fromEntries(entries.map(([name, value]) => {
      if (name.length > 256 || !/^[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*\/[A-Za-z0-9](?:[A-Za-z0-9_.-]*[A-Za-z0-9])?$/u.test(name)) throw new Error("MCP extension identifier must have a qualified prefix");
      if (name === MCP_TASK_EXTENSION && Object.keys(object(value, "tasks extension capability")).length) throw new Error("MCP tasks extension capability must be empty for revision 2026-07-28");
      return [name, structuredClone(object(value, "protocol extension settings"))];
    }));
  }
  return { ...(tools ? { tools } : {}), ...(resources ? { resources } : {}), ...(prompts ? { prompts } : {}), ...(raw.completions === undefined ? {} : { completions: {} }), ...(tasks ? { tasks } : {}), ...(extensions ? { extensions } : {}) };
}
export function parseResource(value: unknown): McpResource {
  const raw = object(value, "MCP resource");
  if (raw.size !== undefined && (typeof raw.size !== "number" || !Number.isSafeInteger(raw.size) || raw.size < 0)) throw new Error("MCP resource size must be a nonnegative safe integer");
  return { uri: mcpUri(raw.uri), name: string(raw.name, "resource name", 1024), ...metadata(raw), ...(typeof raw.size === "number" ? { size: raw.size } : {}) };
}
export function parseResourceTemplate(value: unknown): McpResourceTemplate {
  const raw = object(value, "MCP resource template");
  return { uriTemplate: mcpUri(raw.uriTemplate, "resource URI template"), name: string(raw.name, "resource template name", 1024), ...metadata(raw) };
}
function base64(value: unknown, label: string): string {
  const encoded = text(value, label);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) throw new Error(`${label} must use base64 encoding`);
  return encoded;
}
export function parseResourceContent(value: unknown): McpResourceContent {
  const raw = object(value, "MCP resource content");
  const uri = mcpUri(raw.uri); const mimeType = optionalString(raw.mimeType, "mimeType", 256);
  const common = { uri, ...(mimeType === undefined ? {} : { mimeType }) };
  if ((raw.text === undefined) === (raw.blob === undefined)) throw new Error("MCP resource content must contain exactly one of text or blob");
  return raw.text === undefined ? { ...common, blob: base64(raw.blob, "resource blob") } : { ...common, text: text(raw.text, "resource text") };
}
export function parseResourceResult(value: unknown): McpResourceResult {
  const raw = object(value, "resources/read result");
  if (!Array.isArray(raw.contents) || raw.contents.length > 256) throw new Error("MCP resources/read must return a bounded contents array");
  return { contents: raw.contents.map(parseResourceContent) };
}
export function parsePrompt(value: unknown): McpPrompt {
  const raw = object(value, "MCP prompt");
  const name = string(raw.name, "prompt name", 128);
  const title = optionalString(raw.title, "prompt title", 1024); const description = raw.description === undefined ? undefined : text(raw.description, "prompt description", 16_384);
  let args: McpPromptArgument[] | undefined;
  if (raw.arguments !== undefined) {
    if (!Array.isArray(raw.arguments) || raw.arguments.length > 128) throw new Error("MCP prompt arguments must be a bounded array");
    const names = new Set<string>();
    args = raw.arguments.map((value) => {
      const argument = object(value, "prompt argument"); const name = string(argument.name, "prompt argument name", 128);
      if (names.has(name)) throw new Error("Duplicate MCP prompt argument"); names.add(name);
      if (argument.required !== undefined && typeof argument.required !== "boolean") throw new Error("MCP prompt required must be a boolean");
      const description = argument.description === undefined ? undefined : text(argument.description, "argument description", 4096);
      return { name, ...(description === undefined ? {} : { description }), ...(typeof argument.required === "boolean" ? { required: argument.required } : {}) };
    });
  }
  return { name, ...(title === undefined ? {} : { title }), ...(description === undefined ? {} : { description }), ...(args === undefined ? {} : { arguments: args }) };
}
function parsePromptContent(value: unknown): McpPromptContent {
  const raw = object(value, "prompt content");
  switch (raw.type) {
    case "text": return { type: "text", text: text(raw.text, "prompt text") };
    case "image": case "audio": return { type: raw.type, data: base64(raw.data, "prompt media data"), mimeType: string(raw.mimeType, "prompt media mimeType", 256) };
    case "resource": return { type: "resource", resource: parseResourceContent(raw.resource) };
    case "resource_link": return { type: "resource_link", ...parseResource(raw) };
    default: throw new Error("Unsupported MCP prompt content type");
  }
}
export function parsePromptResult(value: unknown): McpPromptResult {
  const raw = object(value, "prompts/get result");
  if (!Array.isArray(raw.messages) || raw.messages.length > 256) throw new Error("MCP prompts/get must return a bounded messages array");
  const description = raw.description === undefined ? undefined : text(raw.description, "prompt description", 16_384);
  const messages = raw.messages.map((value): McpPromptMessage => {
    const message = object(value, "prompt message");
    if (message.role !== "user" && message.role !== "assistant") throw new Error("MCP prompt role must be user or assistant");
    return { role: message.role, content: parsePromptContent(message.content) };
  });
  return { ...(description === undefined ? {} : { description }), messages };
}
export function stringArguments(value: unknown, label: string): Record<string, string> {
  const raw = object(value, label); const entries = Object.entries(raw);
  if (entries.length > 128) throw new Error(`${label} exceeds 128 arguments`);
  const result = Object.fromEntries(entries.map(([name, value]) => [string(name, `${label} name`, 128), text(value, `${label} value`, 65_536)]));
  if (Buffer.byteLength(JSON.stringify(result)) > 65_536) throw new Error(`${label} exceeds 65536 bytes`);
  return result;
}
export function parseCompletionResult(value: unknown): McpCompletionResult {
  const completion = object(object(value, "completion result").completion, "completion");
  if (!Array.isArray(completion.values) || completion.values.length > 100) throw new Error("MCP completion values must contain at most 100 entries");
  const values = completion.values.map((value) => text(value, "completion value", 16_384));
  if (completion.total !== undefined && (typeof completion.total !== "number" || !Number.isSafeInteger(completion.total) || completion.total < values.length)) throw new Error("MCP completion total must be a safe integer at least as large as values");
  if (completion.hasMore !== undefined && typeof completion.hasMore !== "boolean") throw new Error("MCP completion hasMore must be a boolean");
  return { completion: { values, ...(typeof completion.total === "number" ? { total: completion.total } : {}), ...(typeof completion.hasMore === "boolean" ? { hasMore: completion.hasMore } : {}) } };
}
