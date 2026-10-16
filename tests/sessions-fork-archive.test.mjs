import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

function codingRecord(root, overrides = {}) {
  const now = "2026-07-11T00:00:00.000Z";
  const repository = { root, capturedAt: now, dirty: false, changedFiles: [] };
  return {
    schemaVersion: 1,
    id: "hive-test-session",
    objective: "Implement the command",
    mode: "auto",
    approvalPolicy: "changes",
    status: "completed",
    createdAt: now,
    updatedAt: now,
    repository,
    tasks: [{
      id: "bee-001",
      sessionId: "hive-test-session",
      role: "builder",
      title: "Wire CLI",
      objective: "Wire CLI",
      expectedOutput: "working command",
      completionCriteria: ["tests pass"],
      validationCommands: ["npm test"],
      status: "completed",
      providerId: "mock",
      dependencies: [],
      fileScope: ["src/cli.ts"],
      depth: 0,
      attempt: 1,
      maxAttempts: 2,
      createdAt: now,
    }],
    events: [{
      schemaVersion: 1,
      id: "event-session.started",
      sequence: 1,
      sessionId: "hive-test-session",
      timestamp: now,
      type: "session.started",
      payload: { repository },
    }],
    providerBindings: [],
    validationResults: [],
    reviewResults: [],
    files: [],
    ...overrides,
  };
}

function legacyRecord(taskId, overrides = {}) {
  return {
    taskId,
    state: "AWAITING_APPROVAL",
    branchName: `hive-coder/${taskId}`,
    verificationResults: [],
    providers: [],
    ...overrides,
  };
}

async function tempDir(prefix) {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

async function gitRepo() {
  const cwd = await tempDir("hive-sessions-git-");
  await execFileAsync("git", ["init", "-b", "main"], { cwd });
  await execFileAsync("git", ["config", "user.email", "hive@example.test"], { cwd });
  await execFileAsync("git", ["config", "user.name", "HIVE Test"], { cwd });
  await fs.writeFile(path.join(cwd, "README.md"), "fixture\n");
  await execFileAsync("git", ["add", "README.md"], { cwd });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd });
  return cwd;
}

test("help lists session fork, archive, and unarchive", async () => {
  const { runCoderCli } = await import("../dist/cli.js");
  const cwd = await tempDir("hive-sessions-help-");
  try {
    const help = await runCoderCli(["help"], { cwd });
    assert.equal(help.exitCode, 0);
    assert.match(help.output, /hive sessions fork <id>/);
    assert.match(help.output, /hive sessions archive <id>/);
    assert.match(help.output, /hive sessions unarchive <id>/);
    assert.doesNotMatch(help.output, /Not Implemented/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("fork copies a coding session to a new id and leaves the source untouched", async () => {
  const { CodingSessionStore } = await import("../dist/coding/session-store.js");
  const { runCoderCli } = await import("../dist/cli.js");
  const cwd = await tempDir("hive-sessions-fork-");
  try {
    const store = new CodingSessionStore(cwd);
    await store.save(codingRecord(cwd));
    await store.setActive("hive-test-session");
    const sessionDir = path.join(cwd, ".hivemind", "sessions", "hive-test-session");
    await fs.mkdir(path.join(sessionDir, "logs"), { recursive: true });
    await fs.writeFile(path.join(sessionDir, "logs", "cmd-1.log"), "tool output\n");
    const before = await fs.readFile(path.join(sessionDir, "session.json"), "utf8");

    const forked = await runCoderCli(["sessions", "fork", "hive-test-session", "--json"], { cwd });
    assert.equal(forked.exitCode, 0);
    const body = JSON.parse(forked.output);
    assert.deepEqual(
      { success: body.success, kind: body.kind, sourceId: body.sourceId },
      { success: true, kind: "coding", sourceId: "hive-test-session" },
    );
    assert.notEqual(body.id, "hive-test-session");
    assert.doesNotMatch(forked.output, /Not Implemented/);

    assert.equal(await fs.readFile(path.join(sessionDir, "session.json"), "utf8"), before);
    const copy = await store.load(body.id);
    const source = await store.load("hive-test-session");
    assert.equal(copy.forkedFrom, "hive-test-session");
    assert.equal(copy.objective, source.objective);
    assert.equal(copy.status, "completed");
    assert.equal(copy.archived, false);
    assert.equal(copy.tasks[0].sessionId, body.id);
    assert.equal(copy.events[0].sessionId, body.id);
    assert.equal(source.tasks[0].sessionId, "hive-test-session");
    assert.equal(source.events[0].sessionId, "hive-test-session");
    assert.equal(
      await fs.readFile(path.join(cwd, ".hivemind", "sessions", body.id, "logs", "cmd-1.log"), "utf8"),
      "tool output\n",
    );
    assert.equal((await store.getActive()).id, "hive-test-session");
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("fork refuses unmanaged coding worktrees, missing state, and unsafe metadata", async () => {
  const { CodingSessionStore } = await import("../dist/coding/session-store.js");
  const { runCoderCli } = await import("../dist/cli.js");
  const cwd = await tempDir("hive-sessions-worktree-");
  let presentDir;
  try {
    const store = new CodingSessionStore(cwd);
    const missing = codingRecord(cwd);
    missing.repository = { ...missing.repository, worktreePath: path.join(cwd, "missing-worktree") };
    await store.save(missing);
    const missingResult = await runCoderCli(["sessions", "fork", "hive-test-session", "--json"], { cwd });
    assert.equal(missingResult.exitCode, 1);
    assert.match(JSON.parse(missingResult.output).error, /outside this coding session's managed path/);
    assert.equal((await fs.readdir(path.join(cwd, ".hivemind", "sessions"))).length, 1);

    presentDir = await fs.mkdtemp(path.join(os.tmpdir(), "hive-wt-"));
    const present = codingRecord(cwd);
    present.repository = { ...present.repository, worktreePath: presentDir };
    await store.save(present);
    const presentResult = await runCoderCli(["sessions", "fork", "hive-test-session"], { cwd });
    assert.equal(presentResult.exitCode, 1);
    assert.match(presentResult.output, /outside this coding session's managed path/);
    assert.equal((await fs.stat(presentDir)).isDirectory(), true);

    const plain = codingRecord(cwd);
    await store.save(plain);
    await fs.mkdir(path.join(cwd, ".hivemind", "worktrees", "hive-test-session"), { recursive: true });
    const conventional = await runCoderCli(["sessions", "fork", "hive-test-session"], { cwd });
    assert.equal(conventional.exitCode, 1);
    assert.match(conventional.output, /git worktree .* is still present/);

    await fs.rm(path.join(cwd, ".hivemind", "worktrees"), { recursive: true, force: true });
    await fs.writeFile(path.join(cwd, ".hivemind", "sessions", "hive-test-session", "notes.txt"), "extra");
    const extra = await runCoderCli(["sessions", "fork", "hive-test-session"], { cwd });
    assert.equal(extra.exitCode, 1);
    assert.match(extra.output, /cannot be copied safely \(notes.txt\)/);
    assert.equal((await fs.readdir(path.join(cwd, ".hivemind", "sessions"))).filter((name) => name !== "hive-test-session").length, 0);
  } finally {
    if (presentDir) await fs.rm(presentDir, { recursive: true, force: true });
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("archive flags coding and legacy sessions, blocks resume, and restores", async () => {
  const { CodingSessionStore } = await import("../dist/coding/session-store.js");
  const { TaskStore } = await import("../dist/store.js");
  const { runCoderCli } = await import("../dist/cli.js");
  const cwd = await tempDir("hive-sessions-archive-");
  try {
    const codingStore = new CodingSessionStore(cwd);
    const taskStore = new TaskStore(cwd);
    await codingStore.save(codingRecord(cwd));
    await codingStore.setActive("hive-test-session");
    await taskStore.save(legacyRecord("cli-legacy"));
    const activeLegacy = path.join(cwd, ".hivemind", "coder-tasks", "active-task.txt");
    await fs.mkdir(path.dirname(activeLegacy), { recursive: true });
    await fs.writeFile(activeLegacy, "cli-legacy\n");

    const archivedCoding = await runCoderCli(["sessions", "archive", "hive-test-session"], { cwd });
    assert.equal(archivedCoding.exitCode, 0);
    assert.match(archivedCoding.output, /Archived coding session hive-test-session/);
    assert.equal(await codingStore.getActive(), null);
    assert.equal((await codingStore.load("hive-test-session")).archived, true);

    const archivedLegacy = await runCoderCli(["sessions", "archive", "cli-legacy", "--json"], { cwd });
    assert.equal(archivedLegacy.exitCode, 0);
    assert.equal(JSON.parse(archivedLegacy.output).archived, true);
    await assert.rejects(fs.access(activeLegacy));

    const listed = await runCoderCli(["sessions"], { cwd });
    assert.match(listed.output, /hive-test-session \[completed, archived\]/);
    assert.match(listed.output, /cli-legacy \[AWAITING_APPROVAL, archived\]/);
    const listedJson = JSON.parse((await runCoderCli(["sessions", "--json"], { cwd })).output);
    assert.equal(listedJson.find((entry) => entry.id === "hive-test-session").archived, true);
    assert.equal(listedJson.find((entry) => entry.taskId === "cli-legacy").archived, true);
    assert.equal(listedJson.find((entry) => entry.taskId === "cli-legacy").kind, "legacy");

    let resumedRuntime = false;
    const resumed = await runCoderCli(["resume", "hive-test-session"], {
      cwd,
      codingRuntimeFactory() {
        resumedRuntime = true;
        return { async run() { throw new Error("should not run"); } };
      },
    });
    assert.equal(resumed.exitCode, 1);
    assert.equal(resumedRuntime, false);
    assert.match(resumed.output, /archived/);

    const legacyResume = await runCoderCli(["sessions", "resume", "cli-legacy"], { cwd });
    assert.equal(legacyResume.exitCode, 1);
    assert.match(legacyResume.output, /Task cell cli-legacy is archived/);
    await assert.rejects(fs.access(activeLegacy));

    const again = await runCoderCli(["sessions", "archive", "hive-test-session", "--json"], { cwd });
    assert.equal(JSON.parse(again.output).unchanged, true);

    const restored = await runCoderCli(["sessions", "unarchive", "hive-test-session"], { cwd });
    assert.match(restored.output, /Restored coding session hive-test-session/);
    assert.equal((await codingStore.load("hive-test-session")).archived, false);
    const notArchived = await runCoderCli(["sessions", "unarchive", "hive-test-session"], { cwd });
    assert.match(notArchived.output, /is not archived/);

    const resumedOk = await runCoderCli(["sessions", "resume", "hive-test-session"], { cwd });
    assert.equal(resumedOk.exitCode, 0);
    assert.match(resumedOk.output, /Resumed coding session hive-test-session/);
    assert.equal((await codingStore.getActive()).id, "hive-test-session");

    await runCoderCli(["sessions", "unarchive", "cli-legacy"], { cwd });
    const legacyRestored = await runCoderCli(["sessions", "resume", "cli-legacy"], { cwd });
    assert.equal(legacyRestored.exitCode, 0);
    assert.equal((await fs.readFile(activeLegacy, "utf8")).trim(), "cli-legacy");

    const missing = await runCoderCli(["sessions", "archive", "hive-missing"], { cwd });
    assert.equal(missing.exitCode, 1);
    assert.match(missing.output, /Session hive-missing not found/);
    const usage = await runCoderCli(["sessions", "fork"], { cwd });
    assert.equal(usage.exitCode, 1);
    assert.match(usage.output, /Usage: hive sessions fork <id>/);
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("fork copies a legacy task cell and its diff without aliasing the branch", async () => {
  const { TaskStore } = await import("../dist/store.js");
  const { runCoderCli } = await import("../dist/cli.js");
  const cwd = await tempDir("hive-sessions-legacy-");
  try {
    const store = new TaskStore(cwd);
    const source = legacyRecord("cli-legacy", {
      plan: "keep the source plan",
      diffSummary: {
        filesChanged: ["src/cli.ts"],
        submodulesChanged: [],
        insertions: 2,
        deletions: 1,
        patch: "ignored-by-diff-command",
      },
    });
    await store.save(source);
    const patchDir = path.join(cwd, ".hivemind", "coder-tasks", "cli-legacy");
    await fs.mkdir(patchDir, { recursive: true });
    await fs.writeFile(path.join(patchDir, "diff.patch"), "patch-body\n");
    const activePath = path.join(cwd, ".hivemind", "coder-tasks", "active-task.txt");
    await fs.writeFile(activePath, "cli-legacy\n");
    const before = await fs.readFile(path.join(cwd, ".hivemind", "coder", "cli-legacy.json"), "utf8");

    const forked = await runCoderCli(["sessions", "fork", "cli-legacy"], { cwd });
    assert.equal(forked.exitCode, 0);
    const match = forked.output.match(/Forked task cell cli-legacy to (\S+)\./);
    assert.ok(match);
    const newId = match[1];
    assert.notEqual(newId, "cli-legacy");
    assert.equal(await fs.readFile(path.join(cwd, ".hivemind", "coder", "cli-legacy.json"), "utf8"), before);
    const copy = await store.load(newId);
    assert.equal(copy.forkedFrom, "cli-legacy");
    assert.equal(copy.plan, "keep the source plan");
    assert.equal(copy.branchName, `hive-coder/${newId}`);
    assert.equal(copy.archived, false);
    assert.equal(await fs.readFile(path.join(cwd, ".hivemind", "coder-tasks", newId, "diff.patch"), "utf8"), "patch-body\n");
    assert.equal((await fs.readFile(activePath, "utf8")).trim(), "cli-legacy");
    assert.equal(await fs.readFile(path.join(patchDir, "diff.patch"), "utf8"), "patch-body\n");
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("fork refuses legacy task cells with git state or missing diff files", async () => {
  const { TaskStore } = await import("../dist/store.js");
  const { runCoderCli } = await import("../dist/cli.js");
  const cwd = await gitRepo();
  try {
    const store = new TaskStore(cwd);
    await store.save(legacyRecord("cli-open"));
    const opened = await runCoderCli(["sessions", "fork", "cli-open", "--json"], { cwd });
    assert.equal(opened.exitCode, 0, opened.output);
    const openedBody = JSON.parse(opened.output);
    await assert.rejects(
      execFileAsync("git", ["rev-parse", "--verify", "--quiet", `refs/heads/hive-coder/${openedBody.id}`], { cwd }),
    );
    assert.equal((await store.load("cli-open")).branchName, "hive-coder/cli-open");

    await execFileAsync("git", ["branch", "hive-coder/cli-taken"], { cwd });
    await store.save(legacyRecord("cli-taken"));
    const taken = await runCoderCli(["sessions", "fork", "cli-taken"], { cwd });
    assert.equal(taken.exitCode, 1);
    assert.match(taken.output, /git branch hive-coder\/cli-taken still exists/);
    assert.equal(await store.load("cli-taken-fork"), null);

    await store.save(legacyRecord("cli-wt"));
    const worktree = path.join(cwd, ".hivemind", "worktrees", "cli-wt");
    await fs.mkdir(worktree, { recursive: true });
    const withWorktree = await runCoderCli(["sessions", "fork", "cli-wt"], { cwd });
    assert.equal(withWorktree.exitCode, 1);
    assert.match(withWorktree.output, /git worktree .* is still present/);
    assert.equal((await fs.stat(worktree)).isDirectory(), true);

    await store.save(legacyRecord("cli-diff", {
      diffSummary: {
        filesChanged: ["README.md"],
        submodulesChanged: [],
        insertions: 1,
        deletions: 0,
        patch: "missing on disk",
      },
    }));
    const missingPatch = await runCoderCli(["sessions", "fork", "cli-diff"], { cwd });
    assert.equal(missingPatch.exitCode, 1);
    assert.match(missingPatch.output, /diff.patch is missing/);

    const extraDir = path.join(cwd, ".hivemind", "coder-tasks", "cli-extra");
    await store.save(legacyRecord("cli-extra"));
    await fs.mkdir(extraDir, { recursive: true });
    await fs.writeFile(path.join(extraDir, "notes.txt"), "do not drop");
    const extra = await runCoderCli(["sessions", "fork", "cli-extra"], { cwd });
    assert.equal(extra.exitCode, 1);
    assert.match(extra.output, /cannot be copied safely \(notes.txt\)/);
    assert.equal(await fs.readFile(path.join(extraDir, "notes.txt"), "utf8"), "do not drop");
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});

test("queen resume refuses an archived coding session", async () => {
  const { CodingSessionStore } = await import("../dist/coding/session-store.js");
  const { createQueenSession } = await import("../dist/coding/runtime.js");
  const cwd = await gitRepo();
  try {
    const store = new CodingSessionStore(cwd);
    await store.save(codingRecord(cwd, { archived: true, archivedAt: "2026-07-11T00:00:00.000Z" }));
    await assert.rejects(
      () => createQueenSession({
        repositoryPath: cwd,
        objective: "continue",
        resumeId: "hive-test-session",
        mode: "auto",
        approvalPolicy: "changes",
        maxAgents: 1,
        maxRetries: 0,
      }),
      /Coding session hive-test-session is archived/,
    );
  } finally {
    await fs.rm(cwd, { recursive: true, force: true });
  }
});
