import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { connectMcp, installLocalPlugin, readSkillReference, setExtensionState } from "../dist/extensions/index.js";
import { runCoderCli } from "../dist/cli.js";
import { createExtensionToolExecutor } from "../dist/coding/extension-tools.js";
import { StructuredAgentLoop } from "../dist/coding/agent-loop.js";
import { executeTuiCommand, parseTuiCommand } from "../dist/tui/commands.js";
import { initialState } from "../dist/tui/state.js";
import { parseProcess, processEnvironment } from "../dist/extensions/io.js";

const task = { id: "context-builder", sessionId: "context-session", role: "builder", title: "Read MCP context", objective: "Read server context",
  status: "working", providerId: "fixture", dependencies: [], fileScope: [], expectedOutput: "Context read", completionCriteria: [],
  validationCommands: [], depth: 0, attempt: 1, maxAttempts: 1, createdAt: new Date().toISOString() };
async function until(check) {
  const end = Date.now() + 4000;
  while (!await check()) { if (Date.now() > end) assert.fail("Expected observable server event did not arrive"); await new Promise((resolve) => setTimeout(resolve, 5)); }
}
async function fixture(t, stdio = false) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hive-mcp-context-"));
  const root = path.join(directory, "workspace"); await fs.mkdir(path.join(root, ".hive"), { recursive: true });
  const extensionOptions = { trustStateDir: path.join(directory, "trust") };
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  let waiting = false; let disconnected = false; const calls = [];
  const flag = path.join(root, "change"); const marker = path.join(root, "called");
  let spec;
  if (stdio) {
    const script = path.join(root, "server.mjs");
    await fs.writeFile(script, `import readline from 'node:readline';import{existsSync,writeFileSync}from'node:fs';
      const send=m=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...m})+'\\n');let generation=1;
      const poll=setInterval(()=>{if(generation===1&&existsSync(process.argv[2])){generation=2;send({method:'notifications/tools/list_changed'});}},5);
      readline.createInterface({input:process.stdin}).on('line',l=>{const m=JSON.parse(l);let result;
      if(m.method==='initialize')result={protocolVersion:'2025-11-25',capabilities:{tools:{listChanged:true}},serverInfo:{name:'fixture',version:'1'}};
      if(m.method==='tools/list')result={tools:[{name:'echo',description:'Generation '+generation,inputSchema:{type:'object',properties:{value:{type:'string'}}}}]};
      if(m.method==='tools/call'){writeFileSync(process.argv[3],String(generation));result={content:[{type:'text',text:m.params.arguments.value}]};}
      if(result)send({id:m.id,result});}).on('close',()=>{clearInterval(poll);process.exit(0)});`);
    spec = { transport: "stdio", command: process.execPath, args: [script, flag, marker] };
  } else {
    const server = http.createServer(async (request, response) => {
      if (request.method === "DELETE") { response.writeHead(204); response.end(); return; }
      let text = ""; for await (const chunk of request) text += chunk;
      const message = JSON.parse(text); calls.push(message);
      if (!message.id) { response.writeHead(202); response.end(); return; }
      if (message.method === "resources/read" && message.params.uri === "fixture://wait") { waiting = true; response.on("close", () => { disconnected = true; }); return; }
      const result = message.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { resources: {}, prompts: {}, completions: {} }, serverInfo: { name: "context-only", version: "1" } }
        : message.method === "resources/list" ? { resources: [{ uri: "fixture://readme", name: "README" }] }
        : message.method === "resources/templates/list" ? { resourceTemplates: [{ uriTemplate: "fixture://docs/{name}", name: "Docs" }] }
        : message.method === "resources/read" ? { contents: [{ uri: message.params.uri, text: "Actual MCP resource text" }] }
        : message.method === "prompts/list" ? { prompts: [{ name: "review", arguments: [{ name: "code", required: true }] }] }
        : message.method === "prompts/get" ? { messages: [{ role: "user", content: { type: "text", text: "Review " + message.params.arguments.code } }] }
        : message.method === "completion/complete" ? { completion: { values: [message.params.argument.value + "thon"] } } : {};
      response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    t.after(() => { server.closeAllConnections(); server.close(); });
    spec = { transport: "http", url: `http://127.0.0.1:${server.address().port}/mcp` };
  }
  await fs.writeFile(path.join(root, ".hive/extensions.json"), JSON.stringify({ version: 1, mcpServers: { context: spec } }));
  await setExtensionState(root, "mcp:context", "trust", extensionOptions); await setExtensionState(root, "mcp:context", "enable", extensionOptions);
  const make = (requestToolPermission) => createExtensionToolExecutor({ base: { async execute() { assert.fail("No built-in tool expected"); } },
    extensionRoot: root, repositoryRoot: root, mode: "auto", enabledMcpServers: ["context"], extensionOptions,
    requestToolPermission, signal: new AbortController().signal });
  return { root, extensionOptions, make, flag, marker, calls, get waiting() { return waiting; }, get disconnected() { return disconnected; } };
}

test("CLI advanced MCP commands reach actual resource/prompt/completion APIs on a tools-free server", async (t) => {
  const f = await fixture(t);
  const run = (args) => runCoderCli(["mcp", ...args, "--json"], { cwd: f.root, extensionOptions: f.extensionOptions });
  for (const [args, expected] of [
    [["resources", "context"], "fixture://readme"], [["resource-templates", "context"], "fixture://docs/{name}"],
    [["read", "context", "fixture://readme"], "Actual MCP resource text"], [["prompts", "context"], "review"],
    [["prompt", "context", "review", JSON.stringify({ code: "source" })], "Review source"],
    [["complete", "context", JSON.stringify({ reference: { type: "ref/prompt", name: "review" }, argument: { name: "code", value: "py" } })], "python"],
  ]) { const result = await run(args); assert.equal(result.exitCode, 0, result.output); assert.ok(result.output.includes(expected), result.output); }
  assert.match((await run(["doctor", "context"])).output, /0 tool/);
  assert.equal(f.calls.some((call) => call.method === "tools/list"), false);
  assert.ok(f.calls.filter((call) => call.method === "initialize").every((call) => !call.params.capabilities.roots));
  assert.equal((await run(["resources", "context", "unexpected"])).exitCode, 1);
  assert.equal((await run(["prompt", "context", "review", JSON.stringify({ code: 42 })])).exitCode, 1);
});

test("selected context-only MCP servers give agents discoverable context tools with approval before requests", async (t) => {
  const f = await fixture(t); const requests = [];
  const tools = await f.make(async (request) => { requests.push(request); return requests.length > 1; });
  try {
    assert.ok(tools.toolDefinitions.some((tool) => tool.name === "mcp_context__context__read_resource"));
    const name = "mcp_context__context__read_resource";
    const denied = await tools.execute(name, { uri: "fixture://readme" }, task, new AbortController().signal);
    assert.equal(denied.ok, false); assert.equal(f.calls.some((call) => call.method === "resources/read"), false);
    let turn = 0;
    const result = await new StructuredAgentLoop().run({ tools, task, cwd: f.root, sharedContext: "Use the selected server", signal: new AbortController().signal,
      completionClient: { async complete(request) {
        assert.match(request.systemPrompt, /mcp_context__context__read_resource/);
        if (turn++ === 0) return { output: JSON.stringify({ done: false, toolCalls: [{ name, arguments: { uri: "fixture://readme" } }] }) };
        assert.match(request.prompt, /Actual MCP resource text/);
        return { output: JSON.stringify({ done: true, summary: "Read approved context" }) };
      } },
    });
    assert.equal(result.toolCalls, 1); assert.equal(requests.length, 2); assert.equal(requests[1].external, true);
  } finally { await tools.close(); }
});

test("a changed live tool schema requires fresh approval and never executes an earlier approval", async (t) => {
  const f = await fixture(t, true); let entered; let approve; let decisions = 0;
  const pending = new Promise((resolve) => { entered = resolve; }); const decision = new Promise((resolve) => { approve = resolve; });
  const tools = await f.make(async () => { decisions += 1; if (decisions === 1) { entered(); return decision; } return true; });
  try {
    const name = "mcp__context__echo";
    const first = tools.execute(name, { value: "approved" }, task, new AbortController().signal);
    await pending; await fs.writeFile(f.flag, "change");
    await until(async () => { await tools.refreshToolDefinitions(new AbortController().signal); return tools.toolDefinitions.some((tool) => tool.description === "Generation 2"); });
    approve(true);
    assert.match((await first).output, /definition changed/);
    await assert.rejects(fs.access(f.marker), { code: "ENOENT" });
    assert.equal((await tools.execute(name, { value: "fresh approval" }, task, new AbortController().signal)).ok, true);
    assert.equal(decisions, 2); assert.equal(await fs.readFile(f.marker, "utf8"), "2");
  } finally { approve(false); await tools.close(); }
});

test("TUI resource reads use cancellable runtime and disconnect the actual HTTP request", async (t) => {
  const f = await fixture(t); let state = initialState();
  const result = await executeTuiCommand(parseTuiCommand("/mcp read context fixture://wait"), state, f.root, (update) => { state = update(state); }, { extensionOptions: f.extensionOptions });
  assert.ok(result.runtime); await until(() => f.waiting);
  result.runtime.cancel(); await result.runtime.completion;
  await until(() => f.disconnected);
});

test("literal process environment remains bounded, rejects credentials/aliases and overrides Windows casing deterministically", async (t) => {
  const f = await fixture(t);
  const parsed = await parseProcess(f.root, { command: process.execPath, env: { NODE_ENV: "production", plugin_data: "safe" }, envRefs: {} });
  assert.equal(processEnvironment(parsed).NODE_ENV, "production");
  for (const value of [ { env: { SECRET: "opaque" } }, { env: { AUTH: "opaque" } }, { env: { DATABASE_URL: "postgresql://user:password@example.test/db" } },
    { env: { SERVICE_URL: "https://example.test/api?api_key=opaque" } }, { env: { node_env: "production" }, envRefs: { NODE_ENV: "HIVE_TEST_REF" } },
    { env: JSON.parse('{"__proto__":"bad"}') }, { envRefs: JSON.parse('{"__proto__":"HIVE_TEST_REF"}') }, { env: Object.fromEntries(Array.from({ length: 33 }, (_, index) => ["VALUE_" + index, "safe"])) } ]) {
    await assert.rejects(parseProcess(f.root, { command: process.execPath, ...value }), /env|Environment|environment|Credential|32/);
  }
  const processEnv = processEnvironment({ ...parsed, env: { path: "explicit-only" } });
  assert.deepEqual(Object.keys(processEnv).filter((key) => key.toLowerCase() === "path"), ["path"]);
  assert.equal(processEnv.path, "explicit-only");
});

test("transport preflight can refuse a request after asynchronous setup without sending it", async (t) => {
  for (const stdio of [false, true]) {
    const f = await fixture(t, stdio);
    const connection = await connectMcp(f.root, "context", f.extensionOptions);
    try {
      let checked = 0;
      const options = { beforeSend() { checked += 1; throw new Error("Observed definition changed before send"); } };
      await assert.rejects(stdio ? connection.callTool("echo", { value: "never sent" }, options) : connection.readResource("fixture://readme", options), /definition changed/);
      assert.equal(checked, 1);
      if (stdio) await assert.rejects(fs.access(f.marker), { code: "ENOENT" });
      else assert.equal(f.calls.some((message) => message.method === "resources/read"), false);
    } finally { await connection.close(); }
  }
});

test("plugin reference scope remains confined to the selected trusted package including private aliases", async (t) => {
  const f = await fixture(t); const plugin = path.join(f.root, "plugin");
  await fs.mkdir(path.join(plugin, "skills", "selected"), { recursive: true });
  await fs.mkdir(path.join(plugin, "references")); await fs.mkdir(path.join(plugin, "credentials"));
  await fs.writeFile(path.join(plugin, "hive.plugin.json"), JSON.stringify({ version: 1, name: "package", skills: ["skills/selected/SKILL.md"] }));
  await fs.writeFile(path.join(plugin, "skills/selected/SKILL.md"), "---\nname: selected\n---\nUse package references.");
  const reference = path.join(plugin, "references/guide.md"); await fs.writeFile(reference, "Selected package reference");
  await fs.writeFile(path.join(plugin, "credentials/guide.md"), "Private");
  await fs.writeFile(path.join(f.root, "outside.md"), "Outside");
  await fs.symlink(path.join(plugin, "credentials"), path.join(plugin, "alias"), process.platform === "win32" ? "junction" : "dir");
  await installLocalPlugin(f.root, "package", "plugin", f.extensionOptions);
  await setExtensionState(f.root, "plugin:package", "trust", f.extensionOptions); await setExtensionState(f.root, "plugin:package", "enable", f.extensionOptions);
  const id = "skill:package.selected"; const options = { ...f.extensionOptions, scope: "plugin" };
  assert.match((await readSkillReference(f.root, id, reference, options)).content, /Selected package reference/);
  for (const candidate of [path.join(f.root, "outside.md"), "../outside.md", "credentials/guide.md", "alias/guide.md"]) await assert.rejects(readSkillReference(f.root, id, candidate, options), /inside|traversal|private/);
  await fs.link(reference, path.join(plugin, "references/linked.md"));
  await assert.rejects(readSkillReference(f.root, id, "references/linked.md", options), /single-link/);
  await setExtensionState(f.root, "plugin:package", "disable", f.extensionOptions);
  await assert.rejects(readSkillReference(f.root, id, reference, options), /disabled|untrusted/);
});

test("long public literal environment settings validate within a hard child-process deadline", () => {
  const source = 'import{validateEnvironmentLiteral}from"./dist/extensions/io.js";const text="a".repeat(16384);for(let i=0;i<64;i++)if(validateEnvironmentLiteral("PUBLIC_VALUE",text)!==text)process.exit(2);';
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", source], { cwd: path.resolve(import.meta.dirname, ".."), timeout: 5000, encoding: "utf8", windowsHide: true, maxBuffer: 4096 });
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr);
});
