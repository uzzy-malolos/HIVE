import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { runCoderCli } from "../dist/cli.js";
import { executeTuiCommand, parseTuiCommand } from "../dist/tui/commands.js";
import { initialState } from "../dist/tui/state.js";
import { runQueenTuiSession } from "../dist/tui/runtime-adapter.js";
import { CliConversationStore, newConversation } from "../dist/tui/conversations.js";
import { CodingSessionStore } from "../dist/coding/session-store.js";
import { discoverExtensions, setExtensionState } from "../dist/extensions/index.js";
import { ConfigStore } from "../dist/config.js";

const execute = promisify(execFile);
const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function until(predicate, label = "fixture event") { const end = Date.now() + 8000; while (Date.now() < end) { const found = await predicate(); if (found) return found; await sleep(10); } throw new Error(`Expected ${label} was not observed`); }
async function exists(file) { try { await fs.access(file); return true; } catch (error) { if (error.code === "ENOENT") return false; throw error; } }
async function readJsonLines(file) { if (!await exists(file)) return []; return (await fs.readFile(file, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)); }

async function temporary(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hive-cli-final-protocols-")), root = path.join(directory, "workspace");
  await fs.mkdir(path.join(root, ".hive"), { recursive: true });
  const extensionOptions = { trustStateDir: path.join(directory, "trust") };
  try { await run({ directory, root, extensionOptions }); }
  finally { assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir())); assert.ok(path.basename(directory).startsWith("hive-cli-final-protocols-")); await fs.rm(directory, { recursive: true, force: true }); }
}
async function cli(context, args, extra = {}) { return runCoderCli(args, { cwd: context.root, extensionOptions: context.extensionOptions, ...extra }); }
async function okay(context, args, extra) { const result = await cli(context, args, extra); assert.equal(result.exitCode, 0, result.output); return result; }

async function mcpFixture(run) {
  await temporary(async (context) => {
    const requests = [], streams = new Set(); let current = { taskId: "fixture-task", status: "working", createdAt: "2025-11-25T00:00:00Z", lastUpdatedAt: "2025-11-25T00:00:01Z", ttl: 60_000 };
    let fixtureFailure;
    const emit = (response, value) => response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", ...value })}\n\n`);
    const server = http.createServer(async (request, response) => {
      try {
        if (request.method === "DELETE") { requests.push({ verb: "DELETE" }); response.writeHead(200).end(); return; }
        if (request.method === "GET") { requests.push({ verb: "GET", headers: request.headers }); response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders(); streams.add(response); response.on("close", () => streams.delete(response)); return; }
        let raw = ""; for await (const chunk of request) raw += chunk;
        const message = JSON.parse(raw); requests.push(message);
        if (message.id === undefined) { response.writeHead(202).end(); return; }
        let result = {};
        if (message.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: { tools: { listChanged: true }, resources: { subscribe: true }, tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } }, serverInfo: { name: "CLI protocol fixture", version: "1" } };
        if (message.method === "tools/list") result = { tools: [{ name: "deferred", inputSchema: { type: "object" }, execution: { taskSupport: "optional" } }] };
        if (message.method === "tools/call") result = { task: current };
        if (message.method === "tasks/list") result = { tasks: [current] };
        if (message.method === "tasks/get") result = current;
        if (message.method === "tasks/result") result = { content: [{ type: "text", text: "actual deferred fixture result" }] };
        if (message.method === "tasks/cancel") { current = { ...current, status: "cancelled" }; result = current; }
        response.writeHead(200, { "content-type": "application/json", ...(message.method === "initialize" ? { "mcp-session-id": "final-cli-session" } : {}) });
        response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
      } catch (error) { fixtureFailure = error; response.writeHead(500).end(); }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    await fs.writeFile(path.join(context.root, ".hive", "extensions.json"), JSON.stringify({ version: 1, mcpServers: { fixture: { transport: "http", url: `http://127.0.0.1:${server.address().port}/mcp` } } }));
    await setExtensionState(context.root, "mcp:fixture", "trust", context.extensionOptions); await setExtensionState(context.root, "mcp:fixture", "enable", context.extensionOptions);
    try { await run({ ...context, requests, streams, broadcast(value) { for (const response of streams) emit(response, value); } }); if (fixtureFailure) throw fixtureFailure; }
    finally { for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  });
}

test("CLI MCP watch and subscribe deliver real background progress and cancellation closes GET without replay", async () => mcpFixture(async (context) => {
  for (const verb of ["watch", "subscribe"]) {
    const progress = [], controller = new AbortController();
    const pending = cli(context, ["mcp", verb, "fixture", ...(verb === "subscribe" ? ["fixture://watched"] : []), "--json"], { signal: controller.signal, stream: (line) => progress.push(JSON.parse(line)) });
    await until(() => context.streams.size === 1 && progress.some((entry) => entry.text?.includes("watching")), "CLI watching acknowledgement");
    if (verb === "subscribe") context.broadcast({ method: "notifications/resources/updated", params: { uri: "fixture://watched" } });
    else context.broadcast({ method: "notifications/tools/list_changed" });
    await until(() => progress.some((entry) => entry.text?.includes(verb === "subscribe" ? "resource updated fixture://watched" : "tools list changed")), "live CLI extension progress");
    controller.abort(); const result = await pending; assert.notEqual(result.exitCode, 0); assert.match(result.output, /cancelled|aborted/iu);
    await until(() => context.streams.size === 0, "cancelled GET stream close");
  }
  assert.equal(context.requests.filter((entry) => entry.verb === "GET").length, 2);
  assert.equal(context.requests.filter((entry) => entry.method === "resources/subscribe").length, 1);
  assert.equal(context.requests.filter((entry) => entry.method === "tools/call").length, 0);
  for (const request of context.requests.filter((entry) => entry.verb === "GET")) { assert.equal(request.headers["mcp-session-id"], "final-cli-session"); assert.equal(request.headers["mcp-protocol-version"], "2025-11-25"); }
}));

test("CLI task-call/list/status/result/cancel use actual protocol methods and submit work once", async () => mcpFixture(async (context) => {
  const call = await okay(context, ["mcp", "task-call", "fixture", "deferred", '{"value":"one"}', "--json"]); assert.match(call.output, /fixture-task/);
  assert.match((await okay(context, ["mcp", "tasks", "fixture", "--json"])).output, /fixture-task/);
  assert.match((await okay(context, ["mcp", "task", "fixture", "fixture-task", "--json"])).output, /working/);
  assert.match((await okay(context, ["mcp", "task-result", "fixture", "fixture-task", "--json"])).output, /actual deferred fixture result/);
  assert.match((await okay(context, ["mcp", "task-cancel", "fixture", "fixture-task", "--json"])).output, /cancelled/);
  assert.deepEqual(context.requests.filter((entry) => ["tools/call", "tasks/list", "tasks/get", "tasks/result", "tasks/cancel"].includes(entry.method)).map((entry) => entry.method), ["tools/call", "tasks/list", "tasks/get", "tasks/result", "tasks/cancel"]);
  assert.deepEqual(context.requests.find((entry) => entry.method === "tools/call").params, { name: "deferred", arguments: { value: "one" }, task: {} });
}));

const hookScript = `
import {appendFileSync,existsSync} from 'node:fs';import path from 'node:path';
let raw='';for await(const chunk of process.stdin)raw+=chunk;const input=JSON.parse(raw),kind=process.argv[2];
appendFileSync(path.join(input.cwd,'.fixture-hook-events.jsonl'),JSON.stringify({kind,input})+'\\n');
if(kind==='start'&&existsSync(path.join(input.cwd,'.fixture-stop'))){console.log(JSON.stringify({continue:false,stopReason:'fixture-owner-stop'}));}
else console.log(JSON.stringify({hookSpecificOutput:{hookEventName:input.hook_event_name,additionalContext:kind==='start'?'START_HOOK_CONTEXT':kind==='prompt'?'PROMPT_HOOK_CONTEXT':'OTHER_HOOK_CONTEXT'}}));
`;
const lspScript = `
import {appendFileSync} from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';
let buffer=Buffer.alloc(0),length,root,document;
const send=value=>{const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',...value}));process.stdout.write('Content-Length: '+body.length+'\\r\\n\\r\\n');process.stdout.write(body);};
const handle=value=>{if(value.method==='initialize')root=fileURLToPath(value.params.rootUri);if(root)appendFileSync(path.join(root,'.fixture-lsp-events.jsonl'),JSON.stringify(value)+'\\n');
 if(value.method==='initialize')send({id:value.id,result:{capabilities:{textDocumentSync:1,hoverProvider:true,definitionProvider:true,referencesProvider:true,documentSymbolProvider:true,workspaceSymbolProvider:true}}});
 else if(value.method==='textDocument/didOpen')document=value.params.textDocument;
 else if(value.method==='textDocument/didChange')document={...document,text:value.params.contentChanges[0].text};
 else if(value.method==='textDocument/hover')send({id:value.id,result:{contents:{kind:'plaintext',value:'actual-LSP-hover: '+document.text}}});
 else if(value.method==='textDocument/definition'||value.method==='textDocument/references')send({id:value.id,result:[{uri:document.uri,range:{start:{line:0,character:0},end:{line:0,character:1}}}]});
 else if(value.method==='textDocument/documentSymbol')send({id:value.id,result:[{name:'actual fixture symbol',kind:12,range:{start:{line:0,character:0},end:{line:0,character:1}},selectionRange:{start:{line:0,character:0},end:{line:0,character:1}}}]});
 else if(value.method==='shutdown')send({id:value.id,result:null});else if(value.method==='exit')process.exit(0);
};process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length){if(length===undefined){const end=buffer.indexOf('\\r\\n\\r\\n');if(end<0)return;length=Number(buffer.subarray(0,end).toString().split(':')[1]);buffer=buffer.subarray(end+4);}if(buffer.length<length)return;const value=JSON.parse(buffer.subarray(0,length).toString());buffer=buffer.subarray(length);length=undefined;handle(value);}}).on('end',()=>process.exit(0));
`;

async function pluginFixture(run) {
  await temporary(async (context) => {
    await execute("git", ["init", "-b", "main"], { cwd: context.root }); await execute("git", ["config", "user.email", "fixture@example.test"], { cwd: context.root }); await execute("git", ["config", "user.name", "HIVE fixture"], { cwd: context.root });
    await execute("git", ["config", "core.autocrlf", "false"], { cwd: context.root });
    await fs.writeFile(path.join(context.root, ".gitignore"), ".hive/\n.hivemind/\n.fixture-*\n"); await fs.writeFile(path.join(context.root, "input.txt"), "original fixture input\n"); await fs.writeFile(path.join(context.root, "source with spaces.ts"), "const actualFixture = 42;\n");
    await execute("git", ["add", ".gitignore", "input.txt", "source with spaces.ts"], { cwd: context.root }); await execute("git", ["commit", "-m", "Fixture baseline"], { cwd: context.root });
    const market = path.join(context.directory, "market with spaces"), bundle = path.join(market, "plugins", "complete");
    await fs.mkdir(path.join(market, ".claude-plugin"), { recursive: true }); await fs.mkdir(path.join(bundle, ".claude-plugin"), { recursive: true }); await fs.mkdir(path.join(bundle, "agents")); await fs.mkdir(path.join(bundle, "hooks"));
    await fs.writeFile(path.join(market, ".claude-plugin", "marketplace.json"), JSON.stringify({ name: "final-team", plugins: [{ name: "complete", source: "./plugins/complete" }] }));
    await fs.writeFile(path.join(bundle, ".claude-plugin", "plugin.json"), JSON.stringify({ name: "complete", description: "Complete real integration fixture", lspServers: "./.lsp.json" }));
    await fs.writeFile(path.join(bundle, "agents", "inspector.md"), "---\nname: inspector\ndescription: Inspect source evidence\ntools: Read\nmodel: opus\nmaxTurns: 4\n---\nSPECIALIST_AGENCY_CONTEXT: inspect actual repository evidence and obey the HIVE boundaries.\n");
    await fs.writeFile(path.join(bundle, "hook.mjs"), hookScript); await fs.writeFile(path.join(bundle, "lsp.mjs"), lspScript);
    const handler = (kind) => ({ type: "command", command: process.execPath, args: ["${CLAUDE_PLUGIN_ROOT}/hook.mjs", kind] });
    await fs.writeFile(path.join(bundle, "hooks", "hooks.json"), JSON.stringify({ hooks: { SessionStart: [{ hooks: [handler("start"), handler("later-command")] }], UserPromptSubmit: [{ hooks: [handler("prompt")] }], PostToolUse: [{ matcher: "Read", hooks: [handler("read-hook")] }], SessionEnd: [{ hooks: [handler("end")] }] } }));
    await fs.writeFile(path.join(bundle, ".lsp.json"), JSON.stringify({ fixture: { command: process.execPath, args: ["${CLAUDE_PLUGIN_ROOT}/lsp.mjs"], extensionToLanguage: { ".ts": "typescript" }, restartOnCrash: false } }));
    const requests = []; let backendFailure, reviewBehavior = "normal";
    const server = http.createServer(async (request, response) => {
      try {
        if (request.method === "GET") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "selected-fixture-model" }] })); return; }
        let raw = ""; for await (const chunk of request) raw += chunk;
        const body = JSON.parse(raw), system = body.messages.find((message) => message.role === "system")?.content ?? "", prompt = body.messages.find((message) => message.role === "user")?.content ?? "";
        requests.push({ body, system, prompt });
        let result = { done: true, summary: "Actual fixture evidence inspected", data: { status: "passed", findings: [] } };
        if (system.includes("HIVE Planner")) result = { summary: "Inspect actual source evidence", architecture: "One read-only fixture task", risks: [], acceptanceCriteria: ["Actual input was read"], validationCommands: ["node --version"], tasks: [{ key: "inspect", role: "builder", title: "Inspect input", objective: "Inspect the real input.txt and report its contents", dependencies: [], fileScope: ["input.txt"], expectedOutput: "Read evidence", completionCriteria: ["Actual source evidence read"], validationCommands: [] }] };
        else if (system.includes("HIVE builder subagent") && !prompt.includes("[Tool results 1]")) result = { done: false, toolCalls: [{ name: "write_file", arguments: { path: "forbidden-output.txt", content: "must not be written" } }, { name: "read_file", arguments: { path: "input.txt" } }] };
        else if (system.includes("HIVE reviewer subagent") && reviewBehavior === "tools" && !prompt.includes("[Tool results 1]")) result = { done: false, toolCalls: [{ name: "write_file", arguments: { path: "forbidden-output.txt", content: "review must not write" } }, { name: "read_file", arguments: { path: "input.txt" } }] };
        else if (system.includes("HIVE reviewer subagent") && reviewBehavior === "failed") result = { done: true, summary: "Fixture review explicitly failed", data: { status: "failed", findings: [] } };
        const output = JSON.stringify(result);
        if (body.stream) { response.writeHead(200, { "content-type": "text/event-stream" }); for (let index = 0; index < output.length; index += 23) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: output.slice(index, index + 23) } }] })}\n\n`); response.end("data: [DONE]\n\n"); }
        else { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ choices: [{ message: { content: output } }] })); }
      } catch (error) { backendFailure = error; response.writeHead(500).end(JSON.stringify({ error: { message: error.message } })); }
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const provider = { id: "fixture", name: "fixture", kind: "local", authType: "none", approved: true, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, defaultModel: "provider-default-must-not-replace-selection", createdAt: "2026-10-17", updatedAt: "2026-10-17" };
    const roles = Object.fromEntries(["queen", "planner", "scout", "builder", "validator", "reviewer", "fixer"].map((role) => [role, { provider: "fixture", model: "selected-fixture-model" }]));
    await fs.writeFile(path.join(context.root, ".hive", "providers.json"), JSON.stringify([provider])); await fs.writeFile(path.join(context.root, ".hive", "provider-roles.json"), JSON.stringify(roles));
    await new ConfigStore(context.root).setMode("standard");
    const originalProviders = await fs.readFile(path.join(context.root, ".hive", "providers.json")), originalRoles = await fs.readFile(path.join(context.root, ".hive", "provider-roles.json"));
    try {
      const install = async () => {
        await okay(context, ["plugins", "marketplace", "add", market, "--json"]); await okay(context, ["plugins", "install", "complete@final-team", "--json"]);
        const catalog = await discoverExtensions(context.root, context.extensionOptions); assert.deepEqual(catalog.diagnostics, []);
        const plugin = catalog.plugins[0], agent = catalog.agents[0], lsp = catalog.lspServers[0];
        assert.ok(plugin && agent && lsp && catalog.hooks.length === 5);
        for (const entry of [plugin, agent, lsp, ...catalog.hooks]) { assert.equal(entry.trusted, false); assert.equal(entry.enabled, false); }
        assert.equal(requests.length, 0); assert.equal(await exists(path.join(context.root, ".fixture-hook-events.jsonl")), false); assert.equal(await exists(path.join(context.root, ".fixture-lsp-events.jsonl")), false);
        return { plugin, agent, lsp };
      };
      const trust = async (plugin) => { await okay(context, ["plugins", "trust", plugin.id, "--json"]); await okay(context, ["plugins", "enable", plugin.id, "--json"]); };
      await run({ ...context, requests, install, trust, setReviewBehavior(value) { reviewBehavior = value; }, hookLog: path.join(context.root, ".fixture-hook-events.jsonl"), lspLog: path.join(context.root, ".fixture-lsp-events.jsonl") });
      if (backendFailure) throw backendFailure;
      assert.deepEqual(await fs.readFile(path.join(context.root, ".hive", "providers.json")), originalProviders); assert.deepEqual(await fs.readFile(path.join(context.root, ".hive", "provider-roles.json")), originalRoles);
    } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
  });
}

function assertManagedReadOnlySession(record, root) {
  assert.equal(record.status, "completed", JSON.stringify(record.finalReport)); assert.equal(record.verdict, "ACCEPTED", JSON.stringify(record.finalReport));
  assert.ok(record.repository.worktreePath); assert.notEqual(path.resolve(record.repository.worktreePath), path.resolve(root));
}

test("marketplace hook/agent/LSP bundle stays inert until trusted, then real CLI navigation and Queen invocation work", async () => pluginFixture(async (context) => {
  const { plugin, agent, lsp } = await context.install();
  assert.equal((await cli(context, ["plugins", "run-agent", agent.id, "Inspect source", "--json"])).exitCode, 1); assert.equal(context.requests.length, 0);
  await context.trust(plugin);
  const hover = await okay(context, ["lsp", "hover", lsp.id, "source with spaces.ts", "0", "0", "--json"]); assert.match(hover.output, /actual-LSP-hover/); assert.match(hover.output, /const actualFixture = 42/);
  const events = await readJsonLines(context.lspLog); assert.equal(events[0].method, "initialize"); assert.equal(events.find((entry) => entry.method === "textDocument/didOpen").params.textDocument.text, "const actualFixture = 42;\n"); assert.ok(events.some((entry) => entry.method === "shutdown"));
  const result = await okay(context, ["plugins", "run-agent", agent.id, "Inspect actual source evidence", "--json"]); assert.match(result.output, /coding session/);
  const [record] = await new CodingSessionStore(context.root).list(); assertManagedReadOnlySession(record, context.root); assert.equal(record.pluginAgentId, agent.id);
  const registered = await execute("git", ["worktree", "list", "--porcelain"], { cwd: context.root });
  assert.ok(registered.stdout.replaceAll("\\", "/").includes(`worktree ${record.repository.worktreePath.replaceAll("\\", "/")}`));
  assert.equal((await fs.stat(path.join(record.repository.worktreePath, ".git"))).isFile(), true);
  assert.equal(await fs.readFile(path.join(context.root, "input.txt"), "utf8"), "original fixture input\n"); assert.equal(await fs.readFile(path.join(record.repository.worktreePath, "input.txt"), "utf8"), "original fixture input\n");
  assert.equal(await exists(path.join(context.root, "forbidden-output.txt")), false); assert.equal(await exists(path.join(record.repository.worktreePath, "forbidden-output.txt")), false);
  assert.ok(context.requests.every((request) => request.body.model === "selected-fixture-model"));
  assert.ok(context.requests.some((request) => request.system.includes("SPECIALIST_AGENCY_CONTEXT") && request.prompt.includes("denied by the selected agent") && request.prompt.includes("original fixture input")));
  assert.ok(context.requests.some((request) => request.prompt.includes("START_HOOK_CONTEXT") && request.prompt.includes("PROMPT_HOOK_CONTEXT")));
  assert.deepEqual((await readJsonLines(context.hookLog)).slice(0, 3).map((entry) => entry.kind), ["start", "later-command", "prompt"]);
  assert.ok((await readJsonLines(path.join(record.repository.worktreePath, ".fixture-hook-events.jsonl"))).some((entry) => entry.kind === "read-hook"));
  assert.equal((await readJsonLines(context.hookLog)).findLast((entry) => entry.kind === "end").input.reason, record.status);
}));

test("TUI selected agent/LSP persist and reach the real Queen runner; clearing an agent survives follow-up", async () => pluginFixture(async (context) => {
  const { plugin, agent, lsp } = await context.install(); await context.trust(plugin);
  let state = { ...initialState(), sessionMode: "standard", selectedProvider: "fixture", selectedModel: "selected-fixture-model", conversation: { ...newConversation(context.root, "standard"), model: { providerId: "fixture", model: "selected-fixture-model" } } };
  const captures = [], requestToolPermission = async () => true, requestMcpInput = async () => ({ action: "decline" });
  const options = { extensionOptions: context.extensionOptions, requestToolPermission, requestMcpInput, persistSession: true, runSession: async (request) => { captures.push(request); return runQueenTuiSession(request); } };
  const start = async (text) => { const result = await executeTuiCommand(parseTuiCommand(text), state, context.root, (update) => { state = update(state); }, options); state = result.state; await result.runtime?.completion; return result; };
  await start(`/plugins use-agent ${agent.id}`); await start(`/lsp use ${lsp.id}`);
  assert.equal(context.requests.length, 0); assert.equal(await exists(context.lspLog), false, "selection must not start LSP");
  const initialSaved = await new CliConversationStore(context.root).load(state.conversation.id); assert.equal(initialSaved.pluginAgentId, agent.id); assert.deepEqual(initialSaved.lspServerIds, [lsp.id]);
  await start("Inspect source with the selected specialist");
  assert.equal(state.taskStatus, "complete", state.outputLines.join("\n")); assert.equal(captures[0].pluginAgentId, agent.id); assert.deepEqual(captures[0].enabledLspServers, [lsp.id]); assert.equal(captures[0].requestToolPermission, requestToolPermission); assert.equal(captures[0].requestMcpInput, requestMcpInput);
  assert.deepEqual(captures[0].providerOverride, { providerId: "fixture", model: "selected-fixture-model" });
  const saved = await new CliConversationStore(context.root).load(state.conversation.id), record = await new CodingSessionStore(context.root).load(saved.codingSessionId); assertManagedReadOnlySession(record, context.root); assert.equal(record.pluginAgentId, agent.id);
  const requestBoundary = context.requests.length;
  await start("/plugins use-agent off"); await start("/lsp use off");
  const cleared = await new CliConversationStore(context.root).load(state.conversation.id); assert.equal(cleared.pluginAgentId, undefined); assert.deepEqual(cleared.lspServerIds, []);
  await start("Continue inspecting with the normal HIVE agent");
  assert.equal(state.taskStatus, "complete", state.outputLines.join("\n")); assert.equal(captures[1].pluginAgentId, null, "explicit clear must override a persisted coding-session selection"); assert.deepEqual(captures[1].enabledLspServers, []);
  const after = await new CodingSessionStore(context.root).load(state.conversation.codingSessionId); assert.equal(after.pluginAgentId, undefined); assert.equal(after.repository.worktreePath, record.repository.worktreePath);
  const newBuilderRequests = context.requests.slice(requestBoundary).filter((request) => request.system.includes("HIVE builder subagent")); assert.ok(newBuilderRequests.length); assert.ok(newBuilderRequests.every((request) => !request.system.includes("SPECIALIST_AGENCY_CONTEXT")));
}));

test("hive code includes real lifecycle hook context and continue:false prevents later hook commands and provider calls", async () => pluginFixture(async (context) => {
  const { plugin } = await context.install(); await context.trust(plugin);
  const progress = [];
  const completed = await cli(context, ["code", "Inspect source via code CLI", "--mode", "auto", "--approval", "changes", "--provider", "fixture", "--model", "selected-fixture-model", "--no-tui", "--json"], { stream: (line) => progress.push(line) });
  assert.equal(completed.exitCode, 0, [completed.output, ...progress].join("\n"));
  assert.ok(context.requests.some((request) => request.prompt.includes("START_HOOK_CONTEXT") && request.prompt.includes("PROMPT_HOOK_CONTEXT")));
  const records = await new CodingSessionStore(context.root).list(); assert.equal(records.length, 1); assertManagedReadOnlySession(records[0], context.root);
  assert.equal((await readJsonLines(context.hookLog)).findLast((entry) => entry.kind === "end").input.reason, records[0].status);
  const beforeCancellation = context.requests.length, beforeCancellationHooks = (await readJsonLines(context.hookLog)).length;
  const aborted = new AbortController(); aborted.abort("fixture pre-run cancellation");
  const cancelled = await cli(context, ["code", "Do not begin this cancelled turn", "--provider", "fixture", "--model", "selected-fixture-model", "--no-tui", "--json"], { signal: aborted.signal });
  assert.equal(cancelled.exitCode, 130); assert.equal(context.requests.length, beforeCancellation); assert.equal((await readJsonLines(context.hookLog)).length, beforeCancellationHooks);
  const beforeRequests = context.requests.length, beforeEvents = (await readJsonLines(context.hookLog)).length;
  await fs.writeFile(path.join(context.root, ".fixture-stop"), "owner stop");
  const result = await cli(context, ["code", "Must stop before model calls", "--provider", "fixture", "--model", "selected-fixture-model", "--no-tui", "--json"]);
  assert.equal(result.exitCode, 1); assert.match(result.output, /fixture-owner-stop/); assert.equal(context.requests.length, beforeRequests);
  const later = (await readJsonLines(context.hookLog)).slice(beforeEvents); assert.ok(later.some((entry) => entry.kind === "start")); assert.equal(later.some((entry) => entry.kind === "later-command" || entry.kind === "prompt"), false, "continue:false must stop later startup handlers and prompt commands");
  assert.equal((await new CodingSessionStore(context.root).list()).length, 1);
}));

test("selected specialists apply to real plan/review requests without writes and ending hooks reflect failed status", async () => pluginFixture(async (context) => {
  const { plugin, agent } = await context.install(); await context.trust(plugin);
  await new ConfigStore(context.root).setMode("plan");
  const planned = await okay(context, ["plugins", "run-agent", agent.id, "PLAN_SELECTED_SPECIALIST inspect before changes", "--json"]);
  assert.match(planned.output, /coding session/);
  const [planRecord] = await new CodingSessionStore(context.root).list(); assert.equal(planRecord.mode, "plan"); assert.ok(planRecord.plan); assert.equal(planRecord.files.length, 0);
  assert.ok(planRecord.tasks.filter((task) => task.role === "builder").every((task) => task.status === "skipped"));
  assert.ok(context.requests.some((request) => request.system.includes("HIVE Planner") && request.system.includes("SPECIALIST_AGENCY_CONTEXT")));
  assert.equal(context.requests.some((request) => request.system.includes("HIVE builder subagent")), false);
  const boundary = context.requests.length;
  await new ConfigStore(context.root).setMode("review");
  context.setReviewBehavior("tools");
  await okay(context, ["plugins", "run-agent", agent.id, "FORCE_REVIEW_FORBIDDEN_TOOL inspect safely", "--json"]);
  const [reviewRecord] = await new CodingSessionStore(context.root).list(); assert.equal(reviewRecord.mode, "review"); assert.equal(reviewRecord.status, "completed"); assert.equal(reviewRecord.files.length, 0);
  const reviewRequests = context.requests.slice(boundary).filter((request) => request.system.includes("HIVE reviewer subagent"));
  assert.ok(reviewRequests.some((request) => request.system.includes("SPECIALIST_AGENCY_CONTEXT") && /not authorized|denied by the selected agent/u.test(request.prompt) && request.prompt.includes("original fixture input")));
  assert.equal(await exists(path.join(context.root, "forbidden-output.txt")), false); assert.equal(await fs.readFile(path.join(context.root, "input.txt"), "utf8"), "original fixture input\n");
  context.setReviewBehavior("failed");
  const failed = await cli(context, ["plugins", "run-agent", agent.id, "FORCE_REVIEW_FAILED_STATUS return a failed review", "--json"]); assert.equal(failed.exitCode, 1);
  const [failedRecord] = await new CodingSessionStore(context.root).list(); assert.equal(failedRecord.status, "failed");
  const endings = (await readJsonLines(context.hookLog)).filter((entry) => entry.kind === "end");
  for (const record of [planRecord, reviewRecord, failedRecord]) assert.equal(endings.find((entry) => entry.input.session_id === record.id).input.reason, record.status);
  assert.equal((await execute("git", ["diff", "--exit-code"], { cwd: context.root })).stdout, "");
  assert.ok(context.requests.every((request) => request.body.model === "selected-fixture-model"));
}));
