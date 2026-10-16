import { cancelled, object, string } from "./io.js";

export const MODERN_MCP_VERSION = "2026-07-28";
export const MCP_META = "io.modelcontextprotocol/";

/** Protocol errors retain only validated negotiation data, never arbitrary peer data. */
export class McpProtocolError extends Error {
  constructor(readonly code: number, message: string, readonly supported?: string[], readonly httpStatus?: number) { super(message); }
}
export class McpHttpError extends Error { constructor(readonly status: number, message: string) { super(message); } }
export class McpModernResponseError extends Error {}
export function protocolError(value: unknown, httpStatus?: number): McpProtocolError {
  const raw = object(value, "MCP error");
  let supported: string[] | undefined;
  if (raw.code === -32022 && raw.data !== undefined) {
    try {
      const data = object(raw.data, "protocol version error data");
      if (!Array.isArray(data.supported) || data.supported.length > 32) throw new Error("Invalid supported MCP protocol versions");
      supported = data.supported.map((entry) => { const version = string(entry, "supported protocol version", 32); if (!/^\d{4}-\d\d-\d\d$/u.test(version)) throw new Error("Invalid supported MCP protocol version"); return version; });
    } catch { return new McpProtocolError(-32022, "Invalid supported MCP protocol versions", undefined, httpStatus); }
  }
  return new McpProtocolError(typeof raw.code === "number" ? raw.code : -32603, `MCP error ${typeof raw.code === "number" ? raw.code : "unknown"}: ${typeof raw.message === "string" ? raw.message : "Request failed"}`, supported, httpStatus);
}
export function modernError(error: unknown): error is McpProtocolError { return error instanceof McpProtocolError && [-32020, -32021, -32022].includes(error.code); }

export function requestMetadata(params: Record<string, unknown>, capabilities: Record<string, unknown>, logLevel?: string): Record<string, unknown> {
  return { ...params, _meta: { ...(params._meta === undefined ? {} : object(params._meta, "request metadata")), [`${MCP_META}protocolVersion`]: MODERN_MCP_VERSION, [`${MCP_META}clientInfo`]: { name: "hive", version: "0.6.0" }, [`${MCP_META}clientCapabilities`]: capabilities, ...(logLevel ? { [`${MCP_META}logLevel`]: logLevel } : {}) } };
}

export function mcpHeader(value: string): string {
  return /^[\x20-\x7e\t]*$/u.test(value) && value.trim() === value && !(value.startsWith("=?base64?") && value.endsWith("?=")) ? value : `=?base64?${Buffer.from(value, "utf8").toString("base64")}?=`;
}
export interface ToolHeader { name: string; path: string[]; type: "string" | "integer" | "boolean" }
export function toolHeaderSchema(schema: Record<string, unknown>): ToolHeader[] {
  const headers: ToolHeader[] = []; const names = new Set<string>(); let nodes = 0;
  const visit = (value: unknown, path: string[], reachable: boolean, depth: number): void => {
    if (++nodes > 4096 || depth > 32) throw new Error("MCP tool header schema exceeded limits");
    if (!value || typeof value !== "object") return;
    if (Array.isArray(value)) { for (const item of value) visit(item, path, false, depth + 1); return; }
    const entry = object(value, "tool header schema");
    if (entry["x-mcp-header"] !== undefined) {
      const name = string(entry["x-mcp-header"], "tool parameter header", 128);
      if (!reachable || !path.length || !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) || names.has(name.toLowerCase()) || !["string", "integer", "boolean"].includes(String(entry.type))) throw new Error("Invalid MCP x-mcp-header annotation");
      names.add(name.toLowerCase()); headers.push({ name, path, type: entry.type as ToolHeader["type"] });
      if (headers.length > 128) throw new Error("MCP tool parameter headers exceed 128");
    }
    for (const [key, child] of Object.entries(entry)) {
      if (key === "properties" && child && typeof child === "object" && !Array.isArray(child)) for (const [name, property] of Object.entries(child)) visit(property, [...path, name], reachable, depth + 1);
      else if (key !== "x-mcp-header") visit(child, path, false, depth + 1);
    }
  };
  visit(schema, [], true, 0); return headers;
}
export function toolParameterHeaders(headers: ToolHeader[], args: unknown): Record<string, string> {
  const result: Record<string, string> = {};
  for (const header of headers) {
    let value = args;
    for (const key of header.path) { if (!value || typeof value !== "object" || Array.isArray(value) || !Object.hasOwn(value, key)) { value = undefined; break; } value = object(value, "tool argument")[key]; }
    if (value === undefined || value === null) continue;
    if (typeof value !== header.type && !(header.type === "integer" && typeof value === "number" && Number.isSafeInteger(value))) throw new Error("MCP mirrored tool parameter has an invalid primitive type");
    result[`Mcp-Param-${header.name}`] = mcpHeader(String(value));
  }
  if (Buffer.byteLength(JSON.stringify(result)) > 32_768) throw new Error("MCP mirrored tool headers exceed 32768 bytes");
  return result;
}

export interface SubscriptionFilter { toolsListChanged?: boolean; promptsListChanged?: boolean; resourcesListChanged?: boolean; resourceSubscriptions?: string[]; taskIds?: string[] }
export class McpSubscription {
  private acknowledged?: SubscriptionFilter;
  constructor(readonly id: number, readonly requested: SubscriptionFilter) {}
  accept(method: string, params: unknown): "acknowledged" | "notification" {
    const raw = object(params, "subscription notification"); const meta = object(raw._meta, "subscription metadata");
    if (meta[`${MCP_META}subscriptionId`] !== this.id) throw new Error("MCP subscription notification id does not match request");
    if (method === "notifications/subscriptions/acknowledged") {
      if (this.acknowledged) throw new Error("MCP subscription was acknowledged twice");
      const filter = object(raw.notifications, "acknowledged subscription filter");
      for (const key of Object.keys(filter)) if (!["toolsListChanged", "promptsListChanged", "resourcesListChanged", "resourceSubscriptions", "taskIds"].includes(key)) throw new Error("Unknown MCP acknowledged subscription filter");
      for (const key of ["toolsListChanged", "promptsListChanged", "resourcesListChanged"] as const) if (filter[key] !== undefined && (typeof filter[key] !== "boolean" || filter[key] === true && this.requested[key] !== true)) throw new Error("MCP server acknowledged an unrequested notification type");
      if (filter.resourceSubscriptions !== undefined && (!Array.isArray(filter.resourceSubscriptions) || filter.resourceSubscriptions.length > 128 || filter.resourceSubscriptions.some((uri) => typeof uri !== "string" || !this.requested.resourceSubscriptions?.includes(uri)))) throw new Error("MCP server acknowledged an unrequested resource subscription");
      if (filter.taskIds !== undefined && (!Array.isArray(filter.taskIds) || filter.taskIds.length > 128 || new Set(filter.taskIds).size !== filter.taskIds.length || filter.taskIds.some((id) => typeof id !== "string" || !this.requested.taskIds?.includes(id)))) throw new Error("MCP server acknowledged an unrequested task subscription");
      this.acknowledged = filter as SubscriptionFilter; return "acknowledged";
    }
    if (!this.acknowledged) throw new Error("MCP subscription notification preceded acknowledgment");
    const key = method === "notifications/tools/list_changed" ? "toolsListChanged" : method === "notifications/prompts/list_changed" ? "promptsListChanged" : method === "notifications/resources/list_changed" ? "resourcesListChanged" : undefined;
    const requested = key ? this.acknowledged[key] === true
      : method === "notifications/resources/updated" ? this.acknowledged.resourceSubscriptions?.includes(String(raw.uri))
      : method === "notifications/tasks" && this.acknowledged.taskIds?.includes(String(raw.taskId));
    if (!requested) throw new Error("MCP subscription sent an unrequested notification");
    return "notification";
  }
  complete(value: unknown): void {
    const raw = object(value, "subscription completion");
    if (!this.acknowledged || raw.resultType !== "complete" || object(raw._meta, "subscription completion metadata")[`${MCP_META}subscriptionId`] !== this.id) throw new Error("Invalid MCP subscription completion");
  }
}

export async function modernRoundTrips(method: string, params: Record<string, unknown>, request: (params: Record<string, unknown>) => Promise<unknown>, input: (method: string, params: unknown) => Promise<Record<string, unknown>>, check: () => Promise<void>, signal: AbortSignal, tasks = false): Promise<unknown> {
  let next = params;
  for (let round = 0; round < 8; round += 1) {
    if (signal.aborted) throw cancelled(); await check();
    const raw = object(await request(next), `${method} result`);
    if (raw.resultType === "complete") return raw;
    if (raw.resultType === "task" && method === "tools/call" && tasks) return raw;
    if (raw.resultType !== "input_required" || !["tools/call", "resources/read", "prompts/get"].includes(method)) { if (raw.resultType !== undefined) throw new McpModernResponseError("Invalid or unsupported MCP resultType for request"); throw new Error("Invalid or unsupported MCP resultType for request"); }
    if (raw.requestState === undefined && raw.inputRequests === undefined) throw new Error("MCP input_required result has no input or state");
    if (raw.requestState !== undefined && (typeof raw.requestState !== "string" || Buffer.byteLength(raw.requestState) > 65_536)) throw new Error("MCP requestState must be a bounded opaque string");
    const responses: Array<[string, unknown]> = [];
    if (raw.inputRequests !== undefined) {
      const entries = Object.entries(object(raw.inputRequests, "MCP input requests"));
      if (entries.length > 16) throw new Error("MCP input requests exceed 16 per round");
      for (const [key, value] of entries) {
        string(key, "MCP input request id", 256); const entry = object(value, "MCP input request");
        if (!["roots/list", "sampling/createMessage", "elicitation/create"].includes(String(entry.method))) throw new Error("Unsupported MCP input request method");
        const reply = await input(String(entry.method), entry.params);
        if (signal.aborted) throw cancelled();
        if (reply.error !== undefined) throw new Error("MCP requested input is unavailable or was not authorized");
        await check();
        responses.push([key, reply.result]);
      }
    }
    next = { ...params, ...(raw.inputRequests === undefined ? {} : { inputResponses: Object.fromEntries(responses) }), ...(raw.requestState === undefined ? {} : { requestState: raw.requestState }) };
  }
  throw new Error("MCP multi round-trip request exceeded 8 rounds; continue explicitly");
}
