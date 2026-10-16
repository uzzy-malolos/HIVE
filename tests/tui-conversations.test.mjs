import assert from "node:assert/strict";
import test from "node:test";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliConversationStore, newConversation } from "../dist/tui/conversations.js";
import { executeTuiCommand, parseTuiCommand } from "../dist/tui/commands.js";
import { initialState } from "../dist/tui/state.js";
import { attachFileContext, fileMentions } from "../dist/tui/prompt-context.js";
import { insertFileMention } from "../dist/tui/picker.js";
import { ProviderRegistry } from "../dist/providers/registry.js";
import { TuiApp } from "../dist/tui/app.js";

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-cli-conversation-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

function harness(root, runner) {
  let state = initialState();
  return {
    get state() { return state; },
    async run(input, options = {}) {
      const result = await executeTuiCommand(parseTuiCommand(input), state, root, (update) => { state = update(state); }, { runSession: runner, persistSession: true, ...options });
      state = result.state;
      await result.runtime?.completion;
      return state;
    },
  };
}

test("file picker selections with spaces become exact readable context attachments", async (t) => {
  const root = await workspace(t);
  await fs.mkdir(path.join(root, "docs"));
  await fs.writeFile(path.join(root, "docs", "my file.ts"), "export const selected = true;\n");
  const prompt = insertFileMention("Explain @my", "docs\\my file.ts");
  assert.equal(prompt, 'Explain @"docs/my file.ts" ');
  assert.equal(fileMentions(prompt)[0].path, "docs/my file.ts");
  const attached = await attachFileContext(root, prompt);
  assert.deepEqual(attached.paths, ["docs/my file.ts"]);
  assert.match(attached.prompt, /export const selected = true/);
});

test("explicit copy selects a redacted response or complete conversation and propagates failures", async (t) => {
  const root = await workspace(t);
  const state = { ...initialState(), conversation: { ...newConversation(root), messages: [{ role: "user", content: "Review this" }, { role: "assistant", content: "API_KEY=fixture-private-key\nReviewed ✓" }] } };
  let copied;
  const capture = async (text) => { copied = text; };
  await executeTuiCommand(parseTuiCommand("/copy"), state, root, undefined, { copyToClipboard: capture });
  assert.match(copied, /Reviewed ✓/);
  assert.equal(copied.includes("fixture-private-key"), false);
  await executeTuiCommand(parseTuiCommand("/copy all"), state, root, undefined, { copyToClipboard: capture });
  assert.match(copied, /user:\nReview this/);
  await assert.rejects(executeTuiCommand(parseTuiCommand("/copy"), state, root, undefined, { copyToClipboard: async () => { throw new Error("Clipboard fixture unavailable"); } }), /Clipboard fixture unavailable/);
});

test("follow-ups carry bounded conversation context and the previous coding identity; resume restores it", async (t) => {
  const root = await workspace(t);
  const requests = [];
  const cli = harness(root, async (request) => {
    requests.push(request);
    request.onText(`Completed ${request.objective}`);
    if (request.objective === "Build the parser") request.onText("Option one: a streaming parser. Option two: a token parser.");
    return { id: "coding-fixture", status: "completed", finalReport: { result: `Result for ${request.objective}` } };
  });
  await cli.run("Build the parser");
  const id = cli.state.conversation.id;
  await cli.run("Now add error handling");
  assert.equal(requests[0].objective, "Build the parser");
  assert.match(requests[1].context, /Build the parser/);
  assert.match(requests[1].context, /Result for Build the parser/);
  assert.match(requests[1].context, /Option two: a token parser/);
  assert.match(requests[1].context, /Now add error handling/);
  assert.equal(requests[1].continuationId, "coding-fixture");
  assert.equal(requests[1].resumeId, undefined);
  assert.equal(cli.state.conversation.id, id);
  await cli.run("/new");
  assert.notEqual(cli.state.conversation.id, id);
  assert.equal(cli.state.sessionId, undefined);
  await cli.run(`/resume ${id}`);
  assert.equal(cli.state.conversation.messages.length, 4);
  assert.equal(cli.state.conversation.codingSessionId, "coding-fixture");
  assert.match(cli.state.transcript.join("\n"), /Completed Now add error handling/);
  const resumed = new CliConversationStore(root);
  assert.equal((await resumed.load(id)).messages.length, 4);
});

test("approval continuation resumes the saved coding run without appending a duplicate user turn", async (t) => {
  const root = await workspace(t);
  const requests = [];
  const cli = harness(root, async (request) => {
    requests.push(request);
    return { id: "paused-fixture", status: requests.length === 1 ? "paused" : "completed", finalReport: { result: "Saved plan" } };
  });
  await cli.run("Implement the plan");
  await cli.run("Implement the plan", { continuation: true });
  assert.equal(requests[1].resumeId, "paused-fixture");
  assert.equal(requests[1].continuationId, undefined);
  assert.equal(cli.state.conversation.messages.filter((message) => message.role === "user").length, 1);
});

test("in-session model selection reaches the next run and preserves slash-containing model IDs", async (t) => {
  const root = await workspace(t);
  const registry = new ProviderRegistry(root);
  await registry.add({ id: "fixture-model", name: "Local fixture", kind: "local", authType: "none", defaultModel: "org/model" });
  await registry.approve("fixture-model");
  const requests = [];
  const cli = harness(root, async (request) => { requests.push(request); });
  await cli.run("/model fixture-model/org/model");
  await cli.run("Explain this project");
  assert.deepEqual(requests[0].providerOverride, { providerId: "fixture-model", model: "org/model" });
  assert.deepEqual(await registry.getRoles(), {}, "session selection does not rewrite project role bindings");
  await cli.run("/model");
  assert.equal(cli.state.picker.kind, "model");
  assert.ok(cli.state.picker.items.some((item) => item.insert === "/model fixture-model/org/model"));
  await assert.rejects(cli.run("/model missing/model"), /approved/);
});

test("explicit file mentions load jailed redacted content with spaces and line ranges", async (t) => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, "file with spaces.ts"), "first\nAPI_KEY=secret-value\nthird\nfourth\n");
  const context = await attachFileContext(root, 'Explain @"file with spaces.ts":2-3');
  assert.deepEqual(context.paths, ["file with spaces.ts"]);
  assert.match(context.prompt, /2: API_KEY=\[REDACTED\]/);
  assert.match(context.prompt, /3: third/);
  assert.equal(context.prompt.includes("4: fourth"), false);
  assert.equal(context.prompt.includes("secret-value"), false);
  await assert.rejects(attachFileContext(root, "Read @../outside.txt"), /outside|escape|workspace/);
  await assert.rejects(attachFileContext(root, "Read @.env"), /denied|blocked|prohibited/i);
  await assert.rejects(attachFileContext(root, '@"file with spaces.ts":4-2'), /range/);
  await fs.mkdir(path.join(root, ".hive"));
  await fs.writeFile(path.join(root, ".hive", "provider.json"), '{"unrecognizedValue":"private"}');
  await fs.symlink(path.join(root, ".hive"), path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(attachFileContext(root, "Read @alias/provider.json"), /Blocked context target/);
});

test("rename, compact, fork and export preserve the original and refuse overwrites", async (t) => {
  const root = await workspace(t);
  const cli = harness(root, async ({ objective }) => ({ id: "coding-copy", status: "completed", finalReport: { result: objective } }));
  for (let index = 0; index < 6; index += 1) await cli.run(`Request ${index}`);
  const original = cli.state.conversation.id;
  await cli.run("/rename Parser work");
  await cli.run("/compact errors");
  assert.equal(cli.state.conversation.messages.length, 12);
  assert.equal(cli.state.conversation.contextStart, 4);
  assert.match(cli.state.conversation.summary, /Request 0/);
  await cli.run("/export conversation.md");
  assert.match(await fs.readFile(path.join(root, "conversation.md"), "utf8"), /Request 0/);
  await assert.rejects(cli.run("/export conversation.md"), /overwrite|exists/);
  let forkRequest;
  await cli.run("/fork Different approach", { forkSession: async (_cwd, sourceId) => {
    forkRequest = sourceId;
    return { id: "coding-copy-fork", status: "cancelled", repository: { worktreePath: "verified-independent-worktree" } };
  } });
  assert.notEqual(cli.state.conversation.id, original);
  assert.equal(cli.state.conversation.forkedFrom, original);
  assert.equal(forkRequest, "coding-copy");
  assert.equal(cli.state.conversation.codingSessionId, "coding-copy-fork", "fork must not alias the original writable worktree");
  assert.equal((await new CliConversationStore(root).load(original)).title, "Parser work");
});

test("storage redacts data, preserves corrupt files, and rejects traversal and symlink directories", async (t) => {
  const root = await workspace(t);
  const store = new CliConversationStore(root);
  const conversation = newConversation(root);
  conversation.messages.push({ role: "user", content: '{"password":"ordinary-secret"}' });
  await store.save(conversation);
  assert.equal(JSON.stringify(await store.load(conversation.id)).includes("ordinary-secret"), false);
  await assert.rejects(store.load("../escape"), /Invalid/);
  const file = path.join(root, ".hivemind", "cli-sessions", `${conversation.id}.json`);
  await fs.writeFile(file, "broken");
  await assert.rejects(store.load(conversation.id));
  assert.equal((await store.list()).warnings.length, 1);
  assert.equal(await fs.readFile(file, "utf8"), "broken");
  const other = await workspace(t);
  const linked = await workspace(t);
  await fs.symlink(other, path.join(linked, ".hivemind"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(new CliConversationStore(linked).save(newConversation(linked)), /real directory/);
});

function feed(app, input) { app.inputBuffer += input; app.processInputBuffer(); }
async function until(condition) {
  for (let count = 0; count < 200 && !condition(); count += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "conversation lifecycle did not settle");
}

for (const answer of ["n\r", "\x1b"]) {
  test(`declining ${answer === "\x1b" ? "with Esc" : "with n"} before a paused runner settles cannot reattach it`, async (t) => {
    const root = await workspace(t);
    const requests = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const app = new TuiApp(root, { readGitBranch: async () => "main", runSession: async (request) => {
      requests.push(request);
      if (requests.length === 1) {
        request.onEvent({ schemaVersion: 1, id: "pause", sequence: 1, sessionId: "declined-run", timestamp: new Date().toISOString(), type: "session.paused", payload: { reason: "Repository changes require approval." } });
        await gate;
        return { id: "declined-run", status: "paused" };
      }
      return { id: "fresh-run", status: "completed" };
    } });
    app.render = () => {};
    try {
      feed(app, "guarded request\r");
      await until(() => !!app.state.pendingPermission);
      feed(app, answer);
      assert.equal(app.state.conversation.codingSessionId, undefined);
      feed(app, "revised request\r");
      release();
      await until(() => requests.length === 2 && !app.turnBusy());
      assert.equal(requests[1].continuationId, undefined);
      assert.equal(requests[1].resumeId, undefined);
      assert.equal(app.state.conversation.codingSessionId, "fresh-run");
    } finally { release(); }
  });
}

test("tool permissions precede side effects, retain drafts and recheck read-only mode", async (t) => {
  const root = await workspace(t);
  let effects = 0;
  const app = new TuiApp(root, { readGitBranch: async () => "main", runSession: async ({ requestToolPermission, signal }) => {
    const approved = await requestToolPermission({ tool: "mcp__fixture__write", description: "Write a fixture", input: { value: "test" }, external: true }, signal);
    if (approved) effects += 1;
  } });
  app.render = () => {};
  app.persistMode = () => {};
  feed(app, "use the fixture\r");
  feed(app, "unsent draft");
  await until(() => !!app.toolDecision);
  assert.equal(effects, 0);
  assert.equal(app.state.input, "");
  feed(app, "\x1b[Z\x1b[Z\x1b[Z");
  assert.equal(app.state.sessionMode, "guarded", "a running turn keeps its actual posture until settlement");
  await until(() => !app.turnBusy());
  assert.equal(effects, 0, "switching to plan while awaiting approval must fail closed");
  assert.equal(app.state.sessionMode, "plan");
  assert.equal(app.state.input, "unsent draft");
  feed(app, "\x1b[Z\x1b[Z");
  feed(app, "\x01\x0bperform write\r");
  await until(() => !!app.toolDecision);
  feed(app, "y\r");
  await until(() => !app.turnBusy());
  assert.equal(effects, 1);
});

test("shutdown saves the running coding identity and waits for final state reconciliation", async (t) => {
  const root = await workspace(t);
  let finalStatus = "running";
  const app = new TuiApp(root, { persistSession: true, readGitBranch: async () => "main",
    reconcileConversation: async (_cwd, state) => ({ ...state, conversation: { ...state.conversation, codingStatus: finalStatus } }),
    runSession: async ({ signal, onEvent }) => {
      onEvent({ schemaVersion: 1, id: "created", sequence: 1, sessionId: "shutdown-run", timestamp: new Date().toISOString(), type: "session.created", payload: { objective: "request", mode: "auto", approvalPolicy: "safe" } });
      await new Promise((resolve) => signal.addEventListener("abort", () => { finalStatus = "cancelled"; resolve(); }, { once: true }));
      return { id: "shutdown-run", status: "cancelled" };
    },
  });
  app.render = () => {};
  feed(app, "request\r");
  await until(() => app.state.conversation?.codingSessionId === "shutdown-run");
  const id = app.state.conversation.id;
  const stopped = new Promise((resolve) => { app.resolveStop = resolve; });
  const originalWrite = process.stdout.write;
  try { process.stdout.write = () => true; app.stop(); }
  finally { process.stdout.write = originalWrite; }
  await stopped;
  const saved = await new CliConversationStore(root).load(id);
  assert.equal(saved.codingSessionId, "shutdown-run");
  assert.equal(saved.codingStatus, "cancelled");
});

test("drafts and queued prompts typed during reconciliation survive the delayed metadata read", async (t) => {
  const root = await workspace(t);
  let beginReconcile = false;
  let release;
  let reconciles = 0;
  const gate = new Promise((resolve) => { release = resolve; });
  const requests = [];
  const app = new TuiApp(root, { persistSession: true, readGitBranch: async () => "main",
    reconcileConversation: async (_cwd, state) => {
      if (reconciles++ === 0) { beginReconcile = true; await gate; }
      return state;
    },
    runSession: async (request) => { requests.push(request); return { id: "reconcile-run", status: "completed" }; },
  });
  app.render = () => {};
  try {
    feed(app, "first request\r");
    await until(() => beginReconcile);
    feed(app, "queued request\runfinished draft");
    release();
    await until(() => requests.length === 2 && !app.turnBusy());
    assert.equal(requests[1].objective, "queued request");
    assert.equal(app.state.input, "unfinished draft");
    assert.ok(app.state.history.includes("queued request"));
  } finally { release(); }
});
