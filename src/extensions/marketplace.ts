import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { compatibleManifest } from "./marketplace-compat.js";
import { discoverExtensions, installLocalPlugin, replaceLocalPlugin } from "./catalog.js";
import { boundedRead, identifier, inside, missing, object, publicText, string } from "./io.js";
import { atomicRegistry, bundlePath, checkAbort, downloadManifest, plainDirectory, readGitTree, readLocalTree, readRegistryText, safeRemote, sha256, treeDigest, writeTree, type TreeFile } from "./marketplace-io.js";
import type { ExtensionOptions, PluginDescriptor, RequestOptions } from "./types.js";

export type MarketplaceSource = { kind: "directory"; path: string } | { kind: "url"; url: string } | { kind: "git"; url: string; ref?: string; sha?: string };
type PluginSource = { kind: "relative"; path: string } | { kind: "git"; url: string; path: string; ref?: string; sha?: string } | { kind: "unsupported"; type: string };
export interface MarketplacePlugin { name: string; description: string; version?: string; source: PluginSource; manifest: Record<string, unknown> }
export interface MarketplaceRecord { name: string; source: MarketplaceSource; snapshot: string; manifestHash: string; treeHash: string; commit?: string; updatedAt: string }
interface Registry { version: 1; marketplaces: Record<string, MarketplaceRecord> }
interface ParsedManifest { name: string; plugins: MarketplacePlugin[]; diagnostics: string[] }
export interface MarketplaceOptions extends ExtensionOptions, RequestOptions {
  /** Deliberately explicit for local HTTP fixtures. CLI never enables this. */
  allowLoopback?: boolean;
  replace?: boolean;
}
export interface MarketplaceInstallResult { plugin: PluginDescriptor; marketplace: string; pluginName: string; manifestHash: string; treeHash: string; commit?: string; warnings: string[] }

function github(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value)) throw new Error("GitHub sources must use owner/repository");
  return `https://github.com/${value}.git`;
}

function parseGit(raw: Record<string, unknown>, options: MarketplaceOptions): { url: string; ref?: string; sha?: string } {
  const type = raw.source;
  const rawUrl = type === "github" ? github(string(raw.repo, "GitHub repository")) : string(raw.url, "Git repository URL");
  const url = /^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(rawUrl) ? github(rawUrl) : safeRemote(rawUrl, options.allowLoopback);
  const ref = raw.ref === undefined ? undefined : string(raw.ref, "Git ref", 256);
  const sha = raw.sha === undefined ? undefined : string(raw.sha, "Git commit", 40);
  if (sha !== undefined && !/^[a-f0-9]{40}$/u.test(sha)) throw new Error("Git sha must be a full lowercase 40-character commit");
  return { url, ...(ref ? { ref } : {}), ...(sha ? { sha } : {}) };
}

function parseManifest(bytes: Buffer, options: MarketplaceOptions): ParsedManifest {
  const value = object(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)), "marketplace manifest");
  const name = identifier(value.name, "marketplace name");
  if (!Array.isArray(value.plugins) || value.plugins.length > 512) throw new Error("Marketplace plugins must be an array with at most 512 entries");
  const metadata = value.metadata === undefined ? {} : object(value.metadata, "marketplace metadata");
  const pluginRoot = metadata.pluginRoot === undefined ? undefined : bundlePath(string(metadata.pluginRoot, "pluginRoot"));
  const plugins: MarketplacePlugin[] = []; const diagnostics: string[] = []; const names = new Set<string>();
  for (const raw of value.plugins) {
    try {
      const entry = object(raw, "plugin entry"); const pluginName = identifier(entry.name, "plugin name");
      if (names.has(pluginName.toLowerCase())) throw new Error(`Duplicate marketplace plugin name: ${pluginName}`);
      names.add(pluginName.toLowerCase());
      let source: PluginSource;
      if (typeof entry.source === "string") {
        const relative = entry.source;
        if (relative !== "." && !relative.startsWith("./") && !(pluginRoot !== undefined && !relative.includes("/") && !relative.includes("\\"))) throw new Error("Relative plugin sources must start with ./ (or use metadata.pluginRoot)");
        source = { kind: "relative", path: bundlePath(relative.startsWith("./") || relative === "." ? relative : `${pluginRoot}/${relative}`) };
      } else {
        const specification = object(entry.source, "plugin source");
        if (["github", "url", "git-subdir"].includes(String(specification.source))) source = { kind: "git", ...parseGit(specification, options), path: specification.source === "git-subdir" ? bundlePath(string(specification.path, "Git plugin path")) : "" };
        else source = { kind: "unsupported", type: string(specification.source, "plugin source type", 64) };
      }
      plugins.push({ name: pluginName, description: typeof entry.description === "string" ? entry.description.slice(0, 512) : "", ...(typeof entry.version === "string" ? { version: entry.version.slice(0, 128) } : {}), source, manifest: entry });
      if (source.kind === "unsupported") diagnostics.push(`${pluginName}: unsupported ${source.type} source; no command or package manager will run`);
    } catch (error) { diagnostics.push(error instanceof Error ? error.message : "Invalid marketplace entry"); }
  }
  return { name, plugins, diagnostics };
}

async function storage(cwd: string): Promise<{ root: string; directory: string; registryPath: string }> {
  const root = await fs.realpath(cwd); const directory = path.join(root, ".hive", "marketplaces");
  await plainDirectory(directory, true); return { root, directory, registryPath: path.join(directory, "registry.json") };
}

function parseSource(value: unknown, options: MarketplaceOptions): MarketplaceSource {
  const raw = object(value, "marketplace source");
  if (raw.kind === "directory") return { kind: "directory", path: string(raw.path, "marketplace directory") };
  if (raw.kind === "url") return { kind: "url", url: safeRemote(string(raw.url, "marketplace URL"), options.allowLoopback) };
  if (raw.kind === "git") return { kind: "git", ...parseGit({ ...raw, source: "url" }, options) };
  throw new Error("Invalid stored marketplace source");
}

async function registry(file: string, options: MarketplaceOptions): Promise<{ text: string | null; value: Registry }> {
  const text = await readRegistryText(file); if (text === null) return { text, value: { version: 1, marketplaces: {} } };
  const raw = object(JSON.parse(text), "marketplace registry"); if (raw.version !== 1) throw new Error("Marketplace registry version must be 1");
  const entries = object(raw.marketplaces, "marketplaces"); if (Object.keys(entries).length > 32) throw new Error("At most 32 marketplaces may be registered");
  const marketplaces: Record<string, MarketplaceRecord> = {};
  for (const [name, entry] of Object.entries(entries)) {
    identifier(name, "marketplace name"); const item = object(entry, "marketplace record");
    if (item.name !== name || typeof item.manifestHash !== "string" || !/^[a-f0-9]{64}$/u.test(item.manifestHash) || typeof item.treeHash !== "string" || !/^[a-f0-9]{64}$/u.test(item.treeHash)) throw new Error("Invalid marketplace provenance");
    const snapshot = bundlePath(string(item.snapshot, "marketplace snapshot")); if (!/^snapshots\/[A-Za-z0-9_.-]+$/u.test(snapshot)) throw new Error("Invalid marketplace snapshot path");
    const commit = item.commit === undefined ? undefined : string(item.commit, "marketplace commit", 40); if (commit && !/^[a-f0-9]{40}$/u.test(commit)) throw new Error("Invalid marketplace commit");
    marketplaces[name] = { name, source: parseSource(item.source, options), snapshot, manifestHash: item.manifestHash, treeHash: item.treeHash, ...(commit ? { commit } : {}), updatedAt: string(item.updatedAt, "marketplace updatedAt", 64) };
  }
  return { text, value: { version: 1, marketplaces } };
}

async function locked<T>(directory: string, operation: () => Promise<T>): Promise<T> {
  const file = path.join(directory, "operation.lock");
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try { handle = await fs.open(file, "wx", 0o600); } catch (error) { if (error instanceof Error && "code" in error && error.code === "EEXIST") throw new Error("Another marketplace operation is running; inspect a stale operation.lock before removing it"); throw error; }
  const identity = await handle.stat();
  try { return await operation(); }
  finally { await handle.close(); const current = await fs.lstat(file).catch((error: unknown) => { if (missing(error)) return null; throw error; }); if (current && current.ino === identity.ino && current.dev === identity.dev && !current.isSymbolicLink()) await fs.unlink(file); }
}

async function inputSource(cwd: string, input: string | MarketplaceSource, options: MarketplaceOptions): Promise<MarketplaceSource> {
  if (typeof input !== "string") return parseSource(input, options);
  string(input, "marketplace source");
  if (input.startsWith("https://") || input.startsWith("http://")) {
    const url = safeRemote(input, options.allowLoopback); return new URL(url).pathname.endsWith(".json") ? { kind: "url", url } : { kind: "git", url };
  }
  if (/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(input) && !input.startsWith("./") && !input.startsWith("../")) return { kind: "git", url: github(input) };
  const candidate = path.resolve(cwd, input); const stat = await fs.lstat(candidate);
  if (stat.isSymbolicLink()) throw new Error("Marketplace sources cannot be symlinks");
  if (stat.isDirectory()) return { kind: "directory", path: await fs.realpath(candidate) };
  if (!stat.isFile() || stat.nlink !== 1 || !candidate.endsWith(".json")) throw new Error("Marketplace source must be a directory, manifest JSON, GitHub repository or HTTPS URL");
  const directory = path.basename(path.dirname(candidate)) === ".claude-plugin" ? path.dirname(path.dirname(candidate)) : path.dirname(candidate);
  if (path.basename(candidate) !== "marketplace.json") throw new Error("Local marketplace manifest must be named marketplace.json");
  return { kind: "directory", path: await fs.realpath(directory) };
}

function manifestFile(files: TreeFile[]): TreeFile {
  const file = files.find((entry) => entry.name === ".claude-plugin/marketplace.json") ?? files.find((entry) => entry.name === "marketplace.json");
  if (!file || file.bytes.length > 512 * 1024) throw new Error("Marketplace requires a bounded .claude-plugin/marketplace.json or marketplace.json");
  return file;
}

async function fetchSource(source: MarketplaceSource, temporary: string, options: MarketplaceOptions): Promise<{ files: TreeFile[]; commit?: string }> {
  checkAbort(options.signal);
  if (source.kind === "directory") return { files: await readLocalTree(source.path, options.signal) };
  if (source.kind === "url") return { files: [{ name: "marketplace.json", bytes: await downloadManifest(source.url, options.signal, options.allowLoopback), executable: false }] };
  // A marketplace Git repository can hold hundreds of unrelated bundles. Read
  // only its catalog now; installation reads the selected bundle at this commit.
  return readGitTree(path.join(temporary, "git"), source.url, source.ref, source.sha, options.signal, [".claude-plugin/marketplace.json", "marketplace.json"]);
}

async function readSnapshot(directory: string, record: MarketplaceRecord, options: MarketplaceOptions): Promise<{ files: TreeFile[]; manifest: ParsedManifest }> {
  const target = path.resolve(directory, record.snapshot); if (!inside(directory, target)) throw new Error("Marketplace snapshot escapes storage");
  const files = await readLocalTree(target, options.signal); const file = manifestFile(files);
  if (sha256(file.bytes) !== record.manifestHash || treeDigest(files) !== record.treeHash) throw new Error("Marketplace snapshot changed after registration; update it explicitly before installing");
  const manifest = parseManifest(file.bytes, options); if (manifest.name !== record.name) throw new Error("Marketplace snapshot name does not match provenance");
  return { files, manifest };
}

export async function addMarketplace(cwd: string, input: string | MarketplaceSource, options: MarketplaceOptions = {}): Promise<{ record: MarketplaceRecord; plugins: MarketplacePlugin[]; diagnostics: string[] }> {
  const store = await storage(cwd);
  return locked(store.directory, async () => {
    const saved = await registry(store.registryPath, options); const source = await inputSource(store.root, input, options); const temporary = path.join(store.directory, `.staging-${randomUUID()}`);
    await plainDirectory(temporary, true);
    try {
      const fetched = await fetchSource(source, temporary, options); const file = manifestFile(fetched.files); const manifest = parseManifest(file.bytes, options);
      if (Object.hasOwn(saved.value.marketplaces, manifest.name)) throw new Error(`Marketplace ${manifest.name} is already registered; use marketplace update`);
      if (Object.keys(saved.value.marketplaces).length >= 32) throw new Error("At most 32 marketplaces may be registered");
      const relative = `snapshots/${manifest.name}-${randomUUID()}`; const destination = path.join(store.directory, relative); await writeTree(destination, fetched.files, options.signal);
      const record: MarketplaceRecord = { name: manifest.name, source, snapshot: relative, manifestHash: sha256(file.bytes), treeHash: treeDigest(fetched.files), ...(fetched.commit ? { commit: fetched.commit } : {}), updatedAt: new Date().toISOString() };
      checkAbort(options.signal); await atomicRegistry(store.registryPath, { ...saved.value, marketplaces: { ...saved.value.marketplaces, [record.name]: record } }, saved.text);
      return { record, plugins: manifest.plugins, diagnostics: manifest.diagnostics };
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  });
}

export async function updateMarketplace(cwd: string, name: string, options: MarketplaceOptions = {}): Promise<{ record: MarketplaceRecord; plugins: MarketplacePlugin[]; diagnostics: string[] }> {
  identifier(name, "marketplace name"); const store = await storage(cwd);
  return locked(store.directory, async () => {
    const saved = await registry(store.registryPath, options); const existing = saved.value.marketplaces[name]; if (!existing) throw new Error(`Unknown marketplace: ${name}`);
    const temporary = path.join(store.directory, `.staging-${randomUUID()}`); await plainDirectory(temporary, true);
    try {
      const fetched = await fetchSource(existing.source, temporary, options); const file = manifestFile(fetched.files); const manifest = parseManifest(file.bytes, options);
      if (manifest.name !== name) throw new Error("Marketplace update changed its name; remove it and add the new source explicitly");
      const relative = `snapshots/${name}-${randomUUID()}`; await writeTree(path.join(store.directory, relative), fetched.files, options.signal);
      const record: MarketplaceRecord = { ...existing, snapshot: relative, manifestHash: sha256(file.bytes), treeHash: treeDigest(fetched.files), ...(fetched.commit ? { commit: fetched.commit } : {}), updatedAt: new Date().toISOString() };
      checkAbort(options.signal); await atomicRegistry(store.registryPath, { ...saved.value, marketplaces: { ...saved.value.marketplaces, [name]: record } }, saved.text);
      return { record, plugins: manifest.plugins, diagnostics: manifest.diagnostics };
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  });
}

export async function removeMarketplace(cwd: string, name: string, options: MarketplaceOptions = {}): Promise<void> {
  identifier(name, "marketplace name"); const store = await storage(cwd);
  await locked(store.directory, async () => { checkAbort(options.signal); const saved = await registry(store.registryPath, options); if (!Object.hasOwn(saved.value.marketplaces, name)) throw new Error(`Unknown marketplace: ${name}`); const remaining = { ...saved.value.marketplaces }; delete remaining[name]; await atomicRegistry(store.registryPath, { ...saved.value, marketplaces: remaining }, saved.text); });
}

export async function listMarketplaces(cwd: string, options: MarketplaceOptions = {}): Promise<MarketplaceRecord[]> {
  const store = await storage(cwd); checkAbort(options.signal); return Object.values((await registry(store.registryPath, options)).value.marketplaces);
}

export async function listMarketplacePlugins(cwd: string, name: string, options: MarketplaceOptions = {}): Promise<{ plugins: MarketplacePlugin[]; diagnostics: string[] }> {
  identifier(name, "marketplace name"); const store = await storage(cwd); const saved = await registry(store.registryPath, options); const record = saved.value.marketplaces[name]; if (!record) throw new Error(`Unknown marketplace: ${name}`); const { manifest } = await readSnapshot(store.directory, record, options); return { plugins: manifest.plugins, diagnostics: manifest.diagnostics };
}

export async function installMarketplacePlugin(cwd: string, selector: string, options: MarketplaceOptions = {}): Promise<MarketplaceInstallResult> {
  const parts = selector.split("@"); if (parts.length !== 2) throw new Error("Marketplace plugin selector must use plugin@marketplace");
  const pluginName = identifier(parts[0], "plugin name"); const marketplace = identifier(parts[1], "marketplace name"); const installedName = identifier(`${pluginName}.${marketplace}`, "installed plugin name"); const store = await storage(cwd);
  return locked(store.directory, async () => {
    const saved = await registry(store.registryPath, options); const record = saved.value.marketplaces[marketplace]; if (!record) throw new Error(`Unknown marketplace: ${marketplace}`);
    const { files, manifest } = await readSnapshot(store.directory, record, options); const entry = manifest.plugins.find((plugin) => plugin.name === pluginName); if (!entry) throw new Error(`Unknown marketplace plugin: ${selector}`);
    const temporary = path.join(store.directory, `.staging-${randomUUID()}`); await plainDirectory(temporary, true);
    try {
      let selected: TreeFile[]; let commit = record.commit;
      if (entry.source.kind === "unsupported") throw new Error(`Unsupported marketplace plugin source: ${entry.source.type}; command and dependency installers are never run`);
      if (entry.source.kind === "relative") {
        if (record.source.kind === "url") throw new Error("Relative plugin sources cannot resolve from a URL-only marketplace; use a Git or directory marketplace");
        const prefix = entry.source.path ? `${entry.source.path}/` : "";
        let sourceFiles = files;
        if (record.source.kind === "git") {
          if (!record.commit) throw new Error("Git marketplace is missing its pinned commit");
          sourceFiles = (await readGitTree(path.join(temporary, "git"), record.source.url, record.source.ref, record.commit, options.signal, entry.source.path ? [entry.source.path] : [])).files;
        }
        selected = sourceFiles.filter((file) => file.name.startsWith(prefix)).map((file) => ({ ...file, name: file.name.slice(prefix.length) }));
      } else {
        const fetched = await readGitTree(path.join(temporary, "git"), entry.source.url, entry.source.ref, entry.source.sha, options.signal, entry.source.path ? [entry.source.path] : []); commit = fetched.commit; const prefix = entry.source.path ? `${entry.source.path}/` : ""; selected = fetched.files.filter((file) => file.name.startsWith(prefix)).map((file) => ({ ...file, name: file.name.slice(prefix.length) }));
      }
      if (!selected.length) throw new Error("Marketplace plugin source directory is empty or missing");
      const treeHash = treeDigest(selected); const manifestHash = sha256(JSON.stringify(entry.manifest));
      const destination = path.join(store.root, ".hive", "plugins", `${installedName}-${treeHash.slice(0, 16)}-${randomUUID()}`);
      const converted = compatibleManifest(selected, installedName, destination, entry.manifest);
      const provenance = { version: 1, selector, marketplace, marketplaceManifestHash: record.manifestHash, manifestHash, treeHash, installedTreeHash: treeDigest(converted.files), ...(commit ? { commit } : {}), source: entry.source, installedAt: new Date().toISOString() };
      if (converted.files.some((file) => file.name.toLowerCase() === "hive.marketplace.json")) throw new Error("Plugin source collides with reserved provenance file hive.marketplace.json");
      converted.files.push({ name: "hive.marketplace.json", bytes: Buffer.from(JSON.stringify(provenance, null, 2)), executable: false });
      await writeTree(destination, converted.files, options.signal);
      const before = (await discoverExtensions(store.root, options)).plugins.find((plugin) => plugin.name === installedName);
      const plugin = options.replace ? await replaceLocalPlugin(store.root, installedName, destination, before?.path, options) : await installLocalPlugin(store.root, installedName, destination, options);
      return { plugin, marketplace, pluginName, manifestHash, treeHash, ...(commit ? { commit } : {}), warnings: converted.warnings };
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  });
}

/** Shared CLI/TUI marketplace dispatcher. All listing and download diagnostics are inert. */
export async function marketplaceCommand(cwd: string, args: string, options: MarketplaceOptions = {}): Promise<string[]> {
  const match = /^\s*(\S+)?(?:\s+([\s\S]*?))?\s*$/u.exec(args); const action = match?.[1] ?? "list"; const target = (match?.[2] ?? "").replace(/^(["'])([\s\S]*)\1$/u, "$2");
  if (action === "help") return ["/plugins marketplace add <directory|owner/repo|HTTPS Git URL|HTTPS marketplace.json>", "/plugins marketplace list [name] | update <name> | remove <name>", "/plugins install <plugin>@<marketplace> | update <plugin>@<marketplace>", "Installation copies a pinned snapshot, executes no plugin code, and requires separate trust and enable commands."];
  if (action === "list") {
    if (target) { const result = await listMarketplacePlugins(cwd, target, options); return [...result.plugins.map((plugin) => `${plugin.name}@${target}${plugin.version ? ` (${plugin.version})` : ""}: ${publicText(plugin.description)}${plugin.source.kind === "unsupported" ? ` [unsupported ${plugin.source.type}]` : ""}`), ...result.diagnostics.map((line) => `Warning: ${publicText(line)}`)]; }
    const records = await listMarketplaces(cwd, options); return records.length ? records.map((record) => `${record.name}: ${record.source.kind} ${record.commit ? `commit ${record.commit}` : `snapshot ${record.treeHash}`} (${record.updatedAt})`) : ["No marketplaces registered."];
  }
  if (!target) throw new Error(`marketplace ${action} requires a source or name`);
  if (action === "remove") { await removeMarketplace(cwd, target, options); return [`Marketplace ${target} removed. Installed plugins and pinned snapshots were preserved.`]; }
  if (action === "add" || action === "update") { const result = action === "add" ? await addMarketplace(cwd, target, options) : await updateMarketplace(cwd, target, options); return [`Marketplace ${result.record.name}: ${result.plugins.length} plugin(s), pinned ${result.record.commit ?? result.record.treeHash}. Installed plugins were not changed.`, ...result.diagnostics.map((line) => `Warning: ${publicText(line)}`)]; }
  throw new Error("Unknown marketplace action; use /plugins marketplace help");
}
