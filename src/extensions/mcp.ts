import type { ChildProcessWithoutNullStreams } from "node:child_process";
import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { discoverExtensions, requireActive } from "./catalog.js";
import { cancelled, explicitSecrets, MAX_MESSAGE_BYTES, object, protectedFailure, protectedText, publicText, startProcess, stopProcess, string, timeout } from "./io.js";
import { McpAuthorizationRequiredError, McpOAuthCredentials } from "./oauth.js";
import type { ExtensionOptions, McpConnection, McpServerDescriptor, McpTool, McpToolResult, RequestOptions } from "./types.js";
import { mcpUri, parseCapabilities, parseCompletionResult, parsePrompt, parsePromptResult, parseResource, parseResourceResult, parseResourceTemplate, stringArguments, type McpListKind } from "./mcp-advanced.js";
import { mcpJsonBody, mcpReconnectDelay, mcpSseEvents } from "./mcp-stream.js";
import { MCP_TASK_EXTENSION, parseModernTask, parseModernTaskHandle, parseTask, parseTaskList, taskId, taskTtl, type McpModernTask, type McpTask } from "./mcp-tasks.js";
import { MCP_META, MODERN_MCP_VERSION, McpHttpError, McpModernResponseError, McpProtocolError, McpSubscription, mcpHeader, modernError, modernRoundTrips, protocolError, requestMetadata, toolHeaderSchema, toolParameterHeaders, type SubscriptionFilter, type ToolHeader } from "./mcp-lifecycle.js";

const versions = ["2025-11-25", "2025-06-18", "2025-03-26"];
function protectResult(value: unknown, secrets: string[]): unknown {
  const scrub = (input: unknown, depth: number): unknown => {
    if (depth > 64) throw new Error("MCP result exceeded nesting limit");
    if (typeof input === "string") return protectedText(input, secrets);
    if (Array.isArray(input)) return input.map((entry) => scrub(entry, depth + 1));
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([key, value]) => [protectedText(key, secrets), scrub(value, depth + 1)]));
    return input;
  };
  return scrub(value, 0);
}
interface Transport {
  request(method: string, params: Record<string, unknown>, options?: RequestOptions): Promise<unknown>;
  notify(method: string, params?: Record<string, unknown>, options?: RequestOptions): Promise<void>;
  setVersion(version: string): void;
  setClientCapabilities(capabilities: Record<string, unknown>): void;
  setSubscriptions(filter: SubscriptionFilter): void;
  setTools(tools: McpTool[]): void;
  setIncoming(handlers: IncomingHandlers): void;
  startBackground(options?: RequestOptions): Promise<void>;
  stopBackground(): Promise<void>;
  close(): Promise<void>;
}
interface IncomingHandlers {
  request(method: string, params: unknown, signal: AbortSignal): Promise<Record<string, unknown>>;
  notification(method: string, params?: unknown): Promise<void> | void;
  check?(): Promise<void>;
  backgroundError?(error: Error): void;
}
export interface McpIncomingHandler {
  capabilities?: Record<string, unknown>;
  request(method: string, params: unknown, signal: AbortSignal): Promise<{ result?: unknown; error?: { code: number; message: string; data?: unknown } }>;
}
const unsupportedIncoming: IncomingHandlers = {
  async request(method) { return method === "ping" ? { result: {} } : { error: { code: -32601, message: "Client capability not supported" } }; },
  notification() {},
};

async function incomingReply(handlers: IncomingHandlers, method: string, params: unknown, signal: AbortSignal): Promise<Record<string, unknown>> {
  if (signal.aborted) return { error: { code: -32800, message: "Client request cancelled" } };
  let relatedTask: string | undefined;
  try {
    if (params && typeof params === "object" && !Array.isArray(params)) {
      const metadata = (params as Record<string, unknown>)._meta;
      if (metadata !== undefined) {
        const related = object(metadata, "request metadata")["io.modelcontextprotocol/related-task"];
        if (related !== undefined) relatedTask = taskId(object(related, "related task metadata").taskId);
      }
    }
  } catch { return { error: { code: -32602, message: "Invalid MCP related-task metadata" } }; }
  let abort: (() => void) | undefined;
  try {
    const reply = await Promise.race([
      handlers.request(method, params, signal),
      new Promise<Record<string, unknown>>((resolve) => { abort = () => resolve({ error: { code: -32800, message: "Client request cancelled" } }); signal.addEventListener("abort", abort, { once: true }); if (signal.aborted) abort(); }),
    ]);
    if ((reply.result === undefined) === (reply.error === undefined)) return { error: { code: -32603, message: "Client handler returned an invalid response" } };
    if (relatedTask !== undefined && reply.result !== undefined) {
      const result = object(reply.result, "client result");
      return { ...reply, result: { ...result, _meta: { ...(result._meta === undefined ? {} : object(result._meta, "client result metadata")), "io.modelcontextprotocol/related-task": { taskId: relatedTask } } } };
    }
    return reply;
  } catch {
    return { error: { code: signal.aborted ? -32800 : -32603, message: signal.aborted ? "Client request cancelled" : "Client request failed" } };
  } finally { if (abort) signal.removeEventListener("abort", abort); }
}

function protectTransport(transport: Transport, secrets: string[], defaultTimeoutMs: number): Transport {
  let version = versions[0]; let capabilities: Record<string, unknown> = {}; let handlers = unsupportedIncoming; let logLevel: string | undefined;
  const failure = (error: unknown) => error instanceof McpAuthorizationRequiredError ? error : error instanceof McpProtocolError ? new McpProtocolError(error.code, protectedText(error.message, secrets), error.supported, error.httpStatus) : error instanceof McpHttpError ? new McpHttpError(error.status, protectedText(error.message, secrets)) : error instanceof McpModernResponseError ? new McpModernResponseError(protectedText(error.message, secrets)) : protectedFailure(error, secrets);
  return {
    async request(method, params, options) {
      try {
        if (version !== MODERN_MCP_VERSION) return protectResult(await transport.request(method, params, options), secrets);
        if (method === "logging/setLevel") { logLevel = string(params.level, "logging level", 32); return { resultType: "complete" }; }
        const controller = new AbortController(); const abort = () => controller.abort(); options?.signal?.addEventListener("abort", abort, { once: true });
        if (options?.signal?.aborted) controller.abort();
        const milliseconds = timeout(options?.timeoutMs ?? defaultTimeoutMs); let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; abort(); }, milliseconds); const deadline = Date.now() + milliseconds;
        try {
          const result = await modernRoundTrips(method, params,
            (next) => transport.request(method, requestMetadata(next, capabilities, logLevel), { ...options, signal: controller.signal, timeoutMs: Math.max(100, deadline - Date.now()) }),
            (method, params) => incomingReply(handlers, method, params, controller.signal),
            async () => { await handlers.check?.(); }, controller.signal, capabilities.extensions !== undefined && Object.hasOwn(object(capabilities.extensions, "client extensions"), MCP_TASK_EXTENSION));
          return protectResult(result, secrets);
        } catch (error) {
          if (timedOut && !options?.signal?.aborted) throw new Error(`MCP ${method} timed out after ${milliseconds}ms`);
          throw error;
        } finally { clearTimeout(timer); options?.signal?.removeEventListener("abort", abort); }
      }
      catch (error) { throw failure(error); }
    },
    async notify(method, params, options) {
      try { await transport.notify(method, params, options); }
      catch (error) { throw failure(error); }
    },
    setVersion: (value) => { version = value; transport.setVersion(value); },
    setClientCapabilities: (value) => { capabilities = structuredClone(value); transport.setClientCapabilities(value); },
    setSubscriptions: (filter) => transport.setSubscriptions(filter),
    setTools: (tools) => transport.setTools(tools),
    setIncoming: (value) => { handlers = { ...value, request: (method, params, signal) => value.request(method, protectResult(params, secrets), signal), notification: (method, params) => value.notification(method, protectResult(params, secrets)), backgroundError: (error) => value.backgroundError?.(failure(error)) }; transport.setIncoming(handlers); },
    async startBackground(options) { try { await transport.startBackground(options); } catch (error) { throw failure(error); } },
    stopBackground: () => transport.stopBackground(),
    async close() { try { await transport.close(); } catch (error) { throw failure(error); } },
  };
}

function message(value: unknown): Record<string, unknown> {
  const result = object(value, "MCP message");
  if (result.jsonrpc !== "2.0") throw new Error("MCP message must use JSON-RPC 2.0");
  return result;
}

function resultOf(value: Record<string, unknown>): unknown {
  if (value.error !== undefined) {
    throw protocolError(value.error);
  }
  if (!("result" in value)) throw new Error("MCP response has no result");
  return value.result;
}

interface Pending { finish(error: Error | undefined, result?: unknown): void }

class StdioTransport implements Transport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private sequence = 0;
  private probeSequence = 0;
  private modern = false;
  private clientCapabilities: Record<string, unknown> = {};
  private filter: SubscriptionFilter = {};
  private subscription?: { stream: McpSubscription; controller: AbortController; ready: Promise<void>; done: Promise<void>; acknowledge(): void; fail(error: Error): void };
  private closed = false;
  private failure?: Error;
  private closePromise?: Promise<void>;
  private buffer = "";
  private incoming = unsupportedIncoming;
  private incomingCount = 0;
  private readonly incomingControllers = new Map<string | number, AbortController>();
  private readonly incomingParents = new Map<string | number, number>();
  private notifications = Promise.resolve();
  private notificationCount = 0;

  constructor(private readonly server: Extract<McpServerDescriptor, { transport: "stdio" }>) {
    this.child = startProcess(server.process);
    const decoder = new StringDecoder("utf8");
    this.child.stderr.resume();
    this.child.stdin.on("error", (error) => this.fail(new Error(`MCP stdin failed: ${publicText(error.message)}`)));
    this.child.on("error", (error) => this.fail(new Error(`MCP process failed: ${publicText(error.message)}`)));
    this.child.on("exit", () => this.fail(new Error("MCP server exited")));
    this.child.stdout.on("data", (chunk: Buffer) => {
      if (this.closed || this.failure) return;
      this.buffer += decoder.write(chunk);
      try {
        if (Buffer.byteLength(this.buffer) > MAX_MESSAGE_BYTES && !this.buffer.includes("\n")) throw new Error("MCP response exceeded message size limit");
        let end: number;
        while ((end = this.buffer.indexOf("\n")) >= 0) {
          const line = this.buffer.slice(0, end).trim(); this.buffer = this.buffer.slice(end + 1);
          if (!line) continue;
          if (Buffer.byteLength(line) > MAX_MESSAGE_BYTES) throw new Error("MCP response exceeded message size limit");
          this.receive(message(JSON.parse(line)));
        }
        if (Buffer.byteLength(this.buffer) > MAX_MESSAGE_BYTES) throw new Error("MCP response exceeded message size limit");
      } catch (error) { this.fail(error instanceof SyntaxError ? new Error("Invalid MCP JSON-RPC response") : error instanceof Error ? error : new Error("Invalid MCP response")); void this.close().catch(() => undefined); }
    });
  }

  private receive(value: Record<string, unknown>): void {
    if (typeof value.method === "string") {
      if (typeof value.id === "number" || typeof value.id === "string") {
        if (this.modern) throw new Error("Modern MCP servers must use input_required results instead of server requests");
        if (this.incomingCount >= 16) { this.write({ jsonrpc: "2.0", id: value.id, error: { code: -32000, message: "Too many concurrent server requests" } }); return; }
        if (this.incomingControllers.has(value.id)) { this.write({ jsonrpc: "2.0", id: value.id, error: { code: -32600, message: "Duplicate active request id" } }); return; }
        this.incomingCount += 1;
        const controller = new AbortController(); this.incomingControllers.set(value.id, controller);
        // Stdio carries no ordinary request-parent field. Associate only when
        // exactly one client RPC was outstanding when this server request arrived.
        if (this.pending.size === 1) this.incomingParents.set(value.id, this.pending.keys().next().value!);
        const timer = setTimeout(() => controller.abort(), 120_000);
        void incomingReply(this.incoming, value.method, value.params, controller.signal).then((reply) => {
          if (!this.closed && !this.failure) this.write({ jsonrpc: "2.0", id: value.id, ...reply });
        }).catch(() => {
          if (!this.closed && !this.failure) this.write({ jsonrpc: "2.0", id: value.id, error: { code: -32603, message: "Client request failed" } });
        }).finally(() => { clearTimeout(timer); this.incomingControllers.delete(value.id as string | number); this.incomingParents.delete(value.id as string | number); this.incomingCount -= 1; });
      } else {
        if (this.modern && (value.method === "notifications/subscriptions/acknowledged" || value.method === "notifications/resources/updated" || value.method === "notifications/tasks" || value.method.endsWith("/list_changed"))) {
          const active = this.subscription;
          if (!active) return;
          try { if (active.stream.accept(value.method, value.params) === "acknowledged") { active.acknowledge(); return; } }
          catch (error) { const failure = error instanceof Error ? error : new Error("Invalid MCP subscription notification"); active.fail(failure); this.incoming.backgroundError?.(failure); return; }
        }
        if (this.notificationCount >= 64) { this.fail(new Error("Too many pending MCP notifications")); void this.close().catch(() => undefined); return; }
        this.notificationCount += 1;
        if (value.method === "notifications/cancelled") {
          const params = value.params && typeof value.params === "object" ? value.params as Record<string, unknown> : {};
          if (typeof params.requestId === "string" || typeof params.requestId === "number") this.incomingControllers.get(params.requestId)?.abort();
        }
        this.notifications = this.notifications.then(() => this.incoming.notification(value.method as string, value.params)).catch((error) => { this.fail(error instanceof Error ? error : new Error("MCP notification failed")); }).finally(() => { this.notificationCount -= 1; });
      }
      return;
    }
    if (typeof value.id !== "number") throw new Error("Invalid MCP response id");
    const request = this.pending.get(value.id);
    if (!request) return;
    void this.notifications.then(() => { try { request.finish(undefined, resultOf(value)); } catch (error) { request.finish(error instanceof Error ? error : new Error("Invalid MCP response")); } });
  }

  private write(value: unknown): void {
    if (this.failure) throw this.failure;
    if (this.closed) throw new Error("MCP connection is closed");
    const encoded = JSON.stringify(value);
    if (Buffer.byteLength(encoded) > MAX_MESSAGE_BYTES) throw new Error("MCP request exceeds message size limit");
    this.child.stdin.write(`${encoded}\n`);
  }

  private fail(error: Error): void {
    this.failure ??= error;
    for (const pending of this.pending.values()) pending.finish(error);
  }

  setVersion(version: string): void { this.modern = version === MODERN_MCP_VERSION; }
  setClientCapabilities(capabilities: Record<string, unknown>): void { this.clientCapabilities = structuredClone(capabilities); }
  setSubscriptions(filter: SubscriptionFilter): void { this.filter = structuredClone(filter); }
  setTools(): void {}
  setIncoming(handlers: IncomingHandlers): void { this.incoming = handlers; }
  async startBackground(options: RequestOptions = {}): Promise<void> {
    if (this.closed) throw new Error("MCP connection is closed"); if (!this.modern) return;
    if (this.subscription) return this.subscription.ready;
    if (this.pending.size >= 32) throw new Error("Too many concurrent MCP requests");
    const controller = new AbortController(); const abort = () => controller.abort(); options.signal?.addEventListener("abort", abort, { once: true }); if (options.signal?.aborted) controller.abort();
    const id = ++this.sequence; const stream = new McpSubscription(id, structuredClone(this.filter));
    let acknowledge!: () => void; let rejectReady!: (error: unknown) => void; const ready = new Promise<void>((resolve, reject) => { acknowledge = resolve; rejectReady = reject; });
    let settled = false; let finish!: () => void; const done = new Promise<void>((resolve) => { finish = resolve; });
    const timer = setTimeout(() => fail(new Error("MCP subscription acknowledgment timed out")), timeout(options.timeoutMs ?? this.server.process.timeoutMs));
    const trustTimer = setInterval(() => { void this.incoming.check?.().catch((error) => { const failure = error instanceof Error ? error : new Error("MCP trust recheck failed"); this.incoming.backgroundError?.(failure); fail(failure); }); }, 1000); trustTimer.unref();
    const cleanup = () => { settled = true; clearTimeout(timer); clearInterval(trustTimer); options.signal?.removeEventListener("abort", abort); controller.signal.removeEventListener("abort", onAbort); this.pending.delete(id); if (this.subscription?.stream === stream) this.subscription = undefined; finish(); };
    const fail = (error: Error) => { if (settled) return; rejectReady(error); if (!this.closed) void this.notify("notifications/cancelled", { requestId: id, reason: "Subscription ended" }).catch(() => undefined); cleanup(); };
    const onAbort = () => fail(cancelled()); controller.signal.addEventListener("abort", onAbort, { once: true });
    this.subscription = { stream, controller, ready, done, acknowledge: () => { clearTimeout(timer); acknowledge(); }, fail };
    this.pending.set(id, { finish: (error, result) => { if (error) { rejectReady(error); if (!controller.signal.aborted && !this.closed) this.incoming.backgroundError?.(error); } else { try { stream.complete(result); } catch (error) { const failure = error instanceof Error ? error : new Error("Invalid MCP subscription completion"); rejectReady(failure); this.incoming.backgroundError?.(failure); } } cleanup(); } });
    void (async () => {
      try { if (controller.signal.aborted) throw cancelled(); await this.incoming.check?.(); if (settled || controller.signal.aborted) throw cancelled(); options.beforeSend?.(); this.write({ jsonrpc: "2.0", id, method: "subscriptions/listen", params: requestMetadata({ notifications: stream.requested }, this.clientCapabilities) }); }
      catch (error) { fail(error instanceof Error ? error : new Error("MCP subscription failed")); }
    })();
    await ready;
  }
  async stopBackground(): Promise<void> { const active = this.subscription; if (!active) return; active.controller.abort(); await active.done; }

  request(method: string, params: Record<string, unknown>, options: RequestOptions = {}): Promise<unknown> {
    if (options.signal?.aborted) return Promise.reject(cancelled());
    if (this.pending.size >= 32) return Promise.reject(new Error("Too many concurrent MCP requests"));
    const id = method === "server/discover" ? --this.probeSequence : ++this.sequence;
    const milliseconds = timeout(options.timeoutMs ?? this.server.process.timeoutMs);
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error: Error | undefined, result?: unknown) => {
        if (settled) return;
        settled = true; clearTimeout(timer); options.signal?.removeEventListener("abort", abort); this.pending.delete(id);
        if (error) reject(error); else resolve(result);
      };
      const cancel = (error: Error) => {
        for (const [incomingId, parentId] of this.incomingParents) if (parentId === id) this.incomingControllers.get(incomingId)?.abort();
        // Stdio cancels the pending RPC by requestId in every era. This does not
        // cancel a durable task; only an explicit tasks/cancel can request that.
        if (method !== "initialize" && params.task === undefined) void this.notify("notifications/cancelled", { requestId: id, reason: "Client cancelled or timed out" }).catch(() => undefined);
        finish(error);
      };
      const abort = () => cancel(cancelled());
      const timer = setTimeout(() => cancel(new Error(`MCP ${method} timed out after ${milliseconds}ms`)), milliseconds);
      this.pending.set(id, { finish });
      options.signal?.addEventListener("abort", abort, { once: true });
      try { options.beforeSend?.(); this.write({ jsonrpc: "2.0", id, method, params }); } catch (error) { finish(error instanceof Error ? error : new Error("MCP write failed")); }
    });
  }

  async notify(method: string, params?: Record<string, unknown>, options: RequestOptions = {}): Promise<void> {
    if (options.signal?.aborted) throw cancelled();
    this.write({ jsonrpc: "2.0", method, ...(params ? { params } : {}) });
  }

  close(): Promise<void> {
    return this.closePromise ??= (async () => { this.fail(new Error("MCP connection closed")); this.closed = true; for (const controller of this.incomingControllers.values()) controller.abort(); await stopProcess(this.child); })();
  }
}

class HttpTransport implements Transport {
  private sequence = 0;
  private probeSequence = 0;
  private version = versions[0];
  private clientCapabilities: Record<string, unknown> = {};
  private filter: SubscriptionFilter = {};
  private readonly toolHeaders = new Map<string, ToolHeader[]>();
  private session?: string;
  private readonly controllers = new Set<AbortController>();
  private closed = false;
  private readonly authorization?: string;
  private lastAuthorization?: string;
  private rejectedOAuthToken?: string;
  private closePromise?: Promise<void>;
  private incoming = unsupportedIncoming;
  private background?: { controller: AbortController; done: Promise<void>; ready: Promise<void> };
  private incomingCount = 0;
  private readonly incomingControllers = new Map<string | number, AbortController>();

  constructor(private readonly server: Extract<McpServerDescriptor, { transport: "http" }>, private readonly oauth?: McpOAuthCredentials) {
    if (server.bearerTokenEnv) {
      const token = process.env[server.bearerTokenEnv];
      if (!token || /[\u0000-\u0020\u007f]/u.test(token)) throw new Error(`Required bearer token environment variable is missing or invalid: ${server.bearerTokenEnv}`);
      this.authorization = `Bearer ${token}`;
    }
  }

  setVersion(version: string): void { this.version = version; }
  setClientCapabilities(capabilities: Record<string, unknown>): void { this.clientCapabilities = structuredClone(capabilities); }
  setSubscriptions(filter: SubscriptionFilter): void { this.filter = structuredClone(filter); }
  setTools(tools: McpTool[]): void { this.toolHeaders.clear(); for (const tool of tools) this.toolHeaders.set(tool.name, toolHeaderSchema(tool.inputSchema)); }
  setIncoming(handlers: IncomingHandlers): void { this.incoming = handlers; }

  private headers(authorization = this.authorization ?? this.lastAuthorization): Record<string, string> {
    return { "content-type": "application/json", accept: "application/json, text/event-stream", "MCP-Protocol-Version": this.version,
      ...(this.session ? { "Mcp-Session-Id": this.session } : {}), ...(authorization ? { authorization } : {}) };
  }

  private async receive(value: Record<string, unknown>, signal: AbortSignal, requestOptions: RequestOptions, subscription = false): Promise<void> {
    if (typeof value.method !== "string") throw new Error("Unexpected JSON-RPC response on MCP background stream");
    if (this.version === MODERN_MCP_VERSION && !subscription && (value.method === "notifications/subscriptions/acknowledged" || value.method === "notifications/resources/updated" || value.method === "notifications/tasks" || value.method.endsWith("/list_changed"))) throw new Error("Modern MCP change notifications require an acknowledged subscription");
    if (typeof value.id === "string" || typeof value.id === "number") {
      if (this.version === MODERN_MCP_VERSION) throw new Error("Modern MCP servers must use input_required results instead of server requests");
      if (this.incomingCount >= 16 || this.incomingControllers.has(value.id)) throw new Error("Too many or duplicate MCP server requests");
      this.incomingCount += 1; const controller = new AbortController(); this.incomingControllers.set(value.id, controller);
      const abort = () => controller.abort(); signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) controller.abort();
      const timer = setTimeout(abort, signal === this.background?.controller.signal ? 120_000 : timeout(requestOptions.timeoutMs ?? this.server.timeoutMs));
      void (async () => { try {
        const reply = await incomingReply(this.incoming, String(value.method), value.params, controller.signal);
        if (signal.aborted) throw cancelled();
        await this.incoming.check?.();
        await this.post({ jsonrpc: "2.0", id: value.id, ...reply }, { ...requestOptions, signal });
      } finally { clearTimeout(timer); signal.removeEventListener("abort", abort); this.incomingControllers.delete(value.id as string | number); this.incomingCount -= 1; } })().catch((error) => { if (!signal.aborted && !this.closed) this.incoming.backgroundError?.(error instanceof Error ? error : new Error("MCP client reply failed")); });
    } else {
      if (value.method === "notifications/cancelled") {
        const params = value.params && typeof value.params === "object" ? value.params as Record<string, unknown> : {};
        if (typeof params.requestId === "number" || typeof params.requestId === "string") this.incomingControllers.get(params.requestId)?.abort();
      }
      await this.incoming.notification(value.method, value.params);
    }
  }

  private async getStream(signal: AbortSignal, options: RequestOptions, lastEventId?: string): Promise<Response> {
    if (this.closed) throw new Error("MCP connection is closed");
    if (signal.aborted) throw cancelled();
    await this.incoming.check?.();
    let token = await this.oauth?.accessToken({ ...options, signal }, this.rejectedOAuthToken);
    this.rejectedOAuthToken = undefined; this.lastAuthorization = token ? `Bearer ${token}` : undefined;
    const send = () => {
      if (signal.aborted || this.closed) throw cancelled(); options.beforeSend?.();
      return fetch(this.server.url, { method: "GET", headers: { ...this.headers(), accept: "text/event-stream", ...(lastEventId ? { "Last-Event-ID": lastEventId } : {}) }, signal, credentials: "omit", redirect: "error" });
    };
    await this.incoming.check?.();
    let response = await send();
    if (response.status === 401 && token) {
      await response.body?.cancel(); this.rejectedOAuthToken = token;
      token = await this.oauth?.accessToken({ ...options, signal }, token); this.rejectedOAuthToken = undefined; this.lastAuthorization = token ? `Bearer ${token}` : undefined;
      await this.incoming.check?.(); response = await send();
    }
    if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new McpAuthorizationRequiredError(this.server.id, response.status === 403); }
    if (response.status === 405) { await response.body?.cancel(); throw new Error("MCP server does not support background SSE streams (HTTP 405)"); }
    if (response.status === 404 && this.session) { await response.body?.cancel(); throw new Error("MCP session expired; reconnect before retrying"); }
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("text/event-stream") || !response.body) {
      await response.body?.cancel(); throw new Error(`MCP background stream failed (${response.status}); expected text/event-stream`);
    }
    return response;
  }

  async startBackground(options: RequestOptions = {}): Promise<void> {
    options = { ...options };
    if (this.closed) throw new Error("MCP connection is closed");
    if (this.background) return this.background.ready;
    if (options.signal?.aborted) throw cancelled();
    if (this.version === MODERN_MCP_VERSION) return this.startModernBackground(options);
    const controller = new AbortController(); const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    // A quiet stream still loses authority promptly after trust is revoked.
    const trustTimer = setInterval(() => { void this.incoming.check?.().catch((error) => { this.incoming.backgroundError?.(error instanceof Error ? error : new Error("MCP trust recheck failed")); controller.abort(); }); }, 1000);
    trustTimer.unref();
    let readyResolve!: () => void; let readyReject!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
    const done = (async () => {
      let lastEventId: string | undefined; let retry = 250; let reconnects = 0;
      const delivered = new Map<string, string>();
      try {
        while (!controller.signal.aborted && !this.closed) {
          const openTimer = setTimeout(abort, timeout(options.timeoutMs ?? this.server.timeoutMs));
          let response: Response;
          try { response = await this.getStream(controller.signal, options, lastEventId); } finally { clearTimeout(openTimer); }
          readyResolve();
          try {
            for await (const event of mcpSseEvents(response.body!, controller.signal, { resumable: this.version !== MODERN_MCP_VERSION })) {
              await this.incoming.check?.();
              if (event.retry !== undefined) retry = Math.max(100, event.retry);
              if (event.id !== undefined) lastEventId = event.id || undefined;
              if (event.data) {
                const digest = event.id ? createHash("sha256").update(event.data).digest("hex") : undefined;
                if (event.id && delivered.has(event.id)) { if (delivered.get(event.id) !== digest) throw new Error("MCP SSE event id was reused with different content"); continue; }
                await this.receive(message(JSON.parse(event.data)), controller.signal, options);
                if (event.id) { delivered.set(event.id, digest!); if (delivered.size > 64) delivered.delete(delivered.keys().next().value!); }
              }
            }
          } catch (error) { if (!(error instanceof TypeError) || controller.signal.aborted) throw error; }
          if (controller.signal.aborted || this.closed) break;
          reconnects += 1;
          if (reconnects > 5) throw new Error("MCP background stream disconnected repeatedly; reconnect explicitly");
          await mcpReconnectDelay(Math.min(120_000, Math.max(retry, 250 * 2 ** (reconnects - 1))), controller.signal);
        }
      } catch (error) {
        readyReject(error);
        if (!controller.signal.aborted && !this.closed) this.incoming.backgroundError?.(error instanceof SyntaxError ? new Error("Invalid MCP JSON-RPC background event") : error instanceof Error ? error : new Error("MCP background stream failed"));
      } finally {
        controller.abort();
        clearInterval(trustTimer); options.signal?.removeEventListener("abort", abort);
        if (this.background?.controller === controller) this.background = undefined;
      }
    })();
    this.background = { controller, done, ready };
    await ready;
  }

  async stopBackground(): Promise<void> {
    const active = this.background; if (!active) return;
    active.controller.abort(); await active.done;
  }

  private async startModernBackground(options: RequestOptions): Promise<void> {
    const controller = new AbortController(); const abort = () => controller.abort(); options.signal?.addEventListener("abort", abort, { once: true }); if (options.signal?.aborted) controller.abort();
    const id = ++this.sequence; const stream = new McpSubscription(id, structuredClone(this.filter));
    let acknowledge!: () => void; let rejectReady!: (error: unknown) => void;
    const ready = new Promise<void>((resolve, reject) => { acknowledge = resolve; rejectReady = reject; });
    const trustTimer = setInterval(() => { void this.incoming.check?.().catch((error) => { this.incoming.backgroundError?.(error instanceof Error ? error : new Error("MCP trust recheck failed")); controller.abort(); }); }, 1000); trustTimer.unref();
    const done = this.post({ jsonrpc: "2.0", id, method: "subscriptions/listen", params: requestMetadata({ notifications: stream.requested }, this.clientCapabilities) }, { ...options, signal: controller.signal }, { stream, acknowledge }).then(() => undefined).catch((error) => { rejectReady(error); if (!controller.signal.aborted && !this.closed) this.incoming.backgroundError?.(error instanceof Error ? error : new Error("MCP subscription failed")); }).finally(() => { clearInterval(trustTimer); options.signal?.removeEventListener("abort", abort); if (this.background?.controller === controller) this.background = undefined; });
    this.background = { controller, ready, done }; await ready;
  }

  private async post(payload: Record<string, unknown>, options: RequestOptions = {}, subscription?: { stream: McpSubscription; acknowledge(): void }): Promise<unknown> {
    if (this.closed) throw new Error("MCP connection is closed");
    if (options.signal?.aborted) throw cancelled();
    if (this.controllers.size >= 32) throw new Error("Too many concurrent MCP requests");
    const encoded = JSON.stringify(payload);
    if (Buffer.byteLength(encoded) > MAX_MESSAGE_BYTES) throw new Error("MCP request exceeds message size limit");
    const controller = new AbortController(); this.controllers.add(controller);
    const milliseconds = timeout(options.timeoutMs ?? this.server.timeoutMs);
    let timedOut = false;
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, milliseconds);
    try {
      let oauthToken = await this.oauth?.accessToken({ ...options, signal: controller.signal }, this.rejectedOAuthToken);
      this.rejectedOAuthToken = undefined;
      this.lastAuthorization = oauthToken ? `Bearer ${oauthToken}` : undefined;
      const send = () => {
        if (this.closed) throw new Error("MCP connection is closed");
        if (controller.signal.aborted) throw cancelled();
        options.beforeSend?.();
        const params = payload.params && typeof payload.params === "object" ? object(payload.params, "request params") : {};
        const modernHeaders = this.version === MODERN_MCP_VERSION ? { "Mcp-Method": mcpHeader(String(payload.method)), ...(["tools/call", "resources/read", "prompts/get", "tasks/get", "tasks/update", "tasks/cancel"].includes(String(payload.method)) ? { "Mcp-Name": mcpHeader(String(params.name ?? params.uri ?? params.taskId)) } : {}), ...(payload.method === "tools/call" ? toolParameterHeaders(this.toolHeaders.get(String(params.name)) ?? [], params.arguments) : {}) } : {};
        return fetch(this.server.url, { method: "POST", headers: { ...this.headers(this.authorization ?? this.lastAuthorization), ...modernHeaders }, body: encoded, signal: controller.signal, credentials: "omit", redirect: "error" });
      };
      await this.incoming.check?.();
      let response = await send();
      if (response.status === 401 && oauthToken) {
        this.rejectedOAuthToken = oauthToken;
        // Only initialization/discovery can be retried. A tools/call may have
        // performed a side effect before rejecting authentication.
        if (["server/discover", "initialize", "tools/list", "resources/list", "resources/templates/list", "prompts/list"].includes(String(payload.method))) {
          await response.body?.cancel();
          oauthToken = await this.oauth?.accessToken({ ...options, signal: controller.signal }, oauthToken);
          this.rejectedOAuthToken = undefined; this.lastAuthorization = oauthToken ? `Bearer ${oauthToken}` : undefined;
          await this.incoming.check?.();
          response = await send();
        }
      }
      if (response.status === 401 || response.status === 403) { await response.body?.cancel(); throw new McpAuthorizationRequiredError(this.server.id, response.status === 403); }
      if (!response.ok) {
        if (this.version === MODERN_MCP_VERSION && response.body && (response.headers.get("content-type") ?? "").includes("application/json")) {
          const errorBody = message(await mcpJsonBody(response.body));
          if (errorBody.id !== undefined && errorBody.id !== null && errorBody.id !== payload.id) throw new McpModernResponseError("MCP HTTP error response id does not match request");
          if (errorBody.error !== undefined) throw protocolError(errorBody.error, response.status);
        }
        await response.body?.cancel(); throw new McpHttpError(response.status, response.status === 404 && this.session ? "MCP session expired; reconnect before retrying" : `MCP HTTP request failed (${response.status})`);
      }
      if (payload.method === "initialize") {
        const session = response.headers.get("mcp-session-id");
        if (session !== null) {
          if (!/^[\x21-\x7e]{1,1024}$/u.test(session)) { await response.body?.cancel(); throw new Error("Invalid MCP session identifier"); }
          this.session = session;
        }
      }
      if (!("id" in payload) || !("method" in payload)) { await response.body?.cancel(); if (response.status !== 202) throw new Error("MCP notifications must return HTTP 202"); return undefined; }
      const contentType = response.headers.get("content-type") ?? "";
      if (!response.body) throw new Error("MCP HTTP response has no body");
      if (contentType.includes("text/event-stream")) {
        let lastEventId: string | undefined; let retry = 250;
        const delivered = new Map<string, string>();
        for (let reconnect = 0; reconnect <= 5; reconnect += 1) {
          try {
            for await (const event of mcpSseEvents(response.body!, controller.signal, { resumable: this.version !== MODERN_MCP_VERSION })) {
              if (event.id !== undefined) lastEventId = event.id || undefined;
              if (event.retry !== undefined) retry = Math.max(100, event.retry);
              if (!event.data) continue;
              const digest = event.id ? createHash("sha256").update(event.data).digest("hex") : undefined;
              if (event.id && delivered.has(event.id)) { if (delivered.get(event.id) !== digest) throw new Error("MCP SSE event id was reused with different content"); continue; }
              const value = message(JSON.parse(event.data));
              if (value.id === payload.id && typeof value.method !== "string") { const result = resultOf(value); if (subscription) subscription.stream.complete(result); return result; }
              if (subscription) {
                if (typeof value.method !== "string" || value.id !== undefined) throw new Error("Invalid MCP subscription message");
                if (subscription.stream.accept(value.method, value.params) === "acknowledged") { clearTimeout(timer); subscription.acknowledge(); continue; }
              }
              await this.receive(value, controller.signal, { ...options, timeoutMs: milliseconds }, subscription !== undefined);
              if (event.id) { delivered.set(event.id, digest!); if (delivered.size > 64) delivered.delete(delivered.keys().next().value!); }
            }
          } catch (error) { if (!(error instanceof TypeError) || controller.signal.aborted) throw error; }
          if (this.version === MODERN_MCP_VERSION || !lastEventId || reconnect === 5) throw new Error("MCP SSE stream ended without a matching response; request was not replayed");
          await mcpReconnectDelay(Math.min(120_000, Math.max(retry, 250 * 2 ** reconnect)), controller.signal);
          // Resume the stream with GET, never repeat a possibly side-effecting POST.
          response = await this.getStream(controller.signal, options, lastEventId);
        }
        throw new Error("MCP SSE reconnect limit exceeded");
      }
      if (!contentType.includes("application/json")) { await response.body.cancel(); throw new Error("MCP HTTP response must use application/json or text/event-stream"); }
      if (subscription) { await response.body.cancel(); throw new Error("MCP subscriptions/listen requires an SSE response stream"); }
      const value = message(await mcpJsonBody(response.body));
      if (value.id !== payload.id || typeof value.method === "string") throw new Error("MCP HTTP response id does not match request");
      return resultOf(value);
    } catch (error) {
      if (controller.signal.aborted) {
        if (this.version !== MODERN_MCP_VERSION && typeof payload.id === "number" && typeof payload.method === "string" && payload.method !== "initialize" && (payload.params as Record<string, unknown> | undefined)?.task === undefined && !this.closed) {
          void this.notify("notifications/cancelled", { requestId: payload.id, reason: "Client cancelled or timed out" }).catch(() => undefined);
        }
        if (timedOut) throw new Error(`MCP request timed out after ${milliseconds}ms`);
        throw cancelled();
      }
      if (error instanceof SyntaxError) throw new Error("Invalid MCP JSON-RPC response");
      throw error;
    } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); this.controllers.delete(controller); controller.abort(); }
  }

  request(method: string, params: Record<string, unknown>, options?: RequestOptions): Promise<unknown> { return this.post({ jsonrpc: "2.0", id: method === "server/discover" ? --this.probeSequence : ++this.sequence, method, params }, options); }
  async notify(method: string, params?: Record<string, unknown>, options: RequestOptions = {}): Promise<void> { await this.post({ jsonrpc: "2.0", method, ...(params ? { params } : {}) }, { ...options, timeoutMs: Math.min(options.timeoutMs ?? this.server.timeoutMs, 1000) }); }

  close(): Promise<void> {
    return this.closePromise ??= (async () => {
      this.closed = true;
      for (const controller of this.controllers) controller.abort();
      for (const controller of this.incomingControllers.values()) controller.abort();
      await this.stopBackground();
      if (this.session) {
        const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), 1000);
        try {
          const response = await fetch(this.server.url, { method: "DELETE", headers: this.headers(), credentials: "omit", redirect: "error", signal: controller.signal });
          await response.body?.cancel();
          if (!response.ok && response.status !== 404 && response.status !== 405) throw new Error(`MCP session cleanup failed (${response.status})`);
        } finally { clearTimeout(timer); }
      }
    })();
  }
}

/** Explicit opt-in: calling this function launches or contacts the trusted server. */
export async function connectMcp(cwd: string, id: string, options: ExtensionOptions & RequestOptions & { roots?: boolean; incoming?: McpIncomingHandler } = {}): Promise<McpConnection> {
  const shareRoot = options.roots === true;
  options = { ...options };
  if (options.signal?.aborted) throw cancelled();
  const catalog = await discoverExtensions(cwd, options);
  const exact = catalog.servers.find((entry) => entry.id === id || entry.id === `mcp:${id}`);
  const matches = exact ? [exact] : catalog.servers.filter((entry) => entry.name === id);
  if (matches.length > 1) throw new Error(`Ambiguous MCP server: ${id}; use its full namespaced id`);
  const server = matches[0];
  if (!server) throw new Error(`Unknown MCP server: ${id}`);
  requireActive(server);
  options = { ...options, incoming: options.incoming ?? options.mcpHost?.(server.id) };
  const incoming = options.incoming;
  const incomingCapabilities = structuredClone(incoming?.capabilities ?? {});
  // Only supported host-implemented request categories can be advertised.
  for (const key of Object.keys(incomingCapabilities)) if (!["sampling", "elicitation"].includes(key)) throw new Error(`Unsupported MCP client capability: ${key}`);
  if (options.signal?.aborted) throw cancelled();
  const refs = server.transport === "stdio" ? Object.values(server.process.envRefs) : [server.bearerTokenEnv, server.oauth?.clientSecretEnv].filter((ref): ref is string => !!ref);
  const secrets = explicitSecrets(refs);
  let transport: Transport;
  try { transport = protectTransport(server.transport === "stdio" ? new StdioTransport(server) : new HttpTransport(server, server.bearerTokenEnv ? undefined : new McpOAuthCredentials(catalog.root, server, options, secrets)), secrets, server.transport === "stdio" ? server.process.timeoutMs : server.timeoutMs); }
  catch (error) { throw protectedFailure(error, secrets); }
  try {
    let closed = false; let revoked = false; let initialized = false;
    const listeners = new Set<(kind: McpListKind) => void>();
    const resourceListeners = new Set<(uri: string) => void>();
    const taskListeners = new Set<(task: McpTask) => void>();
    const backgroundListeners = new Set<(error: Error) => void>();
    const subscriptions = new Set<string>();
    const taskSubscriptions = new Set<string>();
    const subscriptionOperations = new Set<string>();
    const taskInputs = new Map<string, Map<string, { digest: string; sent: boolean }>>();
    const taskUpdates = new Set<string>();
    const knownTools = new Map<string, McpTool>();
    const incomingControllers = new Set<AbortController>();
    let capabilities = parseCapabilities({});
    const ensureActive = async (requestOptions: RequestOptions = {}): Promise<void> => {
      if (closed) throw new Error("MCP connection is closed");
      if (requestOptions.signal?.aborted) throw cancelled();
      if (revoked) throw new Error("MCP trust or configuration changed; reconnect after reviewing it");
      const currentCatalog = await discoverExtensions(catalog.root, options);
      const current = currentCatalog.servers.find((entry) => entry.id === server.id);
      if (!current?.trusted || !current.enabled || current.blockedReason || current.fingerprint !== server.fingerprint) {
        revoked = true;
        for (const controller of incomingControllers) controller.abort();
        throw new Error(current?.blockedReason ?? "MCP trust or configuration changed; reconnect after reviewing it");
      }
      if (requestOptions.signal?.aborted) throw cancelled();
      if (closed) throw new Error("MCP connection is closed");
    };
    const hostHandlers: IncomingHandlers = {
      check: ensureActive,
      backgroundError(error) { for (const listener of [...backgroundListeners]) { try { listener(error); } catch { /* Observers cannot break the transport. */ } } },
      async request(method, params, signal) {
        if (method === "ping") return { result: {} };
        if (method !== "roots/list" && (!incoming || !(method.startsWith("sampling/") && incomingCapabilities.sampling || method.startsWith("elicitation/") && incomingCapabilities.elicitation))) return { error: { code: -32601, message: "Client capability not supported" } };
        if (method === "roots/list" && !shareRoot) return { error: { code: -32601, message: "Client capability not supported" } };
        if (!initialized) return { error: { code: -32000, message: "Client initialization is incomplete" } };
        try { await ensureActive({ signal }); }
        catch { return { error: { code: -32000, message: "Project root access is no longer available; reconnect after reviewing trust" } }; }
        // Explicit scope is the one canonical project root. Server-provided paths,
        // personal directories and nested roots are never consulted or disclosed.
        if (method === "roots/list") return { result: { roots: [{ uri: pathToFileURL(catalog.root).href, name: "Project" }] } };
        const controller = new AbortController(); const abort = () => controller.abort();
        signal.addEventListener("abort", abort, { once: true }); incomingControllers.add(controller);
        const timer = setInterval(() => { void ensureActive().catch(abort); }, 1000); timer.unref();
        try {
          const reply = await incomingReply({ request: (method, params, signal) => incoming!.request(method, params, signal), notification() {} }, method, params, controller.signal);
          await ensureActive({ signal });
          return reply;
        } finally { clearInterval(timer); signal.removeEventListener("abort", abort); incomingControllers.delete(controller); }
      },
      async notification(method, params) {
        if (!initialized || closed || revoked) return;
        await ensureActive();
        if (method === "notifications/resources/updated" && capabilities.resources?.subscribe) {
          const uri = mcpUri(object(params, "resource update notification").uri);
          if (subscriptions.has(uri)) for (const listener of [...resourceListeners]) { try { listener(uri); } catch { /* Observer isolation. */ } }
          return;
        }
        if (method === "notifications/tasks/status" && capabilities.tasks) {
          const task = parseTask(params);
          for (const listener of [...taskListeners]) { try { listener(structuredClone(task)); } catch { /* Observer isolation. */ } }
          return;
        }
        if (method === "notifications/tasks" && capabilities.extensions?.[MCP_TASK_EXTENSION] && taskSubscriptions.has(String(object(params, "task notification").taskId))) {
          const task = recordModernTask(parseModernTask(params));
          for (const listener of [...taskListeners]) { try { listener(structuredClone(task)); } catch { /* Observer isolation. */ } }
          return;
        }
        const kind: McpListKind | undefined = method === "notifications/tools/list_changed" ? "tools" : method === "notifications/resources/list_changed" ? "resources" : method === "notifications/prompts/list_changed" ? "prompts" : undefined;
        if (!kind || capabilities[kind]?.listChanged !== true) return;
        if (kind === "tools") knownTools.clear();
        for (const listener of [...listeners]) {
          try { listener(kind); } catch { /* Observers cannot break the transport. */ }
        }
      },
    };
    transport.setIncoming(hostHandlers);
    const clientCapabilities = { ...incomingCapabilities, ...(shareRoot ? { roots: {} } : {}) };
    transport.setClientCapabilities(clientCapabilities); transport.setVersion(MODERN_MCP_VERSION);
    let discovered: Record<string, unknown> | undefined;
    try { discovered = object(await transport.request("server/discover", {}, { ...options, timeoutMs: Math.min(options.timeoutMs ?? (server.transport === "stdio" ? server.process.timeoutMs : server.timeoutMs), 1500) }), "server/discover result"); }
    catch (error) {
      if (error instanceof McpHttpError && ![400, 404, 405].includes(error.status)) throw error;
      if (error instanceof McpModernResponseError || error instanceof McpProtocolError && (error.httpStatus !== undefined && error.httpStatus >= 500 || error.httpStatus === 404 && error.code === -32601)) throw error;
      if (options.signal?.aborted || error instanceof McpAuthorizationRequiredError || modernError(error)) {
        if (error instanceof McpProtocolError && error.code === -32022) throw new Error(`MCP server requires an unsupported modern protocol version; supported: ${(error.supported ?? []).join(", ") || "none"}`);
        throw error;
      }
      // Discovery is side-effect free. Legacy pre-initialize errors and quiet
      // servers have no standard error code, so they enter the legacy handshake.
    }
    let protocolVersion: string;
    if (discovered) {
      if (!Array.isArray(discovered.supportedVersions) || discovered.supportedVersions.length > 32) throw new Error("Invalid MCP discovery supportedVersions");
      const supported = discovered.supportedVersions.map((entry) => string(entry, "supported protocol version", 32));
      if (!supported.includes(MODERN_MCP_VERSION)) throw new Error(`No supported modern MCP protocol version; server supports: ${supported.join(", ")}`);
      protocolVersion = MODERN_MCP_VERSION; capabilities = parseCapabilities(discovered.capabilities);
      if (capabilities.extensions?.[MCP_TASK_EXTENSION]) transport.setClientCapabilities({ ...clientCapabilities, extensions: { [MCP_TASK_EXTENSION]: {} } });
      if (discovered._meta !== undefined) {
        const info = object(discovered._meta, "discovery metadata")[`${MCP_META}serverInfo`];
        if (info !== undefined) { const serverInfo = object(info, "serverInfo"); string(serverInfo.name, "server name", 256); string(serverInfo.version, "server version", 128); }
      }
    } else {
      transport.setVersion(versions[0]);
      const result = object(await transport.request("initialize", { protocolVersion: versions[0], capabilities: clientCapabilities, clientInfo: { name: "hive", version: "0.6.0" } }, options), "initialize result");
      protocolVersion = string(result.protocolVersion, "protocolVersion", 32);
      if (!versions.includes(protocolVersion)) throw new Error(`Unsupported MCP protocol version: ${protocolVersion}`);
      capabilities = parseCapabilities(result.capabilities);
      const serverInfo = object(result.serverInfo, "serverInfo"); string(serverInfo.name, "server name", 256); string(serverInfo.version, "server version", 128);
      transport.setVersion(protocolVersion); await transport.notify("notifications/initialized", undefined, options);
    }
    initialized = true;
    let backgroundRequested = false; let modernSubscriptionBusy = false; let backgroundGeneration = 0;
    const subscriptionFilter = (): SubscriptionFilter => ({ ...(capabilities.tools?.listChanged ? { toolsListChanged: true } : {}), ...(capabilities.prompts?.listChanged ? { promptsListChanged: true } : {}), ...(capabilities.resources?.listChanged ? { resourcesListChanged: true } : {}), ...(subscriptions.size ? { resourceSubscriptions: [...subscriptions] } : {}), ...(taskSubscriptions.size ? { taskIds: [...taskSubscriptions] } : {}) });
    const refreshSubscriptions = async (requestOptions: RequestOptions): Promise<void> => {
      const generation = backgroundGeneration;
      transport.setSubscriptions(subscriptionFilter());
      if (backgroundRequested) {
        await transport.stopBackground();
        if (!backgroundRequested || generation !== backgroundGeneration) throw cancelled();
        await transport.startBackground(requestOptions);
        if (!backgroundRequested || generation !== backgroundGeneration) { await transport.stopBackground(); throw cancelled(); }
      }
    };
    const ensureTools = () => { if (capabilities.tools === undefined) throw new Error("MCP server does not advertise tools capability"); };
    const ensureCapability = (name: "resources" | "prompts" | "completions") => { if (capabilities[name] === undefined) throw new Error(`MCP server does not advertise ${name} capability`); };
    const ensureTasks = () => {
      if (protocolVersion === MODERN_MCP_VERSION) { if (!capabilities.extensions?.[MCP_TASK_EXTENSION]) throw new Error("MCP server does not advertise the modern tasks extension"); }
      else if (protocolVersion !== "2025-11-25" || !capabilities.tasks) throw new Error("MCP server does not advertise tasks for protocol 2025-11-25");
    };
    const recordModernTask = (task: McpModernTask): McpModernTask => {
      if (task.status !== "input_required") return task;
      let seen = taskInputs.get(task.taskId);
      if (!seen) { if (taskInputs.size >= 128) throw new Error("MCP tasks with client input exceed 128 per connection"); seen = new Map(); taskInputs.set(task.taskId, seen); }
      const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical) : value && typeof value === "object" ? Object.fromEntries(Object.entries(object(value, "task input")).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)])) : value;
      for (const [key, request] of Object.entries(task.inputRequests)) {
        const digest = createHash("sha256").update(JSON.stringify(canonical(request))).digest("hex"), previous = seen.get(key);
        if (previous && previous.digest !== digest) throw new Error("MCP task reused an input request key for different input");
        if (!previous) { if (seen.size >= 256) throw new Error("MCP task input request keys exceed 256 per task"); seen.set(key, { digest, sent: false }); }
      }
      return task;
    };
    const parseToolResult = (value: unknown): McpToolResult => {
      const raw = object(value, "tools/call result");
      if (!Array.isArray(raw.content) || raw.content.length > 256) throw new Error("MCP tool result must contain a bounded content array");
      const content = raw.content.map((entry) => { const block = object(entry, "tool result content"); string(block.type, "content type", 64); return block; });
      if (raw.isError !== undefined && typeof raw.isError !== "boolean") throw new Error("MCP isError must be a boolean");
      return { content, ...(raw.structuredContent === undefined ? {} : { structuredContent: object(raw.structuredContent, "structuredContent") }), ...(typeof raw.isError === "boolean" ? { isError: raw.isError } : {}) };
    };
    const observe = <T>(set: Set<(value: T) => void>, listener: (value: T) => void): (() => void) => {
      if (closed) throw new Error("MCP connection is closed");
      if (typeof listener !== "function") throw new Error("MCP listener must be a function");
      if (set.size >= 32) throw new Error("MCP listeners exceed 32");
      set.add(listener); return () => { set.delete(listener); };
    };
    const paginated = async <T>(method: string, field: string, parse: (value: unknown) => T, identity: (value: T) => string, requestOptions: RequestOptions): Promise<T[]> => {
      const entries: T[] = []; const names = new Set<string>(); const cursors = new Set<string>(); let cursor: string | undefined; let bytes = 0;
      for (let page = 0; page < 16; page += 1) {
        await ensureActive(requestOptions);
        const result = object(await transport.request(method, cursor ? { cursor } : {}, requestOptions), `${method} result`);
        const values = result[field];
        if (!Array.isArray(values)) throw new Error(`MCP ${method} must return an array`);
        bytes += Buffer.byteLength(JSON.stringify(values));
        if (bytes > MAX_MESSAGE_BYTES) throw new Error(`MCP ${method} catalog exceeded message size limit`);
        for (const value of values) {
          const parsed = parse(value); const name = identity(parsed);
          if (names.has(name)) throw new Error(`MCP ${method} returned a duplicate entry`);
          names.add(name); entries.push(parsed);
          if (entries.length > 256) throw new Error(`MCP ${method} count exceeds 256`);
        }
        if (result.nextCursor === undefined) return entries;
        cursor = string(result.nextCursor, `${method} cursor`, 4096);
        if (cursors.has(cursor)) throw new Error(`MCP ${method} returned a repeated cursor`);
        cursors.add(cursor);
      }
      throw new Error(`MCP ${method} exceeded 16 pages`);
    };
    const connection: McpConnection = {
      serverId: server.id, protocolVersion,
      capabilities: structuredClone(capabilities),
      async startBackground(requestOptions = {}) {
        if (protocolVersion === MODERN_MCP_VERSION && modernSubscriptionBusy) throw new Error("MCP subscription operation is already in progress");
        const generation = ++backgroundGeneration;
        if (protocolVersion === MODERN_MCP_VERSION) modernSubscriptionBusy = true;
        try {
          await ensureActive(requestOptions);
          if (generation !== backgroundGeneration) throw cancelled();
          transport.setSubscriptions(subscriptionFilter());
          await transport.startBackground(requestOptions);
          if (generation !== backgroundGeneration) { await transport.stopBackground(); throw cancelled(); }
          backgroundRequested = true;
        } finally { if (protocolVersion === MODERN_MCP_VERSION) modernSubscriptionBusy = false; }
      },
      stopBackground() { backgroundGeneration += 1; backgroundRequested = false; return transport.stopBackground(); },
      onBackgroundError(listener) { return observe(backgroundListeners, listener); },
      onResourceUpdated(listener) { return observe(resourceListeners, listener); },
      onTaskStatus(listener) { return observe(taskListeners, listener); },
      onListChanged(listener) {
        if (closed) throw new Error("MCP connection is closed");
        if (typeof listener !== "function") throw new Error("MCP list change listener must be a function");
        if (listeners.size >= 32) throw new Error("MCP list change listeners exceed 32");
        listeners.add(listener); return () => { listeners.delete(listener); };
      },
      async listTools(requestOptions = {}) {
        ensureTools(); const tools: McpTool[] = []; const names = new Set<string>(); const cursors = new Set<string>(); let cursor: string | undefined;
        for (let page = 0; page < 16; page += 1) {
          await ensureActive(requestOptions);
          const result = object(await transport.request("tools/list", cursor ? { cursor } : {}, requestOptions), "tools/list result");
          if (!Array.isArray(result.tools)) throw new Error("MCP tools/list must return an array");
          for (const raw of result.tools) {
            const tool = object(raw, "MCP tool"); const name = string(tool.name, "tool name", 128);
            if (names.has(name) || !/^[A-Za-z0-9_.-]+$/u.test(name)) throw new Error("Duplicate or invalid MCP tool name");
            const inputSchema = object(tool.inputSchema, "tool inputSchema");
            if (inputSchema.type !== "object") throw new Error("MCP tool inputSchema must describe an object");
            if (protocolVersion === MODERN_MCP_VERSION && server.transport === "http") { try { toolHeaderSchema(inputSchema); } catch { continue; } }
            let execution: McpTool["execution"];
            if (tool.execution !== undefined) {
              const support = object(tool.execution, "tool execution").taskSupport;
              if (support !== undefined) {
                if (!["optional", "required", "forbidden"].includes(String(support))) throw new Error("Invalid MCP tool taskSupport");
                execution = { taskSupport: support as "optional" | "required" | "forbidden" };
              }
            }
            names.add(name); tools.push({ name, description: typeof tool.description === "string" ? tool.description.slice(0, 4096) : name, inputSchema, ...(execution ? { execution } : {}) });
            if (tools.length > 128) throw new Error("MCP tool count exceeds 128");
          }
          if (result.nextCursor === undefined) { knownTools.clear(); for (const tool of tools) knownTools.set(tool.name, structuredClone(tool)); if (protocolVersion === MODERN_MCP_VERSION && server.transport === "http") transport.setTools(tools); return tools; }
          cursor = string(result.nextCursor, "tools cursor", 4096);
          if (cursors.has(cursor)) throw new Error("MCP tools/list returned a repeated cursor");
          cursors.add(cursor);
        }
        throw new Error("MCP tools/list exceeded 16 pages");
      },
      async callTool(name, args, requestOptions = {}) {
        ensureTools(); string(name, "tool name", 128); object(args, "tool arguments");
        if (protocolVersion === MODERN_MCP_VERSION && server.transport === "http" && !knownTools.has(name)) { await connection.listTools(requestOptions); if (!knownTools.has(name)) throw new Error("Unknown or invalid MCP tool; refresh tools/list before calling"); }
        if (protocolVersion !== MODERN_MCP_VERSION && knownTools.get(name)?.execution?.taskSupport === "required") throw new Error("MCP tool requires task execution; use callToolTask");
        await ensureActive(requestOptions);
        const raw = object(await transport.request("tools/call", { name, arguments: args }, requestOptions), "tools/call result");
        return protocolVersion === MODERN_MCP_VERSION && raw.resultType === "task" ? { task: parseModernTaskHandle(raw) } : parseToolResult(raw);
      },
      async callToolTask(name, args, requestOptions = {}) {
        requestOptions = { ...requestOptions };
        ensureTasks(); ensureTools(); string(name, "tool name", 128); object(args, "tool arguments");
        if (protocolVersion === MODERN_MCP_VERSION) {
          if (requestOptions.ttl !== undefined) throw new Error("Modern MCP tasks use server-selected ttlMs; a client TTL preference is not supported");
          return connection.callTool(name, args, requestOptions);
        }
        if (!capabilities.tasks?.requests?.tools?.call) throw new Error("MCP server does not advertise task-augmented tools/call");
        if (requestOptions.ttl !== undefined) taskTtl(requestOptions.ttl);
        const tool = (await connection.listTools(requestOptions)).find((entry) => entry.name === name);
        if (!tool || !["optional", "required"].includes(tool.execution?.taskSupport ?? "forbidden")) throw new Error("MCP tool does not allow task execution");
        await ensureActive(requestOptions);
        const raw = object(await transport.request("tools/call", { name, arguments: args, task: requestOptions.ttl === undefined ? {} : { ttl: requestOptions.ttl } }, requestOptions), "task creation result");
        const task = parseTask(raw.task);
        if (task.status !== "working") throw new Error("MCP task must begin in working status");
        return { task };
      },
      async getTask(id, requestOptions = {}) {
        ensureTasks(); taskId(id); await ensureActive(requestOptions);
        const raw = await transport.request("tasks/get", { taskId: id }, requestOptions);
        const task = protocolVersion === MODERN_MCP_VERSION ? recordModernTask(parseModernTask(raw)) : parseTask(raw);
        if (task.taskId !== id) throw new Error("MCP task response id does not match request"); return task;
      },
      async listTasks(requestOptions = {}) {
        if (protocolVersion === MODERN_MCP_VERSION) throw new Error("Modern MCP tasks do not support tasks/list; retain returned task IDs");
        ensureTasks(); if (!capabilities.tasks?.list) throw new Error("MCP server does not advertise tasks/list");
        const cursor = requestOptions.cursor === undefined ? undefined : string(requestOptions.cursor, "tasks cursor", 4096);
        await ensureActive(requestOptions); return parseTaskList(await transport.request("tasks/list", cursor ? { cursor } : {}, requestOptions));
      },
      async getTaskResult(id, requestOptions = {}) {
        ensureTasks(); taskId(id); await ensureActive(requestOptions);
        if (protocolVersion === MODERN_MCP_VERSION) {
          const task = await connection.getTask(id, requestOptions);
          if (!("protocolVersion" in task)) throw new Error("Invalid modern MCP task state");
          if (task.status === "failed") throw new Error(`MCP task failed (${task.error.code}): ${task.error.message}`);
          if (task.status !== "completed") throw new Error(`MCP task is ${task.status}; inspect its status${task.status === "input_required" ? " and continue its input requests" : " before requesting the result"}`);
          return parseToolResult(task.result);
        }
        const raw = object(await transport.request("tasks/result", { taskId: id }, requestOptions), "tasks/result result");
        if (raw._meta !== undefined) {
          const related = object(raw._meta, "task result metadata")["io.modelcontextprotocol/related-task"];
          if (related !== undefined && taskId(object(related, "related task metadata").taskId) !== id) throw new Error("MCP task result metadata id does not match request");
        }
        return parseToolResult(raw);
      },
      async cancelTask(id, requestOptions = {}) {
        ensureTasks(); taskId(id); if (protocolVersion !== MODERN_MCP_VERSION && !capabilities.tasks?.cancel) throw new Error("MCP server does not advertise tasks/cancel");
        await ensureActive(requestOptions);
        const raw = await transport.request("tasks/cancel", { taskId: id }, requestOptions);
        if (protocolVersion === MODERN_MCP_VERSION) { object(raw, "task cancellation acknowledgment"); return { taskId: id, cancellationRequested: true }; }
        const task = parseTask(raw);
        if (task.taskId !== id || task.status !== "cancelled") throw new Error("MCP task cancellation returned inconsistent task state"); return task;
      },
      async updateTask(id, requestOptions = {}) {
        ensureTasks(); taskId(id);
        if (protocolVersion !== MODERN_MCP_VERSION) throw new Error("MCP tasks/update requires the modern tasks extension");
        if (taskUpdates.has(id)) throw new Error("MCP task input continuation is already in progress");
        taskUpdates.add(id);
        const controller = new AbortController(), abort = () => controller.abort(); requestOptions.signal?.addEventListener("abort", abort, { once: true });
        if (requestOptions.signal?.aborted) controller.abort();
        const milliseconds = timeout(requestOptions.timeoutMs ?? (server.transport === "stdio" ? server.process.timeoutMs : server.timeoutMs)); let timedOut = false;
        const deadline = Date.now() + milliseconds, timer = setTimeout(() => { timedOut = true; controller.abort(); }, milliseconds);
        const currentOptions = () => ({ ...requestOptions, signal: controller.signal, timeoutMs: Math.max(100, deadline - Date.now()) });
        try {
          const task = await connection.getTask(id, currentOptions());
          if (!("protocolVersion" in task) || task.status !== "input_required") throw new Error(`MCP task is ${task.status}; no client input is outstanding`);
          const seen = taskInputs.get(id)!; const responses: Array<[string, unknown]> = [];
          for (const [key, input] of Object.entries(task.inputRequests)) {
            if (seen.get(key)?.sent) continue;
            await ensureActive(currentOptions());
            const reply = await incomingReply(hostHandlers, input.method, input.params, controller.signal);
            if (controller.signal.aborted) throw cancelled();
            if (reply.error !== undefined) throw new Error("MCP task input is unavailable or was not authorized");
            await ensureActive(currentOptions()); responses.push([key, reply.result]);
          }
          const updatedInputKeys = responses.map(([key]) => key);
          if (responses.length) {
            await ensureActive(currentOptions());
            await transport.request("tasks/update", { taskId: id, inputResponses: Object.fromEntries(responses) }, { ...currentOptions(), beforeSend() { requestOptions.beforeSend?.(); for (const key of updatedInputKeys) seen.get(key)!.sent = true; } });
          }
          return { taskId: id, updatedInputKeys };
        } catch (error) { if (timedOut && !requestOptions.signal?.aborted) throw new Error(`MCP tasks/update timed out after ${milliseconds}ms`); throw error; }
        finally { clearTimeout(timer); requestOptions.signal?.removeEventListener("abort", abort); taskUpdates.delete(id); }
      },
      async subscribeTask(id, requestOptions = {}) {
        ensureTasks(); taskId(id); if (protocolVersion !== MODERN_MCP_VERSION) throw new Error("Task subscriptions require the modern MCP tasks extension");
        await ensureActive(requestOptions); if (taskSubscriptions.has(id)) return;
        if (modernSubscriptionBusy) throw new Error("MCP subscription operation is already in progress");
        if (taskSubscriptions.size >= 128) throw new Error("MCP task subscriptions exceed 128");
        modernSubscriptionBusy = true; taskSubscriptions.add(id);
        try { await refreshSubscriptions(requestOptions); } catch (error) { taskSubscriptions.delete(id); throw error; } finally { modernSubscriptionBusy = false; }
      },
      async unsubscribeTask(id, requestOptions = {}) {
        ensureTasks(); taskId(id); if (protocolVersion !== MODERN_MCP_VERSION) throw new Error("Task subscriptions require the modern MCP tasks extension");
        await ensureActive(requestOptions); if (!taskSubscriptions.has(id)) return;
        if (modernSubscriptionBusy) throw new Error("MCP subscription operation is already in progress");
        modernSubscriptionBusy = true; taskSubscriptions.delete(id);
        try { await refreshSubscriptions(requestOptions); } catch (error) { taskSubscriptions.add(id); throw error; } finally { modernSubscriptionBusy = false; }
      },
      async listResources(requestOptions = {}) {
        ensureCapability("resources");
        return paginated("resources/list", "resources", parseResource, (resource) => resource.uri, requestOptions);
      },
      async listResourceTemplates(requestOptions = {}) {
        ensureCapability("resources");
        return paginated("resources/templates/list", "resourceTemplates", parseResourceTemplate, (resource) => resource.uriTemplate, requestOptions);
      },
      async readResource(uri, requestOptions = {}) {
        ensureCapability("resources"); mcpUri(uri); await ensureActive(requestOptions);
        return parseResourceResult(await transport.request("resources/read", { uri }, requestOptions));
      },
      async subscribeResource(uri, requestOptions = {}) {
        ensureCapability("resources"); mcpUri(uri);
        if (capabilities.resources?.subscribe !== true) throw new Error("MCP server does not advertise resource subscriptions");
        await ensureActive(requestOptions);
        if (subscriptionOperations.has(uri) || protocolVersion === MODERN_MCP_VERSION && modernSubscriptionBusy) throw new Error("MCP resource subscription operation is already in progress");
        if (subscriptions.has(uri)) return;
        if (subscriptions.size >= 128) throw new Error("MCP resource subscriptions exceed 128");
        subscriptionOperations.add(uri); subscriptions.add(uri); modernSubscriptionBusy = true;
        try { if (protocolVersion === MODERN_MCP_VERSION) await refreshSubscriptions(requestOptions); else object(await transport.request("resources/subscribe", { uri }, requestOptions), "resources/subscribe result"); }
        catch (error) { subscriptions.delete(uri); throw error; }
        finally { subscriptionOperations.delete(uri); modernSubscriptionBusy = false; }
      },
      async unsubscribeResource(uri, requestOptions = {}) {
        ensureCapability("resources"); mcpUri(uri);
        if (capabilities.resources?.subscribe !== true) throw new Error("MCP server does not advertise resource subscriptions");
        await ensureActive(requestOptions);
        if (subscriptionOperations.has(uri) || protocolVersion === MODERN_MCP_VERSION && modernSubscriptionBusy) throw new Error("MCP resource subscription operation is already in progress");
        if (!subscriptions.has(uri)) return;
        subscriptionOperations.add(uri); modernSubscriptionBusy = true;
        try { if (protocolVersion === MODERN_MCP_VERSION) { subscriptions.delete(uri); await refreshSubscriptions(requestOptions); } else { object(await transport.request("resources/unsubscribe", { uri }, requestOptions), "resources/unsubscribe result"); subscriptions.delete(uri); } }
        catch (error) { if (protocolVersion === MODERN_MCP_VERSION) subscriptions.add(uri); throw error; }
        finally { subscriptionOperations.delete(uri); modernSubscriptionBusy = false; }
      },
      async listPrompts(requestOptions = {}) {
        ensureCapability("prompts");
        return paginated("prompts/list", "prompts", parsePrompt, (prompt) => prompt.name, requestOptions);
      },
      async getPrompt(name, args = {}, requestOptions = {}) {
        ensureCapability("prompts"); string(name, "prompt name", 128);
        const argumentsValue = stringArguments(args, "prompt arguments"); await ensureActive(requestOptions);
        return parsePromptResult(await transport.request("prompts/get", { name, arguments: argumentsValue }, requestOptions));
      },
      async complete(ref, argument, requestOptions = {}) {
        ensureCapability("completions");
        const reference = object(ref, "completion reference");
        if (reference.type !== "ref/prompt" && reference.type !== "ref/resource") throw new Error("MCP completion reference type must be ref/prompt or ref/resource");
        const target = reference.type === "ref/prompt" ? { type: reference.type, name: string(reference.name, "completion prompt name", 128) } : { type: reference.type, uri: mcpUri(reference.uri, "completion resource template URI") };
        const input = object(argument, "completion argument"); const name = string(input.name, "completion argument name", 128);
        if (typeof input.value !== "string" || input.value.length > 16_384 || input.value.includes("\0")) throw new Error("MCP completion argument value must be a bounded string");
        const context = requestOptions.context === undefined ? undefined : { arguments: stringArguments(object(requestOptions.context, "completion context").arguments, "completion context arguments") };
        await ensureActive(requestOptions);
        return parseCompletionResult(await transport.request("completion/complete", { ref: target, argument: { name, value: input.value }, ...(context ? { context } : {}) }, requestOptions));
      },
      close() { closed = true; listeners.clear(); resourceListeners.clear(); taskListeners.clear(); backgroundListeners.clear(); subscriptions.clear(); taskSubscriptions.clear(); taskInputs.clear(); for (const controller of incomingControllers) controller.abort(); return transport.close(); },
    };
    return connection;
  } catch (error) { await transport.close().catch(() => undefined); if (error instanceof McpAuthorizationRequiredError) throw error; throw protectedFailure(error, secrets); }
}
