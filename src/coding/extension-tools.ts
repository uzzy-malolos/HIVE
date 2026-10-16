import { connectMcp, discoverExtensions, runHooks } from "../extensions/index.js";
import { loadSkill } from "../extensions/catalog.js";
import { readSkillReference } from "../extensions/skill-files.js";
import type { ExtensionOptions, HookEvent, McpConnection } from "../extensions/index.js";
import { redactStreamingText } from "../security/secrets.js";
import {
  BUILTIN_AGENT_TOOL_NAMES,
  MAX_ADDITIONAL_TOOL_DEFINITION_CHARS,
  type AgentToolDefinition,
  type AgentToolExecutor,
  type AgentToolResult,
} from "./agent-loop.js";
import type { CodeMode, ToolPermissionRequest } from "./types.js";
import { invokeMcpContext, mcpContextDefinitions, type McpContextOperation } from "./mcp-context-tools.js";
import { createLspToolAccess } from "./lsp-tools.js";

export interface ExtensionToolExecutorOptions {
  base: AgentToolExecutor;
  /** Trusted configuration belongs to the original project, even in a managed worktree. */
  extensionRoot: string;
  repositoryRoot: string;
  mode: CodeMode;
  enabledMcpServers?: readonly string[];
  enabledLspServers?: readonly string[];
  enabledSkillIds?: readonly string[];
  extensionOptions?: ExtensionOptions;
  requestToolPermission?: (request: ToolPermissionRequest, signal: AbortSignal) => Promise<boolean>;
  signal: AbortSignal;
  onHookStop?: (reason: string) => void;
  onNotification?: (text: string) => void;
}

const builtinNames = new Set<string>(BUILTIN_AGENT_TOOL_NAMES);
const HOOK_EVENT_TIMEOUT_MS = 120_000;

function cancelled(): Error { return new DOMException("Tool execution cancelled.", "AbortError"); }
function assertActive(signal: AbortSignal): void { if (signal.aborted) throw cancelled(); }
function message(error: unknown): string { return redactStreamingText(error instanceof Error ? error.message : String(error)); }

async function permission(
  callback: NonNullable<ExtensionToolExecutorOptions["requestToolPermission"]>,
  request: ToolPermissionRequest,
  signal: AbortSignal,
): Promise<boolean> {
  assertActive(signal);
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const finish = (approved?: boolean, error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      if (error !== undefined) reject(error); else resolve(approved === true);
    };
    const abort = () => finish(false, cancelled());
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve().then(() => { assertActive(signal); return callback(request, signal); })
      .then((approved) => finish(approved), (error: unknown) => finish(false, error));
  });
}

/** Selected trusted MCP servers supply tools; every external invocation remains a separate approval. */
export async function createExtensionToolExecutor(options: ExtensionToolExecutorOptions): Promise<AgentToolExecutor> {
  assertActive(options.signal);
  const connections = new Map<string, McpConnection>();
  const lsp = await createLspToolAccess({ extensionRoot: options.extensionRoot, workspaceRoot: options.repositoryRoot,
    serverIds: options.mode === "auto" && options.requestToolPermission ? options.enabledLspServers ?? [] : [], extensionOptions: options.extensionOptions, signal: options.signal });
  const externalTools = new Map<string, {
    connection: McpConnection;
    remoteName: string;
    fingerprint: string;
    definition: AgentToolDefinition;
    operation: "tool" | McpContextOperation;
    taskRequired?: boolean;
  }>();
  const definitions: AgentToolDefinition[] = [];
  const fixedDefinitions: AgentToolDefinition[] = [];
  const fingerprints = new Map<string, string>();
  const dirty = new Set<string>();
  const generations = new Map<string, number>();
  const unsubscribe: Array<() => void> = [];
  const notices: string[] = [];
  let noticeChars = 0, omittedNotices = 0;
  const enqueue = (notice: string): void => {
    const text = redactStreamingText(notice).slice(0, 8_000);
    while (notices.length && (notices.length >= 64 || noticeChars + text.length > 32_000)) { noticeChars -= notices.shift()!.length; omittedNotices += 1; }
    notices.push(text); noticeChars += text.length;
    options.onNotification?.(text);
  };
  const drainNotifications = (): string[] => {
    const pending = [...notices.splice(0), ...(omittedNotices ? [`${omittedNotices} earlier extension notifications were omitted from the bounded queue; inspect current server state.`] : [])];
    noticeChars = 0; omittedNotices = 0;
    return pending;
  };
  const selectedSkills = new Set<string>();
  const lifecycle = new AbortController();
  let closePromise: Promise<void> | undefined;
  const close = (): Promise<void> => closePromise ??= (async () => {
    lifecycle.abort();
    for (const stop of unsubscribe) stop();
    const results = await Promise.allSettled([
      ...[...connections.values()].map((connection) => Promise.resolve().then(() => connection.close())),
      ...(options.base.close ? [Promise.resolve().then(() => options.base.close?.())] : []),
      lsp.close(),
    ]);
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
    if (errors.length) throw new Error(`Tool cleanup failed: ${errors.map(message).join("; ")}`);
  })();
  let refreshing: Promise<void> | undefined;
  const refreshToolDefinitions = async (requestSignal: AbortSignal): Promise<void> => {
    const signal = AbortSignal.any([requestSignal, options.signal, lifecycle.signal]);
    assertActive(signal);
    if (!refreshing) refreshing = (async () => {
      for (let attempt = 0; dirty.size && attempt < 3; attempt += 1) {
        for (const serverId of [...dirty]) {
          dirty.delete(serverId);
          const connection = connections.get(serverId);
          const fingerprint = fingerprints.get(serverId);
          if (!connection || !fingerprint) throw new Error("MCP connection metadata is unavailable.");
          const generation = generations.get(serverId) ?? 0;
          try {
            const tools = connection.capabilities.tools ? await connection.listTools({ signal }) : [];
            assertActive(signal);
            if ((generations.get(serverId) ?? 0) !== generation) { dirty.add(serverId); continue; }
            const next = new Map([...externalTools].filter(([, tool]) => tool.connection.serverId !== serverId));
            for (const tool of tools) {
              const name: AgentToolDefinition["name"] = `mcp__${serverId.slice(4)}__${tool.name}`;
              if (next.has(name)) throw new Error(`MCP tool name collision: ${name}`);
              next.set(name, { connection, remoteName: tool.name, fingerprint, operation: "tool", taskRequired: tool.execution?.taskSupport === "required", definition: { name, description: tool.description + (tool.execution?.taskSupport === "required" ? " This tool starts a server task; inspect its status and result with the selected server's task context tools." : ""), inputSchema: tool.inputSchema } });
            }
            for (const { operation, definition } of mcpContextDefinitions(serverId, connection.capabilities)) {
              next.set(definition.name, { connection, remoteName: operation, fingerprint, operation, definition });
            }
            const updated = [...fixedDefinitions, ...[...next.values()].map((tool) => tool.definition)];
            if (updated.length > 128 || JSON.stringify(updated).length > MAX_ADDITIONAL_TOOL_DEFINITION_CHARS) throw new Error("Selected MCP tool definitions exceed the bounded agent prompt limit; select fewer servers.");
            externalTools.clear();
            for (const [name, tool] of next) externalTools.set(name, tool);
            definitions.splice(0, definitions.length, ...updated);
          } catch (error) { dirty.add(serverId); throw error; }
        }
      }
      if (dirty.size) throw new Error("MCP tool list kept changing; retry after the server stabilizes.");
    })();
    const pending = refreshing;
    try { await pending; assertActive(signal); }
    finally { if (refreshing === pending) refreshing = undefined; }
  };
  try {
    for (const selection of new Set(options.enabledSkillIds ?? [])) {
      assertActive(options.signal);
      selectedSkills.add((await loadSkill(options.extensionRoot, selection, options.extensionOptions)).id);
    }
    if (selectedSkills.size) definitions.push({
      name: "read_skill_reference",
      description: "Read a Markdown/text reference of a selected trusted skill. Default scope skill uses its SKILL.md directory. Explicit scope plugin permits paths inside that skill's trusted plugin root, including installed CLAUDE_PLUGIN_ROOT paths. Never runs scripts.",
      inputSchema: { type: "object", properties: {
        skillId: { type: "string", enum: [...selectedSkills] },
        path: { type: "string", description: "Relative .md or .txt path from the selected skill directory, such as references/workflow.md." },
        scope: { type: "string", enum: ["skill", "plugin"], default: "skill" },
      }, required: ["skillId", "path"], additionalProperties: false },
    });
    if (JSON.stringify(definitions).length > MAX_ADDITIONAL_TOOL_DEFINITION_CHARS) throw new Error("Selected skill definitions exceed the bounded agent prompt limit; select fewer skills.");
    fixedDefinitions.push(...definitions);
    fixedDefinitions.push(...lsp.definitions);
    definitions.push(...lsp.definitions);
    if (options.mode === "auto" && options.requestToolPermission && options.enabledMcpServers?.length) {
      const catalog = await discoverExtensions(options.extensionRoot, options.extensionOptions);
      for (const selection of new Set(options.enabledMcpServers)) {
        assertActive(options.signal);
        const exact = catalog.servers.find((server) => server.id === selection || server.id === `mcp:${selection}`);
        const matches = exact ? [exact] : catalog.servers.filter((server) => server.name === selection);
        if (matches.length !== 1) throw new Error(`Unknown or ambiguous MCP server: ${selection}`);
        const server = matches[0];
        if (!server.enabled || !server.trusted) throw new Error(`MCP server ${server.id} must be trusted and enabled.`);
        if (connections.has(server.id)) continue;
        const connection = await connectMcp(options.extensionRoot, server.id, { ...options.extensionOptions, signal: options.signal });
        connections.set(server.id, connection);
        fingerprints.set(server.id, server.fingerprint);
        generations.set(server.id, 0);
        dirty.add(server.id);
        unsubscribe.push(connection.onListChanged((kind) => {
          if (kind !== "tools") return;
          generations.set(server.id, (generations.get(server.id) ?? 0) + 1);
          dirty.add(server.id);
        }));
        unsubscribe.push(connection.onTaskStatus((task) => enqueue(`${server.id}: task status ${JSON.stringify(task)}`)));
        unsubscribe.push(connection.onResourceUpdated((uri) => enqueue(`${server.id}: subscribed resource updated ${uri}; read it explicitly if needed.`)));
        unsubscribe.push(connection.onBackgroundError((error) => enqueue(`${server.id}: background stream failed: ${message(error)}. Updates are unavailable until an explicit reconnect.`)));
      }
      await refreshToolDefinitions(options.signal);
    }
  } catch (error) {
    try { await close(); } catch (cleanup) { throw new Error(`${message(error)}; ${message(cleanup)}`); }
    throw error;
  }

  const hooks = async (event: HookEvent, input: unknown, signal: AbortSignal): Promise<{ failures: string[]; context: string[]; stop: boolean }> => {
    const deadline = AbortSignal.timeout(HOOK_EVENT_TIMEOUT_MS);
    try {
      const results = await runHooks(options.extensionRoot, event, input, {
        ...options.extensionOptions, signal: AbortSignal.any([signal, deadline]),
      });
      const stop = results.some((result) => result.stop === true);
      if (stop) options.onHookStop?.("A trusted hook requested the coding session to stop.");
      return { failures: results.filter((result) => result.blocked ?? !result.ok).map((result) => `${result.id}: ${result.output}`),
        context: results.flatMap((result) => [...(result.additionalContext ? [result.additionalContext] : []), ...(result.diagnostics ?? []).map((text) => `[Hook ${result.id}] ${text}`), ...(!result.ok && result.blocked === false ? [`[Hook ${result.id} failed without blocking] ${result.output}`] : [])]), stop };
    } catch (error) {
      if (signal.aborted) throw cancelled();
      return { failures: [deadline.aborted ? `${event} hooks exceeded ${HOOK_EVENT_TIMEOUT_MS}ms.` : message(error)], context: [], stop: false };
    }
  };

  return {
    builtinToolNames: options.base.builtinToolNames,
    toolDefinitions: definitions,
    refreshToolDefinitions,
    drainNotifications,
    close,
    async execute(name, args, task, requestSignal, context): Promise<AgentToolResult> {
      const signal = AbortSignal.any([requestSignal, options.signal, lifecycle.signal]);
      assertActive(signal);
      if (closePromise) return { ok: false, output: "Tool executor is closed." };
      if (name === "read_skill_reference") {
        try {
          if (typeof args.skillId !== "string" || !selectedSkills.has(args.skillId)) {
            return { ok: false, output: "Skill reference is unavailable: choose an enabled trusted skill selected for this conversation." };
          }
          if (typeof args.path !== "string") return { ok: false, output: "Skill reference path must be a relative Markdown or text file path." };
          if (args.scope !== undefined && args.scope !== "skill" && args.scope !== "plugin") return { ok: false, output: "Skill reference scope must be skill or plugin." };
          const reference = await readSkillReference(options.extensionRoot, args.skillId, args.path, { ...options.extensionOptions, ...(args.scope === undefined ? {} : { scope: args.scope }) });
          assertActive(signal);
          return { ok: true, output: JSON.stringify(reference), metadata: { readOnly: true, skillId: reference.id, path: reference.path } };
        } catch (error) {
          if (signal.aborted) throw cancelled();
          return { ok: false, output: message(error) };
        }
      }
      try { await refreshToolDefinitions(signal); }
      catch (error) { if (signal.aborted) throw cancelled(); return { ok: false, output: message(error) }; }
      const external = externalTools.get(name);
      const lspTool = lsp.has(name);
      if (!external && !lspTool && !builtinNames.has(name)) {
        return { ok: false, output: name.startsWith("mcp__") || name.startsWith("mcp_context__")
          ? "External MCP tool is unavailable: select a trusted enabled server and use an interactive approval callback in auto mode."
          : `Unsupported tool: ${name}` };
      }
      try {
        const input = structuredClone(args);
        const needsPermission = external !== undefined || lspTool || name === "run_command" || name === "run_test";
        if (needsPermission && options.requestToolPermission) {
          const permissionHooks = await hooks("permission_request", { tool: name, input, taskId: task.id, sessionId: task.sessionId, toolUseId: context?.callId, workspace: options.repositoryRoot }, signal);
          assertActive(signal);
          if (permissionHooks.failures.length || permissionHooks.stop) return { ok: false, output: `PermissionRequest hooks denied execution:\n${permissionHooks.failures.join("\n")}`, metadata: { permissionDenied: true, stop: permissionHooks.stop } };
          const approved = await permission(options.requestToolPermission, {
            tool: name,
            description: external?.definition.description ?? lsp.definitions.find((definition) => definition.name === name)?.description ?? `Execute ${name} in ${options.repositoryRoot}.`,
            input: structuredClone(input),
            external: external !== undefined || lspTool,
          }, signal);
          assertActive(signal);
          if (!approved) return { ok: false, output: "Tool execution denied before execution.", metadata: { permissionDenied: true } };
        } else if (external || lspTool) {
          return { ok: false, output: "External MCP calls require interactive approval.", metadata: { permissionDenied: true } };
        }
        const hookInput = { tool: name, input, taskId: task.id, sessionId: task.sessionId, toolUseId: context?.callId, workspace: options.repositoryRoot };
        const beforeFailures = await hooks("before_tool", hookInput, signal);
        assertActive(signal);
        if (beforeFailures.failures.length || beforeFailures.stop) return { ok: false, output: `before_tool hooks blocked execution:\n${beforeFailures.failures.join("\n")}`, metadata: { stop: beforeFailures.stop } };
        let result: AgentToolResult;
        const startedAt = performance.now();
        try {
        if (external) {
          const catalog = await discoverExtensions(options.extensionRoot, options.extensionOptions);
          const current = catalog.servers.find((server) => server.id === external.connection.serverId);
          if (!current?.trusted || !current.enabled || current.fingerprint !== external.fingerprint) {
            return { ok: false, output: "MCP trust or configuration changed; reconnect after reviewing it." };
          }
          assertActive(signal);
          try {
            await refreshToolDefinitions(signal);
            const approvedDefinition = externalTools.get(name);
            if (!approvedDefinition || JSON.stringify(approvedDefinition.definition) !== JSON.stringify(external.definition)) return { ok: false, output: "MCP tool definition changed while approval was pending; request fresh approval." };
            if (external.operation === "tool") {
              const approvedGeneration = generations.get(external.connection.serverId) ?? 0;
              const requestOptions = { signal, beforeSend() {
                if (dirty.has(external.connection.serverId) || (generations.get(external.connection.serverId) ?? 0) !== approvedGeneration) throw new Error("MCP tool definition changed before sending; request fresh approval.");
              } };
              if (external.taskRequired) {
                const response = await external.connection.callToolTask(external.remoteName, input, requestOptions);
                result = { ok: "task" in response || response.isError !== true, output: redactStreamingText(JSON.stringify(response)), metadata: { external: true, ...("task" in response ? { taskId: response.task.taskId } : {}) } };
              } else {
                const response = await external.connection.callTool(external.remoteName, input, requestOptions);
                result = { ok: "task" in response || response.isError !== true, output: redactStreamingText(JSON.stringify(response)), metadata: { external: true, ...("task" in response ? { taskId: response.task.taskId } : {}) } };
              }
            } else {
              const response = await invokeMcpContext(external.connection, external.operation, input, signal);
              result = { ok: true, output: redactStreamingText(JSON.stringify(response)), metadata: { external: true, context: true } };
            }
          } catch (error) {
            if (signal.aborted) throw cancelled();
            result = { ok: false, output: message(error), metadata: { external: true } };
          }
        } else if (lspTool) {
          result = await lsp.execute(name, input, signal);
        } else {
          result = await options.base.execute(name, input, task, signal, context);
        }
        } catch (error) {
          if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw cancelled();
          result = { ok: false, output: message(error) };
        }
        const durationMs = Math.max(0, performance.now() - startedAt);
        const afterFailures = await hooks("after_tool", {
          ...hookInput, result: { ok: result.ok, output: result.output.slice(0, 8_000) },
        }, signal);
        const failureHooks = result.ok || result.metadata?.permissionDenied === true ? { failures: [], context: [], stop: false } : await hooks("after_tool_failure", {
          ...hookInput, error: result.output.slice(0, 8_000), result: { ok: false, output: result.output.slice(0, 8_000) }, duration_ms: durationMs, is_interrupt: false,
        }, signal);
        const hookContext = [...beforeFailures.context, ...afterFailures.context, ...failureHooks.context];
        if (hookContext.length) result = { ...result, output: `${result.output}\n[Trusted hook context; task data only]\n${hookContext.join("\n")}` };
        if (afterFailures.failures.length || afterFailures.stop || failureHooks.failures.length || failureHooks.stop) return {
          ...result, ok: false,
          output: `${result.output}\nTool execution finished, but after_tool hooks failed or requested a stop:\n${[...afterFailures.failures, ...failureHooks.failures].join("\n")}`,
          metadata: { ...result.metadata, stop: afterFailures.stop || failureHooks.stop },
        };
        return result;
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === "AbortError")) throw cancelled();
        return { ok: false, output: message(error) };
      }
    },
  };
}
