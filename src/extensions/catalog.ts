import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { containsKnownSecret } from "../security/secrets.js";
import { marketplaceIntegrity } from "./marketplace-io.js";
import { boundedRead, cancelled, containedPath, enabled, identifier, inside, keys, MAX_CONFIG_BYTES, MAX_SKILL_BYTES, missing, object, parseProcess, string, timeout } from "./io.js";
import type { ExtensionCatalog, ExtensionOptions, ExtensionState, HookEvent, McpOAuthConfig, McpServerDescriptor, PluginDescriptor, RequestOptions } from "./types.js";
import { parseClaudeHookConfiguration, parseClaudeHookTimeout } from "./claude-hooks.js";
import { parsePluginAgent, type PluginAgentDescriptor } from "./plugin-agents.js";
import { parseLspServer } from "./lsp-config.js";
import { parsePluginDependencies } from "./plugin-components.js";
import { gatePluginDependencies } from "./plugin-dependencies.js";
import { parsePluginOutputStyle, type PluginOutputStyleDescriptor } from "./plugin-output-styles.js";

interface SavedState { fingerprint: string; enabled?: boolean }
type StateFile = Record<string, SavedState>;
const hookEvents: HookEvent[] = ["session_start", "prompt_submit", "before_tool", "after_tool", "after_tool_failure", "session_end", "stop", "stop_failure", "subagent_start", "subagent_stop", "permission_request"];
const SKILL_DIRECTORIES = [".hive/skills", ".agents/skills", ".claude/skills", ".codex/skills", "skills"];
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

function oauthConfiguration(raw: unknown): McpOAuthConfig | undefined {
  if (raw === undefined) return undefined;
  const value = object(raw, "MCP OAuth configuration");
  keys(value, ["clientId", "clientSecretEnv", "scopes", "redirectPort"], "MCP OAuth configuration");
  const clientId = value.clientId === undefined ? undefined : string(value.clientId, "OAuth clientId");
  if (clientId && containsKnownSecret(clientId)) throw new Error("OAuth clientId cannot contain a credential");
  const clientSecretEnv = value.clientSecretEnv === undefined ? undefined : string(value.clientSecretEnv, "OAuth clientSecretEnv", 128);
  if (clientSecretEnv && (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(clientSecretEnv) || !clientId)) throw new Error("OAuth clientSecretEnv must name an environment variable and requires clientId");
  let scopes: string[] | undefined;
  if (value.scopes !== undefined) {
    if (!Array.isArray(value.scopes) || value.scopes.length > 128) throw new Error("OAuth scopes must be an array with at most 128 entries");
    scopes = value.scopes.map((entry) => {
      const scope = string(entry, "OAuth scope", 256);
      if (!/^[\x21\x23-\x5b\x5d-\x7e]+$/u.test(scope)) throw new Error("OAuth scopes must be individual OAuth scope tokens");
      return scope;
    });
    if (new Set(scopes).size !== scopes.length) throw new Error("OAuth scopes must be unique");
  }
  const redirectPort = value.redirectPort;
  if (redirectPort !== undefined && (typeof redirectPort !== "number" || !Number.isInteger(redirectPort) || redirectPort < 1 || redirectPort > 65535)) throw new Error("OAuth redirectPort must be an integer from 1 to 65535");
  return { ...(clientId ? { clientId } : {}), ...(clientSecretEnv ? { clientSecretEnv } : {}), ...(scopes ? { scopes } : {}), ...(typeof redirectPort === "number" ? { redirectPort } : {}) };
}

async function statePath(root: string, options: ExtensionOptions): Promise<string> {
  const directory = options.trustStateDir ?? path.join(os.homedir(), ".hive", "extension-trust");
  return path.join(directory, `${digest(root)}.json`);
}

async function readState(root: string, options: ExtensionOptions): Promise<StateFile> {
  try {
    const input = object(JSON.parse(await boundedRead(await statePath(root, options), MAX_CONFIG_BYTES)), "trust state");
    const result: StateFile = {};
    for (const [id, raw] of Object.entries(input)) {
      const value = object(raw, "trust entry");
      if (typeof value.fingerprint !== "string" || !/^[a-f0-9]{64}$/u.test(value.fingerprint)) throw new Error("Invalid extension trust state");
      result[id] = { fingerprint: value.fingerprint, ...(value.enabled === undefined ? {} : { enabled: enabled(value.enabled) }) };
    }
    return result;
  } catch (error) { if (missing(error)) return {}; throw error; }
}

type FileSnapshot = { text: null } | { text: string; bytes: Buffer; stamp: string; relocationStamp: string; mode: number };

function stamp(stat: Awaited<ReturnType<typeof fs.lstat>>): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode, stat.nlink].join(":");
}

function relocationStamp(stat: Awaited<ReturnType<typeof fs.lstat>>): string {
  // Rename may change ctime, but must preserve the inode, contents, mode and mtime.
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.mode, stat.nlink].join(":");
}

/** Never create or replace storage through a directory symlink. */
async function storageDirectory(directory: string, create: boolean): Promise<void> {
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(directory, await fs.realpath(directory)) !== "") {
      throw new Error(`Extension storage must use plain directories: ${directory}`);
    }
  } catch (error) {
    if (!missing(error) || !create) throw error;
    const parent = path.dirname(directory);
    if (parent === directory) throw error;
    await storageDirectory(parent, true);
    await fs.mkdir(directory, { mode: 0o700 }).catch((mkdirError: unknown) => {
      if (!(mkdirError instanceof Error && "code" in mkdirError && mkdirError.code === "EEXIST")) throw mkdirError;
    });
    await storageDirectory(directory, false);
  }
}

async function snapshot(file: string): Promise<FileSnapshot> {
  let before: Awaited<ReturnType<typeof fs.lstat>>;
  try { before = await fs.lstat(file); }
  catch (error) { if (missing(error)) return { text: null }; throw error; }
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error(`Extension storage must use a plain single-link file: ${file}`);
  const handle = await fs.open(file, "r");
  try {
    const opened = await handle.stat();
    if (stamp(before) !== stamp(opened) || opened.size > MAX_CONFIG_BYTES) throw new Error("Extension configuration changed while it was being read or exceeds the size limit");
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_CONFIG_BYTES) throw new Error(`Extension configuration exceeds ${MAX_CONFIG_BYTES} bytes`);
    const bytes = Buffer.from(buffer.subarray(0, bytesRead));
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const after = await fs.lstat(file);
    if (stamp(before) !== stamp(after) || stamp(before) !== stamp(await handle.stat()) || after.isSymbolicLink()) throw new Error("Extension configuration changed while it was being read; retry the operation");
    return { text, bytes, stamp: stamp(after), relocationStamp: relocationStamp(after), mode: after.mode & 0o777 };
  } finally { await handle.close(); }
}

async function unchanged(file: string, expected: FileSnapshot): Promise<void> {
  const current = await snapshot(file);
  if (current.text !== expected.text || (current.text !== null && expected.text !== null && current.stamp !== expected.stamp)) throw new Error("Extension configuration changed during the update; no configuration was overwritten");
}

async function stageFile(file: string, bytes: Buffer, mode: number): Promise<string> {
  const temporary = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(temporary, "wx", mode);
    await handle.chmod(mode);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close(); handle = undefined;
    return temporary;
  } catch (error) {
    await handle?.close(); handle = undefined;
    await fs.rm(temporary, { force: true });
    throw error;
  } finally { await handle?.close(); }
}

async function atomicReplace(file: string, value: unknown, expected: FileSnapshot): Promise<void> {
  const newline = expected.text?.includes("\r\n") ? "\r\n" : "\n";
  const text = `${JSON.stringify(value, null, 2)}\n`.replaceAll("\n", newline);
  const bom = expected.text !== null && expected.bytes.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf]));
  const bytes = Buffer.from(`${bom ? "\uFEFF" : ""}${text}`, "utf8");
  if (bytes.length > MAX_CONFIG_BYTES) throw new Error(`Extension configuration exceeds ${MAX_CONFIG_BYTES} bytes`);
  await storageDirectory(path.dirname(file), false);
  const temporary = await stageFile(file, bytes, expected.text === null ? 0o600 : expected.mode);
  let backup: string | undefined;
  try {
    await storageDirectory(path.dirname(file), false);
    await unchanged(file, expected);
    if (expected.text !== null) {
      // Keep the displaced inode, even on success: a pre-existing open file handle
      // can still write to it after the rename. This is recovery, not portable CAS.
      const displacedPath = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomUUID()}.backup`);
      await fs.rename(file, displacedPath);
      backup = displacedPath;
      const displaced = await snapshot(backup);
      if (displaced.text === null || displaced.relocationStamp !== expected.relocationStamp || !displaced.bytes.equals(expected.bytes)) throw new Error("Extension configuration changed during final publication");
    }
    // link is exclusive: a writer that recreates the destination wins without
    // being overwritten, including the initially-absent configuration case.
    await fs.link(temporary, file);
    await fs.unlink(temporary);
    const published = await snapshot(file);
    if (published.text === null || !published.bytes.equals(bytes)) throw new Error("Extension configuration changed during final publication");
    if (backup && expected.text !== null) {
      const retained = await snapshot(backup);
      if (retained.text === null || retained.relocationStamp !== expected.relocationStamp || !retained.bytes.equals(expected.bytes)) throw new Error("Extension configuration changed through a displaced file handle");
    }
  } catch (error) {
    if (backup) {
      // Restore a copy only when the active path is absent. Retain the displaced
      // inode so late writes through an old handle remain recoverable as well.
      let recovery: string | undefined;
      try {
        const displaced = await snapshot(backup);
        if (displaced.text !== null) {
          recovery = await stageFile(file, displaced.bytes, displaced.mode);
          await fs.link(recovery, file);
        }
      } catch { /* The existing destination or retained backup takes precedence. */ }
      finally { if (recovery) await fs.rm(recovery, { force: true }); }
      throw new Error(`Extension configuration update conflicted; inspect the active file and recoverable backup: ${backup}`, { cause: error });
    }
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new Error("Extension configuration update conflicted; an externally created active file was preserved", { cause: error });
    throw error;
  } finally {
    await fs.rm(temporary, { force: true });
  }
}

/** Cooperative writers share this lock; displaced files retain external edits for recovery. */
async function withConfigurationLock<T>(root: string, operation: () => Promise<T>): Promise<T> {
  const directory = path.join(root, ".hive");
  await storageDirectory(directory, true);
  const file = path.join(directory, "extensions.lock");
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try { handle = await fs.open(file, "wx", 0o600); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new Error("Another extension configuration update holds .hive/extensions.lock; retry after it finishes. Inspect a stale lock before removing it");
    throw error;
  }
  const identity = stamp(await handle.stat());
  try { return await operation(); }
  finally {
    await handle.close();
    const current = await fs.lstat(file).catch((error: unknown) => { if (missing(error)) return null; throw error; });
    if (current && stamp(current) === identity && !current.isSymbolicLink()) await fs.unlink(file);
  }
}

async function revokePluginState(root: string, pluginId: string, options: ExtensionOptions, retainedIds: ReadonlySet<string> = new Set()): Promise<void> {
  const file = await statePath(root, options);
  await storageDirectory(path.dirname(file), true);
  const before = await snapshot(file);
  if (before.text === null) return;
  const saved = await readState(root, options);
  const name = pluginId.slice("plugin:".length);
  for (const id of Object.keys(saved)) {
    if (id === pluginId || (!retainedIds.has(id) && ["mcp:", "skill:", "hook:", "agent:", "lsp:"].some((prefix) => id.startsWith(`${prefix}${name}.`)))) delete saved[id];
  }
  await atomicReplace(file, saved, before);
}

function state(id: string, content: unknown, configuredEnabled: boolean, saved: StateFile, plugin?: PluginDescriptor): ExtensionState {
  const fingerprint = digest(JSON.stringify(content));
  const entry = saved[id];
  const trusted = entry?.fingerprint === fingerprint;
  return { id, fingerprint, trusted: trusted && (!plugin || plugin.trusted), enabled: (entry?.enabled ?? configuredEnabled) && (!plugin || plugin.enabled), ...(plugin ? { pluginId: plugin.id } : {}) };
}

function noSecretConfig(value: unknown): void {
  const input = object(value, "extension configuration");
  const { envRefs: _envRefs, bearerTokenEnv: _bearerTokenEnv, ...executable } = input;
  if (containsKnownSecret(JSON.stringify(executable))) throw new Error("Extension configuration contains a credential. Use envRefs or bearerTokenEnv instead");
  if (Array.isArray(input.args) && input.args.some((arg) => typeof arg === "string" && /^--?(?:api[-_]?key|token|password|secret|authorization)(?:=|$)/iu.test(arg))) {
    throw new Error("Credentials cannot be passed as extension arguments; use envRefs");
  }
}

async function addServers(catalog: ExtensionCatalog, raw: unknown, saved: StateFile, root: string, plugin?: PluginDescriptor): Promise<void> {
  if (raw === undefined) return;
  const entries = Object.entries(object(raw, "mcpServers"));
  if (entries.length > 32) throw new Error("At most 32 MCP servers may be configured per scope");
  for (const [name, entry] of entries) {
    identifier(name, "server name");
    const value = object(entry, `MCP server ${name}`);
    noSecretConfig(value);
    keys(value, ["transport", "command", "args", "cwd", "envRefs", "env", "timeoutMs", "enabled", "url", "bearerTokenEnv", "oauth"], `MCP server ${name}`);
    const id = `mcp:${plugin ? `${plugin.name}.` : ""}${name}`;
    const common = { ...state(id, [root, value], enabled(value.enabled, !!plugin), saved, plugin), name };
    let server: McpServerDescriptor;
    if (value.transport === "stdio") {
      if (value.url !== undefined || value.bearerTokenEnv !== undefined || value.oauth !== undefined) throw new Error("stdio MCP servers cannot declare HTTP fields");
      server = { ...common, transport: "stdio", process: await parseProcess(root, value) };
    } else if (value.transport === "http") {
      if (["command", "args", "cwd", "envRefs", "env"].some((key) => value[key] !== undefined)) throw new Error("HTTP MCP servers cannot declare process fields");
      const url = new URL(string(value.url, "MCP URL"));
      if (url.username || url.password || url.search || url.hash) throw new Error("MCP URLs cannot contain credentials, query strings, or fragments");
      const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
      if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) throw new Error("MCP requires HTTPS or HTTP on a loopback host");
      const bearerTokenEnv = value.bearerTokenEnv === undefined ? undefined : string(value.bearerTokenEnv, "bearerTokenEnv", 128);
      if (bearerTokenEnv && !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(bearerTokenEnv)) throw new Error("bearerTokenEnv must name an environment variable");
      const oauth = oauthConfiguration(value.oauth);
      if (oauth && bearerTokenEnv) throw new Error("HTTP MCP servers must use either OAuth or bearerTokenEnv");
      server = { ...common, transport: "http", url: url.toString(), timeoutMs: timeout(value.timeoutMs), ...(bearerTokenEnv ? { bearerTokenEnv } : {}), ...(oauth ? { oauth } : {}) };
    } else throw new Error(`MCP server ${name} transport must be stdio or http`);
    catalog.servers.push(server);
  }
}

async function addHooks(catalog: ExtensionCatalog, raw: unknown, saved: StateFile, root: string, plugin?: PluginDescriptor): Promise<void> {
  if (raw === undefined) return;
  const entries = Object.entries(object(raw, "hooks"));
  if (entries.length > 32) throw new Error("At most 32 hooks may be configured per scope");
  for (const [name, entry] of entries) {
    identifier(name, "hook name");
    const value = object(entry, `Hook ${name}`);
    keys(value, ["event", "command", "args", "cwd", "envRefs", "env", "timeoutMs", "enabled", "claude"], `Hook ${name}`);
    const event = hookEvents.find((candidate) => candidate === value.event);
    if (!event) throw new Error(`Hook ${name} has an unsupported lifecycle event`);
    const claude = value.claude === undefined ? undefined : parseClaudeHookConfiguration(value.claude, event);
    // The handler parser validates credential header references before this generic scan.
    noSecretConfig(claude?.handler ? { ...value, claude: { ...claude, handler: undefined } } : value);
    if (claude?.handler && ["command", "args", "cwd", "envRefs", "env"].some((key) => value[key] !== undefined)) throw new Error("Non-command hooks cannot declare process fields");
    const execution = claude?.handler ? { timeoutMs: parseClaudeHookTimeout(value.timeoutMs, claude.handler.type) } : { process: await parseProcess(root, value) };
    catalog.hooks.push({ ...state(`hook:${plugin ? `${plugin.name}.` : ""}${name}`, [root, value], enabled(value.enabled, !!plugin), saved, plugin), event, ...execution, ...(claude ? { claude } : {}) });
  }
}

async function addLspServers(catalog: ExtensionCatalog, raw: unknown, saved: StateFile, root: string, plugin?: PluginDescriptor): Promise<void> {
  if (raw === undefined) return;
  const entries = Object.entries(object(raw, "lspServers"));
  if (entries.length > 32) throw new Error("At most 32 LSP servers may be configured per scope");
  for (const [name, entry] of entries) {
    identifier(name, "LSP server name");
    const value = object(entry, "LSP server"); noSecretConfig(value);
    const parsed = await parseLspServer(root, name, value);
    catalog.lspServers.push({ ...parsed, ...state(`lsp:${plugin ? `${plugin.name}.` : ""}${name}`, [root, value], enabled(value.enabled, !!plugin), saved, plugin) });
  }
}

async function addPluginAgents(catalog: ExtensionCatalog, raw: unknown, saved: StateFile, root: string, plugin: PluginDescriptor): Promise<void> {
  if (raw === undefined) return;
  if (!Array.isArray(raw) || raw.length > 128) throw new Error("Plugin agents must list at most 128 Markdown paths");
  for (const candidate of raw) {
    const file = await containedPath(root, string(candidate, "agent path"));
    if (path.extname(file).toLowerCase() !== ".md") throw new Error("Plugin agent paths must name Markdown files");
    const text = await boundedRead(file, MAX_SKILL_BYTES);
    const parsed = parsePluginAgent(text, file, path.relative(root, file));
    const id = `agent:${plugin.name}.${parsed.name}`;
    if (catalog.agents.some((entry) => entry.id === id)) throw new Error(`Duplicate plugin agent: ${id}`);
    catalog.agents.push({ ...parsed, ...state(id, [file, text], true, saved, plugin) });
  }
}

async function addSkill(catalog: ExtensionCatalog, file: string, saved: StateFile, root: string, plugin?: PluginDescriptor): Promise<void> {
  const resolved = await containedPath(root, file);
  const text = await boundedRead(resolved, MAX_SKILL_BYTES);
  const directory = path.basename(path.dirname(resolved));
  const rawName = /^name:\s*["']?([^\r\n"']+)/mu.exec(text)?.[1]?.trim() ?? directory;
  const name = identifier(rawName, "skill name");
  const description = /^description:\s*["']?([^\r\n"']+)/mu.exec(text)?.[1]?.trim() ?? "Local skill";
  const id = `skill:${plugin ? `${plugin.name}.` : ""}${name}`;
  if (catalog.skills.some((skill) => skill.path === resolved && skill.id === id)) return;
  if (catalog.skills.some((skill) => skill.id === id)) throw new Error(`Duplicate skill id: ${id}`);
  catalog.skills.push({ ...state(id, [resolved, text], true, saved, plugin), name, path: resolved, description: description.slice(0, 512) });
}

async function scanSkills(catalog: ExtensionCatalog, directory: string, saved: StateFile, root: string, optionalRoot = false): Promise<void> {
    let contained: string;
    let rootPresent = false;
    try { await fs.lstat(path.resolve(root, directory)); rootPresent = true; contained = await containedPath(root, directory); }
    catch (error) { if (optionalRoot && !rootPresent && missing(error)) return; throw error; }
    const entries = await fs.readdir(contained, { withFileTypes: true });
    // One wrapper level supports vendored packages without walking arbitrary repo documentation.
    for (const entry of entries.slice(0, 128)) {
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      const child = await containedPath(root, path.join(contained, entry.name));
      const direct = path.join(child, "SKILL.md");
      let hasDirect = true;
      try { await fs.access(direct); }
      catch (error) { if (!missing(error)) throw error; hasDirect = false; }
      if (hasDirect) { await addSkill(catalog, direct, saved, root); continue; }
      const nested = path.join(child, "skills");
      let nestedEntries;
      try { nestedEntries = await fs.readdir(nested, { withFileTypes: true }); }
      catch (error) { if (missing(error)) continue; throw error; }
      for (const skill of nestedEntries.slice(0, 128)) {
        if (skill.isDirectory()) await addSkill(catalog, path.join(nested, skill.name, "SKILL.md"), saved, root);
      }
    }
}

async function addPlugins(catalog: ExtensionCatalog, raw: unknown, saved: StateFile): Promise<void> {
  if (raw === undefined) return;
  const entries = Object.entries(object(raw, "plugins"));
  if (entries.length > 32) throw new Error("At most 32 plugins may be configured");
  for (const [name, entry] of entries) {
    identifier(name, "plugin name");
    const value = object(entry, `Plugin ${name}`);
    keys(value, ["path", "enabled"], `Plugin ${name}`);
    const root = await containedPath(catalog.root, string(value.path, "plugin path"));
    const manifestPath = await containedPath(root, "hive.plugin.json");
    const manifestText = await boundedRead(manifestPath, MAX_CONFIG_BYTES);
    const manifest = object(JSON.parse(manifestText), "plugin manifest");
    keys(manifest, ["version", "name", "description", "mcpServers", "skills", "hooks", "agents", "lspServers", "outputStyles", "pluginVersion", "dependencies"], "plugin manifest");
    if (manifest.version !== 1 || manifest.name !== name) throw new Error(`Plugin ${name} must use manifest version 1 and matching name`);
    const provenance = await marketplaceIntegrity(root);
    const selector = provenance === undefined ? undefined : object(JSON.parse(provenance), "plugin provenance").selector;
    const origin = typeof selector === "string" ? /^([A-Za-z0-9][A-Za-z0-9._-]{0,95})@([A-Za-z0-9][A-Za-z0-9._-]{0,95})$/u.exec(selector) : null;
    const pluginVersion = manifest.pluginVersion === undefined ? undefined : string(manifest.pluginVersion, "pluginVersion", 256);
    if (pluginVersion && containsKnownSecret(pluginVersion)) throw new Error("Plugin version cannot contain a credential");
    const fingerprintContent = provenance === undefined ? [root, value, manifestText] : [root, value, manifestText, provenance];
    const plugin: PluginDescriptor = { ...state(`plugin:${name}`, fingerprintContent, enabled(value.enabled), saved), name, path: root, description: typeof manifest.description === "string" ? manifest.description.slice(0, 512) : "Local plugin",
      ...(origin ? { sourceName: origin[1], marketplace: origin[2] } : {}), ...(pluginVersion ? { pluginVersion } : {}), dependencies: parsePluginDependencies(manifest.dependencies) };
    catalog.plugins.push(plugin);
    await addServers(catalog, manifest.mcpServers, saved, root, plugin);
    await addHooks(catalog, manifest.hooks, saved, root, plugin);
    await addPluginAgents(catalog, manifest.agents, saved, root, plugin);
    await addLspServers(catalog, manifest.lspServers, saved, root, plugin);
    if (manifest.outputStyles !== undefined) {
      if (!Array.isArray(manifest.outputStyles) || manifest.outputStyles.length > 128) throw new Error("Plugin outputStyles must list at most 128 Markdown paths");
      for (const entry of manifest.outputStyles) {
        const relative = string(entry, "output style path"), file = await containedPath(root, relative);
        if (path.extname(file).toLowerCase() !== ".md") throw new Error("Output styles must name Markdown files");
        const text = await boundedRead(file, MAX_SKILL_BYTES), parsed = parsePluginOutputStyle(text, file, relative);
        const id = `style:${plugin.name}.${parsed.key}`;
        if (catalog.outputStyles.some((style) => style.id === id)) throw new Error(`Duplicate plugin output style: ${id}`);
        catalog.outputStyles.push({ ...parsed, ...state(id, [file, text], true, saved, plugin) });
      }
    }
    if (manifest.skills !== undefined) {
      if (!Array.isArray(manifest.skills) || manifest.skills.length > 128) throw new Error("Plugin skills must list at most 128 SKILL.md paths");
      for (const file of manifest.skills) {
        const candidate = string(file, "skill path");
        if (path.basename(candidate) !== "SKILL.md") throw new Error("Plugin skills must point to SKILL.md files");
        await addSkill(catalog, candidate, saved, root, plugin);
      }
    }
  }
}

function emptyCatalog(root: string): ExtensionCatalog {
  return { root, configPath: path.join(root, ".hive", "extensions.json"), servers: [], skills: [], hooks: [], plugins: [], agents: [], lspServers: [], outputStyles: [], diagnostics: [] };
}

async function readConfiguredExtensions(catalog: ExtensionCatalog, config: Record<string, unknown>, saved: StateFile): Promise<void> {
  keys(config, ["version", "mcpServers", "hooks", "plugins", "skillDirectories", "lspServers"], "extensions config");
  if (config.version !== 1) throw new Error("Extension config version must be 1");
  await addServers(catalog, config.mcpServers, saved, catalog.root);
  await addHooks(catalog, config.hooks, saved, catalog.root);
  await addLspServers(catalog, config.lspServers, saved, catalog.root);
  await addPlugins(catalog, config.plugins, saved);
  for (const entries of [catalog.servers, catalog.hooks, catalog.plugins, catalog.agents, catalog.lspServers, catalog.outputStyles]) {
    const ids = entries.map((entry) => entry.id);
    if (new Set(ids).size !== ids.length) throw new Error("Duplicate extension ids; rename conflicting scoped contributions");
  }
  if (config.skillDirectories !== undefined) {
    if (!Array.isArray(config.skillDirectories) || config.skillDirectories.length > 16) throw new Error("skillDirectories must contain at most 16 workspace directories");
    for (const directory of config.skillDirectories) await scanSkills(catalog, string(directory, "skill directory"), saved, catalog.root);
  }
}

async function validateRegistration(catalog: ExtensionCatalog, config: Record<string, unknown>): Promise<void> {
  await readConfiguredExtensions(catalog, config, {});
  for (const directory of SKILL_DIRECTORIES) {
    await scanSkills(catalog, path.join(catalog.root, directory), {}, catalog.root, true);
  }
}

/** Discovery only reads bounded local files. It never launches a process or connects. */
export async function discoverExtensions(cwd: string, options: ExtensionOptions = {}): Promise<ExtensionCatalog> {
  const root = await fs.realpath(cwd);
  const catalog = emptyCatalog(root);
  let saved: StateFile = {};
  try { saved = await readState(root, options); } catch { catalog.diagnostics.push("Extension trust state is invalid; all extensions require fresh trust"); }
  let configPresent = false;
  try {
    await fs.lstat(catalog.configPath);
    configPresent = true;
    const configPath = await containedPath(root, catalog.configPath);
    const config = object(JSON.parse(await boundedRead(configPath, MAX_CONFIG_BYTES)), "extensions config");
    await readConfiguredExtensions(catalog, config, saved);
  } catch (error) {
    if (configPresent || !missing(error)) {
      // Invalid configuration cannot leave earlier executable entries partly active.
      catalog.servers = []; catalog.hooks = []; catalog.plugins = []; catalog.skills = []; catalog.agents = []; catalog.lspServers = []; catalog.outputStyles = [];
      catalog.diagnostics.push(error instanceof Error ? error.message : "Invalid extension configuration");
    }
  }
  for (const directory of SKILL_DIRECTORIES) {
    try { await scanSkills(catalog, path.join(root, directory), saved, root, true); }
    catch (error) {
      catalog.servers = []; catalog.hooks = []; catalog.plugins = []; catalog.skills = []; catalog.agents = []; catalog.lspServers = []; catalog.outputStyles = [];
      catalog.diagnostics.push(error instanceof Error ? error.message : "Skill discovery failed");
    }
  }
  gatePluginDependencies(catalog);
  return catalog;
}

/** Register an existing local bundle. Validation never executes its contributions. */
export async function installLocalPlugin(cwd: string, name: string, directory: string, options: ExtensionOptions & RequestOptions = {}): Promise<PluginDescriptor> {
  identifier(name, "plugin name");
  string(directory, "plugin directory");
  const root = await fs.realpath(cwd);
  const pluginPath = path.resolve(root, directory);
  if (!inside(root, pluginPath)) throw new Error("Plugin directory must remain inside the workspace");
  await storageDirectory(pluginPath, false);
  await snapshot(path.join(pluginPath, "hive.plugin.json"));
  return withConfigurationLock(root, async () => {
    if (options.signal?.aborted) throw cancelled();
    const catalog = emptyCatalog(root);
    const before = await snapshot(catalog.configPath);
    const config: Record<string, unknown> = before.text === null ? { version: 1 } : object(JSON.parse(before.text), "extensions config");
    await validateRegistration(catalog, config);
    const plugins = config.plugins === undefined ? {} : object(config.plugins, "plugins");
    if (Object.hasOwn(plugins, name)) throw new Error(`Plugin ${name} is already registered; uninstall it before changing its registration`);
    const next = { ...config, plugins: { ...plugins, [name]: { path: path.relative(root, pluginPath).split(path.sep).join("/") || ".", enabled: false } } };
    const validated = emptyCatalog(root);
    await validateRegistration(validated, next);
    const installed = validated.plugins.find((entry) => entry.name === name);
    if (!installed) throw new Error("Plugin validation did not produce a registration");
    if (Buffer.byteLength(`${JSON.stringify(next, null, 2)}\n`) > MAX_CONFIG_BYTES) throw new Error(`Extension configuration exceeds ${MAX_CONFIG_BYTES} bytes`);
    if (options.signal?.aborted) throw cancelled();
    await unchanged(catalog.configPath, before);
    await revokePluginState(root, installed.id, options);
    if (options.signal?.aborted) throw cancelled();
    await atomicReplace(catalog.configPath, next, before);
    return installed;
  });
}

/** Replace only the expected registration; retain old bundle files and revoke all prior trust. */
export async function replaceLocalPlugin(cwd: string, name: string, directory: string, expectedPath: string | undefined, options: ExtensionOptions & RequestOptions = {}): Promise<PluginDescriptor> {
  identifier(name, "plugin name");
  if (!expectedPath) throw new Error(`Plugin ${name} is not installed; install it before updating`);
  const root = await fs.realpath(cwd); const pluginPath = path.resolve(root, string(directory, "plugin directory"));
  if (!inside(root, pluginPath)) throw new Error("Plugin directory must remain inside the workspace");
  await storageDirectory(pluginPath, false); await snapshot(path.join(pluginPath, "hive.plugin.json"));
  return withConfigurationLock(root, async () => {
    if (options.signal?.aborted) throw cancelled();
    const catalog = emptyCatalog(root); const before = await snapshot(catalog.configPath);
    if (before.text === null) throw new Error(`Unknown plugin: ${name}`);
    const config = object(JSON.parse(before.text), "extensions config"); await validateRegistration(catalog, config);
    const plugins = object(config.plugins, "plugins"); const previous = object(plugins[name], `Plugin ${name}`);
    if (path.resolve(root, string(previous.path, "plugin path")) !== path.resolve(expectedPath)) throw new Error("Plugin registration changed during update; the newer registration was preserved");
    const next = { ...config, plugins: { ...plugins, [name]: { path: path.relative(root, pluginPath).split(path.sep).join("/"), enabled: false } } };
    const validated = emptyCatalog(root); await validateRegistration(validated, next);
    const installed = validated.plugins.find((entry) => entry.name === name); if (!installed) throw new Error("Plugin update did not produce a valid registration");
    await unchanged(catalog.configPath, before); await revokePluginState(root, installed.id, options);
    if (options.signal?.aborted) throw cancelled();
    await atomicReplace(catalog.configPath, next, before); return installed;
  });
}

/** Unregister only; bundle files remain available for inspection or later installation. */
export async function uninstallLocalPlugin(cwd: string, name: string, options: ExtensionOptions & RequestOptions = {}): Promise<void> {
  identifier(name, "plugin name");
  const root = await fs.realpath(cwd);
  await withConfigurationLock(root, async () => {
    if (options.signal?.aborted) throw cancelled();
    const catalog = emptyCatalog(root);
    const before = await snapshot(catalog.configPath);
    if (before.text === null) throw new Error(`Unknown plugin: ${name}`);
    const config = object(JSON.parse(before.text), "extensions config");
    keys(config, ["version", "mcpServers", "hooks", "plugins", "skillDirectories", "lspServers"], "extensions config");
    if (config.version !== 1) throw new Error("Extension config version must be 1");
    const plugins = config.plugins === undefined ? {} : object(config.plugins, "plugins");
    if (!Object.hasOwn(plugins, name)) throw new Error(`Unknown plugin: ${name}`);
    const registration = object(plugins[name], `Plugin ${name}`);
    keys(registration, ["path", "enabled"], `Plugin ${name}`);
    string(registration.path, "plugin path");
    enabled(registration.enabled);
    const remaining = { ...plugins };
    delete remaining[name];
    const next = { ...config, plugins: remaining };
    await validateRegistration(catalog, next);
    if (options.signal?.aborted) throw cancelled();
    await unchanged(catalog.configPath, before);
    const retainedIds = new Set([...catalog.servers, ...catalog.skills, ...catalog.hooks, ...catalog.plugins, ...catalog.agents, ...catalog.lspServers, ...catalog.outputStyles].map((entry) => entry.id));
    await revokePluginState(root, `plugin:${name}`, options, retainedIds);
    if (options.signal?.aborted) throw cancelled();
    await atomicReplace(catalog.configPath, next, before);
  });
}

export async function setExtensionState(cwd: string, id: string, action: "trust" | "enable" | "disable" | "untrust", options: ExtensionOptions = {}): Promise<void> {
  const root = await fs.realpath(cwd);
  await withConfigurationLock(root, () => updateExtensionState(root, id, action, options));
}

async function updateExtensionState(cwd: string, id: string, action: "trust" | "enable" | "disable" | "untrust", options: ExtensionOptions): Promise<void> {
  const catalog = await discoverExtensions(cwd, options);
  const all = [...catalog.servers, ...catalog.skills, ...catalog.hooks, ...catalog.plugins, ...catalog.agents, ...catalog.lspServers, ...catalog.outputStyles];
  const target = all.find((entry) => entry.id === id);
  if (!target) throw new Error(`Unknown extension: ${id}`);
  const file = await statePath(catalog.root, options);
  await storageDirectory(path.dirname(file), true);
  const before = await snapshot(file);
  const saved = await readState(catalog.root, options);
  const targets = target.id.startsWith("plugin:") ? all.filter((entry) => entry.id === target.id || entry.pluginId === target.id) : [target];
  for (const entry of targets) {
    if (action === "trust") saved[entry.id] = { fingerprint: entry.fingerprint, ...(saved[entry.id]?.enabled === undefined ? {} : { enabled: saved[entry.id].enabled }) };
    else if (action === "untrust") delete saved[entry.id];
    else {
      if (action === "enable" && !entry.trusted) throw new Error(`Trust ${entry.id} before enabling it`);
      saved[entry.id] = { fingerprint: saved[entry.id]?.fingerprint ?? "0".repeat(64), enabled: action === "enable" };
    }
  }
  await atomicReplace(file, saved, before);
}

export function requireActive(entry: ExtensionState): void {
  if (entry.blockedReason) throw new Error(entry.blockedReason);
  if (!entry.trusted) throw new Error(`Extension ${entry.id} is untrusted; inspect it then run its trust command`);
  if (!entry.enabled) throw new Error(`Extension ${entry.id} is disabled`);
}

export async function loadSkill(cwd: string, id: string, options: ExtensionOptions = {}): Promise<{ id: string; path: string; text: string }> {
  const catalog = await discoverExtensions(cwd, options);
  const exact = catalog.skills.find((entry) => entry.id === id || entry.id === `skill:${id}`);
  const matches = exact ? [exact] : catalog.skills.filter((entry) => entry.name === id);
  if (matches.length > 1) throw new Error(`Ambiguous skill: ${id}; use its full namespaced id`);
  const skill = matches[0];
  if (!skill) throw new Error(`Unknown skill: ${id}`);
  requireActive(skill);
  const text = await boundedRead(await containedPath(catalog.root, skill.path), MAX_SKILL_BYTES);
  if (digest(JSON.stringify([skill.path, text])) !== skill.fingerprint) throw new Error("Skill changed after discovery; trust it again");
  return { id: skill.id, path: skill.path, text };
}

function assertSkillPreloadPolicy(text: string, id: string): void {
  const header = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/u.exec(text)?.[1];
  if (header === undefined) {
    if (/^\uFEFF?---[ \t]*(?:\r?\n|$)/u.test(text)) throw new Error("Unterminated skill frontmatter; automatic preload refused");
    return;
  }
  if (/^[ \t]*[?&*!]/mu.test(header)) throw new Error("Complex YAML skill policies are unsupported for automatic preload");
  const declarations: string[] = [];
  for (const line of header.split(/\r?\n/u)) {
    const field = /^[ \t]*("(?:[^"\\]|\\.)*"|'(?:[^']|'')*'|[^:#\s][^:]*?)[ \t]*:[ \t]*(.*)$/u.exec(line);
    if (!field) continue;
    const rawKey = field[1].trim();
    let key = rawKey;
    if (rawKey.startsWith('"')) { try { key = JSON.parse(rawKey); } catch { throw new Error("Unsupported quoted skill policy key for automatic preload"); } }
    else if (rawKey.startsWith("'")) key = rawKey.slice(1, -1).replaceAll("''", "'");
    if (key === "<<") throw new Error("Merged skill policies are unsupported for automatic preload");
    if (key === "disable-model-invocation") declarations.push(field[2].trim());
  }
  const normalized = header.replace(/\\\r?\n[ \t]*/gu, "").replace(/\\(?:u([a-fA-F0-9]{4})|x([a-fA-F0-9]{2})|U([a-fA-F0-9]{8}))/gu, (_match, unicode: string | undefined, byte: string | undefined, long: string | undefined) => {
    const point = Number.parseInt(unicode ?? byte ?? long ?? "0", 16); return point <= 0x10ffff ? String.fromCodePoint(point) : "";
  });
  const mentions = [...normalized.matchAll(/["']?disable-model-invocation["']?[ \t]*:/gu)].length;
  if (declarations.length > 1 || mentions > declarations.length) throw new Error("Ambiguous or duplicate skill invocation policy; automatic preload refused");
  if (declarations.some((value) => !/^(?:false|"false"|'false')[ \t]*(?:#.*)?$/u.test(value))) throw new Error(`Skill ${id} disables automatic model invocation or has an unsupported invocation policy; invoke it explicitly instead`);
}

export async function loadPluginAgent(cwd: string, id: string, options: ExtensionOptions = {}): Promise<PluginAgentDescriptor & { preloadedSkillIds: string[] }> {
  const catalog = await discoverExtensions(cwd, options);
  const exact = catalog.agents.find((entry) => entry.id === id || entry.id === `agent:${id}`);
  const matches = exact ? [exact] : catalog.agents.filter((entry) => entry.name === id);
  if (matches.length !== 1) throw new Error(`Unknown or ambiguous plugin agent: ${id}`);
  const agent = matches[0]; requireActive(agent);
  const text = await boundedRead(await containedPath(catalog.root, agent.path), MAX_SKILL_BYTES);
  if (digest(JSON.stringify([agent.path, text])) !== agent.fingerprint) throw new Error("Plugin agent changed after discovery; inspect and trust it again");
  const preloaded: Array<{ id: string; text: string; fingerprint: string }> = [];
  for (const name of agent.skills ?? []) {
    let qualified = name.startsWith("skill:") ? name : undefined;
    if (!qualified && name.includes(":")) {
      const [pluginName, skillName] = name.split(":");
      const owner = catalog.plugins.find((entry) => entry.id === agent.pluginId);
      const ownPlugin = owner && (owner.name === pluginName || owner.sourceName === pluginName) ? owner : undefined;
      const plugins = ownPlugin ? [ownPlugin] : catalog.plugins.filter((entry) => entry.name === pluginName || entry.sourceName === pluginName);
      if (plugins.length !== 1) throw new Error(`Unknown or ambiguous preloaded skill plugin: ${pluginName}; use a full skill id`);
      qualified = `skill:${plugins[0].name}.${skillName}`;
    }
    const ownId = agent.pluginId && !qualified ? `skill:${agent.pluginId.slice(7)}.${name}` : undefined;
    const own = ownId ? catalog.skills.find((entry) => entry.id === ownId) : undefined;
    const candidates = own ? [own] : catalog.skills.filter((entry) => qualified ? entry.id === qualified : entry.name === name);
    if (candidates.length !== 1) throw new Error(`Unknown or ambiguous preloaded agent skill: ${name}`);
    const skill = candidates[0]; requireActive(skill);
    const skillText = await boundedRead(await containedPath(catalog.root, skill.path), MAX_SKILL_BYTES);
    if (digest(JSON.stringify([skill.path, skillText])) !== skill.fingerprint) throw new Error("Preloaded skill changed after discovery; inspect and trust it again");
    assertSkillPreloadPolicy(skillText, skill.id);
    if (!preloaded.some((entry) => entry.id === skill.id)) preloaded.push({ id: skill.id, text: skillText, fingerprint: skill.fingerprint });
  }
  const instructions = [agent.instructions, ...preloaded.map((skill) => `[Preloaded skill ${skill.id}]\n${skill.text}\nUse read_skill_reference with skillId ${JSON.stringify(skill.id)} to read its linked Markdown/text instructions.`)].join("\n\n");
  if (Buffer.byteLength(instructions) > MAX_SKILL_BYTES) throw new Error("Agent and preloaded skill instructions exceed 65536 bytes; select fewer skills");
  return { ...agent, instructions, preloadedSkillIds: preloaded.map((skill) => skill.id), fingerprint: preloaded.length ? digest(JSON.stringify([agent.fingerprint, preloaded.map((skill) => [skill.id, skill.fingerprint])])) : agent.fingerprint };
}

export async function loadLspServer(cwd: string, id: string, options: ExtensionOptions = {}): Promise<import("./lsp-config.js").LspServerDescriptor> {
  const catalog = await discoverExtensions(cwd, options);
  const exact = catalog.lspServers.find((entry) => entry.id === id || entry.id === `lsp:${id}`);
  const matches = exact ? [exact] : catalog.lspServers.filter((entry) => entry.name === id);
  if (matches.length !== 1) throw new Error(`Unknown or ambiguous LSP server: ${id}`);
  const server = matches[0]; requireActive(server); return server;
}

export async function loadTrustedPluginOutputStyle(cwd: string, id: string, options: ExtensionOptions = {}): Promise<PluginOutputStyleDescriptor> {
  const catalog = await discoverExtensions(cwd, options);
  const exact = catalog.outputStyles.find((style) => style.id === id || style.id === `style:${id}`);
  const matches = exact ? [exact] : catalog.outputStyles.filter((style) => style.name === id);
  if (matches.length !== 1) throw new Error(`Unknown or ambiguous output style: ${id}`);
  const style = matches[0]; requireActive(style);
  const text = await boundedRead(await containedPath(catalog.root, style.path), MAX_SKILL_BYTES);
  if (digest(JSON.stringify([style.path, text])) !== style.fingerprint) throw new Error("Output style changed after discovery; inspect and trust it again");
  return style;
}
