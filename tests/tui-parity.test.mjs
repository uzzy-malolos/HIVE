/**
 * tui-parity.test.mjs
 * Command picker, file picker, in-turn diff, live provider text, and rewind.
 */

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

function agentTask() {
  return {
    id: "bee-stream",
    sessionId: "session-1",
    role: "builder",
    title: "Build",
    objective: "Build one file",
    status: "working",
    providerId: "mock",
    dependencies: [],
    fileScope: ["src/a.ts"],
    expectedOutput: "A file",
    completionCriteria: ["Done"],
    validationCommands: [],
    depth: 1,
    attempt: 1,
    maxAttempts: 1,
    createdAt: "2026-10-16T00:00:00.000Z",
  };
}

test("slash picker filters, selects, and renders", async () => {
  const { acceptPicker, commandPicker, slashQuery } = await import("../dist/tui/picker.js");
  const { renderTuiScreen } = await import("../dist/tui/renderer.js");
  const { initialState } = await import("../dist/tui/state.js");
  const { parseTuiCommand } = await import("../dist/tui/commands.js");

  assert.equal(parseTuiCommand("/rewind").kind, "rewind");
  assert.equal(slashQuery("/re"), "re");
  assert.equal(slashQuery("/mode plan"), null);

  const partial = commandPicker("/m");
  assert.equal(partial.items[0].label, "/model"); // Exact /m alias outranks the /mode prefix.
  const inserted = acceptPicker("/m", partial);
  assert.equal(inserted.submit, false);
  assert.equal(inserted.input, "/model ");

  const exact = acceptPicker("/mode", commandPicker("/mode"));
  assert.equal(exact.submit, true);
  assert.equal(exact.input, "/mode");

  const rewind = commandPicker("/re");
  assert.equal(rewind.items[0].label, "/rewind");
  const state = {
    ...initialState(),
    width: 100,
    height: 32,
    colorEnabled: false,
    input: "/re",
    picker: rewind,
  };
  const frame = renderTuiScreen(state);
  assert.match(frame, /\/rewind/);
  assert.match(frame, /enter selects \S esc closes/);
  const longest = Math.max(...frame.split("\n").map((line) => line.length));
  assert.ok(longest <= 100, `picker frame is ${longest} columns`);
});

test("file picker searches paths, caps results, and does not read file contents", async () => {
  const { filePicker, insertFileMention, listWorkspaceFiles, rankFilePaths } = await import("../dist/tui/picker.js");
  const { renderTuiScreen } = await import("../dist/tui/renderer.js");
  const { initialState } = await import("../dist/tui/state.js");
  const root = await mkdtemp(path.join(tmpdir(), "hive-files-"));
  try {
    await writeFile(path.join(root, "beta.ts"), "FILE_BODY_DO_NOT_DUMP\n");
    await writeFile(path.join(root, "alpha.ts"), "alpha\n");
    await mkdir(path.join(root, "node_modules"), { recursive: true });
    await writeFile(path.join(root, "node_modules", "secret.js"), "SECRET_MODULE\n");
    const paths = await listWorkspaceFiles(root);
    assert.deepEqual(paths, ["alpha.ts", "beta.ts"]);
    assert.equal(paths.join("\n").includes("FILE_BODY_DO_NOT_DUMP"), false);
    assert.equal(paths.join("\n").includes("SECRET_MODULE"), false);

    const many = Array.from({ length: 20 }, (_, index) => `file-${index}.ts`);
    assert.equal(rankFilePaths(many, "file").length, 8);

    const picker = filePicker("@b", paths);
    assert.equal(picker.items[0].label, "beta.ts");
    assert.equal(insertFileMention("read @b", "beta.ts"), "read @beta.ts ");
    const frame = renderTuiScreen({
      ...initialState(),
      width: 100,
      height: 32,
      colorEnabled: false,
      input: "@b",
      picker,
    });
    assert.match(frame, /beta\.ts/);
    assert.equal(frame.includes("FILE_BODY_DO_NOT_DUMP"), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("scripted composer filters commands, inserts a file path, and closes on Esc", async () => {
  const { renderTuiScreen } = await import("../dist/tui/renderer.js");
  const { TuiApp } = await import("../dist/tui/app.js");
  const root = await mkdtemp(path.join(tmpdir(), "hive-composer-"));
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    await writeFile(path.join(root, "beta.ts"), "FILE_BODY_DO_NOT_DUMP\n");
    await writeFile(path.join(root, "alpha.ts"), "alpha\n");
    const app = new TuiApp(root);
    const feed = (text) => {
      app.inputBuffer += text;
      app.processInputBuffer();
    };

    feed("/re");
    assert.equal(app.state.picker?.kind, "command");
    assert.equal(app.state.picker.items[0].label, "/rewind");
    const commandFrame = renderTuiScreen({ ...app.state, width: 100, height: 32, colorEnabled: false });
    assert.match(commandFrame, /\/rewind/);
    assert.equal(commandFrame.includes("\x1b["), false);

    feed("\x1b");
    assert.equal(app.state.picker, undefined);
    assert.equal(app.state.input, "/re");
    assert.equal(app.stopped, false);

    feed("\x7f\x7f\x7f@b");
    for (let attempt = 0; attempt < 20 && app.state.picker?.items?.length !== 1; attempt += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(app.state.picker?.kind, "file");
    assert.equal(app.state.picker.items[0].insert, "beta.ts");
    feed("\r");
    assert.equal(app.state.input, "@beta.ts ");
    assert.equal(app.state.input.includes("FILE_BODY_DO_NOT_DUMP"), false);
    assert.equal(app.state.picker, undefined);
  } finally {
    process.stdout.write = originalWrite;
    await rm(root, { recursive: true, force: true });
  }
});

test("edit activity renders a bounded redacted diff", async () => {
  const { diffLinesForRuntimeEvent, formatUnifiedDiff } = await import("../dist/tui/diff-view.js");
  const { executeTuiCommand, parseTuiCommand } = await import("../dist/tui/commands.js");
  const { renderTuiScreen } = await import("../dist/tui/renderer.js");
  const { initialState } = await import("../dist/tui/state.js");

  const edited = formatUnifiedDiff({
    path: "src/auth.ts",
    before: "keep\ntoken sk-abcdefghijklmnopqrstuvwxyz\n",
    after: "keep\ntoken ok\n",
    baseline: "exact",
  });
  assert.match(edited[0], /^diff src\/auth\.ts {2}\+1 -1$/);
  assert.match(edited.join("\n"), /\+token ok/);
  assert.match(edited.join("\n"), /\[REDACTED\]/);
  assert.equal(edited.join("\n").includes("sk-"), false);

  const bulky = formatUnifiedDiff({
    path: "src/big.ts",
    before: "",
    after: Array.from({ length: 40 }, (_, index) => `line ${index}`).join("\n"),
    baseline: "empty",
  });
  assert.match(bulky[0], /\+40 -0/);
  assert.ok(bulky.includes("...[truncated]"));
  assert.ok(bulky.filter((line) => line.startsWith("+") && !line.startsWith("+++")).length <= 16);

  const written = diffLinesForRuntimeEvent({
    type: "subagent.tool_call",
    payload: { tool: "write_file", input: { path: "src/a.ts", content: "hello\n" } },
  });
  assert.match(written.join("\n"), /previous file text was not on the event/);

  const secretRead = diffLinesForRuntimeEvent({
    type: "subagent.tool_call",
    payload: { tool: "read_file", input: { path: "src/a.ts", content: "sk-abcdefghijklmnopqrstuvwxyz" } },
  });
  assert.deepEqual(secretRead, []);

  let projected = initialState();
  const result = await executeTuiCommand(
    parseTuiCommand("edit auth"),
    projected,
    process.cwd(),
    (updater) => { projected = updater(projected); },
    {
      runSession: async ({ onEvent }) => {
        onEvent({
          schemaVersion: 1,
          id: "event-diff",
          sequence: 1,
          sessionId: "session-diff",
          timestamp: "2026-10-16T00:00:00.000Z",
          type: "subagent.tool_call",
          payload: {
            subagentId: "bee-1",
            tool: "edit_file",
            input: {
              path: "src/auth.ts",
              search: "return 1;\n",
              replacement: "return sk-abcdefghijklmnopqrstuvwxyz;\n",
            },
          },
        });
      },
    },
  );
  projected = result.state;
  await result.runtime.completion;
  const transcript = projected.transcript.join("\n");
  assert.match(transcript, /edit src\/auth\.ts/);
  assert.match(transcript, /diff src\/auth\.ts {2}\+1 -1/);
  assert.match(transcript, /\[REDACTED\]/);
  assert.equal(transcript.includes("sk-"), false);

  const frame = renderTuiScreen({
    ...initialState(),
    width: 100,
    height: 90,
    colorEnabled: false,
    transcript: edited,
    liveText: "Reading the auth path",
  });
  assert.match(frame, /diff src\/auth\.ts/);
  assert.match(frame, /Reading the auth path/);
  assert.equal(frame.includes("sk-"), false);
});

test("provider stream chunks update assistant prose without inventing tokens", async () => {
  const { StructuredAgentLoop } = await import("../dist/coding/agent-loop.js");
  const { executeTuiCommand, parseTuiCommand } = await import("../dist/tui/commands.js");
  const { runTuiTask } = await import("../dist/tui/runtime-adapter.js");
  const { initialState } = await import("../dist/tui/state.js");

  const secret = "sk-abcdefghijklmnopqrstuvwxyz";
  const streamed = JSON.stringify({
    done: true,
    summary: `Hello ${secret} hive`,
    toolCalls: [{ name: "write_file", arguments: { content: "SECRET_BODY_SHOULD_NOT_STREAM" } }],
  });
  const pieces = [];
  for (let index = 0; index < streamed.length; index += 12) pieces.push(streamed.slice(index, index + 12));
  const deltas = [];
  let completeCalls = 0;
  const streamedResult = await new StructuredAgentLoop().run({
    task: agentTask(),
    cwd: process.cwd(),
    sharedContext: "context",
    completionClient: {
      async complete() {
        completeCalls += 1;
        return { output: streamed };
      },
      async streamComplete(_request, onChunk) {
        for (const piece of pieces) onChunk(piece);
        return { output: streamed };
      },
    },
    tools: { async execute() { return { ok: true, output: "unused" }; } },
    signal: new AbortController().signal,
    onEvent(event) {
      if (event.type === "assistant.delta") deltas.push(event.payload.text);
    },
  });
  assert.equal(completeCalls, 0);
  assert.equal(streamedResult.summary, `Hello ${secret} hive`);
  assert.ok(deltas.length >= 2, "expected more than one provider chunk");
  for (const text of deltas) {
    assert.equal(text.includes("SECRET_BODY_SHOULD_NOT_STREAM"), false);
    assert.equal(text.includes("toolCalls"), false);
    assert.equal(text.includes(secret), false);
  }
  assert.match(deltas.at(-1), /Hello \[REDACTED\] hive/);

  const buffered = [];
  await new StructuredAgentLoop().run({
    task: agentTask(),
    cwd: process.cwd(),
    sharedContext: "context",
    completionClient: {
      async complete() {
        return { output: JSON.stringify({ done: true, summary: "Buffered once" }) };
      },
    },
    tools: { async execute() { return { ok: true, output: "unused" }; } },
    signal: new AbortController().signal,
    onEvent(event) {
      if (event.type === "assistant.delta") buffered.push(event.payload.text);
    },
  });
  assert.deepEqual(buffered, ["Buffered once"]);

  const seen = [];
  const handle = runTuiTask(process.cwd(), "say hello", {
    onEvent() {},
    onText(text) { seen.push(text); },
  }, {
    runSession: async ({ onText }) => {
      onText?.("Hel");
      onText?.("Hello");
    },
  });
  await handle.completion;
  assert.deepEqual(seen, ["Hel", "Hello"]);

  let projected = initialState();
  const snapshots = [];
  const result = await executeTuiCommand(
    parseTuiCommand("say hello"),
    projected,
    process.cwd(),
    (updater) => { projected = updater(projected); },
    {
      runSession: async ({ onText, onEvent }) => {
        onText?.("Hel");
        snapshots.push(projected.liveText);
        onText?.(`Hello ${secret}`);
        snapshots.push(projected.liveText);
        onEvent({
          schemaVersion: 1,
          id: "event-out",
          sequence: 1,
          sessionId: "session-stream",
          timestamp: "2026-10-16T00:00:00.000Z",
          type: "command.output",
          payload: { commandId: "cmd-1", stream: "stdout", chunk: `ready ${secret} next` },
        });
        onEvent({
          schemaVersion: 1,
          id: "event-done",
          sequence: 2,
          sessionId: "session-stream",
          timestamp: "2026-10-16T00:00:01.000Z",
          type: "session.completed",
          payload: { summary: "done" },
        });
      },
    },
  );
  projected = result.state;
  await result.runtime.completion;
  assert.deepEqual(snapshots, ["Hel", "Hello [REDACTED]"]);
  const transcript = projected.transcript.join("\n");
  assert.match(transcript, /Hello \[REDACTED\]/);
  assert.match(transcript, /stdout ready \[REDACTED\] next/);
  assert.equal(transcript.includes(secret), false);
});

test("/rewind restores the previous user turn and leaves the coding session file in place", async () => {
  const { executeTuiCommand, parseTuiCommand } = await import("../dist/tui/commands.js");
  const { appendTranscriptLine, initialState } = await import("../dist/tui/state.js");
  const root = await mkdtemp(path.join(tmpdir(), "hive-rewind-"));
  const marker = path.join(root, ".hivemind", "coding-sessions", "keep-session", "session.json");
  try {
    await mkdir(path.dirname(marker), { recursive: true });
    await writeFile(marker, "{\"id\":\"keep-session\"}\n");

    let state = initialState();
    state = appendTranscriptLine(state, "[User] first task");
    state = appendTranscriptLine(state, "read src/a.ts");
    state = appendTranscriptLine(state, "  $ second task");
    state = appendTranscriptLine(state, "  Working: second task");
    state = appendTranscriptLine(state, "[User] second task");
    state = appendTranscriptLine(state, "edit src/b.ts");
    state = (await executeTuiCommand(parseTuiCommand("/rewind"), state, root)).state;
    const transcript = state.transcript.join("\n");
    assert.match(transcript, /\[User\] first task/);
    assert.match(transcript, /read src\/a\.ts/);
    assert.equal(transcript.includes("second task"), false);
    assert.equal(transcript.includes("src/b.ts"), false);
    assert.match(transcript, /saved coding session were not changed/);
    assert.equal(await readFile(marker, "utf8"), "{\"id\":\"keep-session\"}\n");

    const running = { ...initialState(), taskStatus: "running", transcript: ["[User] keep me"] };
    const refused = (await executeTuiCommand(parseTuiCommand("/rewind"), running, root)).state;
    assert.match(refused.transcript.join("\n"), /\[User\] keep me/);
    assert.match(refused.outputLines.at(-1), /Press Esc before \/rewind/);
    assert.equal(await readFile(marker, "utf8"), "{\"id\":\"keep-session\"}\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

function runtimeEvent(id, type, payload) {
  return {
    schemaVersion: 1,
    id,
    sequence: 1,
    sessionId: "session-card",
    timestamp: "2026-10-16T00:00:00.000Z",
    type,
    payload,
  };
}

test("a tool card expands and collapses without using j, k, or the arrow keys", async () => {
  const { executeTuiCommand, parseTuiCommand } = await import("../dist/tui/commands.js");
  const { renderTuiScreen } = await import("../dist/tui/renderer.js");
  const { initialState } = await import("../dist/tui/state.js");
  const { TuiApp } = await import("../dist/tui/app.js");

  let projected = { ...initialState(), width: 100, height: 30, colorEnabled: false, sessionMode: "guarded" };
  const result = await executeTuiCommand(
    parseTuiCommand("edit the gate"),
    projected,
    process.cwd(),
    (updater) => { projected = updater(projected); },
    {
      runSession: async ({ onEvent }) => {
        onEvent(runtimeEvent("read-1", "subagent.tool_call", {
          subagentId: "bee-1",
          tool: "read_file",
          input: { path: "src/auth.ts" },
        }));
        onEvent(runtimeEvent("edit-1", "subagent.tool_call", {
          subagentId: "bee-1",
          tool: "edit_file",
          input: {
            path: "src/gate.ts",
            search: "return 1;\n",
            replacement: "return HIVE_CARD_TOKEN;\n",
          },
        }));
      },
    },
  );
  projected = result.state;
  await result.runtime.completion;

  const transcript = projected.transcript.join("\n");
  assert.match(transcript, /read src\/auth\.ts/);
  assert.match(transcript, /edit src\/gate\.ts/);
  assert.match(transcript, /HIVE_CARD_TOKEN/);

  const shown = () => renderTuiScreen({ ...projected, width: 100, height: 30, colorEnabled: false, scrollOffset: 0 });
  const open = shown();
  const openLines = open.split("\n");
  assert.equal(openLines.length, 30);
  const rule = openLines.findLastIndex((line) => line.startsWith("╭") || line.startsWith("+"));
  assert.ok(openLines.slice(0, rule).length > openLines.length / 2);
  assert.match(open, /read_file\(src\/auth\.ts\) +running/);
  assert.equal(open.includes("read src/auth.ts"), false);
  assert.match(open, /edit_file\(src\/gate\.ts\) +running/);
  assert.match(open, /HIVE_CARD_TOKEN/);
  assert.equal(open.includes("Awaiting approval"), false);

  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const app = new TuiApp(process.cwd());
    app.state = { ...projected, width: 100, height: 30, colorEnabled: false };
    const feed = (text) => {
      app.inputBuffer += text;
      app.processInputBuffer();
    };
    feed("\x1b[A");
    feed("\x1b[B");
    feed("jk");
    assert.equal(app.state.input, "jk");
    assert.match(renderTuiScreen(app.state), /HIVE_CARD_TOKEN/);
    feed("\x7f\x7f");
    assert.equal(app.state.input, "");

    feed("\x0f");
    const collapsed = renderTuiScreen(app.state);
    assert.match(collapsed, /edit_file\(src\/gate\.ts\)/);
    assert.equal(collapsed.includes("HIVE_CARD_TOKEN"), false);
    assert.match(app.state.transcript.join("\n"), /HIVE_CARD_TOKEN/);

    feed("\x0f");
    assert.match(renderTuiScreen(app.state), /HIVE_CARD_TOKEN/);
  } finally {
    process.stdout.write = originalWrite;
  }
});

test("guarded Accept on the newest tool card calls decidePermission, and plan does not apply", async () => {
  const { executeTuiCommand, parseTuiCommand } = await import("../dist/tui/commands.js");
  const { decidePermission, settlePermissionAsk } = await import("../dist/tui/interaction.js");
  const { renderTuiScreen } = await import("../dist/tui/renderer.js");
  const { initialState } = await import("../dist/tui/state.js");
  const { TuiApp } = await import("../dist/tui/app.js");

  const edit = {
    subagentId: "bee-1",
    tool: "edit_file",
    input: {
      path: "src/gate.ts",
      search: "return 1;\n",
      replacement: "return HIVE_ACCEPT_TOKEN;\n",
    },
  };

  let projected = { ...initialState(), width: 100, height: 30, colorEnabled: false, sessionMode: "guarded" };
  const guarded = await executeTuiCommand(
    parseTuiCommand("edit the gate"),
    projected,
    process.cwd(),
    (updater) => { projected = updater(projected); },
    {
      runSession: async ({ onEvent }) => {
        onEvent(runtimeEvent("edit-ask", "subagent.tool_call", edit));
        onEvent(runtimeEvent("pause-ask", "session.paused", { reason: "Repository changes require approval." }));
      },
    },
  );
  projected = guarded.state;
  await guarded.runtime.completion;

  const asking = renderTuiScreen({ ...projected, width: 100, height: 30, colorEnabled: false, scrollOffset: 0 });
  assert.match(asking, /edit_file\(src\/gate\.ts\) +asking/);
  assert.match(asking, /HIVE_ACCEPT_TOKEN/);
  assert.match(asking, /Awaiting approval/);
  assert.match(asking, /Allow in-workspace edits\?/, "the selector box carries the question");
  assert.match(asking, /1\. Yes/);
  assert.match(asking, /2\. No/);
  assert.match(projected.permissionPrompt, /Allow in-workspace edits/);
  assert.equal(projected.editsApproved, false);

  const pending = projected.pendingPermission;
  const refused = settlePermissionAsk("plan", pending, true, {});
  assert.equal(refused.applied, false);
  assert.match(refused.detail, /Plan mode does not apply edits/);
  assert.equal(refused.decision.canApply, decidePermission("plan", {
    kind: "edit",
    target: "workspace",
    inWorkspace: true,
    confirmed: false,
  }).canApply);

  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const planApp = new TuiApp(process.cwd());
    planApp.state = { ...projected, sessionMode: "plan", editsApproved: false, width: 100, height: 30, colorEnabled: false };
    planApp.inputBuffer += "y\r";
    planApp.processInputBuffer();
    assert.equal(planApp.state.editsApproved, false);
    assert.match(planApp.state.transcript.join("\n"), /Plan mode does not apply edits/);
    assert.equal(planApp.state.transcript.join("\n").includes("permission edit workspace - allowed"), false);

    const app = new TuiApp(process.cwd());
    app.state = { ...projected, width: 100, height: 30, colorEnabled: false };
    app.inputBuffer += "y\r";
    app.processInputBuffer();
    assert.equal(app.state.editsApproved, true);
    assert.match(app.state.transcript.join("\n"), /permission edit workspace - allowed/);
    const allowed = renderTuiScreen(app.state);
    assert.match(allowed, /edit_file\(src\/gate\.ts\) +allowed/);
    assert.equal(allowed.includes("Awaiting approval"), false);
    assert.match(allowed, /HIVE_ACCEPT_TOKEN/);
  } finally {
    process.stdout.write = originalWrite;
  }

  let planned = { ...initialState(), width: 100, height: 30, colorEnabled: false, sessionMode: "plan" };
  const planRun = await executeTuiCommand(
    parseTuiCommand("plan the gate"),
    planned,
    process.cwd(),
    (updater) => { planned = updater(planned); },
    {
      runSession: async ({ onEvent }) => {
        onEvent(runtimeEvent("edit-plan", "subagent.tool_call", {
          ...edit,
          input: { ...edit.input, replacement: "return HIVE_PLAN_TOKEN;\n" },
        }));
      },
    },
  );
  planned = planRun.state;
  await planRun.runtime.completion;
  const planFrame = renderTuiScreen({ ...planned, width: 100, height: 30, colorEnabled: false, scrollOffset: 0 });
  assert.match(planFrame, /edit_file\(src\/gate\.ts\) +planned/);
  assert.match(planFrame, /HIVE_PLAN_TOKEN/);
  assert.equal(planFrame.includes("Awaiting approval"), false);
  assert.equal(planned.pendingPermission.canApply, false);
  assert.equal(planned.editsApproved, false);
  assert.match(planned.transcript.join("\n"), /Plan mode does not apply edits/);
});

async function ticks(count = 1) {
  for (let index = 0; index < count; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

test("a submit during a live turn queues and runs after that turn resolves", async () => {
  const { sessionHelpLines } = await import("../dist/tui/interaction.js");
  const { renderTuiScreen } = await import("../dist/tui/renderer.js");
  const { TuiApp } = await import("../dist/tui/app.js");
  const help = sessionHelpLines().join("\n");
  assert.match(help, /Enter during a turn queues it/);
  assert.match(help, /second Esc or Ctrl\+C clears it/);

  const started = [];
  let releaseFirst = () => {};
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const app = new TuiApp(process.cwd(), {
    runSession: ({ objective }) => {
      started.push(objective);
      if (objective === "first task") return firstGate;
      return Promise.resolve();
    },
  });
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const feed = (text) => {
      app.inputBuffer += text;
      app.processInputBuffer();
    };
    feed("first task\r");
    feed("second task\r");
    feed("third task\r");
    assert.deepEqual(app.state.messageQueue, ["second task", "third task"]);
    assert.equal(app.state.transcript.join("\n").includes("still running"), false);
    assert.deepEqual(started, []);

    for (let attempt = 0; attempt < 30 && started.length < 1; attempt += 1) await ticks();
    assert.deepEqual(started, ["first task"]);
    assert.deepEqual(app.state.messageQueue, ["second task", "third task"]);

    const queued = renderTuiScreen({ ...app.state, width: 100, height: 30, colorEnabled: false, scrollOffset: 0 });
    const lines = queued.split("\n");
    assert.equal(lines.length, 30);
    const rule = lines.findIndex((line) => line.startsWith("------------------------"));
    assert.ok(lines.slice(1, rule).length > lines.length / 2, `transcript rows ${lines.slice(1, rule).length}`);
    assert.match(queued, /2 queued {2}second task/);
    assert.equal(queued.includes("third task"), false);

    releaseFirst();
    for (let attempt = 0; attempt < 40 && started.length < 3; attempt += 1) await ticks();
    assert.deepEqual(started, ["first task", "second task", "third task"]);
    assert.deepEqual(app.state.messageQueue, []);
  } finally {
    releaseFirst();
    process.stdout.write = originalWrite;
  }
});

test("Esc cancels a live turn and keeps the queue; a second cancel clears it", async () => {
  const { TuiApp } = await import("../dist/tui/app.js");
  const started = [];
  let releaseFirst = () => {};
  let releaseCleared = () => {};
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const app = new TuiApp(process.cwd(), {
      runSession: ({ objective }) => {
        started.push(objective);
        if (started.length === 1) return firstGate;
        return Promise.resolve();
      },
    });
    const feed = (text) => {
      app.inputBuffer += text;
      app.processInputBuffer();
    };
    feed("first task\r");
    for (let attempt = 0; attempt < 30 && started.length === 0; attempt += 1) await ticks();
    assert.equal(app.turnLive, true);
    feed("kept task\r");
    assert.deepEqual(app.state.messageQueue, ["kept task"]);

    let queuedAtCancel = -1;
    const runtime = app.activeRuntime;
    const cancel = runtime.cancel.bind(runtime);
    runtime.cancel = (reason) => {
      queuedAtCancel = app.state.messageQueue.length;
      cancel(reason);
    };
    feed("\x1b");
    assert.equal(queuedAtCancel, 1);
    assert.equal(app.turnLive, false);
    assert.equal(app.stopped, false);
    assert.deepEqual(app.state.messageQueue, ["kept task"]);

    feed("\x1b");
    assert.deepEqual(app.state.messageQueue, []);
    assert.equal(app.stopped, false);
    releaseFirst();
    await ticks(8);
    assert.deepEqual(started, ["first task"]);
    assert.deepEqual(app.state.messageQueue, []);

    const clearedGate = new Promise((resolve) => { releaseCleared = resolve; });
    const cleared = new TuiApp(process.cwd(), {
      runSession: () => clearedGate,
    });
    const feedCleared = (text) => {
      cleared.inputBuffer += text;
      cleared.processInputBuffer();
    };
    feedCleared("another task\r");
    for (let attempt = 0; attempt < 30 && !cleared.turnLive; attempt += 1) await ticks();
    feedCleared("drop me\r");
    assert.deepEqual(cleared.state.messageQueue, ["drop me"]);
    let queuedAtCtrlC = -1;
    const active = cleared.activeRuntime;
    const cancelActive = active.cancel.bind(active);
    active.cancel = (reason) => {
      queuedAtCtrlC = cleared.state.messageQueue.length;
      cancelActive(reason);
    };
    feedCleared("\x03");
    assert.equal(queuedAtCtrlC, 1);
    assert.deepEqual(cleared.state.messageQueue, []);
    assert.equal(cleared.turnLive, false);
    assert.equal(cleared.stopped, false);
  } finally {
    releaseFirst();
    releaseCleared();
    process.stdout.write = originalWrite;
  }
});

test("status line includes a branch when git output is injected", async () => {
  const { parseGitBranch, renderTuiScreen } = await import("../dist/tui/renderer.js");
  const { initialState } = await import("../dist/tui/state.js");
  const branch = parseGitBranch("feature/status\r\n");
  assert.equal(branch, "feature/status");
  assert.equal(parseGitBranch(""), undefined);
  assert.equal(parseGitBranch(" \n"), undefined);

  const frame = renderTuiScreen({
    ...initialState(),
    width: 120,
    height: 30,
    colorEnabled: false,
    provider: "openai",
    model: "gpt-test",
    sessionId: "sess-1",
    sessionMode: "guarded",
    workspaceName: "hive-repo",
    gitBranch: branch,
    transcript: ["status token"],
    outputLines: [],
    scrollOffset: 0,
  });
  const status = frame.split("\n").at(-1);
  assert.match(status, /guarded mode/);
  assert.match(status, /openai\/gpt-test/);
  assert.match(status, /session:sess-1/);
  assert.match(status, /hive-repo/);
  assert.match(status, /feature\/status/);
  assert.equal(status.includes("$"), false);
  assert.equal(/\btok\b/.test(status), false);

  const withUsage = renderTuiScreen({
    ...initialState(),
    width: 120,
    height: 30,
    colorEnabled: false,
    provider: "openai",
    model: "gpt-test",
    sessionId: "sess-1",
    sessionMode: "guarded",
    workspaceName: "hive-repo",
    gitBranch: branch,
    subagents: [{ tokenUsage: { total: 42 } }],
    transcript: ["status token"],
    outputLines: [],
    scrollOffset: 0,
  });
  const usageStatus = withUsage.split("\n").at(-1);
  assert.match(usageStatus, /42 tok/);
  assert.equal(usageStatus.includes("$"), false);

  const withReceipt = renderTuiScreen({
    ...initialState(),
    width: 140,
    height: 30,
    colorEnabled: false,
    subagents: [{ tokenUsage: { total: 42, cost: 1.5 } }],
    transcript: [],
    outputLines: [],
    scrollOffset: 0,
  });
  assert.match(withReceipt.split("\n").at(-1), /\$1\.5/);
});

test("Ctrl+Left focuses the previous tool card, and a shell card shows the redacted command", async () => {
  const { executeTuiCommand, parseTuiCommand } = await import("../dist/tui/commands.js");
  const { shellCommandPreview } = await import("../dist/tui/interaction.js");
  const { renderTuiScreen } = await import("../dist/tui/renderer.js");
  const { initialState } = await import("../dist/tui/state.js");
  const { TuiApp } = await import("../dist/tui/app.js");

  const longTail = "y".repeat(220);
  const longCommand = `npm test ${longTail}`;
  const preview = shellCommandPreview(longCommand);
  assert.equal(preview.length, 200);
  assert.match(preview, /^npm test /);
  assert.match(preview, /\.\.\.$/);
  assert.equal(preview.includes(longTail), false);

  let projected = { ...initialState(), width: 100, height: 30, colorEnabled: false, sessionMode: "guarded" };
  const result = await executeTuiCommand(
    parseTuiCommand("edit the gate"),
    projected,
    process.cwd(),
    (updater) => { projected = updater(projected); },
    {
      runSession: async ({ onEvent }) => {
        onEvent(runtimeEvent("read-focus", "subagent.tool_call", {
          subagentId: "bee-1",
          tool: "read_file",
          input: { path: "src/auth.ts" },
        }));
        onEvent(runtimeEvent("edit-focus", "subagent.tool_call", {
          subagentId: "bee-1",
          tool: "edit_file",
          input: {
            path: "src/gate.ts",
            search: "return 1;\n",
            replacement: "return HIVE_CARD_TOKEN;\n",
          },
        }));
      },
    },
  );
  projected = result.state;
  await result.runtime.completion;

  const originalWrite = process.stdout.write;
  process.stdout.write = () => true;
  try {
    const app = new TuiApp(process.cwd());
    app.state = { ...projected, width: 100, height: 30, colorEnabled: false, input: "", messageQueue: [] };
    const feed = (text) => {
      app.inputBuffer += text;
      app.processInputBuffer();
    };
    const shown = () => renderTuiScreen({ ...app.state, width: 100, height: 30, colorEnabled: false, scrollOffset: 0 });
    assert.match(shown(), /HIVE_CARD_TOKEN/);
    assert.equal(shown().includes("read src/auth.ts"), false);

    feed("\x1b[1;5D");
    const focused = shown();
    assert.match(focused, /[❯>] read_file\(src\/auth\.ts\)/);
    assert.equal(focused.includes("> edit_file"), false);

    feed("\x0f");
    const toggled = shown();
    assert.match(toggled, /read src\/auth\.ts/);
    assert.match(toggled, /HIVE_CARD_TOKEN/);

    feed("]");
    assert.match(shown(), /[❯>] edit_file\(/);
    feed("[");
    assert.match(shown(), /[❯>] read_file\(/);
  } finally {
    process.stdout.write = originalWrite;
  }

  const root = await mkdtemp(path.join(tmpdir(), "hive-read-card-"));
  const diskFile = path.join(root, "secret.txt");
  try {
    await writeFile(diskFile, "ONLY_ON_DISK\n");
    const lines = Array.from({ length: 13 }, (_, index) => `L${String(index + 1).padStart(2, "0")}-LINE`);
    lines[1] = "sk-abcdefghijklmnopqrstuvwxyz";
    let readState = { ...initialState(), width: 100, height: 40, colorEnabled: false, sessionMode: "autonomous" };
    const readRun = await executeTuiCommand(
      parseTuiCommand("read the file"),
      readState,
      root,
      (updater) => { readState = updater(readState); },
      {
        runSession: async ({ onEvent }) => {
          onEvent(runtimeEvent("read-body", "subagent.tool_call", {
            subagentId: "bee-1",
            tool: "read_file",
            input: { path: diskFile, content: "ARG_ONLY" },
            output: `${lines.join("\n")}\n`,
          }));
          onEvent(runtimeEvent("shell-1", "command.started", {
            commandId: "cmd-1",
            command: "npm test --watch --header sk-abcdefghijklmnopqrstuvwxyz",
            cwd: root,
          }));
        },
      },
    );
    readState = readRun.state;
    await readRun.runtime.completion;
    const transcript = readState.transcript.join("\n");
    assert.match(transcript, /command npm/);
    assert.match(transcript, /npm test --watch --header \[REDACTED\]/);
    assert.equal(transcript.includes("sk-"), false);
    assert.equal(transcript.includes("ONLY_ON_DISK"), false);
    assert.equal(transcript.includes("ARG_ONLY"), false);
    assert.match(transcript, /L01-LINE/);
    assert.match(transcript, /L12-LINE/);
    assert.equal(transcript.includes("L13-LINE"), false);

    let shellState = { ...initialState(), width: 120, height: 30, colorEnabled: false, sessionMode: "autonomous" };
    const shellRun = await executeTuiCommand(
      parseTuiCommand("run the long command"),
      shellState,
      root,
      (updater) => { shellState = updater(shellState); },
      {
        runSession: async ({ onEvent }) => {
          onEvent(runtimeEvent("shell-long", "subagent.tool_call", {
            subagentId: "bee-1",
            tool: "run_command",
            input: { command: longCommand },
          }));
        },
      },
    );
    shellState = shellRun.state;
    await shellRun.runtime.completion;
    const shellTranscript = shellState.transcript.join("\n");
    assert.match(shellTranscript, /npm test yyy/);
    assert.match(shellTranscript, /\.\.\./);
    assert.equal(shellTranscript.includes(longTail), false);
    assert.match(shellTranscript, /command npm/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
