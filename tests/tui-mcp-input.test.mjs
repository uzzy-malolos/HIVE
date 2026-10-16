import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { TuiApp } from "../dist/tui/app.js";
import { renderTuiScreen } from "../dist/tui/renderer.js";
import { CliConversationStore, newConversation, persistConversation } from "../dist/tui/conversations.js";

const form = (extra = {}) => ({ serverId: "mcp:fixture", mode: "form", message: "Choose a workspace display name", requestedSchema: { type: "object", properties: { name: { type: "string", default: "default-private-name" }, enabled: { type: "boolean", default: true } }, required: ["name"] }, ...extra });
const url = () => ({ serverId: "mcp:fixture", mode: "url", message: "Complete the external authentication flow", url: "https://example.com/authorize?nonce=private-url-nonce", elicitationId: "private-elicitation-id" });
function harness(t) {
  const app = new TuiApp(process.cwd(), { persistSession: false }); app.render = () => {};
  const aborts = [];
  t.after(() => { for (const abort of aborts) abort.abort(); clearTimeout(app.escapeTimer); });
  return { app, feed: (text) => { app.inputBuffer += text; app.processInputBuffer(); }, ask(request = form()) { const abort = new AbortController(); aborts.push(abort); return { result: app.requestMcpInput(request, abort.signal), abort }; } };
}

test("MCP form defaults require explicit Enter and restore the exact previous draft and history cursor", async (t) => {
  const { app, feed, ask } = harness(t);
  app.state = { ...app.state, input: "saved draft 👩🏽‍💻", cursor: 5, history: ["prior command"], historyIndex: 0 };
  app.historyDraft = { input: "prior history draft", cursor: 3 };
  const before = { transcript: [...app.state.transcript], output: [...app.state.outputLines], history: [...app.state.history] };
  const request = ask(); let resolved = false; request.result.then(() => { resolved = true; });
  await Promise.resolve(); assert.equal(resolved, false);
  assert.deepEqual(JSON.parse(app.state.input), { name: "default-private-name", enabled: true });
  feed("\x1b[A\x1b[B"); assert.equal(app.state.input.includes("prior command"), false);
  feed("\r");
  assert.deepEqual(await request.result, { action: "accept", content: { name: "default-private-name", enabled: true } });
  assert.equal(app.state.input, "saved draft 👩🏽‍💻"); assert.equal(app.state.cursor, 5); assert.equal(app.state.historyIndex, 0);
  assert.deepEqual(app.historyDraft, { input: "prior history draft", cursor: 3 });
  assert.equal(app.state.mcpInput, undefined);
  assert.deepEqual(app.state.transcript, before.transcript); assert.deepEqual(app.state.outputLines, before.output); assert.deepEqual(app.state.history, before.history);
});

test("MCP private Unicode input edits normally and invalid responses never become commands or queue entries", async (t) => {
  const { app, feed, ask } = harness(t); const request = ask();
  app.state = { ...app.state, input: "", cursor: 0 };
  feed("/exit\r"); assert.equal(app.stopped, false); assert.equal(app.state.picker, undefined);
  assert.match(app.state.mcpInput.error, /JSON object/); assert.equal(JSON.stringify(app.state.history).includes("/exit"), false); assert.deepEqual(app.state.messageQueue, []);
  app.state = { ...app.state, input: "", cursor: 0 };
  for (const byte of Buffer.from('{"name":"中文 👩🏽‍💻"}')) app.onData(Buffer.from([byte]));
  feed("\x1b[D\x1b[D\x1b[C\x1b[C\r/exit\r");
  assert.deepEqual(await request.result, { action: "accept", content: { name: "中文 👩🏽‍💻" } });
  assert.equal(app.stopped, false); assert.deepEqual(app.state.messageQueue, []); assert.equal(app.state.history.length, 0);
  assert.equal(JSON.stringify(app.state.transcript).includes("中文"), false);
});

test("MCP URL flow is displayed transiently and accepts only explicit completion or decline", async (t) => {
  const { app, feed, ask } = harness(t); const request = ask(url());
  const frame = renderTuiScreen({ ...app.state, width: 100, height: 24, colorEnabled: false });
  assert.match(frame, /Open this URL manually/); assert.match(frame, /private-url-nonce/); assert.equal(app.state.input, "");
  feed("\r"); assert.ok(app.state.mcpInput); assert.match(app.state.mcpInput.error, /Type accept/);
  feed("accept\r"); assert.deepEqual(await request.result, { action: "accept" });
  assert.equal(JSON.stringify(app.state).includes("private-url-nonce"), false);
  const next = ask(url()); feed("/decline\r"); assert.deepEqual(await next.result, { action: "decline" });
});

test("Esc, Ctrl+C, explicit stop, signal abort and app stop settle private requests without retaining answers", async (t) => {
  for (const key of ["\x1b", "\x03", "/stop\r", "/cancel\r"]) {
    const { app, feed, ask } = harness(t); app.state = { ...app.state, input: "retained draft", cursor: 4 };
    const request = ask(url()); feed(key); assert.deepEqual(await request.result, { action: "cancel" });
    assert.equal(app.state.input, "retained draft"); assert.equal(app.state.cursor, 4); assert.equal(app.state.mcpInput, undefined);
  }
  const { app, ask } = harness(t); const first = ask(); first.abort.abort(); assert.deepEqual(await first.result, { action: "cancel" });
  const active = ask(); const queued = ask(url());
  const originalWrite = process.stdout.write; process.stdout.write = () => true;
  try { app.stop(); } finally { process.stdout.write = originalWrite; }
  assert.deepEqual(await active.result, { action: "cancel" }); assert.deepEqual(await queued.result, { action: "cancel" });
  assert.equal(app.state.mcpInput, undefined); assert.equal(app.mcpInputQueue.length, 0);
});

test("tool permission and MCP modal prompts serialize and do not copy private composer text into permission history", async (t) => {
  const { app, feed, ask } = harness(t);
  app.state = { ...app.state, sessionMode: "autonomous", input: "original draft", cursor: 3 };
  const permissionAbort = new AbortController();
  const permission = app.requestToolPermission({ tool: "mcp_fixture", description: "Fixture operation", input: {}, external: true, alwaysAsk: true }, permissionAbort.signal);
  assert.ok(app.state.pendingPermission); const request = ask(); assert.equal(app.state.mcpInput, undefined);
  feed("y\r"); assert.equal(await permission, true); assert.ok(app.state.mcpInput); assert.equal(app.state.pendingPermission, undefined);
  const second = app.requestToolPermission({ tool: "mcp_second", description: "Second fixture", input: {}, external: true, alwaysAsk: true }, permissionAbort.signal);
  assert.equal(app.state.pendingPermission, undefined);
  feed("\r"); assert.equal((await request.result).action, "accept"); assert.ok(app.state.pendingPermission); assert.equal(app.state.mcpInput, undefined);
  feed("n\r"); assert.equal(await second, false); assert.equal(app.state.input, "original draft"); assert.equal(app.state.cursor, 3);
  assert.equal(JSON.stringify(app.state.transcript).includes("default-private-name"), false);
});

test("private input queues are bounded and aborted queued entries release capacity before the active request finishes", async (t) => {
  const { app, ask } = harness(t); const active = ask();
  const queued = Array.from({ length: 31 }, () => ask(url())); assert.equal(app.mcpInputQueue.length, 31);
  const refused = ask(url()); assert.deepEqual(await refused.result, { action: "cancel" });
  queued[0].abort.abort(); assert.deepEqual(await queued[0].result, { action: "cancel" }); assert.equal(app.mcpInputQueue.length, 30);
  const replacement = ask(); assert.equal(app.mcpInputQueue.length, 31);
  active.abort.abort(); replacement.abort.abort(); for (const entry of queued) entry.abort.abort();
  await Promise.all([active.result, replacement.result, ...queued.map((entry) => entry.result)]);
  assert.equal(app.state.mcpInput, undefined); assert.equal(app.mcpInputQueue.length, 0);
});

test("MCP field text is sanitized, bounded, scrollable and validation errors stay visible", async (t) => {
  const { app, feed, ask } = harness(t);
  const request = ask(form({ message: "\x1b[2J" + "lengthy message ".repeat(200), requestedSchema: { type: "object", properties: Object.fromEntries(Array.from({ length: 32 }, (_, index) => [`field${index}`, { type: "string", description: `Description ${index}` }])), required: ["field31"] } }));
  app.state = { ...app.state, width: 45, height: 15, colorEnabled: false };
  const top = renderTuiScreen(app.state); assert.equal(top.includes("\x1b[2J"), false); assert.equal(top.split("\n").length, 15);
  feed("\x1b[6~\x1b[6~\x1b[6~"); assert.ok(app.state.mcpInput.scrollOffset > 0); assert.notEqual(renderTuiScreen(app.state), top);
  feed("\r"); assert.ok(app.state.mcpInput.error);
  feed("\x1b[5~".repeat(100)); assert.match(renderTuiScreen(app.state), /JSON object/);
  app.state = { ...app.state, input: "/decline", cursor: 8 }; feed("\r");
  assert.deepEqual(await request.result, { action: "decline" });
});

test("private form schemas, defaults, URL nonces and submitted values never enter persisted conversations", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hive-tui-mcp-private-")); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const { app, feed, ask } = harness(t); app.state = { ...app.state, conversation: newConversation(directory) };
  const request = ask(); app.state = { ...app.state, input: '{"name":"submitted-private-value"}', cursor: 34 };
  await persistConversation(directory, app.state);
  feed("\r"); await request.result;
  const external = ask(url()); await persistConversation(directory, app.state); feed("/decline\r"); await external.result;
  await persistConversation(directory, app.state);
  const stored = await new CliConversationStore(directory).load(app.state.conversation.id);
  const serialized = JSON.stringify(stored);
  for (const privateText of ["default-private-name", "submitted-private-value", "private-url-nonce", "private-elicitation-id", "Choose a workspace display name"]) assert.equal(serialized.includes(privateText), false, privateText);
});

test("a submitted coding turn receives the live MCP input callback through the command and runtime adapters", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hive-tui-mcp-adapter-")); t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let response;
  const app = new TuiApp(directory, { persistSession: false, readGitBranch: async () => "main", runSession: async ({ requestMcpInput, signal }) => {
    assert.equal(typeof requestMcpInput, "function"); response = await requestMcpInput(form(), signal);
    return { id: "input-fixture", status: "completed", finalReport: { result: "Input request settled" } };
  } });
  app.render = () => {};
  t.after(() => { app.activeRuntime?.cancel("Test cleanup"); clearTimeout(app.escapeTimer); });
  const feed = (text) => { app.inputBuffer += text; app.processInputBuffer(); };
  const until = async (predicate) => { const deadline = Date.now() + 3000; while (!predicate()) { if (Date.now() >= deadline) throw new Error("TUI callback did not settle"); await new Promise((resolve) => setTimeout(resolve, 5)); } };
  feed("Complete a fixture task\r"); await until(() => !!app.state.mcpInput);
  feed("\r"); await until(() => !app.turnBusy());
  assert.deepEqual(response, { action: "accept", content: { name: "default-private-name", enabled: true } });
  assert.equal(JSON.stringify(app.state.transcript).includes("default-private-name"), false);
  assert.equal(JSON.stringify(app.state.history).includes("default-private-name"), false);
});
