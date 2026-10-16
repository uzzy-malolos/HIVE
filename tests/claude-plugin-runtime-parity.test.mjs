import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createQueenSession } from "../dist/coding/runtime.js";
import { runCodeCommand } from "../dist/coding/command.js";
import { setExtensionState } from "../dist/extensions/catalog.js";
import { executeTuiCommand, parseTuiCommand } from "../dist/tui/commands.js";
import { initialState } from "../dist/tui/state.js";
import { CliConversationStore } from "../dist/tui/conversations.js";

const execute = promisify(execFile);
const styleId = "style:review.concise", skillId = "skill:review.inspect";
const styleMarker = "EXPLICIT_FINAL_STYLE_BODY";
const styledResponse = "Observed: the scoped input was read and checks passed. No source files changed.";

async function fixture(t, behavior = "normal") {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hive-plugin-parity-")), root = path.join(temporary, "workspace with spaces");
  const extensionOptions = { trustStateDir: path.join(temporary, "trust") }, requests = [], approvals = [];
  await fs.mkdir(path.join(root, ".hive"), { recursive: true });
  const write = async (relative, content) => { const target = path.join(root, relative); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, content); };
  await write(".gitignore", ".hive/\n.hivemind/\nplugins/\n"); await write("input.txt", "ACTUAL_SCOPED_EVIDENCE\n");
  await write("plugins/review/hive.plugin.json", JSON.stringify({ version: 1, name: "review", outputStyles: ["output-styles/concise.md"], skills: ["skills/inspect/SKILL.md", "skills/private/SKILL.md"] }));
  await write("plugins/review/output-styles/concise.md", `---\nname: Concise result\nkeep-coding-instructions: true\n---\n${styleMarker}: lead with the observed result.\n`);
  await write("plugins/review/skills/inspect/SKILL.md", "---\nname: inspect\ndescription: Inspect a scoped input\ndisable-model-invocation: true\n---\nEXPLICIT_SKILL_BODY target=$0; second=$ARGUMENTS[1]; all=$ARGUMENTS.\nRead the target through approved tools.\n");
  await write("plugins/review/skills/private/SKILL.md", "---\nname: private\nuser-invocable: false\n---\nPRIVATE_SKILL_MUST_NOT_RUN\n");
  await write(".hive/extensions.json", JSON.stringify({ version: 1, plugins: { review: { path: "plugins/review", enabled: false } } }));
  for (const args of [["init", "-b", "main"], ["config", "user.email", "fixture@example.test"], ["config", "user.name", "Plugin parity fixture"], ["config", "core.autocrlf", "false"], ["add", "."], ["commit", "-m", "Fixture baseline"]]) await execute("git", args, { cwd: root });
  await setExtensionState(root, "plugin:review", "trust", extensionOptions); await setExtensionState(root, "plugin:review", "enable", extensionOptions);
  let providerFailure;
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "owner-selected-model" }] })); return; }
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw), system = body.messages.find((entry) => entry.role === "system")?.content ?? "", prompt = body.messages.find((entry) => entry.role === "user")?.content ?? "";
      requests.push({ body, system, prompt });
      let output = JSON.stringify({ done: true, summary: "Actual scoped evidence inspected", data: { status: "passed", findings: [] } });
      if (system.includes("HIVE Planner")) output = JSON.stringify({ summary: "Inspect actual input", architecture: "One narrow read-only task", risks: [], acceptanceCriteria: ["Scoped input was read"], validationCommands: ["node --version"], tasks: [{ key: "inspect", role: "builder", title: "Inspect input", objective: "Read input.txt and report actual evidence", dependencies: [], fileScope: ["input.txt"], expectedOutput: "Read evidence", completionCriteria: ["Input inspected"], validationCommands: [] }] });
      else if (system.includes("HIVE builder subagent") && !prompt.includes("[Tool results 1]")) output = JSON.stringify({ done: false, toolCalls: [{ name: "read_file", arguments: { path: "input.txt" } }] });
      else if (system.startsWith("Write the final HIVE coding response")) {
        if (behavior === "revoke-style-at-final") await setExtensionState(root, "plugin:review", "untrust", extensionOptions);
        output = styledResponse;
      }
      if (body.stream) { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: output } }] })}\n\ndata: [DONE]\n\n`); }
      else { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ choices: [{ message: { content: output } }] })); }
    } catch (error) { providerFailure = error; response.writeHead(500).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const provider = { id: "fixture", name: "Fixture", kind: "local", authType: "none", approved: true, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, defaultModel: "unchanged-default", createdAt: "2026-10-17", updatedAt: "2026-10-17" };
  const roles = Object.fromEntries(["queen", "planner", "scout", "builder", "validator", "reviewer", "fixer"].map((role) => [role, { provider: "fixture", model: "owner-selected-model" }]));
  await write(".hive/providers.json", JSON.stringify([provider])); await write(".hive/provider-roles.json", JSON.stringify(roles));
  const originalProviders = await fs.readFile(path.join(root, ".hive/providers.json")), originalRoles = await fs.readFile(path.join(root, ".hive/provider-roles.json"));
  t.after(async () => {
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    try { if (providerFailure) throw providerFailure; assert.deepEqual(await fs.readFile(path.join(root, ".hive/providers.json")), originalProviders); assert.deepEqual(await fs.readFile(path.join(root, ".hive/provider-roles.json")), originalRoles); }
    finally { assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir())); assert.ok(path.basename(temporary).startsWith("hive-plugin-parity-")); await fs.rm(temporary, { recursive: true, force: true }); }
  });
  return { root, extensionOptions, requests, approvals, write,
    async start(extra = {}) { const runtime = await createQueenSession({ repositoryPath: root, objective: "Inspect the actual scoped input", mode: "auto", approvalPolicy: "changes", maxAgents: 1, maxRetries: 0, extensionOptions, requestToolPermission: async (request) => { approvals.push(request); return true; }, ...extra }); return { ...runtime, record: await runtime.orchestrator.run() }; },
  };
}

function assertRealRead(requests) {
  const builder = requests.filter((entry) => entry.system.includes("HIVE builder subagent"));
  assert.ok(builder.some((entry) => entry.prompt.includes("ACTUAL_SCOPED_EVIDENCE")), "Builder must receive the actual file-read result");
  assert.ok(requests.every((entry) => entry.body.model === "owner-selected-model"), "All roles retain the user's selected model");
}

test("actual Queen final synthesis applies the selected style only to the main-role response and preserves verified evidence", async (t) => {
  const f = await fixture(t), { record, store } = await f.start({ outputStyleId: styleId });
  assert.equal(record.status, "completed", JSON.stringify(record.finalReport)); assert.equal(record.verdict, "ACCEPTED");
  assert.equal(record.outputStyleId, styleId); assert.equal(record.finalReport.result, styledResponse);
  const styled = f.requests.filter((entry) => entry.system.includes(styleMarker));
  assert.equal(styled.length, 1); assert.ok(styled[0].system.startsWith("Write the final HIVE coding response"));
  assert.equal(styled[0].body.tools, undefined); assert.match(styled[0].system, /Preserve failures, uncertainties, validation outcomes and the exact verdict/);
  const facts = JSON.parse(styled[0].prompt); assert.equal(facts.verdict, "ACCEPTED"); assert.deepEqual(facts.files, []); assert.ok(facts.validations.some((entry) => entry.command === "node --version" && entry.status === "passed"));
  for (const entry of f.requests.filter((entry) => /HIVE (?:Planner|builder|validator|reviewer)/u.test(entry.system))) {
    assert.equal(entry.system.includes(styleMarker), false, "Subagent system instructions must not include the main output style");
    assert.equal(entry.prompt.includes("Explicitly selected plugin output style"), false, "Style selection must not be injected into subagent task instructions");
  }
  assert.equal((await store.load(record.id)).outputStyleId, styleId); assert.equal((await store.load(record.id)).finalReport.result, styledResponse);
  assertRealRead(f.requests); assert.equal(await fs.readFile(path.join(f.root, "input.txt"), "utf8"), "ACTUAL_SCOPED_EVIDENCE\n");
});

test("revoking selected-style trust during the actual final provider request prevents a successful styled result", async (t) => {
  const f = await fixture(t, "revoke-style-at-final"), { record } = await f.start({ outputStyleId: styleId });
  assert.equal(f.requests.filter((entry) => entry.system.includes(styleMarker)).length, 1);
  assert.equal(record.status, "failed"); assert.notEqual(record.verdict, "ACCEPTED"); assert.notEqual(record.finalReport.result, styledResponse);
  assert.match(JSON.stringify(record.finalReport), /untrusted/); assertRealRead(f.requests);
  const before = f.requests.length;
  await assert.rejects(f.start({ outputStyleId: styleId }), /untrusted/);
  assert.equal(f.requests.length, before, "An untrusted style must fail before provider work starts");
});

test("TUI style selection persists and canonical plugin:skill invocation reaches the actual provider with one-pass arguments", async (t) => {
  const f = await fixture(t); let state = initialState();
  const run = async (input, options = {}) => {
    const result = await executeTuiCommand(parseTuiCommand(input), state, f.root, (updater) => { state = updater(state); }, { extensionOptions: f.extensionOptions, requestToolPermission: async () => true, posture: { mode: "auto", approvalPolicy: "changes" }, ...options });
    state = result.state; await result.runtime?.completion; return result;
  };
  await run(`/plugins use-style ${styleId}`);
  assert.equal(state.conversation.outputStyleId, styleId);
  const conversationId = state.conversation.id;
  assert.equal((await new CliConversationStore(f.root).load(conversationId)).outputStyleId, styleId);
  const invocation = await run('/review:inspect input.txt "two words"');
  assert.ok(invocation.runtime); assert.equal(state.conversation.codingStatus, "completed", state.outputLines.join("\n"));
  assert.ok(f.requests.some((entry) => entry.prompt.includes('EXPLICIT_SKILL_BODY target=input.txt; second=two words; all=input.txt "two words".')));
  assert.equal(f.requests.filter((entry) => entry.system.includes(styleMarker)).length, 1); assertRealRead(f.requests);
  await run("/plugins use-style off"); assert.equal(state.conversation.outputStyleId, undefined);
  assert.equal((await new CliConversationStore(f.root).load(conversationId)).outputStyleId, undefined);
  const before = f.requests.length;
  await assert.rejects(run("/review:private input.txt"), /not available as a user-invoked/);
  assert.equal(f.requests.length, before);
});

test("TUI canonical slash dispatch carries the canonical skill ID and raw argument text into the runtime boundary", async (t) => {
  const f = await fixture(t); let state = initialState(), received;
  const result = await executeTuiCommand(parseTuiCommand('/review:inspect input.txt "two words"'), state, f.root, (updater) => { state = updater(state); }, { persistSession: false, extensionOptions: f.extensionOptions, runSession: async (options) => { received = options; return { status: "completed" }; } });
  state = result.state; await result.runtime.completion;
  assert.deepEqual(received.invokedSkills, [{ id: skillId, arguments: 'input.txt "two words"' }]);
  assert.equal(received.cwd, f.root); assert.equal(received.outputStyleId, null); assert.equal(f.requests.length, 0);
});

test("CLI --skill and --skill-args run the actual trusted skill and selected final style without changing provider defaults", async (t) => {
  const f = await fixture(t);
  const result = await runCodeCommand(["Inspect actual evidence", "--skill", skillId, "--skill-args", 'input.txt "two words"', "--output-style", styleId, "--mode", "auto", "--approval", "changes", "--max-agents", "1", "--max-retries", "0", "--no-tui"], f.root, { extensionOptions: f.extensionOptions, requestToolPermission: async () => true });
  assert.equal(result.exitCode, 0, result.output); assert.equal(result.session.status, "completed"); assert.equal(result.session.finalReport.result, styledResponse);
  assert.ok(f.requests.some((entry) => entry.prompt.includes('EXPLICIT_SKILL_BODY target=input.txt; second=two words; all=input.txt "two words".')));
  assert.equal(f.requests.filter((entry) => entry.system.includes(styleMarker)).length, 1); assertRealRead(f.requests);
  const before = f.requests.length;
  await setExtensionState(f.root, "plugin:review", "untrust", f.extensionOptions);
  const revoked = await runCodeCommand(["Inspect actual evidence", "--skill", skillId, "--skill-args", "input.txt", "--no-tui"], f.root, { extensionOptions: f.extensionOptions });
  assert.equal(revoked.exitCode, 1); assert.match(revoked.output, /untrusted/); assert.equal(f.requests.length, before);
});
