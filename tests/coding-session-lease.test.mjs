import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { acquireCodingSessionLease, acquireCodingSessionLeaseAtRoot, withCodingSessionLease } from "../dist/coding/session-lease.js";
import { createQueenSession } from "../dist/coding/runtime.js";
import { CodingSessionStore } from "../dist/coding/session-store.js";
import { CheckpointStore } from "../dist/coding/checkpoints.js";
import { runLocalCommand, rewindLocalFiles } from "../dist/tui/local-command.js";
import { runCoderCli } from "../dist/cli.js";
import { DefaultGuardedGitService } from "../dist/desktop/guarded-git-service.js";

const execFileAsync = promisify(execFile);
const leaseModule = pathToFileURL(path.resolve("dist/coding/session-lease.js")).href;

function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }

async function repository(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-session-lease-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "hive@example.test"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "HIVE Test"], { cwd: root });
  await fs.writeFile(path.join(root, "README.md"), "fixture\n");
  await fs.writeFile(path.join(root, "modify.cjs"), "require('node:fs').writeFileSync('result.txt', 'manual\\n');\n");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });
  return root;
}

async function runtime(root, options = {}, planner) {
  const result = await createQueenSession({ repositoryPath: root, objective: "Initial plan", sessionId: "leased-run",
    mode: "plan", approvalPolicy: "changes", maxAgents: 1, maxRetries: 0, ...options });
  let step = 0;
  result.providerRouter.bindingForRole = async (role) => ({ role, providerId: "fixture-provider" });
  result.providerRouter.complete = async (request) => {
    if (request.role === "planner") {
      await planner?.(request);
      return { output: JSON.stringify({ summary: "Implement one owned file", architecture: "One file", risks: [],
        acceptanceCriteria: ["Requested content exists"], validationCommands: ["node --version"],
        tasks: [{ key: "file", role: "builder", title: "Create result", objective: "Create the requested content", dependencies: [],
          fileScope: ["result.txt"], expectedOutput: "Updated result", completionCriteria: ["Correct content"], validationCommands: [] }] }) };
    }
    if (request.role === "builder" && step++ === 0) return { output: JSON.stringify({ done: false,
      toolCalls: [{ name: "create_file", arguments: { path: "result.txt", content: "generated\n" } }] }) };
    return { output: JSON.stringify({ done: true, summary: "Fixture role completed", data: { status: "passed", findings: [] } }) };
  };
  result.providerRouter.streamComplete = (request) => result.providerRouter.complete(request);
  return result;
}

async function leaseChild(t, root, id) {
  const code = `import { acquireCodingSessionLease } from ${JSON.stringify(leaseModule)};
    const lease = await acquireCodingSessionLease(${JSON.stringify(root)}, ${JSON.stringify(id)});
    process.stdout.write('lease ready\\n');
    process.stdin.once('data', async () => { await lease.release(); process.exit(0); });`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { cwd: root, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
  const closed = new Promise((resolve) => child.once("close", (code, signal) => resolve({ code, signal })));
  t.after(async () => { if (child.exitCode === null && child.signalCode === null) child.kill(); await closed; });
  await new Promise((resolve, reject) => {
    let output = ""; let errorOutput = "";
    const timer = setTimeout(() => reject(new Error(`Child lease fixture timed out: ${errorOutput}`)), 10_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => { clearTimeout(timer); if (!output.includes("lease ready")) reject(new Error(`Lease child exited ${code}: ${errorOutput}`)); });
    child.stderr.on("data", (chunk) => { errorOutput += chunk.toString(); });
    child.stdout.on("data", (chunk) => { output += chunk.toString(); if (output.includes("lease ready")) { clearTimeout(timer); resolve(); } });
  });
  return { child, closed };
}

test("a session lease is exclusive across nested paths and independent instances", async (t) => {
  const root = await repository(t);
  await fs.mkdir(path.join(root, "nested"));
  const lease = await acquireCodingSessionLease(root, "exclusive");
  try {
    assert.equal(JSON.parse(await fs.readFile(lease.path, "utf8")).pid, process.pid);
    await assert.rejects(acquireCodingSessionLease(path.join(root, "nested"), "exclusive"), /already in use.*unrecovered lease/);
    const different = await acquireCodingSessionLease(root, "independent");
    await different.release();
  } finally { await lease.release(); }
  await lease.release();
  const next = await acquireCodingSessionLease(root, "exclusive");
  await next.release();
});

test("another Node process holds the same repository and session lease", async (t) => {
  const root = await repository(t);
  const { child, closed } = await leaseChild(t, root, "cross-process");
  await assert.rejects(acquireCodingSessionLease(root, "cross-process"), /already in use/);
  child.stdin.write("release");
  assert.equal((await closed).code, 0);
  const lease = await acquireCodingSessionLease(root, "cross-process");
  await lease.release();
});

test("a crashed writer leaves a visible lock and is never automatically stolen", async (t) => {
  const root = await repository(t);
  const { child, closed } = await leaseChild(t, root, "crashed");
  child.kill();
  await closed;
  const file = path.join(root, ".hivemind", "session-leases", "crashed.lock");
  const original = await fs.readFile(file, "utf8");
  await assert.rejects(acquireCodingSessionLease(root, "crashed"), /confirm no HIVE process.*manually removing.*never steals/);
  assert.equal(await fs.readFile(file, "utf8"), original);
});

test("lease operations release after errors and cancellation, and reject unsafe storage and ids", async (t) => {
  const root = await repository(t);
  await assert.rejects(withCodingSessionLease(root, "failed", async () => { throw new Error("fixture failure"); }), /fixture failure/);
  const controller = new AbortController();
  await assert.rejects(withCodingSessionLease(root, "cancelled", async () => { controller.abort(); throw new DOMException("Cancelled", "AbortError"); }, controller.signal), { name: "AbortError" });
  for (const id of ["failed", "cancelled"]) { const lease = await acquireCodingSessionLease(root, id); await lease.release(); }
  await assert.rejects(acquireCodingSessionLease(root, "../escape"), /Invalid session id/);
  await assert.rejects(acquireCodingSessionLease(root, "preaborted", controller.signal), { name: "AbortError" });
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), "hive-lease-outside-"));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  const other = await repository(t);
  await fs.symlink(outside, path.join(other, ".hivemind"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(acquireCodingSessionLease(other, "unsafe"), /plain storage directories/);
  assert.deepEqual(await fs.readdir(outside), []);
});

test("release preserves replaced, modified, or hardlinked lock files", async (t) => {
  const root = await repository(t);
  const lease = await acquireCodingSessionLease(root, "changed");
  await fs.writeFile(lease.path, "another owner or manual edit");
  await assert.rejects(lease.release(), /ownership changed|content changed/);
  assert.equal(await fs.readFile(lease.path, "utf8"), "another owner or manual edit");
  const linked = await acquireCodingSessionLease(root, "hardlinked");
  const otherLink = path.join(root, "lock-alias");
  await fs.link(linked.path, otherLink);
  await assert.rejects(linked.release(), /ownership changed/);
  assert.equal(await fs.readFile(linked.path, "utf8"), await fs.readFile(otherLink, "utf8"));
});

test("two real continuations initialized before planning cannot lose each other's saved turn", async (t) => {
  const root = await repository(t);
  const initial = await runtime(root);
  assert.equal((await initial.orchestrator.run()).status, "completed");
  const entered = deferred(); const release = deferred();
  const first = await runtime(root, { sessionId: undefined, continuationId: "leased-run", objective: "First continuation" }, async () => { entered.resolve(); await release.promise; });
  const second = await runtime(root, { sessionId: undefined, continuationId: "leased-run", objective: "Second continuation" });
  const active = first.orchestrator.run();
  try {
    await entered.promise;
    const store = new CodingSessionStore(root);
    const before = await store.load("leased-run");
    await assert.rejects(second.orchestrator.run(), /already in use/);
    assert.deepEqual(await store.load("leased-run"), before, "the losing writer did not persist failure or stale state");
  } finally { release.resolve(); }
  const completed = await active;
  assert.equal(completed.status, "completed", JSON.stringify(completed.finalReport));
  assert.equal(completed.turnHistory.length, 1);
  assert.equal(completed.objective, "First continuation");
  const retried = await second.orchestrator.run();
  assert.equal(retried.status, "completed", JSON.stringify(retried.finalReport));
  assert.equal(retried.turnHistory.length, 2);
  assert.equal(retried.turnHistory[1].objective, "First continuation");
  assert.equal(retried.objective, "Second continuation");
});

test("fresh runs cannot overwrite a saved id and leases release after Queen failure and cancellation", async (t) => {
  const root = await repository(t);
  const initial = await runtime(root);
  const saved = await initial.orchestrator.run();
  const savedSnapshot = await new CodingSessionStore(root).load(saved.id);
  const replacement = await runtime(root, { objective: "Overwrite forbidden" });
  await assert.rejects(replacement.orchestrator.run(), /already exists.*resume or continue/);
  assert.deepEqual(await new CodingSessionStore(root).load(saved.id), savedSnapshot);
  const failed = await runtime(root, { sessionId: "failed-run" }, async () => { throw new Error("provider fixture failed"); });
  assert.equal((await failed.orchestrator.run()).status, "failed");
  const failureLease = await acquireCodingSessionLease(root, "failed-run"); await failureLease.release();
  const entered = deferred();
  const cancelled = await runtime(root, { sessionId: "cancelled-run" }, async (request) => { entered.resolve(); await new Promise((resolve, reject) => {
    request.signal.addEventListener("abort", () => reject(new DOMException("provider cancelled", "AbortError")), { once: true });
  }); });
  const pending = cancelled.orchestrator.run();
  await entered.promise;
  cancelled.orchestrator.cancel();
  assert.equal((await pending).status, "cancelled");
  const cancellationLease = await acquireCodingSessionLease(root, "cancelled-run"); await cancellationLease.release();
});

test("shell and rewind cannot mutate a managed workspace leased by another coding operation", async (t) => {
  const root = await repository(t);
  const initial = await runtime(root, { mode: "auto" });
  const record = await initial.orchestrator.run();
  assert.equal(record.status, "completed", JSON.stringify(record.finalReport));
  const [checkpoint] = await new CheckpointStore(record.repository.worktreePath, record.id).list();
  assert.ok(checkpoint);
  const savedSnapshot = await new CodingSessionStore(root).load(record.id);
  const lease = await acquireCodingSessionLease(root, record.id);
  let approvals = 0;
  const shared = { cwd: root, codingSessionId: record.id, signal: new AbortController().signal,
    requestPermission: async () => { approvals += 1; return true; } };
  try {
    await assert.rejects(runLocalCommand({ ...shared, command: "node modify.cjs", onEvent: () => {} }), /already in use/);
    await assert.rejects(rewindLocalFiles({ ...shared, checkpointId: checkpoint.id }), /already in use/);
    assert.equal(approvals, 0);
    assert.equal(await fs.readFile(path.join(record.repository.worktreePath, "result.txt"), "utf8"), "generated\n");
    assert.deepEqual(await new CodingSessionStore(root).load(record.id), savedSnapshot);
  } finally { await lease.release(); }
});

test("a pending shell permission holds the lease until denial settles", async (t) => {
  const root = await repository(t);
  const initial = await runtime(root, { mode: "auto" });
  const record = await initial.orchestrator.run();
  const entered = deferred(); const answer = deferred();
  const pending = runLocalCommand({ cwd: root, codingSessionId: record.id, command: "node modify.cjs", signal: new AbortController().signal,
    requestPermission: async () => { entered.resolve(); return answer.promise; }, onEvent: () => {} });
  await entered.promise;
  try { await assert.rejects(acquireCodingSessionLease(root, record.id), /already in use/); }
  finally { answer.resolve(false); }
  await assert.rejects(pending, /declined/);
  const lease = await acquireCodingSessionLease(root, record.id); await lease.release();
  assert.equal(await fs.readFile(path.join(record.repository.worktreePath, "result.txt"), "utf8"), "generated\n");
});

test("coding CLI metadata mutators honor the same lease and preserve non-Git metadata support", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-lease-metadata-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new CodingSessionStore(root);
  const timestamp = new Date().toISOString();
  await store.save({ schemaVersion: 1, id: "metadata", objective: "Saved metadata", mode: "plan", approvalPolicy: "safe", status: "completed",
    createdAt: timestamp, updatedAt: timestamp, repository: { root, capturedAt: timestamp, dirty: false, changedFiles: [] },
    tasks: [], events: [], providerBindings: [], validationResults: [], reviewResults: [], files: [] });
  await store.setActive("metadata");
  const before = await store.load("metadata");
  await assert.rejects(acquireCodingSessionLease(root, "requires-git"), /Unable to detect a Git repository/);
  const lease = await acquireCodingSessionLeaseAtRoot(root, "metadata");
  try {
    for (const args of [["reject"], ["discard"], ["sessions", "archive", "metadata"], ["sessions", "unarchive", "metadata"],
      ["sessions", "fork", "metadata"], ["sessions", "resume", "metadata"]]) {
      const result = await runCoderCli([...args, "--json"], { cwd: root });
      assert.equal(result.exitCode, 1, args.join(" "));
      assert.match(JSON.parse(result.output).error, /already in use/, args.join(" "));
      assert.deepEqual(await store.load("metadata"), before);
      assert.equal((await store.getActive()).id, "metadata");
      assert.equal((await store.list()).length, 1);
    }
  } finally { await lease.release(); }
  assert.equal((await runCoderCli(["sessions", "archive", "metadata", "--json"], { cwd: root })).exitCode, 0);
  assert.equal((await store.load("metadata")).archived, true);
  assert.equal((await runCoderCli(["sessions", "unarchive", "metadata", "--json"], { cwd: root })).exitCode, 0);
  const fork = await runCoderCli(["sessions", "fork", "metadata", "--json"], { cwd: root });
  assert.equal(fork.exitCode, 0);
  assert.notEqual(JSON.parse(fork.output).id, "metadata");
  await store.setActive("metadata");
  assert.equal((await runCoderCli(["reject", "--json"], { cwd: root })).exitCode, 0);
  assert.equal((await store.load("metadata")).verdict, "REJECTED");
  assert.equal((await runCoderCli(["discard", "--json"], { cwd: root })).exitCode, 0);
  assert.equal((await store.load("metadata")).status, "cancelled");
  assert.equal(await store.getActive(), null);
  const released = await acquireCodingSessionLeaseAtRoot(root, "metadata"); await released.release();
});

test("fork refuses unsettled coding metadata and releases its lease after validation failure", async (t) => {
  const root = await repository(t);
  const initial = await runtime(root);
  const completed = await initial.orchestrator.run();
  const store = new CodingSessionStore(root);
  await store.save({ ...completed, status: "running" });
  const result = await runCoderCli(["sessions", "fork", completed.id, "--json"], { cwd: root });
  assert.equal(result.exitCode, 1);
  assert.match(JSON.parse(result.output).error, /Only settled/);
  assert.equal((await store.list()).length, 1);
  const lease = await acquireCodingSessionLease(root, completed.id); await lease.release();
});

test("desktop commit and discard cannot cross an active session lease or discard an unsettled workspace", async (t) => {
  const root = await repository(t);
  const initial = await runtime(root, { mode: "auto" });
  const completed = await initial.orchestrator.run();
  assert.equal(completed.status, "completed", JSON.stringify(completed.finalReport));
  const store = new CodingSessionStore(root);
  const service = new DefaultGuardedGitService({ forge: { push: async () => { throw new Error("No network calls expected"); },
    createPR: async () => { throw new Error("No network calls expected"); } } });
  const proposal = { action: "commit", repositoryRoot: root, codingSessionId: completed.id, message: "Fixture reviewed change", paths: ["result.txt"] };
  const commit = await service.prepareConfirmation(proposal);
  const discardProposal = { action: "discard", repositoryRoot: root, codingSessionId: completed.id };
  const discard = await service.prepareConfirmation(discardProposal);
  const before = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: completed.repository.worktreePath })).stdout;
  const lease = await acquireCodingSessionLease(root, completed.id);
  try {
    await assert.rejects(service.confirmCommit({ confirmationToken: commit.confirmationToken, proposal }), /already in use/);
    await assert.rejects(service.confirmDiscard({ confirmationToken: discard.confirmationToken, proposal: discardProposal }), /already in use/);
    assert.equal((await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: completed.repository.worktreePath })).stdout, before);
    assert.equal(await fs.readFile(path.join(completed.repository.worktreePath, "result.txt"), "utf8"), "generated\n");
  } finally { await lease.release(); }
  const result = await service.confirmCommit({ confirmationToken: commit.confirmationToken, proposal });
  assert.match(result.summary, /Committed 1/);
  assert.notEqual(`${result.head}\n`, before);
  await store.save({ ...completed, status: "running" });
  const activeDiscard = await service.prepareConfirmation(discardProposal);
  await assert.rejects(service.confirmDiscard({ confirmationToken: activeDiscard.confirmationToken, proposal: discardProposal }), /Only settled/);
  assert.equal((await fs.stat(completed.repository.worktreePath)).isDirectory(), true);
  const released = await acquireCodingSessionLease(root, completed.id); await released.release();
});
