import { discoverExtensions, installLocalPlugin, loadSkill, loadTrustedPluginOutputStyle, setExtensionState, uninstallLocalPlugin } from "./catalog.js";
import { cancelled, object, publicText } from "./io.js";
import { invokeMcpContext, type McpContextOperation } from "./mcp-operations.js";
import { connectMcp } from "./mcp.js";
import type { ExtensionOptions, ExtensionState, RequestOptions } from "./types.js";
import { beginMcpOAuthLogin, getMcpOAuthStatus, logoutMcpOAuth } from "./oauth.js";
import { marketplaceCommand, installMarketplacePlugin } from "./marketplace.js";
import { lspCommand, pluginComponentCommand } from "./plugin-commands.js";

export interface ExtensionCommandOptions extends ExtensionOptions, RequestOptions {
  onProgress?: (line: string) => void;
}

export type ExtensionCommandKind = "mcp" | "skills" | "plugins" | "hooks" | "lsp";
const prefixes: Record<ExtensionCommandKind, string> = { mcp: "mcp:", skills: "skill:", plugins: "plugin:", hooks: "hook:", lsp: "lsp:" };
const status = (entry: ExtensionState) => `${entry.id}  ${entry.trusted ? "trusted" : "untrusted"}  ${entry.enabled ? "enabled" : "disabled"}${entry.blockedReason ? `  blocked: ${publicText(entry.blockedReason)}` : ""}`;

/** Used by slash commands and CLI subcommands; network/process operations are explicit verbs. */
export async function extensionCommand(cwd: string, kind: ExtensionCommandKind, args: string, options: ExtensionCommandOptions = {}): Promise<string[]> {
  if (options.signal?.aborted) throw cancelled();
  if (kind === "lsp") return lspCommand(cwd, args, options);
  if (kind === "plugins" && /^(?:agents|agent)(?:\s|$)/u.test(args)) return pluginComponentCommand(cwd, args, options);
  if (kind === "plugins" && /^(?:styles|style|trust-style|untrust-style|enable-style|disable-style)(?:\s|$)/u.test(args)) {
    const [action, id, ...extra] = args.trim().split(/\s+/u);
    if (extra.length || action !== "styles" && !id) throw new Error("Use plugins styles | style ID | trust-style ID | enable-style ID | disable-style ID | untrust-style ID");
    if (action === "styles") {
      if (id) throw new Error("plugins styles does not accept arguments");
      return (await discoverExtensions(cwd, options)).outputStyles.map((style) => `${status(style)}  ${publicText(style.name)}`);
    }
    const styleId = id.startsWith("style:") ? id : `style:${id}`;
    if (action === "style") { const style = await loadTrustedPluginOutputStyle(cwd, styleId, options); return [style.id, ...style.warnings, publicText(style.instructions)]; }
    const verb = action === "trust-style" ? "trust" : action === "untrust-style" ? "untrust" : action === "enable-style" ? "enable" : "disable";
    await setExtensionState(cwd, styleId, verb, options); return [`${styleId}: ${verb} recorded`];
  }
  const match = /^\s*(\S+)?(?:\s+(\S+))?(?:\s+([\s\S]*))?$/u.exec(args);
  const action = match?.[1] ?? "list"; const target = match?.[2]; const remainder = match?.[3] ?? "";
  if (action === "help") return [
    `/${kind} list | validate | trust <id> | untrust <id> | enable <id> | disable <id>`,
    ...(kind === "mcp" ? ["/mcp doctor <id> | tools <id> | call <id> <tool> <JSON arguments>",
      "/mcp resources <id> | resource-templates <id> | read <id> <URI>",
      "/mcp prompts <id> | prompt <id> <name> <JSON string arguments>",
      "/mcp complete <id> <JSON reference, argument and optional arguments>",
      "/mcp watch <id> | subscribe <id> <URI> (stream until cancelled)",
      "/mcp task-call <id> <tool> <JSON arguments> | tasks <id> [cursor]",
      "/mcp task <id> <task-id> | task-result <id> <task-id> | task-cancel <id> <task-id>",
      "/mcp task-continue <id> <task-id> | task-subscribe <id> <task-id> (modern task input/notifications)",
      "Add --share-root immediately after <id> to explicitly share only this project root for the connection.",
      "/mcp login <id> | auth-status <id> | logout <id>"] : []),
    ...(kind === "skills" ? ["/skills show <id> (loads a trusted skill)"] : []),
    ...(kind === "plugins" ? ["/plugins marketplace add <source> | list [name] | update <name> | remove <name>", "/plugins install <plugin@marketplace> | update <plugin@marketplace>", "/plugins install <name> <workspace-directory> | uninstall <name> (source files are preserved)", "/plugins agents [plugin] | agent <id> | run-agent <id> <objective>", "/plugins styles | style <id> | trust-style <id> | enable-style <id>", "/plugins use-style <id> | off (TUI; final-response style)"] : []),
    "Configuration: .hive/extensions.json; trust is stored outside the repository for this workspace.",
  ];
  if (kind === "plugins" && action === "marketplace") return marketplaceCommand(cwd, [target, remainder].filter(Boolean).join(" "), options);
  if (kind === "plugins" && (action === "install" || action === "update") && target?.includes("@")) {
    if (remainder.trim()) throw new Error("Marketplace installation accepts exactly one plugin@marketplace selector.");
    options.onProgress?.(`Fetching and validating ${publicText(target)}. Downloaded code will remain disabled and untrusted.`);
    const result = await installMarketplacePlugin(cwd, target, { ...options, replace: action === "update" });
    return [`${result.plugin.id}: ${action === "update" ? "updated" : "installed"} disabled and untrusted. Inspect it before explicitly trusting and enabling it.`, ...result.warnings.map(publicText)];
  }
  if (kind === "mcp" && ["login", "auth-status", "logout"].includes(action)) {
    if (!target || remainder.trim()) throw new Error(`/mcp ${action} requires exactly one server id.`);
    if (action === "logout") { await logoutMcpOAuth(cwd, target, options); return [`${target}: local OAuth credentials removed; pending login grants invalidated.`]; }
    if (action === "auth-status") return [JSON.stringify(await getMcpOAuthStatus(cwd, target, options), null, 2)];
    if (!options.onProgress) throw new Error("OAuth login needs a progress output callback to show the authorization URL. Run hive mcp login <id> or use the interactive terminal.");
    const flow = await beginMcpOAuthLogin(cwd, target, options);
    try {
      options.onProgress(`Open this URL in your browser to authorize ${publicText(target)}:\n${flow.authorizationUrl}`);
      const result = await flow.completion;
      return [`${result.serverId}: OAuth authorization saved in encrypted local storage.`];
    } finally { await flow.cancel(); }
  }
  if (kind === "plugins" && action === "install") {
    if (!target || !remainder.trim()) throw new Error("/plugins install requires a name and an existing workspace directory");
    const directory = remainder.trim().replace(/^(["'])([\s\S]*)\1$/u, "$2");
    const plugin = await installLocalPlugin(cwd, target, directory, options);
    return [`${plugin.id}: registered disabled and untrusted. Inspect the bundle, then explicitly trust and enable it. No code was copied, downloaded, or executed.`];
  }
  if (kind === "plugins" && action === "uninstall") {
    if (!target || remainder.trim()) throw new Error("/plugins uninstall requires exactly one plugin name");
    const name = target.startsWith("plugin:") ? target.slice("plugin:".length) : target;
    await uninstallLocalPlugin(cwd, name, options);
    return [`plugin:${name}: unregistered and trust revoked. Plugin source files were preserved.`];
  }
  const catalog = await discoverExtensions(cwd, options);
  if (action === "validate") return catalog.diagnostics.length ? catalog.diagnostics.map((line) => `Invalid: ${publicText(line)}`) : ["Extension configuration is valid. Validation did not execute or contact extensions."];
  const entries = kind === "mcp" ? catalog.servers : kind === "skills" ? catalog.skills : kind === "hooks" ? catalog.hooks : catalog.plugins;
  if (action === "list") return [...catalog.diagnostics.map((line) => `Warning: ${publicText(line)}`), ...(entries.length ? entries.map((entry) => `${status(entry)}${"event" in entry ? `  ${entry.event}` : ""}`) : [`No ${kind} configured.`])];
  if (!target) throw new Error(`/${kind} ${action} requires an extension id; use /${kind} help`);
  const id = target.startsWith(prefixes[kind]) ? target : `${prefixes[kind]}${target}`;
  if (!entries.some((entry) => entry.id === id)) throw new Error(`Unknown ${kind} extension: ${target}`);
  if (action === "trust" || action === "untrust" || action === "enable" || action === "disable") {
    await setExtensionState(cwd, id, action, options);
    return [`${id}: ${action} recorded for this workspace. Changed configuration or skill content requires fresh trust.`];
  }
  if (kind === "skills" && action === "show") { const skill = await loadSkill(cwd, id, options); return [`${skill.id} (${skill.path})`, publicText(skill.text)]; }
  if (kind === "mcp" && ["doctor", "tools", "call", "resources", "resource-templates", "read", "prompts", "prompt", "complete", "watch", "subscribe", "task-call", "tasks", "task", "task-result", "task-cancel", "task-continue", "task-subscribe"].includes(action)) {
    const roots = /^--share-root(?:\s|$)/u.test(remainder);
    const argumentsText = roots ? remainder.replace(/^--share-root(?:\s+|$)/u, "").trim() : remainder.trim();
    if (["doctor", "tools", "resources", "resource-templates", "prompts"].includes(action) && argumentsText) throw new Error(`/mcp ${action} does not accept arguments after the server id and optional --share-root`);
    const connection = await connectMcp(cwd, id, { ...options, roots });
    try {
      if (action === "watch" || action === "subscribe" || action === "task-subscribe") {
        if (!options.signal || !options.onProgress) throw new Error("MCP background streaming requires a cancellable session with progress output");
        if (action === "watch" && argumentsText) throw new Error("/mcp watch accepts only a server id");
        if (action === "subscribe" && !argumentsText) throw new Error("/mcp subscribe requires a resource URI");
        if (action === "task-subscribe" && (!argumentsText || /\s/u.test(argumentsText))) throw new Error("/mcp task-subscribe requires one task id");
        let streamFailure: Error | undefined;
        let rejectStream: (error: Error) => void = () => {};
        const failed = new Promise<never>((_resolve, reject) => { rejectStream = reject; });
        const stops = [connection.onBackgroundError((error) => { streamFailure = error; rejectStream(error); }),
          connection.onListChanged((list) => options.onProgress?.(`${id}: ${list} list changed`)),
          connection.onResourceUpdated((uri) => options.onProgress?.(`${id}: resource updated ${publicText(uri)}`)),
          connection.onTaskStatus((task) => options.onProgress?.(`${id}: task ${publicText(task.taskId)} ${task.status}`))];
        // Attach before initialization so an immediate background error is always observed.
        void failed.catch(() => {});
        try {
          if (action === "subscribe") await connection.subscribeResource(argumentsText, options);
          if (action === "task-subscribe") await connection.subscribeTask(argumentsText, options);
          await connection.startBackground(options);
          options.onProgress(`${id}: ${action === "watch" ? "watching" : "subscribed and watching"}; Esc or Ctrl+C cancels.`);
          let abort: (() => void) | undefined;
          const cancelledWait = new Promise<never>((_resolve, reject) => { abort = () => reject(cancelled()); options.signal?.addEventListener("abort", abort, { once: true }); if (options.signal?.aborted) abort(); });
          try { if (streamFailure) throw streamFailure; await Promise.race([failed, cancelledWait]); }
          finally { if (abort) options.signal.removeEventListener("abort", abort); }
        } finally { for (const stop of stops) stop(); }
      }
      if (action === "tasks") return [publicText(JSON.stringify(await connection.listTasks({ ...options, ...(argumentsText ? { cursor: argumentsText } : {}) }), null, 2))];
      if (action === "task" || action === "task-result" || action === "task-cancel" || action === "task-continue") {
        if (!argumentsText || /\s/u.test(argumentsText)) throw new Error(`/mcp ${action} requires one task id`);
        const result = action === "task" ? await connection.getTask(argumentsText, options) : action === "task-result" ? await connection.getTaskResult(argumentsText, options) : action === "task-continue" ? await connection.updateTask(argumentsText, options) : await connection.cancelTask(argumentsText, options);
        return [publicText(JSON.stringify(result, null, 2))];
      }
      if (action === "doctor") { const tools = connection.capabilities.tools ? await connection.listTools(options) : []; return [`${id}: connected (${connection.protocolVersion}); ${tools.length} tool(s).`, `Capabilities: ${JSON.stringify(connection.capabilities)}. Project root sharing: ${roots ? "enabled for this connection" : "off"}.`]; }
      if (action === "tools") { const tools = await connection.listTools(options); return tools.length ? tools.map((tool) => `${tool.name}: ${publicText(tool.description)}`) : ["Server exposes no tools."]; }
      const contextActions: Partial<Record<string, McpContextOperation>> = { resources: "list_resources", "resource-templates": "list_resource_templates", read: "read_resource", prompts: "list_prompts", prompt: "get_prompt", complete: "complete" };
      const operation = contextActions[action];
      if (operation) {
        let input: Record<string, unknown> = {};
        if (operation === "read_resource") input = { uri: argumentsText };
        if (operation === "get_prompt") {
          const prompt = /^(\S+)(?:\s+([\s\S]+))?$/u.exec(argumentsText);
          if (!prompt) throw new Error("/mcp prompt requires a name and optional JSON string arguments");
          input = { name: prompt[1], arguments: object(JSON.parse(prompt[2] ?? "{}"), "prompt arguments") };
        }
        if (operation === "complete") input = object(JSON.parse(argumentsText), "completion input");
        return [publicText(JSON.stringify(await invokeMcpContext(connection, operation, input, options.signal), null, 2))];
      }
      const call = /^(\S+)(?:\s+([\s\S]+))?$/u.exec(argumentsText);
      if (!call) throw new Error("/mcp call requires a tool name and optional JSON object");
      const input: unknown = JSON.parse(call[2] ?? "{}");
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("MCP arguments must be a JSON object");
      const result = action === "task-call" ? await connection.callToolTask(call[1], input as Record<string, unknown>, options) : await connection.callTool(call[1], input as Record<string, unknown>, options);
      return [publicText(JSON.stringify(result, null, 2))];
    } finally { await connection.close(); }
  }
  throw new Error(`Unknown /${kind} action: ${action}; use /${kind} help`);
}
