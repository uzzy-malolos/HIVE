import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createExtensionToolExecutor } from "../dist/coding/extension-tools.js";
import { StructuredAgentLoop } from "../dist/coding/agent-loop.js";
import { createQueenSession } from "../dist/coding/runtime.js";
import { setExtensionState } from "../dist/extensions/index.js";

const execFileAsync = promisify(execFile);
function deferred() { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; }
const task = { id: "bee-001", sessionId: "extension-session", role: "builder", title: "Fixture", objective: "Fixture",
  status: "working", providerId: "fixture", dependencies: [], fileScope: ["implementation.txt"], expectedOutput: "Fixture",
  completionCriteria: [], validationCommands: [], depth: 0, attempt: 1, maxAttempts: 1, createdAt: new Date().toISOString() };

const serverSource = `import readline from 'node:readline';
import {writeFileSync} from 'node:fs';
writeFileSync(process.argv[2],String(process.pid));
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);
 if(m.method==='initialize')send(m.id,{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
 if(m.method==='tools/list')send(m.id,{tools:[{name:'echo',description:'Echo the supplied value',inputSchema:{type:'object',properties:{value:{type:'string'}},required:['value']}}]});
 if(m.method==='tools/call'){writeFileSync(process.argv[3],JSON.stringify(m.params.arguments));send(m.id,{content:[{type:'text',text:m.params.arguments.value??'result'}]});}
}).on('close',()=>process.exit(0));`;

async function fixture(run, hooks = false) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hive-coding-extensions-"));
  const root = path.join(temporary, "workspace"); const trustStateDir = path.join(temporary, "trust");
  await fs.mkdir(path.join(root, ".hive"), { recursive: true });
  const pidPath = path.join(root, "pid.txt"); const marker = path.join(root, "called.txt");
  const server = path.join(root, "server.mjs"); await fs.writeFile(server, serverSource);
  const hook = path.join(root, "hook.mjs");
  await fs.writeFile(hook, `import {appendFileSync} from 'node:fs';let text='';process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>{const p=JSON.parse(text);appendFileSync(process.argv[2],p.event+'\\n');if(p.event==='before_tool'&&p.input.input.block)process.exit(7);if(p.event==='after_tool')process.exit(9);});`);
  const hookMarker = path.join(root, "hooks.txt");
  await fs.writeFile(path.join(root, ".hive", "extensions.json"), JSON.stringify({ version: 1,
    mcpServers: { fixture: { transport: "stdio", command: process.execPath, args: [server, pidPath, marker] } },
    ...(hooks ? { hooks: {
      before: { event: "before_tool", command: process.execPath, args: [hook, hookMarker] },
      after: { event: "after_tool", command: process.execPath, args: [hook, hookMarker] },
    } } : {}),
  }));
  const extensionOptions = { trustStateDir };
  const activate = async (id) => { await setExtensionState(root, id, "trust", extensionOptions); await setExtensionState(root, id, "enable", extensionOptions); };
  await activate("mcp:fixture");
  const controller = new AbortController();
  const make = (options = {}) => createExtensionToolExecutor({
    base: { async execute() { return { ok: true, output: "Builtin executed" }; } },
    extensionRoot: root, repositoryRoot: root, mode: "auto", enabledMcpServers: ["mcp:fixture"], extensionOptions,
    requestToolPermission: async () => true, signal: controller.signal, ...options,
  });
  try { await run({ root, marker, pidPath, hookMarker, controller, make, activate, extensionOptions }); }
  finally { controller.abort(); await fs.rm(temporary, { recursive: true, force: true }); }
}

test("dynamic MCP tools advertise real schemas and await approval before side effects", async () => fixture(async ({ root, make, marker, pidPath }) => {
  const entered = deferred(); const approval = deferred(); const requests = [];
  const tools = await make({
    base: { builtinToolNames: ["read_file"], async execute() { return { ok: true, output: "Builtin executed" }; } },
    requestToolPermission: (request) => { requests.push(request); entered.resolve(); return approval.promise; },
  });
  const image = { mimeType: "image/png", data: "ephemeral-image-payload" };
  let providerCalls = 0;
  try {
    assert.deepEqual(tools.toolDefinitions[0].inputSchema.required, ["value"]);
    const run = new StructuredAgentLoop().run({ task, cwd: root, sharedContext: "Fixture", tools, images: [image], signal: new AbortController().signal,
      completionClient: { async complete(request) {
        assert.deepEqual(request.images, [image]);
        assert.ok(!request.systemPrompt.includes(image.data) && !request.prompt.includes(image.data));
        assert.match(request.systemPrompt, /mcp__fixture__echo/);
        assert.match(request.systemPrompt, /Echo the supplied value/);
        assert.ok(request.systemPrompt.includes('"name":"read_file"'));
        assert.equal(request.systemPrompt.includes('"name":"write_file"'), false, "extension wrapping must preserve base tool availability");
        return { output: JSON.stringify(providerCalls++ === 0
          ? { done: false, toolCalls: [{ name: "mcp__fixture__echo", arguments: { value: "approved result" } }] }
          : { done: true, summary: "Fixture completed" }) };
      } },
    });
    await entered.promise;
    await assert.rejects(fs.access(marker), { code: "ENOENT" });
    assert.equal(requests[0].external, true);
    assert.deepEqual(requests[0].input, { value: "approved result" });
    approval.resolve(true);
    assert.equal((await run).summary, "Fixture completed");
    assert.deepEqual(JSON.parse(await fs.readFile(marker, "utf8")), { value: "approved result" });
  } finally { await tools.close(); }
  const pid = Number.parseInt(await fs.readFile(pidPath, "utf8"), 10);
  assert.throws(() => process.kill(pid, 0));
}));

test("denial and cancellation while permission is pending execute no MCP call", async () => fixture(async ({ make, marker, controller }) => {
  let decisions = 0;
  const denied = await make({ requestToolPermission: async () => { decisions += 1; return false; } });
  try {
    const result = await denied.execute("mcp__fixture__echo", { value: "denied" }, task, controller.signal);
    assert.equal(result.ok, false); assert.equal(result.metadata.permissionDenied, true); assert.equal(decisions, 1);
    await assert.rejects(fs.access(marker), { code: "ENOENT" });
  } finally { await denied.close(); }
  const entered = deferred(); const approval = deferred();
  const pending = await make({ requestToolPermission: () => { entered.resolve(); return approval.promise; } });
  try {
    const execution = pending.execute("mcp__fixture__echo", { value: "cancelled" }, task, controller.signal);
    await entered.promise; controller.abort();
    await assert.rejects(execution, { name: "AbortError" });
    approval.resolve(true);
    await assert.rejects(fs.access(marker), { code: "ENOENT" });
  } finally { await pending.close(); }
}));

test("missing approval callback and plan or review mode never connect external servers", async () => {
  for (const options of [{ requestToolPermission: undefined }, { mode: "plan" }, { mode: "review" }]) {
    await fixture(async ({ make, pidPath, controller }) => {
      const tools = await make(options);
      try {
        assert.deepEqual(tools.toolDefinitions, []);
        const result = await tools.execute("mcp__fixture__echo", {}, task, controller.signal);
        assert.equal(result.ok, false);
        await assert.rejects(fs.access(pidPath), { code: "ENOENT" });
      } finally { await tools.close(); }
    });
  }
});

test("closing an executor cancels pending approval and leaves no live MCP process", async () => fixture(async ({ make, marker, pidPath, controller }) => {
  const entered = deferred(); const approval = deferred();
  const tools = await make({ requestToolPermission: () => { entered.resolve(); return approval.promise; } });
  const execution = tools.execute("mcp__fixture__echo", { value: "closed" }, task, controller.signal);
  await entered.promise;
  const rejection = assert.rejects(execution, { name: "AbortError" });
  await tools.close(); await rejection;
  approval.resolve(true);
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
  const pid = Number.parseInt(await fs.readFile(pidPath, "utf8"), 10);
  assert.throws(() => process.kill(pid, 0));
}));

test("builtin commands await permission and trusted hooks block or report failures", async () => fixture(async ({ make, activate, hookMarker, controller }) => {
  await activate("hook:before"); await activate("hook:after");
  const entered = deferred(); const approval = deferred(); let executions = 0;
  const tools = await make({ enabledMcpServers: [],
    base: { async execute() { executions += 1; return { ok: true, output: "Builtin completed" }; } },
    requestToolPermission: () => { entered.resolve(); return approval.promise; },
  });
  try {
    const execution = tools.execute("run_command", { command: "node --version", block: true }, task, controller.signal);
    await entered.promise;
    assert.equal(executions, 0);
    await assert.rejects(fs.access(hookMarker), { code: "ENOENT" });
    approval.resolve(true);
    const beforeBlocked = await execution;
    assert.equal(beforeBlocked.ok, false); assert.match(beforeBlocked.output, /before_tool hooks blocked/); assert.equal(executions, 0);
    const afterFailed = await tools.execute("run_test", { command: "node --version", block: false }, task, controller.signal);
    assert.equal(executions, 1); assert.equal(afterFailed.ok, false); assert.match(afterFailed.output, /finished, but after_tool hooks failed/);
  } finally { await tools.close(); }
}, true));

test("untrusted hooks stay inert and revoked MCP trust prevents an approved call", async () => fixture(async ({ make, root, marker, hookMarker, extensionOptions, controller }) => {
  const entered = deferred(); const approval = deferred();
  const tools = await make({ requestToolPermission: () => { entered.resolve(); return approval.promise; } });
  try {
    const execution = tools.execute("mcp__fixture__echo", { value: "revoked" }, task, controller.signal);
    await entered.promise;
    await setExtensionState(root, "mcp:fixture", "untrust", extensionOptions);
    approval.resolve(true);
    const result = await execution;
    assert.equal(result.ok, false); assert.match(result.output, /trust or configuration changed/);
    await assert.rejects(fs.access(marker), { code: "ENOENT" });
    await assert.rejects(fs.access(hookMarker), { code: "ENOENT" });
  } finally { await tools.close(); }
}, true));

test("Queen closes dynamically connected servers on failed and cancelled coding runs", async () => {
  for (const end of ["failed", "cancelled"]) await fixture(async ({ root, pidPath, extensionOptions }) => {
    await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
    await execFileAsync("git", ["config", "user.email", "hive@example.test"], { cwd: root });
    await execFileAsync("git", ["config", "user.name", "HIVE Test"], { cwd: root });
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });
    const runtime = await createQueenSession({ repositoryPath: root, sessionId: "extension-cleanup", objective: "Fixture", mode: "auto", approvalPolicy: "changes",
      maxAgents: 1, maxRetries: 0, enabledMcpServers: ["mcp:fixture"], extensionOptions, requestToolPermission: async () => true });
    runtime.providerRouter.bindingForRole = async (role) => ({ role, providerId: "fixture" });
    runtime.providerRouter.complete = async (request) => {
      if (request.role === "planner") return { output: JSON.stringify({ summary: "Fixture plan", architecture: "One file", risks: [], acceptanceCriteria: ["Fixture"], validationCommands: [],
        tasks: [{ key: "file", role: "builder", title: "Fixture", objective: "Fixture", dependencies: [], fileScope: ["implementation.txt"], expectedOutput: "Fixture", completionCriteria: ["Fixture"], validationCommands: [] }] }) };
      if (end === "cancelled") runtime.orchestrator.cancel("Fixture cancellation");
      throw new Error("Fixture provider failure");
    };
    runtime.providerRouter.streamComplete = (request) => runtime.providerRouter.complete(request);
    const record = await runtime.orchestrator.run();
    assert.equal(record.status, end);
    const pid = Number.parseInt(await fs.readFile(pidPath, "utf8"), 10);
    assert.throws(() => process.kill(pid, 0));
  });
});
