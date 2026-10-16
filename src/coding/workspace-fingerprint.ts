import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, promises as fs, type BigIntStats } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const READ_BYTES = 64 * 1024;
const MAX_PATHS = 250_000;
const PATHS = ["--", ".", ":(exclude,top).hivemind"];
const FORMAT = "HIVE-WORKSPACE-RAW-v2";

type PresentKind = "file" | "directory" | "symlink";
type Observation = { kind: "missing" } | { kind: PresentKind; stat: BigIntStats };
type Observations = Map<string, Observation>;

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", ...args], {
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return result.stdout;
}

function inside(root: string, child: string): boolean {
  const relative = path.relative(root, child);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function safeName(name: string): void {
  if (!name || name.includes("\\") || path.isAbsolute(name) || name.includes("\ufffd") || name.split("/").some((part) => !part || part === "." || part === ".." || /[\x00-\x1f<>:"|?*]/.test(part) || /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`Cannot fingerprint an unsafe or unsupported Git path: ${JSON.stringify(name)}.`);
  }
}

function same(first: Observation, second: Observation): boolean {
  if (first.kind !== second.kind) return false;
  if (first.kind === "missing" || second.kind === "missing") return true;
  const a = first.stat;
  const b = second.stat;
  if (first.kind === "directory") return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode;
  return a.dev === b.dev && a.ino === b.ino && a.mode === b.mode && a.size === b.size && a.nlink === b.nlink && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
}

async function lstat(file: string): Promise<Observation> {
  const stat = await fs.lstat(file, { bigint: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return null;
    throw error;
  });
  if (!stat) return { kind: "missing" };
  if (stat.isSymbolicLink()) return { kind: "symlink", stat };
  if (stat.isDirectory()) return { kind: "directory", stat };
  if (stat.isFile()) return { kind: "file", stat };
  throw new Error(`Cannot fingerprint a non-regular workspace path: ${file}.`);
}

function remember(observations: Observations, file: string, observation: Observation): void {
  const before = observations.get(file);
  if (before && !same(before, observation)) throw new Error(`Workspace changed while fingerprinting: ${file}.`);
  observations.set(file, observation);
}

async function observe(root: string, name: string, parents: Observations): Promise<Observation> {
  safeName(name);
  const full = path.resolve(root, name);
  if (!inside(root, full)) throw new Error("Fingerprint path escapes its workspace.");
  let current = root;
  const rootState = await lstat(root);
  if (rootState.kind !== "directory" || path.relative(root, await fs.realpath(root)) !== "") throw new Error("Fingerprint workspace root is linked or no longer a plain directory.");
  remember(parents, root, rootState);
  for (const part of name.split("/").slice(0, -1)) {
    current = path.join(current, part);
    const state = await lstat(current);
    if (state.kind === "symlink") throw new Error(`Cannot fingerprint through an aliased parent: ${current}.`);
    remember(parents, current, state);
    if (state.kind === "missing" || state.kind === "file") return { kind: "missing" };
    if (path.relative(current, await fs.realpath(current)) !== "") throw new Error(`Cannot fingerprint through an aliased parent: ${current}.`);
  }
  return lstat(full);
}

async function regularDigest(root: string, name: string, before: Extract<Observation, { kind: PresentKind }>, parents: Observations, buffer: Buffer): Promise<string> {
  const file = path.resolve(root, name);
  const handle = await fs.open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat({ bigint: true });
    const openedState: Observation = { kind: "file", stat: opened };
    if (!opened.isFile() || !same(before, openedState) || !same(before, await observe(root, name, parents))) throw new Error(`Workspace file changed before reading: ${name}.`);
    const hash = createHash("sha256");
    let remaining = opened.size;
    while (remaining > 0n) {
      const length = Number(remaining < BigInt(buffer.length) ? remaining : BigInt(buffer.length));
      const result = await handle.read(buffer, 0, length, null);
      if (result.bytesRead === 0) throw new Error(`Workspace file changed while reading: ${name}.`);
      hash.update(buffer.subarray(0, result.bytesRead));
      remaining -= BigInt(result.bytesRead);
    }
    const after = await handle.stat({ bigint: true });
    if (!same(before, { kind: "file", stat: after }) || !same(before, await observe(root, name, parents))) throw new Error(`Workspace file changed while reading: ${name}.`);
    return hash.digest("hex");
  } finally { await handle.close(); }
}

async function verifyObservations(observations: Observations): Promise<void> {
  for (const [file, before] of observations) {
    const after = await lstat(file);
    if (!same(before, after)) throw new Error(`Workspace changed while fingerprinting: ${file}.`);
    if (after.kind === "directory" && path.relative(file, await fs.realpath(file)) !== "") throw new Error(`Workspace parent became aliased while fingerprinting: ${file}.`);
  }
}

function field(hash: ReturnType<typeof createHash>, value: string | Buffer): void {
  const data = typeof value === "string" ? Buffer.from(value, "utf8") : value;
  hash.update(String(data.length)).update(":").update(data);
}

function metadataName(name: string): boolean {
  return name === ".hivemind" || name.startsWith(".hivemind/");
}

function namesFromEntries(serialized: string, kind: "tree" | "index"): string[] {
  const names: string[] = [];
  for (const entry of serialized.split("\0").filter(Boolean)) {
    const tab = entry.indexOf("\t");
    if (tab < 0 || !/^[0-7]{6} /.test(entry)) throw new Error(`Cannot parse fingerprint Git ${kind} metadata.`);
    const name = entry.slice(tab + 1);
    if (metadataName(name)) continue;
    safeName(name);
    if (entry.startsWith("160000 ")) throw new Error(`Cannot fingerprint a Git submodule workspace safely: ${name}.`);
    names.push(name);
  }
  return names;
}

function withoutMetadata(serialized: string): string {
  return serialized.split("\0").filter((entry) => entry && !metadataName(entry.slice(entry.indexOf("\t") + 1))).join("\0");
}

function intentToAddFlags(serialized: string): string {
  const result: string[] = [];
  let cursor = 0;
  while (cursor < serialized.length) {
    const endName = serialized.indexOf("\0", cursor);
    if (endName < 0) throw new Error("Cannot parse Git index semantic flags.");
    const name = serialized.slice(cursor, endName);
    safeName(name);
    cursor = endName + 1;
    let flags: bigint | undefined;
    for (const prefix of ["  ctime:", "  mtime:", "  dev:", "  uid:", "  size:"]) {
      const endLine = serialized.indexOf("\n", cursor);
      if (endLine < 0) throw new Error("Cannot parse Git index semantic flags.");
      const line = serialized.slice(cursor, endLine);
      if (!line.startsWith(prefix)) throw new Error("Unsupported Git index debug metadata format.");
      if (prefix === "  size:") {
        const match = /\tflags: ([0-9a-f]+)$/i.exec(line);
        if (!match?.[1]) throw new Error("Cannot parse Git index intent-to-add flag.");
        flags = BigInt(`0x${match[1]}`);
      }
      cursor = endLine + 1;
    }
    if (flags === undefined) throw new Error("Git index semantic flags are missing.");
    // CE_INTENT_TO_ADD is not exposed by --stage, -v, or -f. Ignore debug
    // timestamps/stat caches while retaining this persistent semantic flag.
    result.push(name, (flags & 0x20000000n) !== 0n ? "intent-to-add" : "staged");
  }
  return result.join("\0");
}

interface IndexSnapshot { state: Observation; digest: string }

async function indexSnapshot(common: string, indexPath: string, parents: Observations, buffer: Buffer): Promise<IndexSnapshot> {
  const name = path.relative(common, indexPath).split(path.sep).join("/");
  const state = await observe(common, name, parents);
  if (state.kind === "missing") return { state, digest: "missing" };
  if (state.kind !== "file" || state.stat.nlink !== 1n) throw new Error("Fingerprint Git index must be a plain single-link file.");
  return { state, digest: await regularDigest(common, name, state, parents, buffer) };
}

/** Raw v2 fingerprints never invoke Git status, diff, filters, textconv, or fsmonitor. */
export async function rawWorkspaceFingerprint(worktreePath: string): Promise<string> {
  const root = await fs.realpath(worktreePath);
  if (path.relative(path.resolve(worktreePath), root) !== "") throw new Error("Fingerprint workspace path must be canonical.");
  const [commonOutput, indexOutput, firstHead] = await Promise.all([
    git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(root, ["rev-parse", "--path-format=absolute", "--git-path", "index"]),
    git(root, ["rev-parse", "HEAD"]),
  ]);
  const common = await fs.realpath(commonOutput.trim());
  const indexPath = path.resolve(indexOutput.trim());
  if (!inside(common, indexPath)) throw new Error("Fingerprint Git index escapes its verified repository.");
  const buffer = Buffer.allocUnsafe(READ_BYTES);
  const indexParents: Observations = new Map();
  const initialIndex = await indexSnapshot(common, indexPath, indexParents, buffer);
  const head = firstHead.trim();
  if (!/^[a-f0-9]{40,64}$/i.test(head)) throw new Error("Fingerprint requires a committed Git HEAD.");
  const [tree, staged, flags, monitorFlags, debugFlags, untracked] = await Promise.all([
    git(root, ["ls-tree", "-r", "-z", "--full-tree", head]),
    git(root, ["ls-files", "--stage", "-z", ...PATHS]),
    git(root, ["ls-files", "-v", "-z", ...PATHS]),
    git(root, ["ls-files", "-f", "-z", ...PATHS]),
    git(root, ["ls-files", "--debug", "-z", ...PATHS]),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z", ...PATHS]),
  ]);
  const names = new Set([...namesFromEntries(tree, "tree"), ...namesFromEntries(staged, "index"), ...untracked.split("\0").filter(Boolean)]);
  if (names.size > MAX_PATHS) throw new Error("Workspace exceeds the 250,000-path fingerprint limit.");
  const hash = createHash("sha256");
  const intentFlags = intentToAddFlags(debugFlags);
  for (const part of [FORMAT, head, withoutMetadata(tree), staged, flags, monitorFlags, intentFlags, untracked]) field(hash, part);
  const parents: Observations = new Map();
  const leaves: Observations = new Map();
  for (const name of [...names].sort()) {
    const state = await observe(root, name, parents);
    const full = path.resolve(root, name);
    remember(leaves, full, state);
    field(hash, name);
    field(hash, state.kind);
    if (state.kind === "missing") continue;
    field(hash, String(state.stat.mode & 0o777n));
    if (state.kind === "file") {
      field(hash, state.stat.size.toString());
      field(hash, await regularDigest(root, name, state, parents, buffer));
    } else if (state.kind === "symlink") {
      const target = await fs.readlink(full, { encoding: "buffer" });
      if (!same(state, await observe(root, name, parents))) throw new Error(`Workspace symlink changed while fingerprinting: ${name}.`);
      field(hash, target);
    }
  }
  await verifyObservations(parents);
  await verifyObservations(leaves);
  const [lastHead, lastStaged, lastFlags, lastMonitorFlags, lastDebugFlags, lastUntracked] = await Promise.all([
    git(root, ["rev-parse", "HEAD"]), git(root, ["ls-files", "--stage", "-z", ...PATHS]),
    git(root, ["ls-files", "-v", "-z", ...PATHS]), git(root, ["ls-files", "-f", "-z", ...PATHS]),
    git(root, ["ls-files", "--debug", "-z", ...PATHS]),
    git(root, ["ls-files", "--others", "--exclude-standard", "-z", ...PATHS]),
  ]);
  const finalIndex = await indexSnapshot(common, indexPath, indexParents, buffer);
  await verifyObservations(indexParents);
  if (lastHead.trim() !== head || staged !== lastStaged || flags !== lastFlags || monitorFlags !== lastMonitorFlags || intentFlags !== intentToAddFlags(lastDebugFlags) || untracked !== lastUntracked || initialIndex.digest !== finalIndex.digest || !same(initialIndex.state, finalIndex.state)) throw new Error("Git HEAD, index, or visible files changed while fingerprinting the workspace.");
  return hash.digest("hex");
}
