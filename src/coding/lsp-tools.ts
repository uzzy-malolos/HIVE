import { loadLspServer } from "../extensions/catalog.js";
import { connectLsp, type LspConnection } from "../extensions/lsp.js";
import { cancelled, object, publicText } from "../extensions/io.js";
import type { ExtensionOptions } from "../extensions/types.js";
import type { AgentToolDefinition, AgentToolResult } from "./agent-loop.js";

export interface LspToolAccessOptions { extensionRoot: string; workspaceRoot: string; serverIds: readonly string[]; extensionOptions?: ExtensionOptions; signal: AbortSignal }
export interface LspToolAccess { definitions: AgentToolDefinition[]; has(name: string): boolean; execute(name: string, args: Record<string, unknown>, signal: AbortSignal): Promise<AgentToolResult>; close(): Promise<void> }

/** Discovery is inert. The host must approve each call before invoking execute. */
export async function createLspToolAccess(options: LspToolAccessOptions): Promise<LspToolAccess> {
  if (options.signal.aborted) throw cancelled();
  const definitions: AgentToolDefinition[] = [];
  const lifecycle = new AbortController();
  const selected = new Map<string, { id: string; fingerprint: string; connection?: Promise<LspConnection> }>();
  const ids = [...new Set(options.serverIds)];
  if (ids.length > 16) throw new Error("Select at most 16 LSP servers per agent");
  for (const id of ids) {
    const server = await loadLspServer(options.extensionRoot, id, options.extensionOptions);
    const name: AgentToolDefinition["name"] = `lsp__${server.id.slice(4)}__query`;
    if (selected.has(name)) continue;
    selected.set(name, { id: server.id, fingerprint: server.fingerprint });
    definitions.push({ name, description: `Query selected LSP server ${server.id} for declared languages ${Object.values(server.extensionToLanguage).join(", ")}. Read-only code navigation; explicit host approval applies. Positions are zero-based UTF-16.`, inputSchema: { type: "object", properties: {
      operation: { type: "string", enum: ["diagnostics", "hover", "definition", "references", "document_symbols", "workspace_symbols"] },
      path: { type: "string", description: "Workspace-relative source file required for document operations." },
      line: { type: "integer", minimum: 0 }, character: { type: "integer", minimum: 0 }, query: { type: "string", maxLength: 1024 },
    }, required: ["operation"], additionalProperties: false } });
  }
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => closing ??= (async () => {
    lifecycle.abort();
    const results = await Promise.allSettled([...selected.values()].flatMap((entry) => entry.connection ? [entry.connection.then((connection) => connection.close())] : []));
    const failures = results.filter((entry): entry is PromiseRejectedResult => entry.status === "rejected");
    if (failures.length) throw new Error(`LSP cleanup failed: ${failures.map((entry) => publicText(entry.reason instanceof Error ? entry.reason.message : "unknown failure")).join("; ")}`);
  })();
  return { definitions, has: (name) => selected.has(name), close,
    async execute(name, args, requestSignal) {
      const signal = AbortSignal.any([options.signal, lifecycle.signal, requestSignal]);
      if (signal.aborted) throw cancelled();
      const selection = selected.get(name);
      if (!selection || closing) return { ok: false, output: "Selected LSP tool is unavailable or closed." };
      try {
        object(args, "LSP tool arguments");
        const operation = args.operation;
        if (!["diagnostics", "hover", "definition", "references", "document_symbols", "workspace_symbols"].includes(String(operation)) || Object.keys(args).some((key) => !["operation", "path", "line", "character", "query"].includes(key))) throw new Error("Invalid LSP query operation or arguments");
        if (operation !== "workspace_symbols" && (typeof args.path !== "string" || !args.path.trim())) throw new Error("LSP document query requires a source path");
        const at = { line: args.line as number, character: args.character as number };
        if (["hover", "definition", "references"].includes(String(operation)) && (!Number.isSafeInteger(at.line) || !Number.isSafeInteger(at.character) || at.line < 0 || at.character < 0)) throw new Error("LSP positions require zero-based line and character integers");
        const revalidate = async () => {
          if (options.signal.aborted || lifecycle.signal.aborted) throw cancelled();
          const current = await loadLspServer(options.extensionRoot, selection.id, options.extensionOptions);
          if (current.fingerprint !== selection.fingerprint) throw new Error("LSP configuration changed; select and trust it again");
          return current;
        };
        const server = await revalidate();
        if (!selection.connection) selection.connection = connectLsp(server, { workspaceRoot: options.workspaceRoot, signal: AbortSignal.any([options.signal, lifecycle.signal]), beforeSend: async () => { await revalidate(); } });
        const connection = await selection.connection;
        let result: unknown;
        if (operation === "workspace_symbols") result = await connection.workspaceSymbols(typeof args.query === "string" ? args.query : "", { signal });
        else {
          if (operation === "diagnostics") {
            let delivered = false;
            let wantedUri: string | undefined;
            let finish!: () => void;
            const received = new Promise<void>((resolve) => { finish = resolve; });
            const off = connection.onDiagnostics((event) => { if (event.uri === wantedUri) { delivered = true; finish(); } });
            const abort = () => finish();
            signal.addEventListener("abort", abort, { once: true });
            let timer: ReturnType<typeof setTimeout> | undefined;
            try {
              wantedUri = (await connection.syncDocument(args.path as string, { signal })).uri;
              const existing = await connection.diagnostics(args.path as string, { signal });
              if (!delivered && !existing.length) { timer = setTimeout(finish, 1000); await received; }
              if (signal.aborted) throw cancelled();
              result = { received: delivered || existing.length > 0, diagnostics: await connection.diagnostics(args.path as string, { signal }) };
            } finally { if (timer) clearTimeout(timer); off(); signal.removeEventListener("abort", abort); }
          } else {
            await connection.syncDocument(args.path as string, { signal });
            if (operation === "document_symbols") result = await connection.documentSymbols(args.path as string, { signal });
            else if (operation === "hover") result = await connection.hover(args.path as string, at, { signal });
            else if (operation === "definition") result = await connection.definition(args.path as string, at, { signal });
            else result = await connection.references(args.path as string, at, { signal });
          }
        }
        return { ok: true, output: JSON.stringify(result), metadata: { readOnly: true, lspServerId: server.id } };
      } catch (error) { if (signal.aborted) throw cancelled(); return { ok: false, output: publicText(error instanceof Error ? error.message : "LSP query failed") }; }
    },
  };
}
