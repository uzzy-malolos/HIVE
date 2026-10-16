import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { cancelled, explicitSecrets, inside, MAX_MESSAGE_BYTES, object, protectedText, startProcess, stopProcess } from "./io.js";
import type { LspServerDescriptor } from "./lsp-config.js";
export type { ParsedLspServer, LspServerDescriptor } from "./lsp-config.js";
export { parseLspServer } from "./lsp-config.js";

export interface LspPosition { line: number; character: number }
export interface LspDiagnostic { uri: string; version?: number; diagnostics: Array<Record<string, unknown>> }
export interface LspRequestOptions { signal?: AbortSignal; timeoutMs?: number }
export interface LspConnectOptions {
  workspaceRoot: string;
  signal?: AbortSignal;
  /** Reload and compare active trust before spawning, sending or delivering notifications. */
  beforeSend: () => Promise<void>;
  /** Optional stricter host file policy, applied before any document contents are read/sent. */
  canReadFile?: (absolutePath: string) => Promise<void>;
}
export interface LspConnection {
  serverId: string;
  capabilities: Record<string, unknown>;
  openDocument(file: string, options?: LspRequestOptions): Promise<{ uri: string; version: number; languageId: string }>;
  /** Refresh an opened document from its safely read on-disk contents. */
  syncDocument(file: string, options?: LspRequestOptions): Promise<{ uri: string; version: number }>;
  changeDocument(file: string, text: string, options?: LspRequestOptions): Promise<{ uri: string; version: number }>;
  closeDocument(file: string, options?: LspRequestOptions): Promise<void>;
  diagnostics(file?: string, options?: LspRequestOptions): Promise<LspDiagnostic[]>;
  onDiagnostics(listener: (event: LspDiagnostic) => void): () => void;
  hover(file: string, position: LspPosition, options?: LspRequestOptions): Promise<unknown>;
  definition(file: string, position: LspPosition, options?: LspRequestOptions): Promise<unknown>;
  references(file: string, position: LspPosition, options?: LspRequestOptions): Promise<unknown>;
  documentSymbols(file: string, options?: LspRequestOptions): Promise<unknown>;
  workspaceSymbols(query: string, options?: LspRequestOptions): Promise<unknown>;
  close(): Promise<void>;
}

const HEADER_LIMIT = 8192;
const SESSION_OUTPUT_LIMIT = 32 * 1024 * 1024;
const DOCUMENT_LIMIT = 1024 * 1024;
const MAX_OPEN_DOCUMENTS = 64;
const PRIVATE_PATH = /(?:^|[\\/])(?:\.git|\.hive|\.hivemind|\.env(?:\.[^\\/]*)?|\.npmrc|\.netrc|credentials(?:\.json)?|id_rsa|id_ed25519)(?:[\\/]|$)|\.(?:pem|p12|pfx|key)$/iu;

function position(value: LspPosition): LspPosition {
  if (!value || !Number.isSafeInteger(value.line) || !Number.isSafeInteger(value.character) || value.line < 0 || value.character < 0 || value.line > 10_000_000 || value.character > 10_000_000) throw new Error("LSP position requires bounded zero-based line and character integers");
  return { line: value.line, character: value.character };
}

/** Explicitly started, read-only LSP 3.17 stdio client. It never installs or discovers executables. */
export async function connectLsp(server: LspServerDescriptor, options: LspConnectOptions): Promise<LspConnection> {
  if (!server.trusted || !server.enabled) throw new Error(`LSP server ${server.id} must be trusted and enabled`);
  if (options.signal?.aborted) throw cancelled();
  const root = await fs.realpath(options.workspaceRoot);
  if (!(await fs.stat(root)).isDirectory()) throw new Error("LSP workspace must be a directory");
  const workspace = server.workspaceFolder === undefined ? root : await fs.realpath(path.resolve(root, server.workspaceFolder));
  if (!inside(root, workspace) || !(await fs.stat(workspace)).isDirectory()) throw new Error("LSP workspaceFolder must remain inside the selected workspace");
  const secrets = explicitSecrets(Object.values(server.process.envRefs));
  const safeMessage = (error: unknown) => protectedText(error instanceof Error ? error.message : typeof error === "string" ? error : "LSP request failed", secrets).slice(0, 4096);
  const guard = async (request?: LspRequestOptions) => {
    if (options.signal?.aborted || request?.signal?.aborted) throw cancelled();
    await options.beforeSend();
    if (options.signal?.aborted || request?.signal?.aborted) throw cancelled();
  };
  await guard();
  const child = startProcess(server.process);
  let closed = false;
  let closing: Promise<void> | undefined;
  let failure: Error | undefined;
  let sequence = 0;
  let bytes = 0;
  let stderrBytes = 0;
  let buffer = Buffer.alloc(0);
  let bodyLength: number | undefined;
  let incoming: Promise<void> = Promise.resolve();
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: unknown): void; finish(): void }>();
  const documents = new Map<string, { file: string; version: number; languageId: string; text: string }>();
  const diagnosticStore = new Map<string, LspDiagnostic>();
  const listeners = new Set<(value: LspDiagnostic) => void>();
  let capabilities: Record<string, unknown> = {};
  let mutationQueue: Promise<void> = Promise.resolve();
  let queuedMutations = 0;
  const mutateDocument = <T>(operation: () => Promise<T>): Promise<T> => {
    if (queuedMutations >= 64) return Promise.reject(new Error("LSP document mutation queue exceeds 64"));
    queuedMutations += 1;
    const result = mutationQueue.then(operation).finally(() => { queuedMutations -= 1; });
    mutationQueue = result.then(() => undefined, () => undefined);
    return result;
  };

  const fail = (error: unknown) => {
    failure ??= new Error(safeMessage(error));
    for (const request of pending.values()) { request.finish(); request.reject(failure); }
    pending.clear();
    if (!closing) void close().catch(() => { /* The triggering request carries the failure. */ });
  };
  const active = () => { if (failure) throw failure; if (closed || closing) throw new Error("LSP connection is closed"); };

  const sendRaw = async (value: Record<string, unknown>, duringClose = false, requestOptions?: LspRequestOptions): Promise<void> => {
    if (!duringClose) active();
    await guard(requestOptions);
    if (!duringClose) active();
    const body = Buffer.from(JSON.stringify(value));
    if (body.length > MAX_MESSAGE_BYTES) throw new Error("LSP outbound message exceeds 1 MiB");
    const frame = Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]);
    await new Promise<void>((resolve, reject) => child.stdin.write(frame, (error) => error ? reject(new Error(safeMessage(error))) : resolve()));
  };
  const notify = (method: string, params: unknown, duringClose = false, requestOptions?: LspRequestOptions) => sendRaw({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }, duringClose, requestOptions);
  const request = async (method: string, params: unknown, requestOptions: LspRequestOptions = {}, duringClose = false): Promise<unknown> => {
    await guard(requestOptions);
    if (!duringClose) active();
    if (pending.size >= 64) throw new Error("LSP request concurrency exceeds 64");
    const milliseconds = requestOptions.timeoutMs ?? server.requestTimeoutMs;
    if (!Number.isInteger(milliseconds) || milliseconds < 100 || milliseconds > 120_000) throw new Error("LSP request timeout must be from 100 through 120000ms");
    const id = ++sequence;
    return new Promise<unknown>((resolve, reject) => {
      const finish = () => { clearTimeout(timer); requestOptions.signal?.removeEventListener("abort", abort); };
      const rejectRequest = (error: unknown) => { const current = pending.get(id); if (!current) return; pending.delete(id); current.finish(); reject(error); void notify("$/cancelRequest", { id }, duringClose).catch(() => {}); };
      const abort = () => rejectRequest(cancelled());
      const timer = setTimeout(() => rejectRequest(new Error(`LSP ${method} timed out after ${milliseconds}ms`)), milliseconds);
      pending.set(id, { resolve, reject, finish });
      requestOptions.signal?.addEventListener("abort", abort, { once: true });
      if (requestOptions.signal?.aborted) { abort(); return; }
      void sendRaw({ jsonrpc: "2.0", id, method, params }, duringClose, requestOptions).catch((error: unknown) => { const current = pending.get(id); if (!current) return; pending.delete(id); current.finish(); reject(new Error(safeMessage(error))); });
    });
  };

  const safeResult = (value: unknown, depth = 0): unknown => {
    if (depth > 48) throw new Error("LSP result nesting exceeds the limit");
    if (typeof value === "string") return protectedText(value, secrets);
    if (Array.isArray(value)) return value.map((entry) => safeResult(entry, depth + 1));
    if (value && typeof value === "object") {
      const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
      for (const [key, entry] of Object.entries(value)) {
        if ((key === "uri" || key === "targetUri") && typeof entry === "string") {
          let file: string;
          try { file = fileURLToPath(entry); } catch { throw new Error("LSP result contains an unsupported non-file URI"); }
          if (!inside(workspace, path.resolve(file)) || PRIVATE_PATH.test(path.relative(workspace, file))) throw new Error("LSP result references a private or out-of-workspace document");
        }
        const safeKey = protectedText(key, secrets);
        if (Object.hasOwn(result, safeKey)) throw new Error("LSP result keys collide after redaction");
        result[safeKey] = safeResult(entry, depth + 1);
      }
      return result;
    }
    return value;
  };
  const handleMessage = async (raw: unknown) => {
    const value = object(raw, "LSP message");
    if (value.jsonrpc !== "2.0") throw new Error("Invalid LSP JSON-RPC version");
    if (value.method !== undefined) {
      if (typeof value.method !== "string") throw new Error("Invalid LSP method");
      if (value.id !== undefined) {
        if ((typeof value.id !== "string" && typeof value.id !== "number") || (typeof value.id === "string" && value.id.length > 256) || (typeof value.id === "number" && !Number.isSafeInteger(value.id))) throw new Error("Invalid LSP server request id");
        await guard();
        if (value.method === "workspace/workspaceFolders") await sendRaw({ jsonrpc: "2.0", id: value.id, result: [{ uri: pathToFileURL(workspace).href, name: path.basename(workspace) }] });
        // No server-initiated file reads, edits, commands, installations or dialogs.
        else await sendRaw({ jsonrpc: "2.0", id: value.id, error: { code: -32601, message: "HIVE does not support this server-initiated request" } });
      } else if (value.method === "textDocument/publishDiagnostics" && server.diagnostics) {
        await guard();
        const params = object(value.params, "LSP diagnostics");
        if (typeof params.uri !== "string" || !documents.has(params.uri)) return;
        const document = documents.get(params.uri)!;
        if (params.version !== undefined && (typeof params.version !== "number" || !Number.isInteger(params.version))) throw new Error("Invalid LSP diagnostics version");
        if (typeof params.version === "number" && params.version < document.version) return;
        if (!Array.isArray(params.diagnostics) || params.diagnostics.length > 1000) throw new Error("LSP diagnostics exceed 1000 entries");
        const event = safeResult({ uri: params.uri, ...(params.version === undefined ? {} : { version: params.version }), diagnostics: params.diagnostics.map((entry) => object(entry, "LSP diagnostic")) }) as LspDiagnostic;
        diagnosticStore.set(params.uri, event);
        for (const listener of listeners) { await guard(); try { listener(structuredClone(event)); } catch { /* Observers cannot break the transport. */ } }
      }
      return;
    }
    if (typeof value.id !== "number" || !Number.isSafeInteger(value.id)) throw new Error("LSP response requires a numeric request id");
    const handler = pending.get(value.id);
    if (!handler) return;
    pending.delete(value.id); handler.finish();
    try {
      await guard();
      if (value.error !== undefined) handler.reject(new Error(`LSP server error: ${safeMessage(object(value.error, "LSP error").message)}`));
      else if (!Object.hasOwn(value, "result")) handler.reject(new Error("LSP response has no result"));
      else handler.resolve(safeResult(value.result));
    } catch (error) { handler.reject(error); throw error; }
  };
  const consume = (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > SESSION_OUTPUT_LIMIT) { fail(new Error("LSP session output exceeded 32 MiB")); return; }
    buffer = Buffer.concat([buffer, chunk]);
    try {
      while (buffer.length) {
        if (bodyLength === undefined) {
          const separator = buffer.indexOf("\r\n\r\n");
          if (separator < 0) { if (buffer.length > HEADER_LIMIT) throw new Error("LSP header exceeds 8192 bytes"); return; }
          if (separator > HEADER_LIMIT) throw new Error("LSP header exceeds 8192 bytes");
          const headers = buffer.subarray(0, separator).toString("ascii").split("\r\n");
          const lengths = headers.filter((header) => /^Content-Length:/iu.test(header));
          if (lengths.length !== 1 || !/^Content-Length:[ \t]*[1-9][0-9]*[ \t]*$/iu.test(lengths[0])) throw new Error("LSP requires one valid Content-Length header");
          for (const header of headers) if (!/^(?:Content-Length:[ \t]*[0-9]+[ \t]*|Content-Type:[ \t]*application\/vscode-jsonrpc(?:;[ \t]*charset=utf-?8)?[ \t]*)$/iu.test(header)) throw new Error("Unsupported LSP message header");
          bodyLength = Number(lengths[0].split(":")[1].trim());
          if (!Number.isSafeInteger(bodyLength) || bodyLength > MAX_MESSAGE_BYTES) throw new Error("LSP message exceeds 1 MiB");
          buffer = buffer.subarray(separator + 4);
        }
        if (buffer.length < bodyLength) return;
        const message: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bodyLength)));
        buffer = buffer.subarray(bodyLength); bodyLength = undefined;
        // Serialized notification delivery keeps trust checks ordered with subsequent responses.
        incoming = incoming.then(() => { if (closed) return; return handleMessage(message); }).catch(fail);
      }
    } catch (error) { fail(error); }
  };
  child.stdout.on("data", consume);
  child.stderr.on("data", (chunk: Buffer) => { stderrBytes += chunk.length; if (stderrBytes > MAX_MESSAGE_BYTES) fail(new Error("LSP stderr exceeded 1 MiB")); });
  child.on("error", fail);
  child.stdin.on("error", fail);
  child.on("exit", () => { if (!closing) fail(new Error("LSP process exited before shutdown")); });
  const abortAll = () => fail(cancelled());
  options.signal?.addEventListener("abort", abortAll, { once: true });
  const lifetime = setTimeout(() => fail(new Error("LSP session reached its 30-minute lifetime limit; reconnect explicitly")), 30 * 60_000);
  lifetime.unref();

  async function close(): Promise<void> {
    if (closing) return closing;
    closing = (async () => {
      clearTimeout(lifetime);
      options.signal?.removeEventListener("abort", abortAll);
      if (!failure && child.exitCode === null && child.signalCode === null) {
        try { await request("shutdown", null, { timeoutMs: server.shutdownTimeoutMs }, true); await notify("exit", undefined, true); } catch { /* Always terminate owned process after the graceful deadline. */ }
      }
      closed = true;
      for (const handler of pending.values()) { handler.finish(); handler.reject(failure ?? new Error("LSP connection closed")); }
      pending.clear(); listeners.clear(); documents.clear(); diagnosticStore.clear();
      await stopProcess(child);
    })();
    return closing;
  }

  const fileInfo = async (file: string, requestOptions: LspRequestOptions = {}) => {
    await guard(requestOptions); active();
    const resolved = await fs.realpath(path.resolve(workspace, file));
    if (!inside(workspace, resolved) || PRIVATE_PATH.test(path.relative(workspace, resolved))) throw new Error("LSP documents must be non-private files inside the selected workspace");
    const stat = await fs.lstat(resolved);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > DOCUMENT_LIMIT) throw new Error("LSP document must be a plain single-link file up to 1 MiB");
    await options.canReadFile?.(resolved);
    const mapping = Object.entries(server.extensionToLanguage).sort(([left], [right]) => right.length - left.length).find(([extension]) => resolved.toLowerCase().endsWith(extension.toLowerCase()));
    if (!mapping) throw new Error("The selected LSP server does not declare this document extension");
    return { file: resolved, uri: pathToFileURL(resolved).href, languageId: mapping[1], stamp: [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode, stat.nlink].join(":") };
  };
  const readDocumentText = async (info: Awaited<ReturnType<typeof fileInfo>>, requestOptions: LspRequestOptions): Promise<string> => {
    const handle = await fs.open(info.file, "r");
    try {
      const opened = await handle.stat();
      const stamp = (stat: typeof opened) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode, stat.nlink].join(":");
      if (!opened.isFile() || stamp(opened) !== info.stamp) throw new Error("LSP document changed while opening it; retry");
      const bytes = Buffer.alloc(DOCUMENT_LIMIT + 1);
      const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
      if (bytesRead > DOCUMENT_LIMIT) throw new Error("LSP document exceeds 1 MiB");
      const after = await fileInfo(info.file, requestOptions);
      if (after.file !== info.file || after.stamp !== info.stamp || stamp(await handle.stat()) !== info.stamp) throw new Error("LSP document changed while reading it; retry");
      const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead));
      if (text.includes("\0")) throw new Error("LSP document contains NUL");
      return text;
    } finally { await handle.close(); }
  };
  const openDocumentInternal = async (file: string, requestOptions: LspRequestOptions = {}) => {
    const info = await fileInfo(file, requestOptions);
    const previous = documents.get(info.uri);
    if (previous) return { uri: info.uri, version: previous.version, languageId: previous.languageId };
    if (documents.size >= MAX_OPEN_DOCUMENTS) throw new Error("LSP open document limit is 64");
    const text = await readDocumentText(info, requestOptions);
    documents.set(info.uri, { file: info.file, version: 1, languageId: info.languageId, text });
    try { await notify("textDocument/didOpen", { textDocument: { uri: info.uri, languageId: info.languageId, version: 1, text } }, false, requestOptions); }
    catch (error) { documents.delete(info.uri); throw error; }
    return { uri: info.uri, version: 1, languageId: info.languageId };
  };
  const openDocument = (file: string, requestOptions: LspRequestOptions = {}) => mutateDocument(() => openDocumentInternal(file, requestOptions));
  const changeDocumentInternal = async (file: string, text: string, requestOptions: LspRequestOptions) => {
    if (typeof text !== "string" || Buffer.byteLength(text) > DOCUMENT_LIMIT || text.includes("\0")) throw new Error("LSP changed document must be UTF-8 text up to 1 MiB without NUL");
    const info = await openDocumentInternal(file, requestOptions);
    await fileInfo(file, requestOptions);
    const document = documents.get(info.uri)!;
    const sync = capabilities.textDocumentSync;
    const kind = typeof sync === "number" ? sync : sync && typeof sync === "object" ? (sync as Record<string, unknown>).change : 0;
    if (kind !== 1 && kind !== 2) throw new Error("LSP server does not advertise document change synchronization");
    const oldLines = document.text.split(/\r\n|\r|\n/u);
    const contentChanges = kind === 1 ? [{ text }] : [{ range: { start: { line: 0, character: 0 }, end: { line: oldLines.length - 1, character: oldLines.at(-1)!.length } }, text }];
    const version = document.version + 1;
    const previousDiagnostics = diagnosticStore.get(info.uri);
    documents.set(info.uri, { ...document, version, text }); diagnosticStore.delete(info.uri);
    try { await notify("textDocument/didChange", { textDocument: { uri: info.uri, version }, contentChanges }, false, requestOptions); }
    catch (error) {
      if (!closed && documents.get(info.uri)?.version === version) {
        documents.set(info.uri, document); diagnosticStore.delete(info.uri);
        if (previousDiagnostics) diagnosticStore.set(info.uri, previousDiagnostics);
      }
      throw error;
    }
    return { uri: info.uri, version };
  };
  const query = async (method: string, capability: string, file: string, at: LspPosition | undefined, requestOptions: LspRequestOptions = {}, extra: Record<string, unknown> = {}) => {
    const validatedPosition = at === undefined ? undefined : position(at);
    if (!capabilities[capability]) throw new Error(`LSP server does not advertise ${capability}`);
    const opened = await openDocument(file, requestOptions);
    return request(method, { textDocument: { uri: opened.uri }, ...(validatedPosition === undefined ? {} : { position: validatedPosition }), ...extra }, requestOptions);
  };
  try {
    const result = object(await request("initialize", { processId: process.pid, clientInfo: { name: "HIVE", version: "0.6.0" }, rootUri: pathToFileURL(workspace).href, workspaceFolders: [{ uri: pathToFileURL(workspace).href, name: path.basename(workspace) }], capabilities: { workspace: { applyEdit: false, configuration: false, workspaceFolders: true }, textDocument: { synchronization: { dynamicRegistration: false, didSave: false }, publishDiagnostics: { versionSupport: true }, hover: { contentFormat: ["plaintext", "markdown"] }, definition: { linkSupport: true }, references: {}, documentSymbol: { hierarchicalDocumentSymbolSupport: true } }, general: { positionEncodings: ["utf-16"] } }, ...(server.initializationOptions === undefined ? {} : { initializationOptions: server.initializationOptions }) }, { timeoutMs: server.startupTimeoutMs }), "LSP initialize result");
    capabilities = object(result.capabilities, "LSP server capabilities");
    if (capabilities.positionEncoding !== undefined && capabilities.positionEncoding !== "utf-16") throw new Error("HIVE LSP requires UTF-16 positions");
    await notify("initialized", {});
    if (server.settings !== undefined) await notify("workspace/didChangeConfiguration", { settings: server.settings });
  } catch (error) { failure ??= new Error(safeMessage(error)); await close(); throw failure; }

  return {
    serverId: server.id, capabilities,
    openDocument,
    changeDocument: (file, text, requestOptions = {}) => mutateDocument(() => changeDocumentInternal(file, text, requestOptions)),
    syncDocument: (file, requestOptions = {}) => mutateDocument(async () => {
      const info = await fileInfo(file, requestOptions);
      const opened = await openDocumentInternal(file, requestOptions);
      const text = await readDocumentText(await fileInfo(info.file, requestOptions), requestOptions);
      return text === documents.get(opened.uri)!.text ? { uri: opened.uri, version: opened.version } : changeDocumentInternal(info.file, text, requestOptions);
    }),
    async closeDocument(file, requestOptions = {}) { return mutateDocument(async () => { const info = await fileInfo(file, requestOptions); if (!documents.has(info.uri)) return; await notify("textDocument/didClose", { textDocument: { uri: info.uri } }, false, requestOptions); documents.delete(info.uri); diagnosticStore.delete(info.uri); }); },
    async diagnostics(file, requestOptions = {}) { await guard(requestOptions); active(); const info = file === undefined ? undefined : await fileInfo(file, requestOptions); return [...diagnosticStore.values()].filter((event) => info === undefined || event.uri === info.uri).map((event) => structuredClone(event)); },
    onDiagnostics(listener) { active(); if (listeners.size >= 32) throw new Error("LSP diagnostics listener limit is 32"); listeners.add(listener); return () => { listeners.delete(listener); }; },
    hover: (file, at, requestOptions) => query("textDocument/hover", "hoverProvider", file, at, requestOptions),
    definition: (file, at, requestOptions) => query("textDocument/definition", "definitionProvider", file, at, requestOptions),
    references: (file, at, requestOptions) => query("textDocument/references", "referencesProvider", file, at, requestOptions, { context: { includeDeclaration: true } }),
    documentSymbols: (file, requestOptions) => query("textDocument/documentSymbol", "documentSymbolProvider", file, undefined, requestOptions),
    async workspaceSymbols(queryText, requestOptions) { if (!capabilities.workspaceSymbolProvider) throw new Error("LSP server does not advertise workspaceSymbolProvider"); if (typeof queryText !== "string" || queryText.length > 1024 || /[\u0000-\u001f\u007f]/u.test(queryText)) throw new Error("LSP symbol query must be bounded text"); return request("workspace/symbol", { query: queryText }, requestOptions); },
    close,
  };
}
