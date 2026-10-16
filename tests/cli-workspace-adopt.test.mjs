import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runCoderCli } from "../dist/cli.js";
import { inspectManagedWorktree, getCodingWorkspace } from "../dist/coding/runtime.js";
import { CodingSessionStore } from "../dist/coding/session-store.js";
import { acquireCodingSessionLease } from "../dist/coding/session-lease.js";
import { WorktreeManager } from "../dist/worktree.js";

const exec = promisify(execFile);
async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-cli-adopt-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  async function git(args) { return (await exec("git", args, { cwd: root })).stdout; }
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "hive@example.test"]);
  await git(["config", "user.name", "HIVE Test"]);
  await fs.writeFile(path.join(root, "file.txt"), "original\n");
  await fs.writeFile(path.join(root, ".gitignore"), ".hivemind/\n");
  await git(["add", "."]); await git(["commit", "-m", "fixture"]);
  const id = "adopt-source";
  const workspace = await new WorktreeManager(root).createWorktreeFrom(id, (await git(["rev-parse", "HEAD"])).trim());
  const store = new CodingSessionStore(root);
  const now = new Date().toISOString();
  const record = { schemaVersion: 1, id, objective: "Continue existing files", mode: "auto", approvalPolicy: "changes",
    status: "completed", createdAt: now, updatedAt: now, verdict: "ACCEPTED", tasks: [], events: [],
    providerBindings: [], validationResults: [], reviewResults: [], files: [],
    repository: { root, worktreePath: workspace, worktreeFingerprint: (await inspectManagedWorktree(root, id, workspace)).fingerprint,
      capturedAt: now, dirty: false, changedFiles: [] },
    finalReport: { evidenceCurrent: true, verdict: "ACCEPTED", validation: ["old"], review: ["old"] } };
  await store.save(record);
  const invoke = (tail = []) => runCoderCli(["sessions", "adopt", id, ...tail, "--json"], { cwd: root });
  return { root, id, workspace, store, record, invoke };
}

test("adoption previews without changing files or metadata, then explicitly invalidates old evidence", async (t) => {
  const { root, id, workspace, store, record, invoke } = await fixture(t);
  await fs.writeFile(path.join(workspace, "file.txt"), "user edit\n");
  await assert.rejects(getCodingWorkspace(root, id), /changed/);
  const before = await fs.readFile(path.join(store.getSessionDirectory(id), "session.json"));
  const preview = await invoke();
  assert.equal(preview.exitCode, 0, preview.output);
  const view = JSON.parse(preview.output);
  assert.equal(view.changed, true); assert.equal(view.adopted, false);
  assert.equal(view.savedFingerprint, record.repository.worktreeFingerprint);
  assert.match(view.confirmCommand, /--confirmed --fingerprint [a-f0-9]{64}$/);
  assert.deepEqual(await fs.readFile(path.join(store.getSessionDirectory(id), "session.json")), before);
  const accepted = await invoke(["--confirmed", "--fingerprint", view.fingerprint]);
  assert.equal(accepted.exitCode, 0, accepted.output); assert.equal(JSON.parse(accepted.output).adopted, true);
  const saved = await store.load(id);
  assert.equal(saved.repository.worktreeFingerprint, view.fingerprint);
  assert.equal(saved.status, "cancelled"); assert.equal(saved.verdict, "BLOCKED");
  assert.equal(saved.finalReport.evidenceCurrent, false);
  assert.deepEqual(saved.finalReport.validation, []); assert.deepEqual(saved.finalReport.review, []);
  assert.equal(await fs.readFile(path.join(workspace, "file.txt"), "utf8"), "user edit\n");
  assert.equal(await getCodingWorkspace(root, id), workspace);
});

test("adoption refuses stale previews, missing confirmation tokens and busy session writers", async (t) => {
  const { root, id, workspace, store, invoke } = await fixture(t);
  await fs.writeFile(path.join(workspace, "file.txt"), "first edit\n");
  const view = JSON.parse((await invoke()).output);
  await fs.writeFile(path.join(workspace, "file.txt"), "newer edit\n");
  const before = await fs.readFile(path.join(store.getSessionDirectory(id), "session.json"));
  const stale = await invoke(["--confirmed", "--fingerprint", view.fingerprint]);
  assert.equal(stale.exitCode, 1); assert.match(stale.output, /changed since adoption preview/);
  for (const invalid of [["--confirmed"], ["--fingerprint"], ["--fingerprint", view.fingerprint], ["--confirmed", "--fingerprint", "invalid"]]) {
    assert.equal((await invoke(invalid)).exitCode, 1);
  }
  const lease = await acquireCodingSessionLease(root, id);
  try { const busy = await invoke(); assert.equal(busy.exitCode, 1); assert.match(busy.output, /already in use/); }
  finally { await lease.release(); }
  assert.deepEqual(await fs.readFile(path.join(store.getSessionDirectory(id), "session.json")), before);
});

test("legacy fingerprints require explicit adoption and valid ownership; settled records alone cannot authorize it", async (t) => {
  const { workspace, store, record, invoke } = await fixture(t);
  record.repository.worktreeFingerprint = "f".repeat(64);
  await store.save(record);
  const preview = JSON.parse((await invoke()).output);
  assert.equal(preview.changed, true);
  assert.equal((await invoke(["--confirmed", "--fingerprint", preview.fingerprint])).exitCode, 0);
  for (const override of [{ archived: true }, { status: "running" }, { repository: { ...record.repository, worktreePath: path.join(workspace, "outside") } }]) {
    await store.save({ ...record, ...override });
    const result = await invoke(); assert.equal(result.exitCode, 1, result.output);
  }
});
