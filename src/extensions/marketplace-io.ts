import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { oauthNetworkRequest, resolveOAuthAddress, validateOAuthUrl, type OAuthLookup } from "../security/oauth-network.js";
import { cancelled, inside, missing, object, publicText } from "./io.js";

export const MAX_TREE_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 4 * 1024 * 1024;
const MAX_FILES = 2048;
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
export interface TreeFile { name: string; bytes: Buffer; executable: boolean }

export function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw cancelled(); }

export function bundlePath(value: string): string {
  const normalized = value.replace(/^\.\//u, "");
  if (normalized === "." || normalized === "") return "";
  const parts = normalized.split("/");
  if (normalized.length > 1024 || parts.some((part) => !part || part === "." || part === ".." || /[\\\u0000-\u001f\u007f:*?"<>|]/u.test(part) || /[. ]$/u.test(part) || /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(part))) throw new Error("Bundle paths must be portable relative paths without traversal");
  return parts.join("/");
}

export function safeRemote(value: string, allowLoopback = false): string {
  try {
    const url = validateOAuthUrl(value, { allowLoopbackOAuthHttp: allowLoopback });
    if (url.search) throw new Error("query strings are not allowed");
    return url.toString();
  } catch { throw new Error("Marketplace sources require public credential-free HTTPS URLs without query strings or fragments"); }
}

export async function plainDirectory(directory: string, create = false): Promise<void> {
  try {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(directory, await fs.realpath(directory)) !== "") throw new Error("Marketplace storage must use plain directories");
  } catch (error) {
    if (!missing(error) || !create) throw error;
    const parent = path.dirname(directory);
    if (parent === directory) throw error;
    await plainDirectory(parent, true);
    await fs.mkdir(directory, { mode: 0o700 }).catch((failure: unknown) => { if (!(failure instanceof Error && "code" in failure && failure.code === "EEXIST")) throw failure; });
    await plainDirectory(directory);
  }
}

function validateFile(name: string, bytes: Buffer): void {
  bundlePath(name);
  if (bytes.length > MAX_FILE_BYTES) throw new Error(`Marketplace file exceeds ${MAX_FILE_BYTES} bytes: ${name}`);
  const base = path.posix.basename(name);
  if (/^(?:\.env(?:\..*)?|id_rsa|id_ed25519|credentials(?:\.json)?|\.npmrc|\.netrc)$/iu.test(base) && !/\.(?:example|sample|template)$/iu.test(base)) throw new Error(`Credential file cannot be installed: ${name}`);
  if (/\.(?:pem|p12|pfx|key)$/iu.test(base)) throw new Error(`Private key files cannot be installed: ${name}`);
  // Binary assets are copied as bytes; inspect textual files for common credential formats.
  if (!bytes.includes(0) && /\b(?:sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16})\b|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/u.test(bytes.toString("utf8"))) throw new Error(`Marketplace file contains a credential: ${name}`);
}

function checkTree(files: TreeFile[]): void {
  if (files.length > MAX_FILES || files.reduce((size, file) => size + file.bytes.length, 0) > MAX_TREE_BYTES) throw new Error("Marketplace bundle exceeds the file count or 32 MiB limit");
  const names = new Set<string>();
  const spellings = new Map<string, string>();
  for (const file of files) {
    validateFile(file.name, file.bytes);
    const key = file.name.toLowerCase();
    if (names.has(key)) throw new Error("Marketplace bundle has duplicate or case-colliding paths");
    names.add(key);
    const parts = file.name.split("/");
    for (let index = 1; index <= parts.length; index += 1) {
      const prefix = parts.slice(0, index).join("/"); const canonical = prefix.toLowerCase(); const previous = spellings.get(canonical);
      if (previous !== undefined && previous !== prefix) throw new Error("Marketplace bundle has case-colliding directory or file paths");
      spellings.set(canonical, prefix);
    }
  }
  for (const key of names) {
    const components = key.split("/");
    for (let index = 1; index < components.length; index += 1) if (names.has(components.slice(0, index).join("/"))) throw new Error("Marketplace bundle path collides with a file");
  }
}

export async function readLocalTree(directory: string, signal?: AbortSignal): Promise<TreeFile[]> {
  await plainDirectory(directory);
  const files: TreeFile[] = [];
  let bytes = 0;
  const visit = async (relative: string): Promise<void> => {
    checkAbort(signal);
    const entries = await fs.readdir(path.join(directory, relative), { withFileTypes: true });
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if ([".git", ".hive", ".hivemind"].includes(entry.name)) continue;
      const name = bundlePath(relative ? `${relative}/${entry.name}` : entry.name);
      const file = path.join(directory, name);
      const before = await fs.lstat(file);
      if (before.isSymbolicLink() || (!before.isDirectory() && (!before.isFile() || before.nlink !== 1))) throw new Error(`Marketplace bundles cannot contain links or special files: ${name}`);
      if (before.isDirectory()) { await visit(name); continue; }
      if (files.length >= MAX_FILES || before.size > MAX_FILE_BYTES || bytes + before.size > MAX_TREE_BYTES) throw new Error("Marketplace bundle exceeds file or byte limits");
      const handle = await fs.open(file, "r");
      try {
        const opened = await handle.stat();
        if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || opened.mtimeMs !== before.mtimeMs) throw new Error("Marketplace source changed during snapshot");
        const buffer = Buffer.alloc(before.size + 1);
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
        const after = await fs.lstat(file);
        if (bytesRead !== before.size || after.isSymbolicLink() || after.ino !== before.ino || after.dev !== before.dev || after.size !== before.size || after.mtimeMs !== before.mtimeMs) throw new Error("Marketplace source changed during snapshot");
        const content = buffer.subarray(0, bytesRead);
        validateFile(name, content);
        files.push({ name, bytes: content, executable: !!(before.mode & 0o111) }); bytes += bytesRead;
      } finally { await handle.close(); }
    }
  };
  await visit(""); checkTree(files); return files;
}

export function treeDigest(files: TreeFile[]): string {
  return sha256(JSON.stringify([...files].sort((left, right) => left.name.localeCompare(right.name)).map((file) => [file.name, sha256(file.bytes), file.executable])));
}

/** Managed copies bind executable source bytes to their inspectable provenance. */
export async function marketplaceIntegrity(directory: string): Promise<string | undefined> {
  const file = path.join(directory, "hive.marketplace.json");
  try { await fs.lstat(file); } catch (error) { if (missing(error)) return undefined; throw error; }
  const files = await readLocalTree(directory);
  const provenanceFile = files.find((entry) => entry.name === "hive.marketplace.json");
  if (!provenanceFile) throw new Error("Marketplace plugin provenance is missing or not a regular file");
  const text = new TextDecoder("utf-8", { fatal: true }).decode(provenanceFile.bytes);
  const provenance = object(JSON.parse(text), "marketplace plugin provenance");
  if (provenance.version !== 1 || typeof provenance.installedTreeHash !== "string" || !/^[a-f0-9]{64}$/u.test(provenance.installedTreeHash)) throw new Error("Marketplace plugin provenance is invalid; reinstall the plugin");
  if (treeDigest(files.filter((entry) => entry.name !== "hive.marketplace.json")) !== provenance.installedTreeHash) throw new Error("Marketplace plugin files changed after installation; unregister and reinstall the plugin before trusting it again");
  // Provenance changes also change the plugin trust fingerprint, even if a local
  // writer recalculates its expected hash after changing executable source.
  return text;
}

export async function writeTree(directory: string, files: TreeFile[], signal?: AbortSignal): Promise<void> {
  checkTree(files); await plainDirectory(directory, true);
  for (const file of files) {
    checkAbort(signal);
    const destination = path.resolve(directory, file.name);
    if (!inside(directory, destination)) throw new Error("Bundle path escapes staging directory");
    await plainDirectory(path.dirname(destination), true);
    await fs.writeFile(destination, file.bytes, { flag: "wx", mode: file.executable ? 0o700 : 0o600 });
  }
}

export interface MarketplaceDownloadOptions { resolveAddress?: OAuthLookup; timeoutMs?: number }

export async function downloadManifest(url: string, signal?: AbortSignal, allowLoopback = false, options: MarketplaceDownloadOptions = {}): Promise<Buffer> {
  checkAbort(signal); safeRemote(url, allowLoopback);
  const timeoutMs = options.timeoutMs ?? 30_000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) throw new Error("Marketplace download deadline must be from 1 to 30000 milliseconds");
  const controller = new AbortController(); const timer = setTimeout(() => controller.abort(), timeoutMs);
  const requestSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  try {
    const response = await oauthNetworkRequest(url, { allowLoopbackOAuthHttp: allowLoopback, signal: requestSignal, maxResponseBytes: 512 * 1024, headers: { Accept: "application/json" } }, options.resolveAddress);
    if (response.status !== 200) throw new Error(`Marketplace download failed (${response.status}); redirects are not followed`);
    return response.bytes;
  } finally { clearTimeout(timer); }
}

async function diskBytes(directory: string): Promise<number> {
  let total = 0;
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch((error: unknown) => { if (missing(error)) return []; throw error; });
  for (const entry of entries) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await diskBytes(target);
    else if (entry.isFile()) total += await fs.stat(target).then((stat) => stat.size).catch((error: unknown) => { if (missing(error)) return 0; throw error; });
  }
  return total;
}

async function git(directory: string, args: string[], limit: number, signal?: AbortSignal, watchSize = false): Promise<Buffer> {
  checkAbort(signal);
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "TEMP", "TMP"]) if (process.env[key] !== undefined) env[key] = process.env[key];
  env.GIT_CONFIG_NOSYSTEM = "1"; env.GIT_CONFIG_GLOBAL = process.platform === "win32" ? "NUL" : "/dev/null"; env.GIT_TERMINAL_PROMPT = "0"; env.GIT_CONFIG_COUNT = "0";
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-c", "credential.helper=", "-c", "core.hooksPath=", "-c", "http.followRedirects=false", "-c", "http.extraHeader=", "-c", "protocol.allow=never", "-c", "protocol.https.allow=always", "-c", "protocol.file.allow=always", ...args], { cwd: directory, env, shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const output: Buffer[] = []; let bytes = 0; let diagnostic = ""; let failure: Error | undefined; let checking = false;
    const stop = (error: Error) => { failure ??= error; child.kill("SIGKILL"); };
    const abort = () => stop(cancelled());
    const timer = setTimeout(() => stop(new Error("Marketplace Git operation timed out")), 60_000);
    const monitor = watchSize ? setInterval(() => { if (checking) return; checking = true; void diskBytes(directory).then((size) => { if (size > 64 * 1024 * 1024) stop(new Error("Marketplace Git download exceeds 64 MiB")); }).catch((error: unknown) => stop(error instanceof Error ? error : new Error("Git storage check failed"))).finally(() => { checking = false; }); }, 100) : undefined;
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes > limit) stop(new Error("Marketplace Git output exceeds its limit")); else output.push(chunk); });
    child.stderr.on("data", (chunk: Buffer) => { if (diagnostic.length < 4096) diagnostic += chunk.toString("utf8").slice(0, 4096 - diagnostic.length); });
    child.once("error", (error) => { failure ??= error; });
    child.once("close", (code) => { clearTimeout(timer); if (monitor) clearInterval(monitor); signal?.removeEventListener("abort", abort); if (failure) reject(failure); else if (code !== 0) reject(new Error(`Marketplace Git operation failed: ${publicText(diagnostic).trim()}`)); else resolve(Buffer.concat(output)); });
  });
}

/** Fetch objects only: no working tree, hooks, submodules, LFS or clean/smudge filters. */
export function gitAddressPin(source: string, address: string): string {
  const url = new URL(source);
  return `${url.hostname}:${url.port || "443"}:${address.includes(":") ? `[${address}]` : address}`;
}

export async function readGitTree(staging: string, source: string, ref: string | undefined, sha: string | undefined, signal?: AbortSignal, fileScopes: string[] = []): Promise<{ files: TreeFile[]; commit: string }> {
  await plainDirectory(staging, true);
  await git(staging, ["init", "--bare", "--template=", "."], 8192, signal);
  const target = sha ?? ref ?? "HEAD";
  if (!target || target.length > 256 || target.startsWith("-") || /[\u0000-\u0020\u007f~^:?*\[\\]/u.test(target) || target.includes("..") || (sha !== undefined && !/^[a-f0-9]{40}$/u.test(sha))) throw new Error("Invalid marketplace Git ref or commit SHA");
  const publicHost = source.startsWith("https://") ? await resolveOAuthAddress(source, {}, signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000)) : undefined;
  const resolved = publicHost ? gitAddressPin(source, publicHost.address) : undefined;
  await git(staging, [...(resolved ? ["-c", `http.curloptResolve=${resolved}`] : []), "fetch", "--depth=1", "--no-tags", "--no-recurse-submodules", "--", source, target], 8192, signal, true);
  if (await diskBytes(staging) > 64 * 1024 * 1024) throw new Error("Marketplace Git download exceeds 64 MiB");
  const commit = (await git(staging, ["rev-parse", "--verify", "FETCH_HEAD^{commit}"], 128, signal)).toString("ascii").trim();
  if (!/^[a-f0-9]{40}$/u.test(commit) || (sha && sha !== commit)) throw new Error("Marketplace source did not resolve to the pinned commit");
  if (fileScopes.length > 16) throw new Error("At most 16 Git bundle paths may be selected");
  const selectedPaths = fileScopes.map((scope) => bundlePath(scope)).filter(Boolean);
  const listing = (await git(staging, ["ls-tree", "-rz", "--full-tree", commit, ...(selectedPaths.length ? ["--", ...selectedPaths] : [])], 1024 * 1024, signal)).toString("utf8").split("\0").filter(Boolean);
  if (listing.length > MAX_FILES) throw new Error("Marketplace Git tree exceeds the file count limit");
  const files: TreeFile[] = []; let total = 0;
  for (const entry of listing) {
    const match = /^(100644|100755) blob ([a-f0-9]{40})\t([\s\S]+)$/u.exec(entry);
    if (!match) throw new Error("Marketplace Git tree contains a link, submodule or unsupported entry");
    const size = Number((await git(staging, ["cat-file", "-s", match[2]], 64, signal)).toString("ascii").trim());
    if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES || total + size > MAX_TREE_BYTES) throw new Error("Marketplace Git tree exceeds file or byte limits");
    const bytes = await git(staging, ["cat-file", "blob", match[2]], MAX_FILE_BYTES, signal);
    validateFile(match[3], bytes); total += bytes.length;
    files.push({ name: match[3], bytes, executable: match[1] === "100755" });
  }
  checkTree(files); return { files, commit };
}

export async function atomicRegistry(file: string, value: unknown, before: string | null): Promise<void> {
  const directory = path.dirname(file); await plainDirectory(directory);
  const current = await readRegistryText(file);
  if (current !== before) throw new Error("Marketplace registry changed during the operation; no registry data was replaced");
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  if (bytes.length > 512 * 1024) throw new Error("Marketplace registry exceeds 512 KiB");
  const temporary = path.join(directory, `.${randomUUID()}.tmp`); await fs.writeFile(temporary, bytes, { flag: "wx", mode: 0o600 });
  let backup: string | undefined;
  try {
    if (await readRegistryText(file) !== before) throw new Error("Marketplace registry changed during publication");
    if (before !== null) { backup = path.join(directory, `.registry.${randomUUID()}.backup`); await fs.rename(file, backup); if (await readRegistryText(backup) !== before) throw new Error("Marketplace registry update conflicted; recover the retained backup"); }
    await fs.link(temporary, file);
  } catch (error) {
    if (backup) { const recovery = `${temporary}.recover`; try { await fs.copyFile(backup, recovery); await fs.link(recovery, file); } catch { /* Keep an existing winner and the recoverable displaced file. */ } finally { await fs.rm(recovery, { force: true }); } }
    throw error;
  } finally { await fs.rm(temporary, { force: true }); }
}

export async function readRegistryText(file: string): Promise<string | null> {
  try {
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > 512 * 1024) throw new Error("Marketplace registry must be a plain bounded file");
    const handle = await fs.open(file, "r");
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size || opened.mtimeMs !== stat.mtimeMs) throw new Error("Marketplace registry changed during read");
      const buffer = Buffer.alloc(512 * 1024 + 1); const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0); const after = await fs.lstat(file);
      if (bytesRead !== stat.size || after.isSymbolicLink() || after.dev !== stat.dev || after.ino !== stat.ino || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) throw new Error("Marketplace registry changed during read");
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } finally { await handle.close(); }
  } catch (error) { if (missing(error)) return null; throw error; }
}
