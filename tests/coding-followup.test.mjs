import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { createQueenSession, getCodingWorkspace } from "../dist/coding/runtime.js";
import { CodingSessionStore } from "../dist/coding/session-store.js";

const execFileAsync = promisify(execFile);

async function repository() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-followup-"));
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "hive@example.test"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "HIVE Test"], { cwd: root });
  await fs.writeFile(path.join(root, "README.md"), "fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });
  return root;
}

async function fixtureRuntime(root, options = {}, followup = false, previousContent = "first\n") {
  const runtime = await createQueenSession({
    repositoryPath: root, objective: "First turn", sessionId: "coding-followup",
    mode: "auto", approvalPolicy: "changes", maxAgents: 1, maxRetries: 0,
    ...options,
  });
  const calls = [];
  let builderStep = 0;
  runtime.providerRouter.bindingForRole = async (role) => ({ role, providerId: "fixture-provider" });
  runtime.providerRouter.complete = async (request) => {
    calls.push({ role: request.role, cwd: request.cwd, prompt: request.prompt });
    if (request.role === "planner") {
      if (followup) assert.equal(await fs.readFile(path.join(request.cwd, "src", "continuity.txt"), "utf8"), previousContent);
      return { output: JSON.stringify({
        summary: followup ? "Continue the existing implementation" : "Create the implementation",
        architecture: "One owned file", risks: [], acceptanceCriteria: ["The file contains the requested turn"],
        validationCommands: ["node --version"],
        tasks: [{ key: "file", role: "builder", title: "Update owned file", objective: "Write the requested content",
          dependencies: [], fileScope: ["src/continuity.txt"], expectedOutput: "Updated file",
          completionCriteria: ["Correct content"], validationCommands: [] }],
      }) };
    }
    if (request.role === "builder") {
      const step = builderStep++;
      if (followup && step === 0) return { output: JSON.stringify({ done: false, toolCalls: [
        { name: "read_file", arguments: { path: "src/continuity.txt" } },
      ] }) };
      if ((!followup && step === 0) || (followup && step === 1)) {
        if (followup) assert.ok(request.prompt.includes(previousContent.trim()));
        return { output: JSON.stringify({ done: false, toolCalls: [
          { name: followup ? "write_file" : "create_file", arguments: { path: "src/continuity.txt", content: followup ? "second\n" : "first\n" } },
        ] }) };
      }
    }
    return { output: JSON.stringify({ done: true, summary: "Fixture role completed", data: { status: "passed", findings: [] } }) };
  };
  runtime.providerRouter.streamComplete = (request) => runtime.providerRouter.complete(request);
  return { ...runtime, calls };
}

test("a fresh follow-up uses the same managed worktree and fresh evidence while preserving its prior turn", async () => {
  const root = await repository();
  try {
    const initial = await fixtureRuntime(root);
    const first = await initial.orchestrator.run();
    assert.equal(first.status, "completed", JSON.stringify(first.finalReport));
    assert.equal(first.verdict, "ACCEPTED");
    const worktree = first.repository.worktreePath;
    assert.equal(await fs.readFile(path.join(worktree, "src/continuity.txt"), "utf8"), "first\n");
    assert.match(first.repository.worktreeFingerprint, /^[a-f0-9]{64}$/);
    assert.equal(await getCodingWorkspace(root, first.id), worktree);
    await fs.mkdir(path.join(worktree, ".hivemind"), { recursive: true });
    await fs.writeFile(path.join(worktree, ".hivemind", "metadata.json"), "unrelated runtime metadata\n");

    const next = await fixtureRuntime(root, { sessionId: undefined, continuationId: first.id, objective: "Second turn: update the file" }, true);
    const second = await next.orchestrator.run();
    assert.equal(second.status, "completed", JSON.stringify(second.finalReport?.outstanding));
    assert.equal(second.verdict, "ACCEPTED");
    assert.equal(second.id, first.id);
    assert.equal(second.repository.root, first.repository.root);
    assert.equal(second.repository.worktreePath, worktree);
    assert.ok(next.calls.every((call) => call.cwd === worktree), "planning, building, validation and review use the existing worktree");
    assert.equal(await fs.readFile(path.join(worktree, "src/continuity.txt"), "utf8"), "second\n");
    assert.equal(second.turnHistory.length, 1);
    assert.equal(second.turnHistory[0].objective, "First turn");
    assert.deepEqual(second.turnHistory[0].validationResults, first.validationResults);
    assert.equal(second.validationResults.length, first.validationResults.length);
    assert.ok(second.validationResults.every((result) => !first.validationResults.some((old) => old.id === result.id)), "earlier passing checks are historical evidence");
    assert.ok(second.tasks.every((task) => !first.tasks.some((old) => old.id === task.id)));
    const freshEvents = second.events.filter((event) => event.sequence > first.events.at(-1).sequence);
    assert.ok(freshEvents.length > 0);
    assert.equal(freshEvents[0].type, "session.created");
    assert.ok(freshEvents.every((event) => !first.events.some((old) => old.id === event.id)), "event identities never collide across turns");
    assert.equal((await new CodingSessionStore(root).load(first.id)).turnHistory.length, 1);
    const { stdout } = await execFileAsync("git", ["worktree", "list", "--porcelain"], { cwd: root });
    assert.equal(stdout.split("worktree ").length - 1, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("four coding turns store each historical event once and normalize legacy cumulative snapshots", async () => {
  const root = await repository();
  try {
    const initial = await fixtureRuntime(root);
    const completed = [await initial.orchestrator.run()];
    const store = new CodingSessionStore(root);
    for (let turn = 2; turn <= 4; turn += 1) {
      const previous = completed.at(-1);
      if (turn === 4) {
        const legacy = structuredClone(previous);
        delete legacy.turnStartSequence;
        legacy.turnHistory = completed.slice(0, -1).map(({ turnHistory, turnStartSequence, ...snapshot }) => snapshot);
        await store.save(legacy);
      }
      const runtime = await fixtureRuntime(root, {
        sessionId: undefined, continuationId: previous.id, objective: `Follow-up turn ${turn}`,
      }, true, turn === 2 ? "first\n" : "second\n");
      const current = await runtime.orchestrator.run();
      assert.equal(current.status, "completed", JSON.stringify(current.finalReport));
      assert.equal(current.verdict, "ACCEPTED");
      assert.equal(current.repository.worktreePath, completed[0].repository.worktreePath);
      completed.push(current);
    }
    const saved = JSON.parse(JSON.stringify(await store.load(completed[0].id)));
    assert.equal(saved.turnHistory.length, 3);
    const historicalEvents = saved.turnHistory.flatMap((turn) => turn.events);
    assert.equal(new Set(historicalEvents.map((event) => event.id)).size, historicalEvents.length);
    assert.equal(new Set(saved.events.map((event) => event.id)).size, saved.events.length);
    assert.equal(historicalEvents.length, saved.events.filter((event) => event.sequence < saved.turnStartSequence).length);
    assert.ok(historicalEvents.length + saved.events.length <= 2 * saved.events.length, "serialized historical event storage grows linearly");
    for (const [index, turn] of saved.turnHistory.entries()) {
      assert.equal(turn.turnHistory, undefined);
      assert.equal(turn.events[0].sequence, turn.turnStartSequence);
      assert.equal(turn.events[0].type, "session.created");
      assert.deepEqual(turn.validationResults, completed[index].validationResults);
      assert.deepEqual(turn.finalReport, completed[index].finalReport);
    }
    const allValidationIds = [...saved.turnHistory, saved].flatMap((turn) => turn.validationResults.map((result) => result.id));
    assert.equal(new Set(allValidationIds).size, allValidationIds.length);
    assert.ok(saved.events.at(-1).sequence > historicalEvents.at(-1).sequence);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("approval resume retains the same turn and does not replan", async () => {
  const root = await repository();
  try {
    const initial = await fixtureRuntime(root, { approvalPolicy: "safe" });
    const paused = await initial.orchestrator.run();
    assert.equal(paused.status, "paused");
    assert.equal(paused.repository.worktreePath, undefined);
    const resumedRuntime = await fixtureRuntime(root, { sessionId: undefined, resumeId: paused.id, objective: undefined });
    const resumed = await resumedRuntime.orchestrator.run();
    assert.equal(resumed.status, "completed", JSON.stringify(resumed.finalReport?.outstanding));
    assert.equal(resumed.id, paused.id);
    assert.equal(resumed.turnHistory, undefined);
    assert.equal(resumedRuntime.calls.some((call) => call.role === "planner"), false);
    assert.equal(resumed.tasks.filter((task) => task.role === "planner").length, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("a completed plan can continue into implementation and retains the root dirty guard", async () => {
  const root = await repository();
  try {
    const initial = await fixtureRuntime(root, { mode: "plan" });
    const planned = await initial.orchestrator.run();
    assert.equal(planned.status, "completed");
    assert.equal(planned.repository.worktreePath, undefined);
    await fs.mkdir(path.join(root, "src"), { recursive: true });
    await fs.writeFile(path.join(root, "src/continuity.txt"), "user content\n");
    const next = await fixtureRuntime(root, { sessionId: undefined, continuationId: planned.id, objective: "Implement the earlier plan" });
    const paused = await next.orchestrator.run();
    assert.equal(paused.status, "paused");
    assert.equal(paused.repository.worktreePath, undefined);
    assert.equal(await fs.readFile(path.join(root, "src/continuity.txt"), "utf8"), "user content\n");
    assert.equal(paused.turnHistory[0].mode, "plan");
    assert.equal(next.calls.some((call) => call.role === "builder"), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("continuation fails closed on archived, missing, paused, drifted or rebound predecessors", async () => {
  const root = await repository();
  try {
    await assert.rejects(() => fixtureRuntime(root, { sessionId: undefined, continuationId: "absent" }), /not found/);
    const pausedRuntime = await fixtureRuntime(root, { approvalPolicy: "safe" });
    const paused = await pausedRuntime.orchestrator.run();
    const invalid = await fixtureRuntime(root, { sessionId: undefined, continuationId: paused.id });
    await assert.rejects(() => invalid.orchestrator.run(), /resume it/);
    const resumed = await fixtureRuntime(root, { sessionId: undefined, resumeId: paused.id });
    const first = await resumed.orchestrator.run();
    const store = new CodingSessionStore(root);
    await store.archive(first.id);
    await assert.rejects(() => fixtureRuntime(root, { sessionId: undefined, continuationId: first.id }), /archived/);
    await store.unarchive(first.id);
    await fs.writeFile(path.join(first.repository.worktreePath, "src/continuity.txt"), "external content with the same git status\n");
    await assert.rejects(() => getCodingWorkspace(root, first.id), /changed/);
    const drifted = await fixtureRuntime(root, { sessionId: undefined, continuationId: first.id });
    await assert.rejects(() => drifted.orchestrator.run(), /changed outside/);
    assert.equal(drifted.calls.length, 0);
    assert.equal((await store.load(first.id)).objective, first.objective);
    await fs.writeFile(path.join(first.repository.worktreePath, "src/continuity.txt"), "first\n");
    await execFileAsync("git", ["checkout", "-b", "unexpected"], { cwd: first.repository.worktreePath });
    const rebound = await fixtureRuntime(root, { sessionId: undefined, continuationId: first.id });
    await assert.rejects(() => rebound.orchestrator.run(), /unexpected registered branch/);
    await execFileAsync("git", ["checkout", `hive-coder/${first.id}`], { cwd: first.repository.worktreePath });
    await fs.rename(first.repository.worktreePath, `${first.repository.worktreePath}-missing`);
    const missing = await fixtureRuntime(root, { sessionId: undefined, continuationId: first.id });
    await assert.rejects(() => missing.orchestrator.run(), /ENOENT/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("continuation and resume operations cannot be combined or rebound to a new id", async () => {
  const root = await repository();
  try {
    await assert.rejects(() => fixtureRuntime(root, { resumeId: "a", continuationId: "a" }), /cannot be combined/);
    await assert.rejects(() => fixtureRuntime(root, { continuationId: "a", sessionId: "b" }), /must match/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
