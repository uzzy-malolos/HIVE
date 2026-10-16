import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { findRepositoryRoot } from "./repository.js";
import { validateCodingSessionId } from "./session-store.js";

export interface CodingSessionLease {
  readonly root: string;
  readonly path: string;
  release(): Promise<void>;
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Coding session operation cancelled.", "AbortError");
}

async function leaseDirectory(root: string): Promise<string> {
  let directory = root;
  for (const component of [".hivemind", "session-leases"]) {
    directory = path.join(directory, component);
    try { await fs.mkdir(directory, { mode: 0o700 }); }
    catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || path.relative(directory, await fs.realpath(directory)) !== "") {
      throw new Error("Coding session leases require plain storage directories inside the canonical repository.");
    }
  }
  return directory;
}

/** A crashed writer leaves its lease for manual inspection; no PID or age-based stealing. */
export async function acquireCodingSessionLease(repositoryPath: string, sessionId: string, signal?: AbortSignal): Promise<CodingSessionLease> {
  validateCodingSessionId(sessionId);
  assertNotAborted(signal);
  return acquireCodingSessionLeaseAtRoot(await findRepositoryRoot(repositoryPath, signal), sessionId, signal);
}

/** Explicit metadata-only callers may already have a resolved root without a Git repository. */
export async function acquireCodingSessionLeaseAtRoot(repositoryRoot: string, sessionId: string, signal?: AbortSignal): Promise<CodingSessionLease> {
  validateCodingSessionId(sessionId);
  assertNotAborted(signal);
  const root = await fs.realpath(repositoryRoot);
  const directory = await leaseDirectory(root);
  assertNotAborted(signal);
  const file = path.join(directory, `${sessionId}.lock`);
  let handle: Awaited<ReturnType<typeof fs.open>>;
  try { handle = await fs.open(file, "wx+", 0o600); }
  catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new Error(`Coding session ${sessionId} is already in use or has an unrecovered lease: ${file}. If its owner crashed, inspect this lock and confirm no HIVE process is using the session before manually removing it. HIVE never steals an existing lease.`);
    }
    throw error;
  }
  const identity = await handle.stat();
  const text = `${JSON.stringify({ sessionId, pid: process.pid, acquiredAt: new Date().toISOString(), token: randomUUID() })}\n`;
  let released = false;
  const lease: CodingSessionLease = { root, path: file, async release() {
    if (released) return;
    released = true;
    try {
      const current = await fs.lstat(file);
      if (!current.isFile() || current.isSymbolicLink() || current.nlink !== 1 || current.dev !== identity.dev || current.ino !== identity.ino || current.size !== Buffer.byteLength(text)) {
        throw new Error(`Coding session lease ownership changed; preserved ${file} for inspection.`);
      }
      const contents = await fs.readFile(file, "utf8");
      if (contents !== text) throw new Error(`Coding session lease content changed; preserved ${file} for inspection.`);
      await fs.unlink(file);
    } finally { await handle.close(); }
  } };
  try {
    if (!identity.isFile() || identity.nlink !== 1) throw new Error("Coding session lease must be a regular single-link file.");
    await handle.writeFile(text, "utf8");
    await handle.sync();
    assertNotAborted(signal);
    return lease;
  } catch (error) {
    // A partially written lease stays visible if ownership cannot be established safely.
    await lease.release().catch(() => undefined);
    throw error;
  }
}

export async function withCodingSessionLease<T>(repositoryPath: string, sessionId: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const lease = await acquireCodingSessionLease(repositoryPath, sessionId, signal);
  try { return await operation(); }
  finally { await lease.release(); }
}

export async function withCodingSessionLeaseAtRoot<T>(repositoryRoot: string, sessionId: string, operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  const lease = await acquireCodingSessionLeaseAtRoot(repositoryRoot, sessionId, signal);
  try { return await operation(); }
  finally { await lease.release(); }
}
