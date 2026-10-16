import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createQueenSession, getCodingWorkspace } from "../dist/coding/runtime.js";
import { CodingSessionStore } from "../dist/coding/session-store.js";
import { CheckpointStore } from "../dist/coding/checkpoints.js";
import { runLocalCommand, rewindLocalFiles } from "../dist/tui/local-command.js";
import { executeTuiCommand, parseTuiCommand } from "../dist/tui/commands.js";
import { newConversation } from "../dist/tui/conversations.js";
import { initialState } from "../dist/tui/state.js";

const execFileAsync = promisify(execFile);

async function repository(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-local-command-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "hive@example.test"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "HIVE Test"], { cwd: root });
  await fs.writeFile(path.join(root, "README.md"), "fixture\n");
  await fs.writeFile(path.join(root, "modify.cjs"), "require('node:fs').writeFileSync('result.txt', 'manual\\n'); console.log('modified');\n");
  await fs.writeFile(path.join(root, "failure.cjs"), "console.log('deliberate failure'); process.exitCode = 7;\n");
  await fs.writeFile(path.join(root, "mutate-failure.cjs"), "require('node:fs').writeFileSync('result.txt', 'failed command changed this\\n'); console.log('mutated then failed'); process.exitCode = 7;\n");
  await fs.writeFile(path.join(root, "mutate-wait.cjs"), "require('node:fs').writeFileSync('result.txt', 'cancelled command changed this\\n'); console.log('child ready'); setInterval(() => {}, 1000);\n");
  await fs.writeFile(path.join(root, "wait.cjs"), "console.log('child ready'); setInterval(() => {}, 1000);\n");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });
  return root;
}

function localOptions(cwd, overrides = {}) {
  return { cwd, command: "node modify.cjs", signal: new AbortController().signal,
    requestPermission: async () => true, onEvent: () => {}, ...overrides };
}

async function completedSession(root) {
  const runtime = await createQueenSession({ repositoryPath: root, objective: "Create a two-step file", sessionId: "local-workflow",
    mode: "auto", approvalPolicy: "changes", maxAgents: 1, maxRetries: 0 });
  let builderStep = 0;
  runtime.providerRouter.bindingForRole = async (role) => ({ role, providerId: "fixture-provider" });
  runtime.providerRouter.complete = async (request) => {
    if (request.role === "planner") return { output: JSON.stringify({ summary: "Create the requested file", architecture: "One owned file",
      risks: [], acceptanceCriteria: ["The file has the requested content"], validationCommands: ["node --version"],
      tasks: [{ key: "file", role: "builder", title: "Create file", objective: "Create the file", dependencies: [], fileScope: ["result.txt"],
        expectedOutput: "Updated result.txt", completionCriteria: ["Correct content"], validationCommands: [] }] }) };
    if (request.role === "builder" && builderStep < 2) {
      const step = builderStep++;
      return { output: JSON.stringify({ done: false, toolCalls: [{ name: step === 0 ? "create_file" : "write_file",
        arguments: { path: "result.txt", content: step === 0 ? "first\n" : "second\n" } }] }) };
    }
    return { output: JSON.stringify({ done: true, summary: "Fixture role completed", data: { status: "passed", findings: [] } }) };
  };
  runtime.providerRouter.streamComplete = (request) => runtime.providerRouter.complete(request);
  const record = await runtime.orchestrator.run();
  assert.equal(record.status, "completed", JSON.stringify(record.finalReport));
  assert.equal(record.verdict, "ACCEPTED");
  return record;
}

function attachedState(root, record) {
  return { ...initialState(), conversation: { ...newConversation(root), codingSessionId: record.id, codingStatus: record.status } };
}

function commandHarness(root, state = initialState()) {
  return { get state() { return state; }, async run(input, options = {}) {
    const result = await executeTuiCommand(parseTuiCommand(input), state, root, (update) => { state = update(state); }, { persistSession: false, ...options });
    state = result.state;
    await result.runtime?.completion;
    return result;
  } };
}

test("local commands cannot execute or emit command events until their permission resolves", async (t) => {
  const root = await repository(t);
  const events = [];
  let release;
  let requested;
  const permission = new Promise((resolve) => { release = resolve; });
  const pending = runLocalCommand(localOptions(root, { onEvent: (event) => events.push(event), requestPermission: async (request, signal) => {
    requested = request;
    assert.equal(signal.aborted, false);
    assert.equal(await fs.readFile(path.join(root, "README.md"), "utf8"), "fixture\n");
    return permission;
  } }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(requested.tool, "run_command");
  assert.deepEqual(requested.input, { command: "node modify.cjs" });
  assert.deepEqual(events, []);
  await assert.rejects(fs.stat(path.join(root, "result.txt")), { code: "ENOENT" });
  release(true);
  const result = await pending;
  assert.equal(result.exitCode, 0);
  assert.equal(result.changedWorkspace, false);
  assert.match(result.output, /modified/);
  assert.equal(await fs.readFile(path.join(root, "result.txt"), "utf8"), "manual\n");
  assert.deepEqual([...new Set(events.map((event) => event.type))], ["command.started", "command.output", "command.completed"]);
  assert.equal(events.at(-1).payload.exitCode, 0);
});

test("denied and already-cancelled local commands have no side effects", async (t) => {
  const root = await repository(t);
  let approvals = 0;
  const events = [];
  const options = localOptions(root, { requestPermission: async () => { approvals += 1; return false; }, onEvent: (event) => events.push(event) });
  await assert.rejects(runLocalCommand(options), /declined before execution/);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runLocalCommand({ ...options, signal: controller.signal }), { name: "AbortError" });
  assert.equal(approvals, 1);
  assert.deepEqual(events, []);
  await assert.rejects(fs.stat(path.join(root, "result.txt")), { code: "ENOENT" });
});

test("shell shortcuts parse consistently, require an interactive approver, and reject read-only modes", async (t) => {
  const root = await repository(t);
  assert.equal(parseTuiCommand("!node modify.cjs").kind, "shell");
  assert.equal(parseTuiCommand("/shell node modify.cjs").args, "node modify.cjs");
  const cli = commandHarness(root);
  const pending = await cli.run("!node modify.cjs");
  assert.equal(pending.runtime, undefined);
  assert.equal(cli.state.pendingPermission.outcome, "ask");
  let approvals = 0;
  for (const sessionMode of ["plan", "review"]) {
    const readOnly = commandHarness(root, { ...initialState(), sessionMode });
    await assert.rejects(readOnly.run("/shell node modify.cjs", { requestToolPermission: async () => { approvals += 1; return true; } }), /read-only/);
    await assert.rejects(readOnly.run("/rewind files", { requestToolPermission: async () => { approvals += 1; return true; } }), /read-only/);
  }
  assert.equal(approvals, 0);
  await assert.rejects(fs.stat(path.join(root, "result.txt")), { code: "ENOENT" });
});

test("approved local commands retain publication, dependency, destructive, and executable guards", async (t) => {
  const root = await repository(t);
  for (const [command, reason] of [
    ["git push origin main", /external operation/], ["git reset --hard", /Prohibited Git/], ["git clean -fd", /Prohibited Git/],
    ["npm publish", /External command/], ["npm install", /Dependency installation/], ["npm run clean", /Destructive command/],
    ["powershell -Command whoami", /not an approved/], ["node ../outside.cjs", /escapes/],
    ["node modify.cjs; node failure.cjs", /metacharacters/],
  ]) {
    const events = [];
    await assert.rejects(runLocalCommand(localOptions(root, { command, onEvent: (event) => events.push(event) })), reason, command);
    assert.deepEqual(events, [], command);
  }
  await assert.rejects(fs.stat(path.join(root, "result.txt")), { code: "ENOENT" });
});

test("command output and a nonzero exit reach the TUI without a false success", async (t) => {
  const root = await repository(t);
  const cli = commandHarness(root, { ...initialState(), conversation: newConversation(root) });
  await cli.run("!node failure.cjs", { requestToolPermission: async () => true });
  assert.equal(cli.state.taskStatus, "error");
  assert.match(cli.state.outputLines.join("\n"), /Command exit: 7/);
  assert.match(cli.state.transcript.join("\n"), /deliberate failure/);
  assert.match(cli.state.conversation.messages.at(-1).content, /Exit code: 7/);
  assert.equal(cli.state.recentRuntimeEvents.at(-1).payload.exitCode, 7);
});

test("cancellation stops the owned child and produces a completed command event", async (t) => {
  const root = await repository(t);
  const controller = new AbortController();
  const events = [];
  const result = await runLocalCommand(localOptions(root, { command: "node wait.cjs", signal: controller.signal,
    onEvent: (event) => { events.push(event); if (event.type === "command.output" && event.payload.chunk.includes("child ready")) controller.abort(); } }));
  assert.equal(controller.signal.aborted, true);
  assert.notEqual(result.exitCode, 0);
  assert.match(result.output, /child ready/);
  assert.equal(events.at(-1).type, "command.completed");
  assert.ok(events.at(-1).payload.signal);
});

test("a local command in a settled managed workspace preserves the root and invalidates old acceptance evidence", async (t) => {
  const root = await repository(t);
  const record = await completedSession(root);
  const previous = structuredClone(record);
  const result = await runLocalCommand(localOptions(root, { codingSessionId: record.id }));
  assert.equal(result.exitCode, 0);
  assert.equal(result.changedWorkspace, true);
  assert.equal(await fs.readFile(path.join(record.repository.worktreePath, "result.txt"), "utf8"), "manual\n");
  await assert.rejects(fs.stat(path.join(root, "result.txt")), { code: "ENOENT" });
  const saved = await new CodingSessionStore(root).load(record.id);
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.verdict, "BLOCKED");
  assert.equal(saved.finalReport.evidenceCurrent, false);
  assert.deepEqual(saved.finalReport.validation, []);
  assert.deepEqual(saved.finalReport.review, []);
  assert.deepEqual(saved.finalReport.evidenceSummary, []);
  assert.deepEqual(saved.validationResults, previous.validationResults, "historical validation records are preserved");
  assert.notEqual(saved.repository.worktreeFingerprint, previous.repository.worktreeFingerprint);
  assert.equal(await getCodingWorkspace(root, record.id), record.repository.worktreePath, "the explicitly changed workspace remains available for a fresh turn");
});

test("read-only commands in a managed workspace keep its accepted evidence current", async (t) => {
  const root = await repository(t);
  const record = await completedSession(root);
  const result = await runLocalCommand(localOptions(root, { command: "node --version", codingSessionId: record.id }));
  assert.equal(result.changedWorkspace, false);
  const saved = await new CodingSessionStore(root).load(record.id);
  assert.equal(saved.status, "completed");
  assert.equal(saved.verdict, "ACCEPTED");
  assert.deepEqual(saved.finalReport, record.finalReport);
});

for (const command of ["node mutate-failure.cjs", "node mutate-wait.cjs"]) {
  test(`${command.includes("wait") ? "cancelled" : "nonzero"} commands still invalidate evidence for files they changed`, async (t) => {
    const root = await repository(t);
    const record = await completedSession(root);
    const controller = new AbortController();
    const result = await runLocalCommand(localOptions(root, { command, codingSessionId: record.id, signal: controller.signal,
      onEvent: (event) => { if (event.type === "command.output" && event.payload.chunk.includes("child ready")) controller.abort(); } }));
    assert.notEqual(result.exitCode, 0);
    assert.equal(result.changedWorkspace, true);
    const saved = await new CodingSessionStore(root).load(record.id);
    assert.equal(saved.status, "cancelled");
    assert.equal(saved.verdict, "BLOCKED");
    assert.equal(saved.finalReport.evidenceCurrent, false);
    assert.equal(await getCodingWorkspace(root, record.id), record.repository.worktreePath);
  });
}

test("a command cannot mutate an unsettled coding workspace before ownership validation", async (t) => {
  const root = await repository(t);
  const record = await completedSession(root);
  const store = new CodingSessionStore(root);
  await store.save({ ...record, status: "running" });
  const events = [];
  await assert.rejects(runLocalCommand(localOptions(root, { codingSessionId: record.id, onEvent: (event) => events.push(event) })), /settled/);
  assert.deepEqual(events, []);
  assert.equal(await fs.readFile(path.join(record.repository.worktreePath, "result.txt"), "utf8"), "second\n");
});

test("checkpoint previews never restore files without an interactive confirmation", async (t) => {
  const root = await repository(t);
  const record = await completedSession(root);
  const [latest] = await new CheckpointStore(record.repository.worktreePath, record.id).list();
  const cli = commandHarness(root, attachedState(root, record));
  await cli.run("/checkpoints");
  assert.match(cli.state.outputLines.join("\n"), new RegExp(latest.id));
  const result = await cli.run(`/rewind files ${latest.id}`);
  assert.equal(result.runtime, undefined);
  assert.match(cli.state.outputLines.join("\n"), /interactive confirmation; no files changed/);
  assert.equal(await fs.readFile(path.join(record.repository.worktreePath, "result.txt"), "utf8"), "second\n");
});

test("default file rewind previews the newest checkpoint rather than an older conflicting write", async (t) => {
  const root = await repository(t);
  const record = await completedSession(root);
  const [latest, older] = await new CheckpointStore(record.repository.worktreePath, record.id).list();
  assert.ok(latest && older);
  const cli = commandHarness(root, attachedState(root, record));
  await cli.run("/rewind files");
  assert.match(cli.state.outputLines.join("\n"), new RegExp(`Checkpoint ${latest.id}:`));
  assert.match(cli.state.outputLines.join("\n"), /interactive confirmation; no files changed/);
});

test("file rewind asks for exact paths, preserves denied files, and marks accepted restores stale", async (t) => {
  const root = await repository(t);
  const record = await completedSession(root);
  const [latest] = await new CheckpointStore(record.repository.worktreePath, record.id).list();
  let requested;
  const options = { cwd: root, codingSessionId: record.id, checkpointId: latest.id, signal: new AbortController().signal,
    requestPermission: async (request) => { requested = request; return false; } };
  await assert.rejects(rewindLocalFiles(options), /declined before any changes/);
  assert.equal(requested.tool, "rewind_files");
  assert.equal(requested.alwaysAsk, true);
  assert.deepEqual(requested.input.paths.map((item) => [item.path, item.action]), [["result.txt", "restore"]]);
  assert.equal(await fs.readFile(path.join(record.repository.worktreePath, "result.txt"), "utf8"), "second\n");
  assert.deepEqual(await rewindLocalFiles({ ...options, requestPermission: async () => true }), ["result.txt"]);
  assert.equal(await fs.readFile(path.join(record.repository.worktreePath, "result.txt"), "utf8"), "first\n");
  const saved = await new CodingSessionStore(root).load(record.id);
  assert.equal(saved.status, "cancelled");
  assert.equal(saved.finalReport.evidenceCurrent, false);
  assert.equal(await getCodingWorkspace(root, record.id), record.repository.worktreePath);
});

test("file rewind rejects an unsettled coding workspace before asking to restore", async (t) => {
  const root = await repository(t);
  const record = await completedSession(root);
  const [latest] = await new CheckpointStore(record.repository.worktreePath, record.id).list();
  await new CodingSessionStore(root).save({ ...record, status: "running" });
  let approvals = 0;
  await assert.rejects(rewindLocalFiles({ cwd: root, codingSessionId: record.id, checkpointId: latest.id,
    signal: new AbortController().signal, requestPermission: async () => { approvals += 1; return true; } }), /settled/);
  assert.equal(approvals, 0);
  assert.equal(await fs.readFile(path.join(record.repository.worktreePath, "result.txt"), "utf8"), "second\n");
});
