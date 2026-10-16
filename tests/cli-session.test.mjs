/**
 * cli-session.test.mjs
 * Pure cockpit contract: mode permissions, slash commands, and a scripted turn.
 */

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("mode permission mapping keeps plan read-only and publish behind confirmation", async () => {
  const { decidePermission, resolveSessionPosture } = await import("../dist/tui/interaction.js");

  assert.deepEqual(resolveSessionPosture("guarded"), { mode: "auto", approvalPolicy: "safe" });
  assert.deepEqual(resolveSessionPosture("standard"), { mode: "auto", approvalPolicy: "changes" });
  assert.deepEqual(resolveSessionPosture("autonomous"), { mode: "auto", approvalPolicy: "changes" });
  assert.deepEqual(resolveSessionPosture("plan"), { mode: "plan", approvalPolicy: "safe" });
  assert.deepEqual(resolveSessionPosture("review"), { mode: "review", approvalPolicy: "safe" });
  assert.deepEqual(
    resolveSessionPosture("plan", { mode: "auto", approvalPolicy: "changes" }),
    { mode: "plan", approvalPolicy: "safe" },
  );
  assert.deepEqual(
    resolveSessionPosture("guarded", { approvalPolicy: "changes" }),
    { mode: "auto", approvalPolicy: "changes" },
  );

  const edit = { kind: "edit", target: "src/auth.ts", inWorkspace: true, confirmed: false };
  assert.equal(decidePermission("guarded", edit).outcome, "ask");
  assert.equal(decidePermission("guarded", edit).canApply, true);
  assert.equal(decidePermission("plan", edit).canApply, false);
  assert.equal(decidePermission("review", edit).outcome, "deny");
  assert.equal(decidePermission("autonomous", edit).outcome, "allow");
  assert.equal(decidePermission("standard", edit).outcome, "allow");
  assert.equal(decidePermission("standard", { ...edit, kind: "command", target: "npm test" }).outcome, "ask");

  const push = { kind: "push", target: "git push origin main", inWorkspace: true, confirmed: false };
  for (const mode of ["guarded", "standard", "autonomous", "plan", "review"]) {
    const decision = decidePermission(mode, push);
    assert.equal(decision.outcome, "deny", mode);
    assert.equal(decision.canApply, false, mode);
    assert.match(decision.reason, /hive push --confirmed/);
  }
  assert.equal(decidePermission("autonomous", { ...push, confirmed: true }).outcome, "allow");
  assert.equal(
    decidePermission("autonomous", { ...edit, inWorkspace: false }).outcome,
    "deny",
  );
});

test("slash commands parse the session controls", async () => {
  const { parseTuiCommand } = await import("../dist/tui/commands.js");

  assert.equal(parseTuiCommand("/help").kind, "help");
  assert.equal(parseTuiCommand("/mode plan").kind, "mode");
  assert.equal(parseTuiCommand("/mode plan").args, "plan");
  assert.equal(parseTuiCommand("/clear").kind, "clear");
  assert.equal(parseTuiCommand("/sessions").kind, "sessions");
  assert.equal(parseTuiCommand("/exit").kind, "exit");
  assert.equal(parseTuiCommand("/plan fix the auth bug").kind, "plan");
  assert.equal(parseTuiCommand("/plan fix the auth bug").args, "fix the auth bug");
  assert.equal(parseTuiCommand("fix the login bug").kind, "task");
});

test("/mode and /plan persist the session mode", async () => {
  const { executeTuiCommand, parseTuiCommand } = await import("../dist/tui/commands.js");
  const { initialState } = await import("../dist/tui/state.js");
  const { ConfigStore } = await import("../dist/config.js");
  const cwd = await mkdtemp(path.join(tmpdir(), "hive-session-"));
  try {
    let state = initialState();
    state = (await executeTuiCommand(parseTuiCommand("/mode autonomous"), state, cwd)).state;
    assert.equal(state.sessionMode, "autonomous");
    assert.match(state.transcript.join("\n"), /Mode set to autonomous/);
    assert.equal(await new ConfigStore(cwd).getMode(), "autonomous");

    state = (await executeTuiCommand(parseTuiCommand("/plan"), state, cwd)).state;
    assert.equal(state.sessionMode, "plan");
    assert.match(state.transcript.join("\n"), /will not apply edits/);
    assert.equal(await new ConfigStore(cwd).getMode(), "plan");

    state = (await executeTuiCommand(parseTuiCommand("/sessions"), state, cwd)).state;
    assert.match(state.outputLines.join("\n"), /Saved sessions/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("scripted turn streams activity and records a guarded permission decision", async () => {
  const { playTurn } = await import("../dist/tui/interaction.js");
  const seen = [];
  const pending = playTurn({
    mode: "guarded",
    chunks: [
      { kind: "text", text: "Reading the auth path." },
      { kind: "activity", activity: { kind: "read", target: "src/auth.ts" } },
      {
        kind: "activity",
        activity: { kind: "command", target: "npm test --header sk-abcdefghijklmnopqrstuvwxyz" },
      },
      {
        kind: "permission",
        action: { kind: "edit", target: "src/auth.ts", inWorkspace: true, confirmed: false },
      },
      { kind: "text", text: "Edit recorded." },
    ],
    onLine(line) { seen.push(line); },
    answer() { return true; },
  });

  await Promise.resolve();
  assert.ok(seen.length >= 1, "expected the first line before the turn finished");
  assert.match(seen[0], /Reading the auth path/);

  const result = await pending;
  const transcript = result.lines.join("\n");
  assert.match(transcript, /read src\/auth\.ts/);
  assert.match(transcript, /^command npm$/m);
  assert.equal(transcript.includes("sk-"), false);
  assert.match(transcript, /permission edit src\/auth\.ts - asking/);
  assert.match(transcript, /permission edit src\/auth\.ts - allowed/);
  assert.equal(result.applied.length, 1);
  assert.equal(result.applied[0].kind, "edit");
  assert.equal(result.interrupted, false);
});

test("plan mode asks and still does not apply an approved edit", async () => {
  const { playTurn } = await import("../dist/tui/interaction.js");
  const result = await playTurn({
    mode: "plan",
    chunks: [
      { kind: "activity", activity: { kind: "read", target: "src/app.ts" } },
      {
        kind: "permission",
        action: { kind: "edit", target: "src/app.ts", inWorkspace: true, confirmed: false },
      },
    ],
    onLine() {},
    answer() { return true; },
  });
  assert.equal(result.applied.length, 0);
  assert.match(result.lines.join("\n"), /Plan mode does not apply edits/);
});

test("autonomous mode applies an in-workspace edit and refuses an unconfirmed push", async () => {
  const { playTurn } = await import("../dist/tui/interaction.js");
  const result = await playTurn({
    mode: "autonomous",
    chunks: [
      {
        kind: "permission",
        action: { kind: "edit", target: "src/app.ts", inWorkspace: true, confirmed: false },
      },
      {
        kind: "permission",
        action: { kind: "push", target: "git push origin main", inWorkspace: true, confirmed: false },
      },
    ],
    onLine() {},
  });
  assert.deepEqual(result.applied.map((action) => action.kind), ["edit"]);
  const transcript = result.lines.join("\n");
  assert.match(transcript, /hive push --confirmed/);
  assert.equal(transcript.includes("origin"), false);
});

test("runtime activity lines hide tool arguments and a guarded pause asks", async () => {
  const { activityLineForRuntimeEvent } = await import("../dist/tui/interaction.js");
  const { executeTuiCommand, parseTuiCommand } = await import("../dist/tui/commands.js");
  const { initialState } = await import("../dist/tui/state.js");

  const commandLine = activityLineForRuntimeEvent({
    type: "subagent.tool_call",
    payload: {
      tool: "run_command",
      input: {
        command: "npm test",
        token: "sk-abcdefghijklmnopqrstuvwxyz",
      },
    },
  });
  assert.equal(commandLine, "command npm");

  const secretOutput = activityLineForRuntimeEvent({
    type: "command.output",
    payload: { chunk: "sk-abcdefghijklmnopqrstuvwxyz" },
  });
  assert.equal(secretOutput, null);

  let projected = { ...initialState(), sessionMode: "guarded" };
  const runSession = async ({ onEvent }) => {
    onEvent({
      schemaVersion: 1,
      id: "event-1",
      sequence: 1,
      sessionId: "session-guarded",
      timestamp: "2026-10-16T00:00:00.000Z",
      type: "subagent.tool_call",
      payload: {
        subagentId: "bee-001",
        tool: "read_file",
        input: { path: "src/auth.ts", content: "sk-abcdefghijklmnopqrstuvwxyz" },
      },
    });
    onEvent({
      schemaVersion: 1,
      id: "event-2",
      sequence: 2,
      sessionId: "session-guarded",
      timestamp: "2026-10-16T00:00:01.000Z",
      type: "command.started",
      payload: {
        commandId: "cmd-1",
        command: "npm test --header sk-abcdefghijklmnopqrstuvwxyz",
        cwd: "/workspace",
      },
    });
    onEvent({
      schemaVersion: 1,
      id: "event-3",
      sequence: 3,
      sessionId: "session-guarded",
      timestamp: "2026-10-16T00:00:02.000Z",
      type: "command.output",
      payload: { commandId: "cmd-1", stream: "stdout", chunk: "sk-abcdefghijklmnopqrstuvwxyz" },
    });
    onEvent({
      schemaVersion: 1,
      id: "event-4",
      sequence: 4,
      sessionId: "session-guarded",
      timestamp: "2026-10-16T00:00:03.000Z",
      type: "session.paused",
      payload: { reason: "Repository changes require approval." },
    });
  };

  const result = await executeTuiCommand(
    parseTuiCommand("fix auth"),
    projected,
    process.cwd(),
    (updater) => { projected = updater(projected); },
    { runSession },
  );
  await result.runtime.completion;

  const transcript = projected.transcript.join("\n");
  assert.match(transcript, /read src\/auth\.ts/);
  assert.match(transcript, /command npm/);
  assert.equal(transcript.includes("sk-"), false);
  assert.match(transcript, /permission edit workspace - asking/);
  assert.match(projected.permissionPrompt, /Allow in-workspace edits/);
  assert.equal(projected.sessionId, "session-guarded");
});

test("Esc cancels a live turn and the next Ctrl+C exits", async () => {
  const { nextInterrupt } = await import("../dist/tui/interaction.js");
  const cancelled = nextInterrupt({
    key: "escape",
    turnLive: true,
    exitArmed: false,
    permissionPending: false,
  });
  assert.equal(cancelled.action, "cancel-turn");
  assert.equal(cancelled.turnLive, false);
  const exited = nextInterrupt({
    key: "ctrl-c",
    turnLive: cancelled.turnLive,
    exitArmed: cancelled.exitArmed,
    permissionPending: false,
  });
  assert.equal(exited.action, "exit");

  const armed = nextInterrupt({
    key: "ctrl-c",
    turnLive: false,
    exitArmed: false,
    permissionPending: false,
  });
  assert.equal(armed.action, "arm-exit");
});

test("an aborted scripted turn stops before later chunks", async () => {
  const { playTurn } = await import("../dist/tui/interaction.js");
  const controller = new AbortController();
  let count = 0;
  const result = await playTurn({
    mode: "guarded",
    signal: controller.signal,
    chunks: [
      { kind: "text", text: "one" },
      { kind: "text", text: "two" },
      { kind: "text", text: "three" },
    ],
    onLine() {
      count += 1;
      if (count === 1) controller.abort();
    },
  });
  assert.equal(result.interrupted, true);
  assert.equal(result.lines.includes("one"), true);
  assert.equal(result.lines.includes("two"), false);
  assert.match(result.lines.join("\n"), /Turn interrupted/);
});
