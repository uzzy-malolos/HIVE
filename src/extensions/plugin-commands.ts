import { discoverExtensions, loadLspServer, setExtensionState } from "./catalog.js";
import { connectLsp } from "./lsp.js";
import { cancelled, publicText } from "./io.js";
import type { ExtensionOptions, RequestOptions } from "./types.js";

export interface PluginComponentCommandOptions extends ExtensionOptions, RequestOptions {
  runAgent?: (id: string, objective: string) => Promise<string | string[]>;
}

function words(input: string | readonly string[]): string[] {
  if (typeof input !== "string") {
    if (input.length > 128 || input.some((entry) => typeof entry !== "string" || entry.includes("\0")) || input.reduce((size, entry) => size + entry.length, 0) > 64 * 1024) throw new Error("Extension command argument array exceeds the bounded text limit");
    return [...input];
  }
  if (input.length > 64 * 1024 || input.includes("\0")) throw new Error("Extension command arguments exceed the bounded text limit");
  const result: string[] = [];
  let value = "", quote: string | undefined, started = false;
  for (let index = 0; index < input.length; index += 1) {
    const char = input[index];
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && [quote, "\\"].includes(input[index + 1])) value += input[++index];
      else value += char;
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/u.test(char)) { if (started) { result.push(value); value = ""; started = false; } }
    else { value += char; started = true; }
  }
  if (quote) throw new Error("Unterminated quoted extension command argument");
  if (started) result.push(value);
  if (result.length > 128) throw new Error("Extension command arguments exceed 128 entries");
  return result;
}

export async function pluginComponentCommand(cwd: string, args: string | readonly string[], options: PluginComponentCommandOptions = {}): Promise<string[]> {
  if (options.signal?.aborted) throw cancelled();
  const [action = "agents", target, ...rest] = words(args);
  const catalog = await discoverExtensions(cwd, options);
  if (action === "agents") {
    if (rest.length) throw new Error("/plugins agents accepts at most one plugin selector");
    const selected = target === undefined ? catalog.agents : catalog.agents.filter((agent) => agent.pluginId === (target.startsWith("plugin:") ? target : `plugin:${target}`));
    return [...catalog.diagnostics.map((line) => `Warning: ${publicText(line)}`), ...(selected.length ? selected.map((agent) => `${agent.id}  ${agent.trusted ? "trusted" : "untrusted"}  ${agent.enabled ? "enabled" : "disabled"}  ${publicText(agent.description)}`) : ["No matching plugin agents configured."])];
  }
  if (action !== "agent" && action !== "run-agent") throw new Error("Use /plugins agents [plugin], agent <id>, or run-agent <id> <objective>");
  if (!target) throw new Error(`/plugins ${action} requires an agent id`);
  const exact = catalog.agents.find((agent) => agent.id === target || agent.id === `agent:${target}`);
  const matches = exact ? [exact] : catalog.agents.filter((agent) => agent.name === target);
  if (matches.length !== 1) throw new Error(`Unknown or ambiguous plugin agent: ${target}; use its full agent id`);
  const agent = matches[0];
  if (action === "agent") {
    if (rest.length) throw new Error("/plugins agent accepts exactly one agent id");
    return [JSON.stringify({ ...agent, instructions: publicText(agent.instructions), description: publicText(agent.description) }, null, 2)];
  }
  const objective = rest.join(" ").trim();
  if (!objective) throw new Error("/plugins run-agent requires an objective");
  if (!agent.trusted || !agent.enabled) throw new Error("The selected plugin agent must be trusted and enabled");
  if (!options.runAgent) throw new Error("Plugin agent invocation requires a coding runtime with an explicitly selected provider");
  const result = await options.runAgent(agent.id, objective);
  return typeof result === "string" ? [publicText(result)] : result.map(publicText);
}

export async function lspCommand(cwd: string, args: string | readonly string[], options: ExtensionOptions & RequestOptions = {}): Promise<string[]> {
  if (options.signal?.aborted) throw cancelled();
  const [action = "list", target, ...rest] = words(args);
  if (action === "help") return ["/lsp list | trust <id> | untrust <id> | enable <id> | disable <id> | doctor <id>", "/lsp diagnostics <id> <file> | symbols <id> <file> | workspace-symbols <id> <query>", "/lsp hover|definition|references <id> <file> <line> <character> (zero-based UTF-16 positions)", "LSP processes start only for an explicit query or doctor invocation; no server binary is installed."];
  const catalog = await discoverExtensions(cwd, options);
  if (action === "list") { if (target) throw new Error("/lsp list does not accept arguments"); return [...catalog.diagnostics.map((line) => `Warning: ${publicText(line)}`), ...(catalog.lspServers.length ? catalog.lspServers.map((server) => `${server.id}  ${server.trusted ? "trusted" : "untrusted"}  ${server.enabled ? "enabled" : "disabled"}  ${Object.keys(server.extensionToLanguage).join(", ")}`) : ["No LSP servers configured."])]; }
  if (!target) throw new Error(`/lsp ${action} requires an LSP server id`);
  const exact = catalog.lspServers.find((server) => server.id === target || server.id === `lsp:${target}`);
  const matches = exact ? [exact] : catalog.lspServers.filter((server) => server.name === target);
  if (matches.length !== 1) throw new Error(`Unknown or ambiguous LSP server: ${target}`);
  const selected = matches[0];
  if (["trust", "untrust", "enable", "disable"].includes(action)) {
    if (rest.length) throw new Error(`/lsp ${action} accepts exactly one server id`);
    await setExtensionState(cwd, selected.id, action as "trust" | "untrust" | "enable" | "disable", options);
    return [`${selected.id}: ${action} recorded for this workspace.`];
  }
  if (!["doctor", "diagnostics", "hover", "definition", "references", "symbols", "workspace-symbols"].includes(action)) throw new Error(`Unsupported LSP command: ${action}`);
  const expected = action === "doctor" ? 0 : ["hover", "definition", "references"].includes(action) ? 3 : action === "workspace-symbols" ? undefined : 1;
  if ((expected !== undefined && rest.length !== expected) || (action === "workspace-symbols" && !rest.length)) throw new Error("LSP command arguments do not match /lsp help");
  const at = expected === 3 ? { line: Number(rest[1]), character: Number(rest[2]) } : undefined;
  if (at && (rest.slice(1).some((value) => !/^\d+$/u.test(value)) || !Number.isSafeInteger(at.line) || !Number.isSafeInteger(at.character))) throw new Error("LSP positions must be zero-based integers");
  const server = await loadLspServer(cwd, selected.id, options);
  const connection = await connectLsp(server, { workspaceRoot: catalog.root, signal: options.signal, beforeSend: async () => { const current = await loadLspServer(cwd, server.id, options); if (current.fingerprint !== server.fingerprint) throw new Error("LSP configuration changed; trust and reconnect explicitly"); } });
  try {
    if (action === "doctor") return [`${server.id}: connected with capabilities ${JSON.stringify(connection.capabilities)}`];
    if (action === "workspace-symbols") return [JSON.stringify(await connection.workspaceSymbols(rest.join(" "), options), null, 2)];
    if (action === "diagnostics") {
      let delivered = false;
      let finish!: () => void;
      const received = new Promise<void>((resolve) => { finish = resolve; });
      const off = connection.onDiagnostics(() => { delivered = true; finish(); });
      const abort = () => finish();
      options.signal?.addEventListener("abort", abort, { once: true });
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        await connection.openDocument(rest[0], options);
        if (!delivered) { timer = setTimeout(finish, Math.min(options.timeoutMs ?? 1000, 5000)); await received; }
        if (options.signal?.aborted) throw cancelled();
        return [JSON.stringify({ received: delivered, diagnostics: await connection.diagnostics(rest[0], options) }, null, 2)];
      } finally { if (timer) clearTimeout(timer); off(); options.signal?.removeEventListener("abort", abort); }
    }
    const result = action === "symbols" ? await connection.documentSymbols(rest[0], options) : action === "hover" ? await connection.hover(rest[0], at!, options) : action === "definition" ? await connection.definition(rest[0], at!, options) : await connection.references(rest[0], at!, options);
    return [JSON.stringify(result, null, 2)];
  } finally { await connection.close(); }
}
