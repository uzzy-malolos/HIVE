import { bundlePath, type TreeFile } from "./marketplace-io.js";
import { componentPaths, pluginMarkdown } from "./marketplace-markdown.js";
import { identifier, keys, object, string, timeout, validateEnvironmentLiteral } from "./io.js";
import { parsePluginAgent } from "./plugin-agents.js";

export interface PluginDependency { name: string; marketplace?: string; version?: string }
interface SemanticVersion { core: number[]; prerelease: string[] }
interface VersionPattern { core: number[]; prerelease: string[] }

function versionPattern(raw: string): VersionPattern | undefined {
  const match = /^v?(\d+(?:\.(?:\d+|[xX*])){0,2}|[xX*])(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(raw);
  if (!match) return undefined;
  const parts = match[1].split("."); const core: number[] = [];
  let wildcard = false;
  for (const part of parts) {
    if (/^[xX*]$/u.test(part)) { wildcard = true; continue; }
    if (wildcard || !/^(?:0|[1-9]\d*)$/u.test(part) || !Number.isSafeInteger(Number(part)) || Number(part) > 1_000_000_000) return undefined;
    core.push(Number(part));
  }
  const prerelease = match[2]?.split(".") ?? [];
  if (prerelease.length && (core.length !== 3 || prerelease.some((part) => /^\d+$/u.test(part) && !/^(?:0|[1-9]\d*)$/u.test(part)))) return undefined;
  return { core, prerelease };
}

function versionCompare(left: SemanticVersion, right: SemanticVersion): number {
  for (let index = 0; index < 3; index += 1) if (left.core[index] !== right.core[index]) return left.core[index] < right.core[index] ? -1 : 1;
  if (!left.prerelease.length || !right.prerelease.length) return Number(!left.prerelease.length) - Number(!right.prerelease.length);
  for (let index = 0; index < Math.max(left.prerelease.length, right.prerelease.length); index += 1) {
    const a = left.prerelease[index], b = right.prerelease[index];
    if (a === undefined || b === undefined) return a === undefined ? -1 : 1;
    if (a === b) continue;
    const numericA = /^\d+$/u.test(a), numericB = /^\d+$/u.test(b);
    if (numericA && numericB) return a.length === b.length ? a < b ? -1 : 1 : a.length < b.length ? -1 : 1;
    if (numericA !== numericB) return numericA ? -1 : 1;
    return a < b ? -1 : 1;
  }
  return 0;
}

type VersionComparator = { operator: ">=" | ">" | "<=" | "<" | "="; version: SemanticVersion; prereleaseOptIn?: boolean };
function versionRange(raw: string): VersionComparator[][] {
  if (!raw.trim() || raw.length > 256) throw new Error("Plugin dependency version must be a bounded semantic-version range");
  const alternatives = raw.trim().split(/\s*\|\|\s*/u);
  if (alternatives.length > 8 || alternatives.some((part) => !part)) throw new Error("Plugin dependency version range has invalid alternatives");
  return alternatives.map((source) => {
    const comparators: VersionComparator[] = [];
    const full = (value: VersionPattern): SemanticVersion => ({ core: [value.core[0] ?? 0, value.core[1] ?? 0, value.core[2] ?? 0], prerelease: value.prerelease });
    const upper = (value: VersionPattern, index: number): SemanticVersion => ({ core: [0, 1, 2].map((position) => position < index ? value.core[position] ?? 0 : position === index ? (value.core[position] ?? 0) + 1 : 0), prerelease: ["0"] });
    const hyphen = /^(\S+)\s+-\s+(\S+)$/u.exec(source);
    if (hyphen) {
      const low = versionPattern(hyphen[1]), high = versionPattern(hyphen[2]);
      if (!low || !high || !low.core.length || !high.core.length) throw new Error("Plugin dependency has an invalid hyphen version range");
      comparators.push({ operator: ">=", version: full(low), prereleaseOptIn: low.prerelease.length > 0 }, high.core.length === 3 ? { operator: "<=", version: full(high), prereleaseOptIn: high.prerelease.length > 0 } : { operator: "<", version: upper(high, high.core.length - 1) });
    } else {
      const tokens = source.replace(/([<>=~^]+)\s+/gu, "$1").split(/\s+/u);
      if (tokens.length > 8) throw new Error("Plugin dependency version range has too many comparators");
      for (const token of tokens) {
        const match = /^(\^|~|>=|<=|>|<|=)?(.+)$/u.exec(token);
        const value = match && versionPattern(match[2]);
        if (!match || !value) throw new Error("Plugin dependency version range uses unsupported syntax");
        const operator = match[1] ?? "=";
        if (!value.core.length) { if (!["=", "^", "~"].includes(operator)) throw new Error("Plugin dependency wildcard cannot use a comparison operator"); continue; }
        const base = full(value);
        if (operator === "^" || operator === "~") {
          const index = operator === "~" ? Math.min(1, value.core.length - 1) : Math.min(value.core.findIndex((part) => part !== 0) < 0 ? value.core.length - 1 : value.core.findIndex((part) => part !== 0), value.core.length - 1);
          comparators.push({ operator: ">=", version: base, prereleaseOptIn: value.prerelease.length > 0 }, { operator: "<", version: upper(value, index) });
        } else if (value.core.length < 3) {
          if (operator === "=") comparators.push({ operator: ">=", version: base }, { operator: "<", version: upper(value, value.core.length - 1) });
          else if (operator === ">" || operator === "<=") comparators.push({ operator: operator === ">" ? ">=" : "<", version: { ...upper(value, value.core.length - 1), prerelease: operator === ">" ? [] : ["0"] } });
          else if (operator === ">=" || operator === "<") comparators.push({ operator, version: { ...base, prerelease: operator === "<" ? ["0"] : [] } });
        } else if (operator === "=" || operator === ">=" || operator === ">" || operator === "<=" || operator === "<") comparators.push({ operator, version: base, prereleaseOptIn: value.prerelease.length > 0 });
      }
    }
    return comparators;
  });
}

/** Checks installed versions only; never resolves tags, fetches or enables dependencies. */
export function pluginVersionSatisfies(version: string | undefined, range: string): boolean {
  const alternatives = versionRange(range);
  const parsed = version === undefined ? undefined : versionPattern(version);
  if (!parsed || parsed.core.length !== 3) return false;
  const current: SemanticVersion = parsed;
  return alternatives.some((comparators) => {
    if (current.prerelease.length && !comparators.some((entry) => entry.prereleaseOptIn && entry.version.core.every((part, index) => part === current.core[index]))) return false;
    return comparators.every(({ operator, version: target }) => {
      const comparison = versionCompare(current, target);
      return operator === "=" ? comparison === 0 : operator === ">=" ? comparison >= 0 : operator === ">" ? comparison > 0 : operator === "<=" ? comparison <= 0 : comparison < 0;
    });
  });
}

export function parsePluginDependencies(raw: unknown): PluginDependency[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw) || raw.length > 32) throw new Error("Plugin dependencies must list at most 32 requirements");
  const result: PluginDependency[] = [];
  const names = new Set<string>();
  for (const declaration of raw) {
    let value: Record<string, unknown>;
    if (typeof declaration === "string") {
      const parts = declaration.split("@");
      if (parts.length > 2) throw new Error("Plugin dependency must use name or name@marketplace");
      value = { name: parts[0], ...(parts.length === 2 ? { marketplace: parts[1] } : {}) };
    } else value = object(declaration, "Plugin dependency");
    keys(value, ["name", "marketplace", "version"], "Plugin dependency");
    const name = identifier(value.name, "dependency name");
    const marketplace = value.marketplace === undefined ? undefined : identifier(value.marketplace, "dependency marketplace");
    const version = value.version === undefined ? undefined : string(value.version, "dependency version", 256);
    if (version !== undefined) versionRange(version);
    const identity = `${name}@${marketplace ?? ""}`.toLowerCase();
    if (names.has(identity)) throw new Error(`Duplicate plugin dependency: ${name}`);
    names.add(identity);
    result.push({ name, ...(marketplace === undefined ? {} : { marketplace }), ...(version === undefined ? {} : { version }) });
  }
  return result;
}

export interface ConvertedAgentLspComponents { agents: string[]; lspServers: Record<string, unknown>; warnings: string[] }

/** Deterministic, inert compatibility import. No executable is resolved, installed or started. */
export function convertClaudeAgentLspComponents(files: TreeFile[], manifest: Record<string, unknown>, entry: Record<string, unknown>, destination: string): ConvertedAgentLspComponents {
  const warnings = new Set<string>();
  const agents = new Set<string>();
  const addAgents = (raw: unknown, defaultDirectory = false) => {
    if (defaultDirectory) {
      for (const file of files.filter((file) => file.name.startsWith("agents/") && file.name.endsWith(".md"))) agents.add(file.name);
      return;
    }
    for (const fileName of componentPaths(raw, "Claude agents")) {
      if (!fileName.endsWith(".md") || !files.some((file) => file.name === fileName)) throw new Error(`Claude agent must point to an existing Markdown file: ${fileName}`);
      agents.add(fileName);
    }
  };
  if (manifest.agents === undefined) addAgents(undefined, true); else addAgents(manifest.agents);
  if (entry !== manifest && entry.strict !== false && entry.agents !== undefined) addAgents(entry.agents);
  if (agents.size > 128) throw new Error("Plugin agents exceed 128 files");
  const names = new Set<string>();
  for (const fileName of agents) {
    const file = files.find((candidate) => candidate.name === fileName)!;
    const source = new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
    const parsed = parsePluginAgent(pluginMarkdown(source, destination, `Agent ${fileName}`), fileName);
    if (names.has(parsed.name.toLowerCase())) throw new Error(`Duplicate plugin agent name: ${parsed.name}`);
    names.add(parsed.name.toLowerCase());
    for (const warning of parsed.warnings) warnings.add(warning);
  }

  const lspServers: Record<string, unknown> = {};
  const substitute = (value: string): string => {
    const result = value.replaceAll("${CLAUDE_PLUGIN_ROOT}", destination);
    if (result.includes("${")) throw new Error("Imported LSP configuration supports only CLAUDE_PLUGIN_ROOT interpolation; credentials require env references");
    return result;
  };
  const addMap = (raw: unknown) => {
    const map = object(raw, "Claude LSP server map");
    for (const [name, rawServer] of Object.entries(map)) {
      identifier(name, "LSP server name");
      const server = object(rawServer, `Claude LSP server ${name}`);
      keys(server, ["command", "args", "transport", "env", "envRefs", "initializationOptions", "settings", "workspaceFolder", "startupTimeout", "shutdownTimeout", "requestTimeout", "extensionToLanguage", "restartOnCrash", "maxRestarts", "diagnostics"], "Claude LSP server");
      if (server.transport !== undefined && server.transport !== "stdio" && server.transport !== "socket") throw new Error("HIVE supports stdio LSP transport only");
      if (server.transport === "socket") warnings.add(`LSP ${name}: Claude accepts transport:socket but runs it over stdio; HIVE also starts this server over stdio without opening a socket.`);
      if (server.restartOnCrash !== undefined && typeof server.restartOnCrash !== "boolean") throw new Error("LSP restartOnCrash must be a boolean");
      if (server.maxRestarts !== undefined && (typeof server.maxRestarts !== "number" || !Number.isInteger(server.maxRestarts) || server.maxRestarts < 0 || server.maxRestarts > 16)) throw new Error("LSP maxRestarts must be an integer from 0 to 16");
      if (server.restartOnCrash !== false || (typeof server.maxRestarts === "number" && server.maxRestarts > 0)) warnings.add(`LSP ${name}: HIVE stops on a crash and requires explicit reconnect; Claude's automatic restart default or settings are not applied.`);
      const command = substitute(string(server.command, "LSP command"));
      const args = server.args ?? [];
      if (!Array.isArray(args) || args.length > 64 || args.some((arg) => typeof arg !== "string" || arg.includes("\0") || arg.length > 16_384)) throw new Error("LSP args must contain at most 64 bounded strings");
      const env: Record<string, string> = {};
      const envRefs: Record<string, string> = {};
      const setRef = (key: string, ref: string) => {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(ref) || key.toLowerCase() === "__proto__") throw new Error("LSP environment references must name environment variables");
        if ([...Object.keys(env), ...Object.keys(envRefs)].some((candidate) => candidate.toLowerCase() === key.toLowerCase())) throw new Error("LSP environment names must be unique ignoring case");
        envRefs[key] = ref;
      };
      if (server.envRefs !== undefined) for (const [key, ref] of Object.entries(object(server.envRefs, "LSP envRefs"))) setRef(key, string(ref, "LSP environment reference", 128));
      if (server.env !== undefined) for (const [key, value] of Object.entries(object(server.env, "LSP env"))) {
        if (typeof value !== "string") throw new Error("LSP environment values must be strings");
        const ref = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/u.exec(value);
        if (ref && ref[1] !== "CLAUDE_PLUGIN_ROOT") { setRef(key, ref[1]); continue; }
        if ([...Object.keys(env), ...Object.keys(envRefs)].some((candidate) => candidate.toLowerCase() === key.toLowerCase())) throw new Error("LSP environment names must be unique ignoring case");
        env[key] = validateEnvironmentLiteral(key, substitute(value));
      }
      if ([...Object.keys(env), ...Object.keys(envRefs)].some((key) => key.toLowerCase() === "claude_plugin_root")) throw new Error("Imported LSP CLAUDE_PLUGIN_ROOT is fixed to its plugin directory");
      env.CLAUDE_PLUGIN_ROOT = validateEnvironmentLiteral("CLAUDE_PLUGIN_ROOT", destination);
      const extensionToLanguage = object(server.extensionToLanguage, "LSP extensionToLanguage");
      if (!Object.keys(extensionToLanguage).length || Object.keys(extensionToLanguage).length > 128) throw new Error("LSP extensionToLanguage requires 1 through 128 entries");
      for (const [extension, language] of Object.entries(extensionToLanguage)) {
        if (!/^\.[A-Za-z0-9_.+-]{1,63}$/u.test(extension)) throw new Error("LSP extension keys must start with a dot");
        string(language, "LSP language ID", 128);
      }
      const aliases = [["startupTimeout", "startupTimeoutMs"], ["shutdownTimeout", "shutdownTimeoutMs"], ["requestTimeout", "requestTimeoutMs"]] as const;
      const timeouts: Record<string, number> = {};
      for (const [source, target] of aliases) if (server[source] !== undefined) timeouts[target] = timeout(server[source]);
      if (server.diagnostics !== undefined && typeof server.diagnostics !== "boolean") throw new Error("LSP diagnostics must be a boolean");
      lspServers[name] = { command, args: args.map((arg) => substitute(String(arg))), cwd: ".", envRefs, env, extensionToLanguage: { ...extensionToLanguage }, ...timeouts,
        ...(server.initializationOptions === undefined ? {} : { initializationOptions: object(server.initializationOptions, "LSP initializationOptions") }),
        ...(server.settings === undefined ? {} : { settings: object(server.settings, "LSP settings") }),
        ...(server.workspaceFolder === undefined ? {} : { workspaceFolder: substitute(string(server.workspaceFolder, "LSP workspaceFolder")) }),
        ...(server.diagnostics === undefined ? {} : { diagnostics: server.diagnostics }) };
      if (Object.keys(lspServers).length > 32) throw new Error("Plugin LSP server count exceeds 32");
    }
  };
  const readConfig = (fileName: string) => {
    const portable = bundlePath(fileName);
    if (!portable.endsWith(".json")) throw new Error("LSP configuration paths must name JSON files");
    const file = files.find((candidate) => candidate.name === portable);
    if (!file) throw new Error(`Missing LSP configuration: ${portable}`);
    if (file.bytes.length > 128 * 1024) throw new Error("LSP configuration exceeds 128 KiB");
    return object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(file.bytes)), "LSP configuration");
  };
  if (files.some((file) => file.name === ".lsp.json")) addMap(readConfig(".lsp.json"));
  const add = (raw: unknown) => {
    if (raw === undefined) return;
    const entries = Array.isArray(raw) ? raw : [raw];
    if (entries.length > 128) throw new Error("LSP configuration sources exceed 128");
    for (const value of entries) addMap(typeof value === "string" ? readConfig(value) : value);
  };
  add(manifest.lspServers);
  if (entry !== manifest && entry.strict !== false) add(entry.lspServers);
  return { agents: [...agents], lspServers, warnings: [...warnings] };
}
