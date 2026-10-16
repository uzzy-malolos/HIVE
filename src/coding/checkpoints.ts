import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { constants } from "node:fs";
import { projectPatch, CHECKPOINT_FILE_LIMIT, CHECKPOINT_BATCH_LIMIT } from "./patch-projection.js";

export { CHECKPOINT_FILE_LIMIT, CHECKPOINT_BATCH_LIMIT } from "./patch-projection.js";
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;
const CHECKPOINT_ID = /^checkpoint-[0-9a-f-]{36}$/;
const HASH = /^[0-9a-f]{64}$/;
const FORBIDDEN = /^(?:\.git|\.hive|\.hivemind|node_modules|\.ssh|\.aws|\.azure|\.gnupg|\.secrets|\.env.*|\.npmrc|\.netrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/i;
const BARE_SECRET_FILE = /^(?:credentials?|secrets?|tokens?)$/i;
const SECRET_STORE = /^(?:credentials?|secrets?|tokens?)(?:[._-].*)?\.(?:json5?|jsonl|ya?ml|toml|env|ini|txt|key|pem|p12|pfx|db|sqlite3?)(?:[._-].*)?$/i;
const WINDOWS_DEVICE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i;
type Status = "pending" | "complete" | "failed" | "restoring" | "restored" | "recovery-required";
interface Snapshot { hash: string | null; size: number; mode?: number }
interface CheckpointFile { path: string; before: Snapshot; after?: Snapshot }
interface Manifest {
  version: 1;
  id: string;
  sessionId: string;
  operation: string;
  createdAt: string;
  status: Status;
  nonce: string;
  files: CheckpointFile[];
  appliedPaths?: string[];
  recoveryFiles?: { path: string; storagePath: string }[];
}
export interface CheckpointSummary { id: string; operation: string; createdAt: string; status: Status; paths: string[] }
export interface CheckpointPreview {
  id: string;
  operation: string;
  status: Status;
  paths: { path: string; action: "restore" | "delete" | "recreate"; currentHash: string | null; targetHash: string | null }[];
  restorable: boolean;
  conflicts: string[];
  confirmationToken?: string;
}

function digest(bytes: Buffer | string): string { return createHash("sha256").update(bytes).digest("hex"); }
function isMissing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
function same(left: Snapshot, right: Snapshot): boolean { return left.hash === right.hash && left.size === right.size && left.mode === right.mode; }
function record(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
class CheckpointMutationError extends Error {
  constructor(readonly recoveryRequired: boolean) { super("Checkpoint replacement failed safely; inspect its recovery manifest."); }
}
async function boundedRead(absolute: string, limit: number): Promise<Buffer> {
  const file = await fs.open(absolute, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.nlink > 1 || stat.size > limit) throw new Error("Checkpoint data must be a bounded regular file without hard links.");
    const bytes = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const { bytesRead } = await file.read(bytes, length, bytes.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    if (length !== stat.size) throw new Error("Checkpoint data changed during its read.");
    return bytes.subarray(0, length);
  } finally { await file.close(); }
}
function safeRelative(value: string, parentDirectory = false): string {
  if (typeof value !== "string" || !value || /[\x00-\x1f<>:"|?*]/.test(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error("Checkpoint file must be an exact workspace-relative path.");
  }
  const parts = value.replace(/\\/g, "/").split("/");
  if (parts.some((part, index) => !part || part === "." || part === ".." || /[. ]$/.test(part) || FORBIDDEN.test(part) || SECRET_STORE.test(part) || WINDOWS_DEVICE.test(part) ||
      (!parentDirectory && index === parts.length - 1 && BARE_SECRET_FILE.test(part)))) {
    throw new Error("Checkpoint path is unsafe, sensitive, or internal metadata.");
  }
  return parts.join("/");
}
function parseSnapshot(value: unknown): Snapshot {
  if (!record(value) || !(value.hash === null || (typeof value.hash === "string" && HASH.test(value.hash))) ||
      typeof value.size !== "number" || !Number.isSafeInteger(value.size) || value.size < 0 || value.size > CHECKPOINT_FILE_LIMIT ||
      (value.hash === null ? value.size !== 0 || value.mode !== undefined : typeof value.mode !== "number" || !Number.isInteger(value.mode) || value.mode < 0 || value.mode > 0o777)) {
    throw new Error("Checkpoint snapshot metadata is invalid.");
  }
  return { hash: value.hash, size: value.size, ...(typeof value.mode === "number" ? { mode: value.mode } : {}) };
}
function parseManifest(value: unknown, id: string, sessionId: string): Manifest {
  if (!record(value) || value.version !== 1 || value.id !== id || value.sessionId !== sessionId ||
      typeof value.operation !== "string" || !/^[a-z_]{1,64}$/.test(value.operation) ||
      typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt)) ||
      typeof value.nonce !== "string" || !HASH.test(value.nonce) ||
      typeof value.status !== "string" || !["pending", "complete", "failed", "restoring", "restored", "recovery-required"].includes(value.status) ||
      !Array.isArray(value.files) || value.files.length === 0 || value.files.length > 128) {
    throw new Error("Checkpoint manifest is invalid.");
  }
  const seen = new Set<string>();
  let totalBytes = 0;
  const files = value.files.map((file: unknown): CheckpointFile => {
    if (!record(file) || typeof file.path !== "string") throw new Error("Checkpoint file metadata is invalid.");
    const filePath = safeRelative(file.path);
    const key = process.platform === "win32" ? filePath.toLowerCase() : filePath;
    if (seen.has(key)) throw new Error("Checkpoint contains duplicate file paths.");
    seen.add(key);
    const before = parseSnapshot(file.before);
    const after = file.after === undefined ? undefined : parseSnapshot(file.after);
    totalBytes += before.size + (after?.size ?? 0);
    return { path: filePath, before, after };
  });
  if (totalBytes > CHECKPOINT_BATCH_LIMIT) throw new Error("Checkpoint exceeds the 8 MiB snapshot limit.");
  const recoveryFiles: NonNullable<Manifest["recoveryFiles"]> = [];
  if (value.recoveryFiles !== undefined) {
    if (!Array.isArray(value.recoveryFiles)) throw new Error("Checkpoint recovery metadata is invalid.");
    const prefix = `.hivemind/checkpoints/${sessionId}/${id}/`;
    for (const entry of value.recoveryFiles) {
      if (!record(entry) || typeof entry.path !== "string" || typeof entry.storagePath !== "string" ||
          !entry.storagePath.startsWith(prefix) || !/^(?:restore-[0-9a-f-]{36}\.tmp|displaced-[0-9a-f-]{36}\.bin)$/.test(entry.storagePath.slice(prefix.length))) {
        throw new Error("Checkpoint recovery metadata is invalid.");
      }
      recoveryFiles.push({ path: safeRelative(entry.path), storagePath: entry.storagePath });
    }
  }
  return { version: 1, id, sessionId, operation: value.operation, createdAt: value.createdAt,
    status: value.status as Status, nonce: value.nonce, files, recoveryFiles };
}

/** Private bounded byte snapshots for built-in writes, independent of conversation rewind. */
export class CheckpointStore {
  readonly #root: string;
  readonly #sessionId: string;

  constructor(cwd: string, sessionId: string) {
    if (!SAFE_ID.test(sessionId) || sessionId.endsWith(".") || WINDOWS_DEVICE.test(sessionId)) throw new Error("CheckpointStore requires a safe session id.");
    this.#root = path.resolve(cwd);
    this.#sessionId = sessionId;
  }

  async #safeAbsolute(relative: string, metadata = false, createDirectories = false): Promise<string> {
    const normalized = metadata ? relative : safeRelative(relative);
    const rootReal = await fs.realpath(this.#root);
    const parts = normalized.split("/");
    let current = this.#root;
    for (let index = 0; index < parts.length; index += 1) {
      current = path.join(current, parts[index]);
      if (createDirectories) await fs.mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => { if (error.code !== "EEXIST") throw error; });
      try {
        const stat = await fs.lstat(current);
        if (stat.isSymbolicLink()) throw new Error("Checkpoint paths cannot contain symbolic links.");
        if (index < parts.length - 1 && !stat.isDirectory()) throw new Error("Checkpoint parent path must be a directory.");
        const real = await fs.realpath(current);
        const relativeReal = path.relative(rootReal, real);
        if (relativeReal === ".." || relativeReal.startsWith(`..${path.sep}`) || path.isAbsolute(relativeReal)) {
          throw new Error("Checkpoint path escapes the workspace.");
        }
        if (!metadata) safeRelative(relativeReal.replace(/\\/g, "/"), index < parts.length - 1);
      } catch (error) { if (!isMissing(error)) throw error; }
    }
    return current;
  }

  #relativeDirectory(id?: string): string {
    if (id !== undefined && !CHECKPOINT_ID.test(id)) throw new Error("Invalid checkpoint id.");
    return [".hivemind", "checkpoints", this.#sessionId, id].filter(Boolean).join("/");
  }

  async #atomicFile(relative: string, bytes: Buffer, mode = 0o600): Promise<void> {
    const target = await this.#safeAbsolute(relative, true);
    const temporary = `${relative}.${randomUUID()}.tmp`;
    const tempPath = await this.#safeAbsolute(temporary, true);
    const handle = await fs.open(tempPath, "wx", mode);
    try {
      try { await handle.writeFile(bytes); await handle.sync(); } finally { await handle.close(); }
      await this.#safeAbsolute(relative, true);
      await fs.rename(tempPath, target);
    } finally { await fs.unlink(tempPath).catch((error) => { if (!isMissing(error)) throw error; }); }
  }

  async #save(manifest: Manifest): Promise<void> {
    const bytes = Buffer.from(JSON.stringify(manifest));
    if (bytes.length > 128 * 1024) throw new Error("Checkpoint manifest exceeds its limit.");
    await this.#atomicFile(`${this.#relativeDirectory(manifest.id)}/manifest.json`, bytes);
  }

  async #load(id: string): Promise<Manifest> {
    const manifestPath = await this.#safeAbsolute(`${this.#relativeDirectory(id)}/manifest.json`, true);
    const stat = await fs.lstat(manifestPath);
    if (!stat.isFile() || stat.size > 128 * 1024) throw new Error("Checkpoint manifest is not a bounded regular file.");
    return parseManifest(JSON.parse((await boundedRead(manifestPath, 128 * 1024)).toString("utf8")), id, this.#sessionId);
  }

  async #read(relative: string): Promise<{ snapshot: Snapshot; bytes?: Buffer }> {
    const absolute = await this.#safeAbsolute(relative);
    let stat;
    try { stat = await fs.lstat(absolute); } catch (error) { if (isMissing(error)) return { snapshot: { hash: null, size: 0 } }; throw error; }
    if (!stat.isFile() || stat.nlink > 1) throw new Error("Checkpoint targets must be regular files without hard links.");
    if (stat.size > CHECKPOINT_FILE_LIMIT) throw new Error("Checkpoint files are limited to 2 MiB each.");
    const file = await fs.open(absolute, "r");
    let bytes: Buffer;
    try {
      const opened = await file.stat();
      await this.#safeAbsolute(relative);
      if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== stat.size) throw new Error("Checkpoint file changed while opening.");
      bytes = Buffer.alloc(stat.size + 1);
      let read = 0;
      while (read < bytes.length) {
        const { bytesRead } = await file.read(bytes, read, bytes.length - read, read);
        if (!bytesRead) break;
        read += bytesRead;
      }
      if (read !== stat.size) throw new Error("Checkpoint file changed while reading.");
      bytes = bytes.subarray(0, read);
    } finally { await file.close(); }
    return { snapshot: { hash: digest(bytes), size: bytes.length, mode: stat.mode & 0o777 }, bytes };
  }

  async #capture(manifest: Manifest, side: "before" | "after"): Promise<void> {
    let total = manifest.files.reduce((sum, file) => sum + (side === "after" ? file.before.size : 0), 0);
    for (const file of manifest.files) {
      const { snapshot, bytes } = await this.#read(file.path);
      total += snapshot.size;
      if (total > CHECKPOINT_BATCH_LIMIT) throw new Error("Checkpoint snapshots exceed the 8 MiB batch limit.");
      if (bytes && snapshot.hash) await this.#atomicFile(`${this.#relativeDirectory(manifest.id)}/${snapshot.hash}.bin`, bytes);
      file[side] = snapshot;
    }
  }

  async #blob(id: string, snapshot: Snapshot): Promise<Buffer | undefined> {
    if (snapshot.hash === null) return undefined;
    const absolute = await this.#safeAbsolute(`${this.#relativeDirectory(id)}/${snapshot.hash}.bin`, true);
    const stat = await fs.lstat(absolute);
    if (!stat.isFile() || stat.size !== snapshot.size || stat.size > CHECKPOINT_FILE_LIMIT) throw new Error("Checkpoint snapshot is corrupt.");
    const bytes = await boundedRead(absolute, CHECKPOINT_FILE_LIMIT);
    if (digest(bytes) !== snapshot.hash) throw new Error("Checkpoint snapshot checksum mismatch.");
    return bytes;
  }

  async #assertCurrent(files: readonly CheckpointFile[], side: "before" | "after"): Promise<void> {
    for (const file of files) {
      const expected = file[side];
      if (!expected || !same((await this.#read(file.path)).snapshot, expected)) throw new Error(`Checkpoint conflict: ${file.path} changed outside this operation.`);
    }
  }

  async projectPatch(paths: readonly string[], patchText: string): Promise<{ afterContents: readonly (Buffer | null)[]; beforeHashes: ReadonlyMap<string, string | null> }> {
    const originals = new Map<string, Buffer | null>();
    const beforeHashes = new Map<string, string | null>();
    for (const file of paths) {
      const read = await this.#read(file);
      originals.set(file, read.bytes ?? null);
      beforeHashes.set(file, read.snapshot.hash);
    }
    const staging = `${this.#relativeDirectory()}/.projection-${randomUUID()}`;
    const absolute = await this.#safeAbsolute(staging, true, true);
    try {
      const projected = await projectPatch(originals, patchText, absolute);
      return { afterContents: paths.map((file) => projected.get(file) ?? null), beforeHashes };
    } finally {
      await this.#safeAbsolute(staging, true);
      await fs.rm(absolute, { recursive: true, force: true });
    }
  }

  async runWrite<T>(paths: readonly string[], operation: string, mutate: () => Promise<T>, proposedContents: readonly (string | Buffer | null)[], expectedHashes?: ReadonlyMap<string, string | null>): Promise<T> {
    if (!/^[a-z_]{1,64}$/.test(operation)) throw new Error("Invalid checkpoint operation.");
    if (paths.length === 0 || paths.length > 128) throw new Error("Checkpoint requires between 1 and 128 exact file paths.");
    const normalized = paths.map((file) => safeRelative(file));
    const keys = normalized.map((file) => process.platform === "win32" ? file.toLowerCase() : file);
    if (new Set(keys).size !== keys.length) throw new Error("Checkpoint paths must be unique.");
    if (!proposedContents || proposedContents.length !== paths.length) throw new Error("Checkpoint writes require exact intended output for every file.");
    if (proposedContents.some((content) => content !== null && Buffer.byteLength(content) > CHECKPOINT_FILE_LIMIT) ||
        proposedContents.reduce((sum, content) => sum + (content === null ? 0 : Buffer.byteLength(content)), 0) > CHECKPOINT_BATCH_LIMIT) {
      throw new Error("Checkpoint writes exceed the 2 MiB file or 8 MiB batch limit.");
    }
    const manifest: Manifest = { version: 1, id: `checkpoint-${randomUUID()}`, sessionId: this.#sessionId, operation,
      createdAt: new Date().toISOString(), status: "pending", nonce: randomBytes(32).toString("hex"),
      files: normalized.map((file) => ({ path: file, before: { hash: null, size: 0 } })) };
    // Verify every target before creating storage or running a mutation.
    let beforeBytes = 0;
    for (const file of manifest.files) {
      const current = await this.#read(file.path);
      beforeBytes += current.snapshot.size;
      if (beforeBytes + proposedContents.reduce((sum, content) => sum + (content === null ? 0 : Buffer.byteLength(content)), 0) > CHECKPOINT_BATCH_LIMIT) {
        throw new Error("Checkpoint before/after snapshots exceed the 8 MiB batch limit.");
      }
    }
    await this.#safeAbsolute(this.#relativeDirectory(manifest.id), true, true);
    await this.#save(manifest);
    try { await this.#capture(manifest, "before"); }
    catch (error) { manifest.status = "recovery-required"; await this.#save(manifest).catch(() => {}); throw error; }
    if (manifest.files.reduce((sum, file) => sum + file.before.size, 0) + proposedContents.reduce((sum, content) => sum + (content === null ? 0 : Buffer.byteLength(content)), 0) > CHECKPOINT_BATCH_LIMIT) {
      throw new Error("Checkpoint before/after snapshots exceed the 8 MiB batch limit.");
    }
    for (const file of manifest.files) {
      if (expectedHashes?.has(file.path) && expectedHashes.get(file.path) !== file.before.hash) throw new Error(`Checkpoint conflict: ${file.path} changed before the edit.`);
    }
    await this.#save(manifest);
    await this.#assertCurrent(manifest.files, "before");
    const matchesIntended = (allowBefore = false): boolean => manifest.files.every((file, index) => {
      const intended = proposedContents[index];
      return file.after && ((file.after.hash === (intended === null ? null : digest(intended)) &&
        file.after.size === (intended === null ? 0 : Buffer.byteLength(intended))) || (allowBefore && same(file.after, file.before)));
    });
    let result: T;
    try { result = await mutate(); } catch (error) {
      try { await this.#capture(manifest, "after"); manifest.status = matchesIntended(true) ? "failed" : "recovery-required"; await this.#save(manifest); }
      catch { manifest.status = "recovery-required"; await this.#save(manifest).catch(() => {}); }
      throw error;
    }
    try {
      await this.#capture(manifest, "after");
      if (!matchesIntended()) throw new Error("Files changed after the intended write.");
      manifest.status = "complete"; await this.#save(manifest);
    }
    catch {
      manifest.status = "recovery-required";
      await this.#save(manifest).catch(() => {});
      throw new Error(`Write completed, but checkpoint ${manifest.id} needs recovery; its durable pending manifest and before snapshots are retained.`);
    }
    return result;
  }

  async list(): Promise<CheckpointSummary[]> {
    let names: string[];
    try { names = await fs.readdir(await this.#safeAbsolute(this.#relativeDirectory(), true)); }
    catch (error) { if (isMissing(error)) return []; throw error; }
    const summaries: CheckpointSummary[] = [];
    for (const id of names.filter((name) => CHECKPOINT_ID.test(name))) {
      const manifest = await this.#load(id);
      summaries.push({ id, operation: manifest.operation, createdAt: manifest.createdAt, status: manifest.status, paths: manifest.files.map((file) => file.path) });
    }
    return summaries.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || right.id.localeCompare(left.id));
  }

  #token(manifest: Manifest): string {
    return digest(JSON.stringify({ id: manifest.id, nonce: manifest.nonce, files: manifest.files, status: manifest.status }));
  }

  async preview(id: string): Promise<CheckpointPreview> {
    const manifest = await this.#load(id);
    const conflicts: string[] = [];
    if (!["complete", "failed"].includes(manifest.status)) conflicts.push(`Checkpoint status is ${manifest.status}; automatic restore is unavailable.`);
    const paths: CheckpointPreview["paths"] = [];
    for (const file of manifest.files) {
      let currentHash: string | null = null;
      try {
        const { snapshot } = await this.#read(file.path);
        currentHash = snapshot.hash;
        if (!file.after || !same(snapshot, file.after)) conflicts.push(`${file.path}: current file differs from the recorded after snapshot.`);
        await this.#blob(id, file.before);
        if (file.after) await this.#blob(id, file.after);
        await fs.stat(path.dirname(await this.#safeAbsolute(file.path)));
      } catch { conflicts.push(`${file.path}: path or snapshot is unavailable or unsafe.`); }
      paths.push({ path: file.path, action: file.before.hash === null ? "delete" : file.after?.hash === null ? "recreate" : "restore", currentHash, targetHash: file.before.hash });
    }
    return { id, operation: manifest.operation, status: manifest.status, paths, restorable: conflicts.length === 0, conflicts,
      ...(conflicts.length === 0 ? { confirmationToken: this.#token(manifest) } : {}) };
  }

  async #replace(id: string, file: CheckpointFile, target: "before" | "after", expected: Snapshot,
    onApplied: () => Promise<void>, onDisplacement: (storagePath: string) => Promise<void>): Promise<void> {
    const snapshot = file[target];
    if (!snapshot) throw new Error("Checkpoint snapshot is unavailable.");
    const bytes = await this.#blob(id, snapshot);
    const absolute = await this.#safeAbsolute(file.path);
    if (!same((await this.#read(file.path)).snapshot, expected)) throw new Error(`Checkpoint conflict: ${file.path} changed during restore.`);
    const temporary = `${this.#relativeDirectory(id)}/restore-${randomUUID()}.tmp`;
    const tempPath = await this.#safeAbsolute(temporary, true);
    const displaced = `${this.#relativeDirectory(id)}/displaced-${randomUUID()}.bin`;
    const displacedPath = await this.#safeAbsolute(displaced, true);
    let moved = false;
    let committed = false;
    let replacedOriginal = false;
    let failed = false;
    let recoveryRequired = false;
    try {
      if (bytes !== undefined) {
        await onDisplacement(temporary);
        await fs.writeFile(tempPath, bytes, { flag: "wx", mode: snapshot.mode ?? 0o600 });
        await fs.chmod(tempPath, snapshot.mode ?? 0o600);
      }
      await this.#safeAbsolute(file.path);
      if (!same((await this.#read(file.path)).snapshot, expected)) throw new Error(`Checkpoint conflict: ${file.path} changed during restore.`);
      if (expected.hash !== null) {
        await onDisplacement(displaced);
        await this.#safeAbsolute(file.path);
        // Preserve the actual current inode before comparing it, so a concurrent edit is never clobbered.
        await fs.rename(absolute, displacedPath);
        moved = true;
        await onApplied();
        const stat = await fs.lstat(displacedPath);
        await this.#safeAbsolute(displaced, true);
        const actual = await boundedRead(displacedPath, CHECKPOINT_FILE_LIMIT);
        if (digest(actual) !== expected.hash || actual.length !== expected.size || (stat.mode & 0o777) !== expected.mode) {
          throw new Error("Checkpoint conflict: displaced file contains newer changes.");
        }
      }
      if (bytes !== undefined) {
        // An exclusive link preserves any file that appeared after the comparison.
        await fs.link(tempPath, absolute);
        if (!moved) await onApplied();
      }
      committed = true;
    } catch {
      failed = true;
      if (moved && !committed) {
        try { await fs.link(displacedPath, absolute); replacedOriginal = true; }
        catch { recoveryRequired = true; }
      }
    }
    if (bytes !== undefined) {
      try { await fs.unlink(tempPath); }
      catch (error) { if (!isMissing(error)) { failed = true; recoveryRequired = true; } }
    }
    if (moved) {
      if (replacedOriginal) {
        try { await fs.unlink(displacedPath); }
        catch { failed = true; recoveryRequired = true; }
      } else if (!committed) recoveryRequired = true;
      // Retain committed displaced inodes: writers holding an old descriptor can still write there.
      // The private recovery manifest maps these retained originals back to their workspace paths.
    }
    if (failed) throw new CheckpointMutationError(recoveryRequired);
  }

  async restore(id: string, confirmationToken: string): Promise<{ id: string; restoredPaths: string[]; invalidatesEvidence: true }> {
    const lockPath = await this.#safeAbsolute(`${this.#relativeDirectory(id)}/restore.lock`, true);
    let lock;
    try { lock = await fs.open(lockPath, "wx", 0o600); }
    catch (error) {
      if (error instanceof Error && "code" in error && error.code === "EEXIST") {
        throw new Error(`Checkpoint restore is already locked. If a prior process crashed, inspect ${lockPath} and remove that lock only after confirming no restore is active.`);
      }
      throw error;
    }
    try {
      await lock.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() }));
      return await this.#restoreLocked(id, confirmationToken);
    } finally {
      await lock.close();
      await fs.unlink(lockPath);
    }
  }

  async #restoreLocked(id: string, confirmationToken: string): Promise<{ id: string; restoredPaths: string[]; invalidatesEvidence: true }> {
    const manifest = await this.#load(id);
    const preview = await this.preview(id);
    if (!preview.restorable || !preview.confirmationToken) throw new Error(`Checkpoint cannot be restored: ${preview.conflicts.join(" ")}`);
    if (this.#token(manifest) !== preview.confirmationToken) throw new Error("Checkpoint manifest changed during restore; preview again.");
    if (typeof confirmationToken !== "string" || !HASH.test(confirmationToken) ||
        !timingSafeEqual(Buffer.from(confirmationToken), Buffer.from(preview.confirmationToken))) throw new Error("Checkpoint restore requires the exact preview confirmation token.");
    await this.#assertCurrent(manifest.files, "after");
    manifest.status = "restoring";
    manifest.appliedPaths = [];
    manifest.recoveryFiles ??= [];
    await this.#save(manifest);
    const applied: CheckpointFile[] = [];
    try {
      for (const file of manifest.files) {
        if (!file.after) throw new Error("Checkpoint after snapshot is unavailable.");
        await this.#replace(id, file, "before", file.after, async () => {
          applied.push(file);
          manifest.appliedPaths?.push(file.path);
          await this.#save(manifest);
        }, async (storagePath) => {
          manifest.recoveryFiles?.push({ path: file.path, storagePath });
          await this.#save(manifest);
        });
      }
      manifest.status = "restored";
      await this.#save(manifest);
    } catch (error) {
      let rolledBack = !(error instanceof CheckpointMutationError && error.recoveryRequired);
      for (const file of applied.reverse()) {
        try {
          if (file.after && same((await this.#read(file.path)).snapshot, file.after)) continue;
          await this.#replace(id, file, "after", file.before, async () => {}, async (storagePath) => {
            manifest.recoveryFiles?.push({ path: file.path, storagePath }); await this.#save(manifest);
          });
        } catch { rolledBack = false; }
      }
      manifest.status = rolledBack ? "complete" : "recovery-required";
      await this.#save(manifest).catch(() => { rolledBack = false; });
      throw new Error(rolledBack ? "Checkpoint restore failed; applied changes were rolled back. Preview again before retrying."
        : `Checkpoint restore needs manual recovery from ${id}; its manifest and both snapshots are retained. Newer edits were preserved.`);
    }
    return { id, restoredPaths: manifest.files.map((file) => file.path), invalidatesEvidence: true };
  }
}
