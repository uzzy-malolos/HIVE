import type { McpIncomingHandler } from "./mcp.js";
import type { ToolPermissionRequest } from "../coding/types.js";
import { containsKnownSecret, isCredentialFieldName } from "../security/secrets.js";
import { cancelled, keys, object, publicText, string, validateEnvironmentLiteral } from "./io.js";

export type McpUserInputRequest = { serverId: string; message: string } & (
  | { mode: "form"; requestedSchema: Record<string, unknown> }
  | { mode: "url"; url: string; elicitationId: string }
);
export type McpUserInputResult = { action: "accept"; content?: Record<string, unknown> } | { action: "decline" | "cancel" };
export type McpUserInput = (request: McpUserInputRequest, signal: AbortSignal) => Promise<McpUserInputResult>;
export interface McpSamplingRequest { prompt: string; maxTokens: number }
export interface McpSamplingRoute {
  providerId: string;
  model: string;
  complete(request: McpSamplingRequest, signal: AbortSignal): Promise<string>;
}
export interface McpClientHostOptions {
  serverId: string;
  requestPermission?: (request: ToolPermissionRequest, signal: AbortSignal) => Promise<boolean>;
  resolveSampling?: (signal: AbortSignal) => Promise<McpSamplingRoute>;
  requestInput?: McpUserInput;
}

function boundedJson(value: unknown, maximum: number, label: string): void {
  if (Buffer.byteLength(JSON.stringify(value)) > maximum) throw new Error(`${label} exceeded its byte limit`);
}
function sensitiveName(value: string): boolean {
  return isCredentialFieldName(value) || /(?:password|secret|token|api.?key|private.?key|credential|authorization)/iu.test(value);
}
function parseFormSchema(value: unknown): Record<string, unknown> {
  const schema = object(value, "elicitation schema");
  keys(schema, ["type", "title", "description", "properties", "required", "additionalProperties"], "elicitation schema");
  if (schema.type !== "object" || schema.additionalProperties === true) throw new Error("Elicitation requires a flat object schema");
  if (schema.additionalProperties !== undefined && schema.additionalProperties !== false) throw new Error("Elicitation additionalProperties must be false when supplied");
  for (const key of ["title", "description"]) if (typeof schema[key] === "string" && sensitiveName(schema[key])) throw new Error("Sensitive information must use an out-of-band URL flow, never a form");
  const properties = object(schema.properties, "elicitation properties");
  if (Object.keys(properties).length > 32) throw new Error("Elicitation exceeds 32 fields");
  if (schema.required !== undefined && (!Array.isArray(schema.required) || schema.required.some((key) => typeof key !== "string" || !Object.hasOwn(properties, key)))) throw new Error("Invalid elicitation required fields");
  for (const [name, raw] of Object.entries(properties)) {
    string(name, "elicitation field", 128);
    if (name === "__proto__" || sensitiveName(name)) throw new Error("Sensitive information must use an out-of-band URL flow, never a form");
    const field = object(raw, "elicitation field schema");
    keys(field, ["type", "title", "description", "default", "enum", "enumNames", "oneOf", "minLength", "maxLength", "minimum", "maximum", "format", "items", "minItems", "maxItems"], "elicitation field schema");
    if (!["string", "number", "integer", "boolean", "array"].includes(String(field.type))) throw new Error("Unsupported elicitation field type");
    for (const key of ["title", "description"]) if (field[key] !== undefined) {
      const label = string(field[key], `elicitation ${key}`, 4096);
      if (sensitiveName(label)) throw new Error("Sensitive information must use an out-of-band URL flow, never a form");
    }
    if (field.format !== undefined && !["email", "uri", "date", "date-time"].includes(String(field.format))) throw new Error("Unsupported elicitation string format");
    for (const key of ["minLength", "maxLength", "minItems", "maxItems"]) if (field[key] !== undefined && (typeof field[key] !== "number" || !Number.isSafeInteger(field[key]) || Number(field[key]) < 0 || Number(field[key]) > 4096)) throw new Error("Invalid elicitation field bound");
    for (const key of ["minimum", "maximum"]) if (field[key] !== undefined && (typeof field[key] !== "number" || !Number.isFinite(field[key]))) throw new Error("Invalid elicitation numeric bound");
    const choice = field.type === "array" ? object(field.items, "elicitation enum items") : field;
    if (field.type === "array") keys(choice, ["type", "enum", "oneOf", "enumNames"], "elicitation enum items");
    if (field.type === "array" && choice.type !== "string") throw new Error("Elicitation arrays must contain enum strings");
    if (choice.enum !== undefined && (!Array.isArray(choice.enum) || !choice.enum.length || choice.enum.length > 128 || choice.enum.some((entry) => typeof entry !== "string" || entry.length > 4096))) throw new Error("Invalid elicitation enum");
    if (choice.oneOf !== undefined && (!Array.isArray(choice.oneOf) || !choice.oneOf.length || choice.oneOf.length > 128 || choice.oneOf.some((entry) => !entry || typeof entry !== "object" || !("const" in entry) || typeof entry.const !== "string"))) throw new Error("Invalid elicitation titled enum");
    if (field.type === "array" && choice.enum === undefined && choice.oneOf === undefined) throw new Error("Elicitation arrays require an enum");
    if (field.default !== undefined && containsKnownSecret(JSON.stringify(field.default))) throw new Error("Elicitation defaults cannot contain credentials");
  }
  boundedJson(schema, 32_768, "Elicitation schema");
  return structuredClone(schema);
}

function validField(value: unknown, schema: Record<string, unknown>): boolean {
  if (schema.type === "array") {
    if (!Array.isArray(value) || value.length > 128 || value.length < Number(schema.minItems ?? 0) || value.length > Number(schema.maxItems ?? 128)) return false;
    const items = object(schema.items, "elicitation enum items");
    return new Set(value).size === value.length && value.every((entry) => validField(entry, items));
  }
  if (schema.type === "boolean" && typeof value !== "boolean") return false;
  if ((schema.type === "number" || schema.type === "integer") && (typeof value !== "number" || !Number.isFinite(value) || (schema.type === "integer" && !Number.isSafeInteger(value)) || value < Number(schema.minimum ?? -Infinity) || value > Number(schema.maximum ?? Infinity))) return false;
  if (schema.type === "string") {
    if (typeof value !== "string" || value.includes("\0") || value.length < Number(schema.minLength ?? 0) || value.length > Math.min(4096, Number(schema.maxLength ?? 4096))) return false;
    validateEnvironmentLiteral("MCP_FORM_VALUE", value);
    if (schema.format === "email" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) return false;
    if (schema.format === "uri") { try { new URL(value); } catch { return false; } }
    if (schema.format === "date" && (!/^\d{4}-\d\d-\d\d$/u.test(value) || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value)) return false;
    if (schema.format === "date-time" && (!/^\d{4}-\d\d-\d\dT/u.test(value) || !Number.isFinite(Date.parse(value)))) return false;
  }
  if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
  if (Array.isArray(schema.oneOf) && !schema.oneOf.some((entry) => entry && typeof entry === "object" && "const" in entry && entry.const === value)) return false;
  return true;
}

/** Used by the terminal modal too; errors never include submitted values. */
export function validateMcpUserInput(request: McpUserInputRequest, response: McpUserInputResult): McpUserInputResult {
  if (response.action === "cancel" || response.action === "decline") return { action: response.action };
  if (response.action !== "accept") throw new Error("Invalid elicitation action");
  if (request.mode === "url") return { action: "accept" };
  const schema = parseFormSchema(request.requestedSchema);
  const content = object(response.content, "elicitation response");
  const properties = object(schema.properties, "elicitation properties");
  if (Object.keys(content).some((key) => !Object.hasOwn(properties, key)) || (Array.isArray(schema.required) && schema.required.some((key) => typeof key === "string" && !Object.hasOwn(content, key)))) throw new Error("Complete the required elicitation fields without adding unknown fields");
  for (const [key, value] of Object.entries(content)) if (!validField(value, object(properties[key], "elicitation field"))) throw new Error(`Invalid elicitation field: ${publicText(key)}`);
  boundedJson(content, 32_768, "Elicitation response");
  if (containsKnownSecret(JSON.stringify(content))) throw new Error("Elicitation forms cannot submit credentials");
  return { action: "accept", content: structuredClone(content) };
}

export function createMcpClientHost(options: McpClientHostOptions): McpIncomingHandler {
  const capabilities: Record<string, unknown> = {};
  if (options.resolveSampling && options.requestPermission) capabilities.sampling = {};
  if (options.requestInput) capabilities.elicitation = { form: {}, url: {} };
  let requests = 0; let tokenBudget = 32_768;
  return { capabilities, async request(method, params, signal) {
    try {
      signal.throwIfAborted();
      if (++requests > 32) throw new Error("MCP client request budget exhausted; reconnect explicitly");
      const raw = object(params, "MCP client request"); boundedJson(raw, 65_536, "MCP client request");
      if (method === "sampling/createMessage" && options.resolveSampling && options.requestPermission) {
        keys(raw, ["messages", "systemPrompt", "maxTokens", "modelPreferences", "includeContext", "temperature", "stopSequences", "metadata", "_meta", "tools", "toolChoice"], "sampling request");
        if (raw.tools !== undefined || raw.toolChoice !== undefined || (raw.includeContext !== undefined && raw.includeContext !== "none")) throw new Error("Sampling tools and ambient context were not advertised");
        if (!Array.isArray(raw.messages) || !raw.messages.length || raw.messages.length > 64) throw new Error("Sampling requires 1 through 64 messages");
        if (typeof raw.maxTokens !== "number" || !Number.isSafeInteger(raw.maxTokens) || raw.maxTokens < 1 || raw.maxTokens > 4096 || raw.maxTokens > tokenBudget) throw new Error("Sampling requires 1 through 4096 output tokens within the connection budget");
        const messages = raw.messages.map((entry) => {
          const message = object(entry, "sampling message");
          if (message.role !== "user" && message.role !== "assistant") throw new Error("Invalid sampling message role");
          const blocks = Array.isArray(message.content) ? message.content : [message.content];
          if (!blocks.length || blocks.length > 32) throw new Error("Sampling content exceeds bounds");
          return { role: message.role, content: blocks.map((entry) => {
            const block = object(entry, "sampling content");
            if (block.type !== "text" || typeof block.text !== "string" || block.text.includes("\0")) throw new Error("This sampling host accepts text content only");
            return { type: "text", text: block.text };
          }) };
        });
        if (raw.systemPrompt !== undefined && typeof raw.systemPrompt !== "string") throw new Error("Sampling systemPrompt must be text");
        if (raw.temperature !== undefined || raw.stopSequences !== undefined) throw new Error("Sampling temperature and stop-sequence overrides are unavailable on this host");
        const route = await options.resolveSampling(signal);
        const prompt = JSON.stringify({ server: options.serverId, systemPrompt: raw.systemPrompt, messages });
        const approved = await options.requestPermission({ tool: "mcp_sampling", description: `Generate up to ${raw.maxTokens} tokens for ${options.serverId} using ${route.providerId}/${route.model}.`, input: { provider: route.providerId, model: route.model, maxTokens: raw.maxTokens, request: JSON.parse(prompt) }, external: true, alwaysAsk: true }, signal);
        signal.throwIfAborted();
        if (!approved) return { error: { code: -32000, message: "Sampling was not authorized before generation" } };
        if (raw.maxTokens > tokenBudget) throw new Error("Sampling connection token budget exhausted");
        tokenBudget -= raw.maxTokens;
        const text = publicText(await route.complete({ prompt, maxTokens: raw.maxTokens }, signal));
        signal.throwIfAborted();
        if (Buffer.byteLength(text) > 131_072) throw new Error("Sampling output exceeded its byte limit");
        const release = await options.requestPermission({ tool: "mcp_sampling_result", description: `Return this sampled response to ${options.serverId}.`, input: { model: route.model, response: text }, external: true, alwaysAsk: true }, signal);
        signal.throwIfAborted();
        if (!release) return { error: { code: -32000, message: "Sampled response was not authorized for return" } };
        return { result: { role: "assistant", content: { type: "text", text }, model: route.model, stopReason: "endTurn" } };
      }
      if (method === "elicitation/create" && options.requestInput) {
        const mode = raw.mode ?? "form";
        let request: McpUserInputRequest;
        const message = string(raw.message, "elicitation message", 8192);
        if (mode === "form") {
          keys(raw, ["mode", "message", "requestedSchema", "_meta"], "form elicitation");
          if (sensitiveName(message)) throw new Error("Sensitive information must use an out-of-band URL flow, never a form");
          request = { mode, serverId: options.serverId, message, requestedSchema: parseFormSchema(raw.requestedSchema) };
        } else if (mode === "url") {
          keys(raw, ["mode", "message", "url", "elicitationId", "_meta"], "URL elicitation");
          const url = new URL(string(raw.url, "elicitation URL", 4096));
          if (url.protocol !== "https:" || url.username || url.password) throw new Error("URL elicitation requires credential-free HTTPS");
          request = { mode, serverId: options.serverId, message, url: url.toString(), elicitationId: string(raw.elicitationId, "elicitation id", 1024) };
        } else throw new Error("Unsupported elicitation mode");
        const response = await options.requestInput(request, signal); signal.throwIfAborted();
        return { result: validateMcpUserInput(request, response) };
      }
      return { error: { code: -32601, message: "Client capability not available" } };
    } catch (error) {
      if (signal.aborted || (error instanceof Error && error.name === "AbortError")) return { error: { code: -32800, message: cancelled().message } };
      return { error: { code: -32602, message: publicText(error instanceof Error ? error.message : "Invalid client request").slice(0, 1000) } };
    }
  } };
}
