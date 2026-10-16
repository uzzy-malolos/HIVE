import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { StructuredAgentLoop, visibleAssistantText } from "../dist/coding/agent-loop.js";
import { RuntimeEventBus, deserializeRuntimeEvent, serializeRuntimeEvent } from "../dist/coding/events.js";
import { QueenOrchestrator } from "../dist/coding/queen.js";
import { CodingSessionStore } from "../dist/coding/session-store.js";
import { RepositoryToolService } from "../dist/coding/tools.js";
import { validateDesktopEvent } from "../dist/desktop/electron/contracts.js";
import { executeTuiCommand, parseTuiCommand } from "../dist/tui/commands.js";
import { initialState } from "../dist/tui/state.js";
import { parseToolCard } from "../dist/tui/tool-card.js";

const now = "2026-10-16T00:00:00.000Z";
const secret = "sk-abcdefghijklmnopqrstuvwxyz";
const execFileAsync = promisify(execFile);
const task = (overrides = {}) => ({
  id: "bee-001", sessionId: "session-tools", role: "builder", title: "Inspect fixture",
  objective: "Inspect the fixture", status: "working", providerId: "fixture",
  dependencies: [], fileScope: [], expectedOutput: "Read result", completionCriteria: ["Read complete"],
  validationCommands: [], depth: 1, attempt: 1, maxAttempts: 1, createdAt: now, ...overrides,
});
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};
const runtimeEvent = (id, type, payload, sessionId = "session-tools") => ({
  schemaVersion: 1, id, sequence: 1, sessionId, timestamp: now, type, payload,
});
const cards = (state) => state.transcript.map(parseToolCard).filter(Boolean);

test("structured prose exposes only top-level public fields even while nested JSON and escapes stream", async () => {
  const structured = JSON.stringify({
    done: true,
    toolCalls: [{ name: "read_file", arguments: { summary: "ARGUMENT_PRIVATE", activity: "ARGUMENT_ACTION", content: '\"},\"activity\":\"ESCAPED_PRIVATE\"' } }],
    data: { summary: "DATA_PRIVATE", activity: "DATA_ACTION" },
    reasoning: [{ summary: "REASONING_PRIVATE", activity: "REASONING_ACTION" }],
    summary: 'Public "quoted } summary"',
  });
  for (const buffer of [structured, `\x60\x60\x60json\n${structured}\n\x60\x60\x60`, `Here is the requested turn:\n${structured}`]) {
    for (let end = 1; end <= buffer.length; end += 1) {
      const visible = visibleAssistantText(buffer.slice(0, end));
      assert.doesNotMatch(visible, /PRIVATE|ARGUMENT|DATA_ACTION|REASONING_ACTION|toolCalls/);
    }
    assert.equal(visibleAssistantText(buffer), 'Public "quoted } summary"');
  }
  assert.equal(visibleAssistantText('{"activity":"Inspect'), "Inspect");
  assert.equal(visibleAssistantText('{"data":{"activity":"private"},"activity":"Inspect \\u0066'), "Inspect f");
  assert.equal(visibleAssistantText('{"data":{"activity":"private"},"activity":"Inspect \\u006'), "Inspect ");
  assert.equal(visibleAssistantText("Unstructured preamble"), "");
  assert.equal(visibleAssistantText('[{"summary":"ARRAY_PRIVATE"}]'), "");
  assert.equal(visibleAssistantText('{"summary":"Public", "data":{"activity":"private'), "Public");
  const deltas = [];
  await new StructuredAgentLoop().run({
    task: task(), cwd: process.cwd(), sharedContext: "Fixture", signal: new AbortController().signal,
    tools: { async execute() { throw new Error("Completed turn must not invoke tools"); } },
    completionClient: {
      async complete() { throw new Error("Streaming completion expected"); },
      async streamComplete(_request, onChunk) {
        for (const character of structured) onChunk(character);
        return { output: structured };
      },
    },
    onEvent: (event) => { if (event.type === "assistant.delta") deltas.push(event.payload.text); },
  });
  assert.ok(deltas.includes("Public"));
  assert.equal(deltas.at(-1), 'Public "quoted } summary"');
  assert.equal(deltas.some((value) => /PRIVATE|ARGUMENT|DATA_ACTION|REASONING_ACTION/.test(value)), false);
});

test("direct truncated file reads redact an incomplete escaped credential before emitting the result", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-truncated-secret-"));
  try {
    const complete = '{"password":"private-prefix\\"private-suffix"}';
    await fs.writeFile(path.join(root, "fixture.json"), complete);
    const events = [];
    const service = new RepositoryToolService({ repositoryRoot: root, sessionId: "session-tools", approvalPolicy: "safe", onEvent: (event) => events.push(event) });
    const result = await service.execute("read_file", { path: "fixture.json", maxChars: complete.indexOf('\\"') + 1 }, task(), new AbortController().signal);
    assert.equal(result.metadata.truncated, true);
    const emitted = events.find((event) => event.type === "subagent.tool_result");
    assert.match(emitted.payload.output, /\[REDACTED\]/);
    assert.doesNotMatch(emitted.payload.output, /private-prefix|private-suffix/);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("tool execution emits a matched completion only after it settles and gives repeated provider IDs distinct identities", async () => {
  const gate = deferred();
  const entered = deferred();
  const events = [];
  const outputs = [
    { done: false, toolCalls: [{ id: "same-id", name: "read_file", arguments: { path: "a.txt" } }] },
    { done: false, toolCalls: [{ id: "same-id", name: "read_file", arguments: { path: "b.txt" } }] },
    { done: true, summary: "Read both files" },
  ];
  const prompts = [];
  let executions = 0;
  const running = new StructuredAgentLoop().run({
    task: task(), cwd: process.cwd(), sharedContext: "Fixture", signal: new AbortController().signal,
    completionClient: { async complete(request) { prompts.push(request.prompt); return { output: JSON.stringify(outputs.shift()) }; } },
    tools: { async execute(_name, _args, _task, _signal, context) {
      executions += 1;
      assert.equal(context.callId, events.filter((event) => event.type === "subagent.tool_call").at(-1).payload.callId);
      if (executions === 1) { entered.resolve(); await gate.promise; }
      return { ok: true, output: `Actual output ${secret}\n${"x".repeat(18_000)}` };
    } },
    onEvent: (event) => events.push(event),
  });
  await entered.promise;
  assert.equal(events.filter((event) => event.type === "subagent.tool_call").length, 1);
  assert.equal(events.some((event) => event.type === "subagent.tool_result"), false);
  gate.resolve();
  await running;
  const starts = events.filter((event) => event.type === "subagent.tool_call");
  const results = events.filter((event) => event.type === "subagent.tool_result");
  assert.equal(new Set(starts.map((event) => event.payload.callId)).size, 2);
  assert.deepEqual(results.map((event) => event.payload.callId), starts.map((event) => event.payload.callId));
  assert.ok(results.every((event) => event.payload.ok && event.payload.output.includes("[REDACTED]")));
  assert.ok(results.every((event) => event.payload.output.length < 16_100));
  assert.equal(JSON.stringify(results).includes(secret), false);
  assert.match(prompts.at(-1), /"id":"same-id"/);
});

test("tool failures, denied writes, and cancellation settle their own pending calls", async () => {
  for (const scenario of ["throw", "denied", "cancelled"]) {
    const controller = new AbortController();
    const events = [];
    let executed = false;
    let turn = 0;
    const running = new StructuredAgentLoop().run({
      task: task({ role: scenario === "denied" ? "reviewer" : "builder" }),
      cwd: process.cwd(), sharedContext: "Fixture", signal: controller.signal,
      completionClient: { async complete() { return { output: JSON.stringify(turn++ === 0
        ? { done: false, toolCalls: [{ name: scenario === "denied" ? "write_file" : "read_file", arguments: { path: "a.txt" } }] }
        : { done: true, summary: "Handled result" }) }; } },
      tools: { async execute() {
        executed = true;
        if (scenario === "throw") throw new Error(`Read failed ${secret}`);
        controller.abort("User cancelled");
        return { ok: false, output: "Read cancelled" };
      } },
      onEvent: (event) => events.push(event),
    });
    if (scenario === "denied") await running;
    else await assert.rejects(running, scenario === "throw" ? /Read failed/ : { name: "AbortError" });
    const start = events.find((event) => event.type === "subagent.tool_call");
    const result = events.find((event) => event.type === "subagent.tool_result");
    assert.equal(result.payload.callId, start.payload.callId);
    assert.equal(result.payload.ok, false);
    assert.equal(result.payload.cancelled, scenario === "cancelled");
    assert.equal(result.payload.output.includes(secret), false);
    assert.equal(executed, scenario !== "denied");
  }
});

test("real command execution carries its tool identity into command events without duplicate starts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-command-identity-"));
  try {
    const events = [];
    const service = new RepositoryToolService({ repositoryRoot: root, sessionId: "session-tools", approvalPolicy: "safe", onEvent: (event) => events.push(event) });
    let turn = 0;
    await new StructuredAgentLoop().run({
      task: task(), cwd: root, sharedContext: "Fixture", signal: new AbortController().signal,
      completionClient: { async complete() { return { output: JSON.stringify(turn++ === 0
        ? { done: false, toolCalls: [{ name: "run_command", arguments: { command: ["node", "--version"] } }] }
        : { done: true, summary: "Checked Node version" }) }; } },
      tools: service, onEvent: (event) => events.push(event),
    });
    const starts = events.filter((event) => event.type === "subagent.tool_call");
    const result = events.find((event) => event.type === "subagent.tool_result");
    const command = events.find((event) => event.type === "command.started");
    assert.equal(starts.length, 1);
    assert.equal(command.payload.toolCallId, starts[0].payload.callId);
    assert.equal(command.payload.taskId, "bee-001");
    assert.equal(command.payload.commandId, result.payload.commandId);
    assert.equal(result.payload.ok, true);
    assert.match(result.payload.output, /^v\d+\.\d+\.\d+/);
    assert.ok(events.some((event) => event.type === "command.completed" && event.payload.commandId === command.payload.commandId));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

async function startProjection(root = process.cwd()) {
  const ready = deferred();
  const gate = deferred();
  let state = { ...initialState(), sessionMode: "autonomous" };
  let send;
  const result = await executeTuiCommand(parseTuiCommand("Inspect tool results"), state, root,
    (updater) => { state = updater(state); }, {
      runSession: async ({ onEvent }) => { send = onEvent; ready.resolve(); await gate.promise; },
    });
  state = result.state;
  await ready.promise;
  return { get state() { return state; }, send, async finish() { gate.resolve(); await result.runtime.completion; } };
}

test("read completion updates its existing card with twelve real redacted lines without opening its path", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-tool-card-"));
  const filePath = path.join(root, "fixture.txt");
  await fs.writeFile(filePath, "ONLY_ON_DISK\n");
  const view = await startProjection(root);
  try {
    view.send(runtimeEvent("read-a", "subagent.tool_call", { subagentId: "bee-a", callId: "same", tool: "read_file", input: { path: filePath, content: "ARG_ONLY" } }));
    const firstId = cards(view.state)[0].id;
    assert.equal(cards(view.state)[0].status, "running");
    assert.equal(cards(view.state)[0].body.length, 1);
    view.send(runtimeEvent("read-b", "subagent.tool_call", { subagentId: "bee-b", callId: "same", tool: "read_file", input: { path: "other.txt" } }));
    const lines = Array.from({ length: 13 }, (_, index) => `L${index + 1}-RESULT`);
    lines[1] = secret;
    view.send(runtimeEvent("result-a", "subagent.tool_result", { subagentId: "bee-a", callId: "same", tool: "read_file", ok: true, output: `${lines.join("\r\n")}\r\n` }));
    const current = cards(view.state);
    assert.equal(current.length, 2);
    assert.equal(current[0].id, firstId);
    assert.equal(current[0].status, "done");
    assert.equal(current[0].expanded, false);
    assert.equal(current[0].body.length, 13);
    assert.match(current[0].body.join("\n"), /L1-RESULT\n\[REDACTED\]/);
    assert.match(current[0].body.join("\n"), /L12-RESULT/);
    assert.equal(current[0].body.join("\n").includes("L13-RESULT"), false);
    assert.equal(current[1].status, "running");
    assert.equal(view.state.transcript.join("\n").includes("ONLY_ON_DISK"), false);
    assert.equal(view.state.transcript.join("\n").includes("ARG_ONLY"), false);
    assert.equal(view.state.transcript.join("\n").includes(secret), false);
    view.send(runtimeEvent("unknown", "subagent.tool_result", { subagentId: "bee-c", callId: "same", tool: "read_file", ok: true, output: "UNMATCHED" }));
    assert.equal(view.state.transcript.join("\n").includes("UNMATCHED"), false);
  } finally { await view.finish(); await fs.rm(root, { recursive: true, force: true }); }
});

test("interleaved shell output and completion update each owning card without duplicate command cards", async () => {
  const view = await startProjection();
  try {
    for (const agent of ["a", "b"]) {
      view.send(runtimeEvent(`tool-${agent}`, "subagent.tool_call", { subagentId: `bee-${agent}`, callId: "same", tool: "run_command", input: { command: "node --version" } }));
      view.send(runtimeEvent(`start-${agent}`, "command.started", { taskId: `bee-${agent}`, toolCallId: "same", commandId: `cmd-${agent}`, command: "node --version", cwd: process.cwd() }));
    }
    assert.equal(cards(view.state).length, 2);
    view.send(runtimeEvent("output-a", "command.output", { commandId: "cmd-a", stream: "stdout", chunk: `FIRST ${secret}\n` }));
    view.send(runtimeEvent("output-b", "command.output", { commandId: "cmd-b", stream: "stderr", chunk: "SECOND\n" }));
    assert.match(cards(view.state)[0].body.join("\n"), /FIRST \[REDACTED\]/);
    assert.equal(cards(view.state)[0].body.join("\n").includes("SECOND"), false);
    assert.match(cards(view.state)[1].body.join("\n"), /SECOND/);
    view.send(runtimeEvent("done-a", "command.completed", { commandId: "cmd-a", exitCode: 0, durationMs: 1 }));
    assert.equal(cards(view.state)[0].status, "done");
    assert.equal(cards(view.state)[1].status, "running");
    view.send(runtimeEvent("result-a", "subagent.tool_result", { subagentId: "bee-a", callId: "same", tool: "run_command", ok: true, output: `FIRST ${secret}\nfinal line` }));
    view.send(runtimeEvent("result-b", "subagent.tool_result", { subagentId: "bee-b", callId: "same", tool: "run_command", ok: false, cancelled: true, output: "Cancelled" }));
    assert.equal(cards(view.state).length, 2);
    assert.deepEqual(cards(view.state)[0].body.slice(1), ["FIRST [REDACTED]", "final line"]);
    assert.equal(cards(view.state)[1].status, "cancelled");
    assert.equal(view.state.transcript.join("\n").includes(secret), false);
  } finally { await view.finish(); }
});

test("tool result events round-trip and desktop validation accepts only their typed public payload", () => {
  const bus = new RuntimeEventBus();
  const event = bus.emit({ sessionId: "session-tools", type: "subagent.tool_result", payload: { subagentId: "bee-1", callId: "call-1", tool: "read_file", ok: true, output: "Actual file text", cancelled: false } });
  assert.deepEqual(deserializeRuntimeEvent(serializeRuntimeEvent(event)), event);
  const envelope = (runtime) => ({ type: "runtime.event", timestamp: now, event: runtime });
  assert.equal(validateDesktopEvent(envelope(event)).event.type, "subagent.tool_result");
  for (const [key, value] of [["ok", "yes"], ["cancelled", "no"], ["callId", 1], ["output", {}], ["reasoning", "private"]]) {
    assert.throws(() => validateDesktopEvent(envelope({ ...event, payload: { ...event.payload, [key]: value } })), /invalid|unexpected/);
  }
  for (const runtime of [
    runtimeEvent("tool", "subagent.tool_call", { subagentId: "bee-1", callId: "call-1", tool: "run_command", input: { command: "node --version" } }),
    runtimeEvent("command", "command.started", { commandId: "cmd-1", taskId: "bee-1", toolCallId: "call-1", command: "node --version", cwd: process.cwd() }),
  ]) assert.doesNotThrow(() => validateDesktopEvent(envelope(runtime)));
});

test("Queen carries real repository tool completions through its persisted runtime feed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-tool-queen-"));
  try {
    for (const args of [["init", "-b", "main"], ["config", "user.email", "hive@example.test"], ["config", "user.name", "HIVE Test"]]) await execFileAsync("git", args, { cwd: root });
    await fs.writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0", scripts: {} }));
    await fs.writeFile(path.join(root, "README.md"), `REAL_REPOSITORY_RESULT ${secret}\n{"password":"plain-secret-value","API_KEY":"custom-secret-value"}\n`);
    await execFileAsync("git", ["add", "package.json", "README.md"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });
    const events = [];
    const queen = new QueenOrchestrator({ repositoryPath: root, objective: "Review fixture", sessionId: "session-tools", mode: "review", approvalPolicy: "safe", maxAgents: 1, maxRetries: 0, onEvent: (event) => events.push(event) }, {
      store: new CodingSessionStore(root),
      provider: {
        async bindingForRole(role) { return { role, providerId: "fixture" }; },
        async complete(request) { return { output: JSON.stringify(request.role === "reviewer" && !request.prompt.includes("[Tool results")
          ? { done: false, toolCalls: [{ id: "read-1", name: "read_file", arguments: { path: "README.md" } }] }
          : { done: true, summary: "Fixture reviewed", data: { status: "passed", findings: [] } }) }; },
      },
      tools: { create(options) { return new RepositoryToolService({ repositoryRoot: options.repositoryRoot, sessionId: options.sessionId, approvalPolicy: options.approvalPolicy, onEvent: (event) => options.emit(event.type, event.payload) }); } },
      worktrees: { async create() { throw new Error("Review does not create a worktree"); } },
    });
    await queen.run();
    const starts = events.filter((event) => event.type === "subagent.tool_call" && event.payload.tool === "read_file");
    const results = events.filter((event) => event.type === "subagent.tool_result" && event.payload.tool === "read_file");
    assert.equal(starts.length, 1);
    assert.equal(results.length, 1);
    assert.equal(starts[0].payload.callId, results[0].payload.callId);
    assert.equal(starts[0].payload.subagentId, results[0].payload.subagentId);
    assert.match(results[0].payload.output, /REAL_REPOSITORY_RESULT \[REDACTED\]/);
    const stored = await new CodingSessionStore(root).load("session-tools");
    const persisted = stored.events.find((event) => event.type === "subagent.tool_result" && event.payload.tool === "read_file");
    assert.equal(persisted.payload.output, results[0].payload.output);
    assert.equal(JSON.stringify(results).includes(secret), false);
    assert.equal(JSON.stringify(results).includes("plain-secret-value"), false);
    assert.equal(JSON.stringify(results).includes("custom-secret-value"), false);
    const directStart = events.find((event) => event.type === "subagent.tool_call" && event.payload.tool === "inspect_diff");
    const directResult = events.find((event) => event.type === "subagent.tool_result" && event.payload.tool === "inspect_diff");
    assert.equal(directResult.payload.callId, directStart.payload.callId);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
