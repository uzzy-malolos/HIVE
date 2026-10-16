import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parsePluginAgent, restrictPluginAgentTools, runPluginAgent } from "../dist/extensions/plugin-agents.js";
import { convertClaudeAgentLspComponents } from "../dist/extensions/plugin-components.js";
import { connectLsp, parseLspServer } from "../dist/extensions/lsp.js";
import { RepositoryToolService } from "../dist/coding/tools.js";
import { createLspToolAccess } from "../dist/coding/lsp-tools.js";
import { lspCommand, pluginComponentCommand } from "../dist/extensions/plugin-commands.js";
import { discoverExtensions, setExtensionState } from "../dist/extensions/catalog.js";

const agentText = `---
name: reviewer
description: >-
  Inspect a repository with a specialist
  evidence-focused workflow.
tools:
  - Read
  - Grep
disallowedTools: Bash(git push *)
model: opus
maxTurns: 5
color: blue
---
Review the supplied file and explain its observable behavior.
`;
const task = { id: "agent-specialist", sessionId: "plugin-agent-fixture", role: "builder", title: "Specialist request", objective: "Inspect assigned input", status: "working", providerId: "user-selected-fixture", model: "user-selected-model", dependencies: [], fileScope: ["answer.txt"], expectedOutput: "A checked answer", completionCriteria: ["Repository evidence inspected"], validationCommands: [], depth: 0, attempt: 1, maxAttempts: 1, createdAt: "2026-10-17T00:00:00.000Z" };
const activeAgent = (text = agentText) => ({ id: "agent:fixture.reviewer", enabled: true, trusted: true, fingerprint: "a".repeat(64), pluginId: "plugin:fixture", ...parsePluginAgent(text, "agents/reviewer.md") });
const file = (name, text) => ({ name, bytes: Buffer.from(typeof text === "string" ? text : JSON.stringify(text)), executable: false });

async function temporary(run) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-agent-lsp-"));
  try { return await run(root); }
  finally { await fs.rm(root, { recursive: true, force: true }); }
}

test("plugin agent frontmatter parses bounded block/list metadata without model or permission overrides", () => {
  const parsed = parsePluginAgent(agentText, "agents/reviewer.md");
  assert.equal(parsed.name, "reviewer");
  assert.equal(parsed.description, "Inspect a repository with a specialist evidence-focused workflow.");
  assert.deepEqual(parsed.tools, ["Read", "Grep"]);
  assert.deepEqual(parsed.disallowedTools, ["Bash(git push *)"]);
  assert.equal(parsed.model, "opus");
  assert.equal(parsed.maxTurns, 5);
  assert.ok(parsed.warnings.some((warning) => warning.includes("explicitly selected HIVE provider/model")));
  assert.equal(parsePluginAgent(agentText, "C:/plugin/agents/review/source.md", "agents/review/source.md").name, "review.reviewer");
  for (const text of [agentText.replace("maxTurns: 5", "maxTurns: 0"), agentText.replace("color: blue", "tools: Read"), agentText.replace("tools:\n  - Read\n  - Grep", "tools: Bash(git status)"), agentText.replace("color: blue", "unknownCapability: unsafe"), agentText.replace("color: blue", "color: &alias unsafe"), agentText + "x".repeat(65536)]) assert.throws(() => parsePluginAgent(text, "agent.md"));
  assert.match(parsePluginAgent(agentText.replace("color: blue", "hooks: unsafe"), "agent.md").warnings.join("\n"), /hooks is ignored for plugin agents/);
});

test("adversarial agent wildcard tools are matched within a bounded owned process", async () => {
  const script = `import {restrictPluginAgentTools} from ${JSON.stringify(new URL("../dist/extensions/plugin-agents.js", import.meta.url).href)}; const tools=restrictPluginAgentTools({tools:['mcp__'+'*a'.repeat(25)+'*z']},{toolDefinitions:[{name:'mcp__'+'a'.repeat(70),description:'untrusted tool',inputSchema:{}}],async execute(){throw Error('not called')}}); if(tools.toolDefinitions.length!==0)throw Error('incorrect wildcard match'); console.log('bounded glob passed');`;
  const result = await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script], { timeout: 3000, windowsHide: true, maxBuffer: 4096 });
  assert.match(result.stdout, /bounded glob passed/);
});

test("named specialist invokes the real agent loop, selected provider and actual repository read", async () => temporary(async (root) => {
  await fs.writeFile(path.join(root, "input.txt"), "observed specialist content");
  let turn = 0, checked = 0;
  const events = [];
  const base = new RepositoryToolService({ repositoryRoot: root, sessionId: task.sessionId, approvalPolicy: "safe", fileScope: task.fileScope });
  const result = await runPluginAgent({ agent: activeAgent(), task, cwd: root, sharedContext: "User requested a specialist", tools: base, signal: new AbortController().signal,
    revalidate: async () => { checked += 1; }, onEvent: (event) => events.push(event),
    completionClient: { async complete(request) {
      assert.equal(request.providerId, "user-selected-fixture"); assert.equal(request.model, "user-selected-model");
      assert.match(request.systemPrompt, /Review the supplied file and explain its observable behavior/);
      const contract = JSON.parse(request.systemPrompt.split("Available repository tools with their actual argument schemas:\n")[1].split("\n")[0]);
      assert.deepEqual(contract.map((entry) => entry.name), ["read_file", "search_text", "search_symbols"]);
      if (++turn === 1) return { output: JSON.stringify({ done: false, toolCalls: [{ name: "read_file", arguments: { path: "input.txt" } }, { name: "write_file", arguments: { path: "answer.txt", content: "must be denied" } }] }) };
      assert.match(request.prompt, /observed specialist content/); assert.match(request.prompt, /denied by the selected agent/);
      return { output: JSON.stringify({ done: true, summary: "Inspected the actual file" }) };
    } },
  });
  assert.equal(result.summary, "Inspected the actual file"); assert.equal(result.turns, 2); assert.equal(result.toolCalls, 2);
  assert.ok(checked >= 6); assert.ok(events.some((event) => event.type === "subagent.tool_result" && event.payload.ok));
  await assert.rejects(fs.stat(path.join(root, "answer.txt")), { code: "ENOENT" });
}));

test("agent restrictions intersect existing capabilities, preserve write scope, refresh and revoke trust", async () => temporary(async (root) => {
  const base = new RepositoryToolService({ repositoryRoot: root, sessionId: task.sessionId, approvalPolicy: "changes", fileScope: task.fileScope });
  const writer = activeAgent(agentText.replace("tools:\n  - Read\n  - Grep", "tools: [Write]"));
  const tools = restrictPluginAgentTools(writer, base);
  const denied = await tools.execute("write_file", { path: "outside-scope.txt", content: "blocked" }, task, new AbortController().signal);
  assert.equal(denied.ok, false); assert.match(denied.output, /scope/i);
  const success = await tools.execute("write_file", { path: "answer.txt", content: "actual scoped write" }, task, new AbortController().signal);
  assert.equal(success.ok, true); assert.equal(await fs.readFile(path.join(root, "answer.txt"), "utf8"), "actual scoped write");
  const safe = restrictPluginAgentTools(writer, new RepositoryToolService({ repositoryRoot: root, sessionId: task.sessionId, approvalPolicy: "safe", fileScope: task.fileScope }));
  assert.match((await safe.execute("write_file", { path: "answer.txt", content: "must remain blocked" }, task, new AbortController().signal)).output, /safe.*blocks repository writes/i);
  let called = 0;
  await assert.rejects(runPluginAgent({ agent: writer, task, cwd: root, sharedContext: "", tools: base, signal: new AbortController().signal,
    revalidate: async () => { throw new Error("Agent changed; trust it again"); }, completionClient: { async complete() { called++; return { output: '{"done":true,"summary":"not reached"}' }; } },
  }), /trust it again/);
  assert.equal(called, 0);
  const mutable = { builtinToolNames: ["read_file"], toolDefinitions: [{ name: "mcp__one__read", description: "one", inputSchema: {} }], async execute() { throw new Error("must not grant unavailable capability"); }, async refreshToolDefinitions() { this.toolDefinitions = [{ name: "mcp__two__read", description: "two", inputSchema: {} }]; } };
  const external = restrictPluginAgentTools({ tools: ["mcp__one__*", "Write"] }, mutable);
  assert.deepEqual(external.builtinToolNames, []); assert.equal(external.toolDefinitions.length, 1);
  await external.refreshToolDefinitions(new AbortController().signal); assert.equal(external.toolDefinitions.length, 0);
}));

test("Claude components import agents and default/path/inline LSP maps without execution", () => {
  const result = convertClaudeAgentLspComponents([
    file("agents/reviewer.md", agentText), file(".lsp.json", { fixture: { command: "old", extensionToLanguage: { ".js": "javascript" } } }),
    file("config/lsp.json", { fixture: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs"], env: { API_TOKEN: "${OWNER_TOKEN}", PUBLIC_MODE: "lint" }, extensionToLanguage: { ".ts": "typescript" }, startupTimeout: 1000, restartOnCrash: true } }),
  ], { lspServers: ["./config/lsp.json", { second: { command: "second", extensionToLanguage: { ".go": "go" } } }] }, {}, "C:/fixture/plugin");
  assert.deepEqual(result.agents, ["agents/reviewer.md"]);
  assert.equal(result.lspServers.fixture.command, "node"); assert.equal(result.lspServers.fixture.startupTimeoutMs, 1000);
  assert.deepEqual(result.lspServers.fixture.envRefs, { API_TOKEN: "OWNER_TOKEN" }); assert.equal(result.lspServers.fixture.env.PUBLIC_MODE, "lint");
  assert.deepEqual(result.lspServers.fixture.args, ["C:/fixture/plugin/server.mjs"]);
  assert.ok(result.warnings.some((warning) => warning.includes("explicit reconnect")));
  assert.throws(() => convertClaudeAgentLspComponents([file("agents/reviewer.md", agentText)], { agents: ["./agents"] }, {}, "."), /Markdown/);
  assert.throws(() => convertClaudeAgentLspComponents([], { lspServers: { x: { command: "server", transport: "tcp", extensionToLanguage: { ".x": "x" } } } }, {}, "."), /stdio/);
  assert.throws(() => convertClaudeAgentLspComponents([], { lspServers: "../outside.json" }, {}, "."), /traversal/);
  assert.throws(() => convertClaudeAgentLspComponents([], { lspServers: { x: { command: "server", env: { TOKEN: "plaintext" }, extensionToLanguage: { ".x": "x" } } } }, {}, "."), /envRefs/);
});

const serverScript = `
import {appendFileSync,readFileSync,existsSync} from 'node:fs';
import {pathToFileURL} from 'node:url';
const log=process.argv[2],mode=process.argv[3]??'',trigger=process.argv[4];
let buffer=Buffer.alloc(0),len,open,lastVersion=0;
const send=value=>{const body=Buffer.from(JSON.stringify({jsonrpc:'2.0',...value}));const frame=Buffer.concat([Buffer.from('Content-Length: '+body.length+'\\r\\n\\r\\n'),body]);if(mode==='fragment'){process.stdout.write(frame.subarray(0,7));process.stdout.write(frame.subarray(7,23));process.stdout.write(frame.subarray(23));}else process.stdout.write(frame);};
const diagnostics=(version=lastVersion)=>send({method:'textDocument/publishDiagnostics',params:{uri:open,version,diagnostics:[{range:{start:{line:0,character:0},end:{line:0,character:1}},message:process.env.SCOPED_TOKEN??'actual diagnostics π',severity:2}]}});
const handle=m=>{
 appendFileSync(log,JSON.stringify(m)+'\\n');
 if(!m.method)return;
 if(m.method==='initialize'){
  if(mode==='oversize'){process.stdout.write('Content-Length: 1048577\\r\\n\\r\\n');return;}
  if(mode==='bad-header'){process.stdout.write('Content-Length: 2\\r\\nContent-Length: 2\\r\\n\\r\\n{}');return;}
  send({id:m.id,result:{capabilities:{positionEncoding:'utf-16',textDocumentSync:2,hoverProvider:true,definitionProvider:true,referencesProvider:true,documentSymbolProvider:true,workspaceSymbolProvider:true,...(mode==='opaque-key'?{[process.env.SCOPED_TOKEN]:'opaque capability metadata'}:{})}}});return;
 }
 if(m.method==='textDocument/didOpen'){open=m.params.textDocument.uri;lastVersion=m.params.textDocument.version;diagnostics();return;}
 if(m.method==='textDocument/didChange'){lastVersion=m.params.textDocument.version;diagnostics(lastVersion-1);diagnostics();return;}
 if(m.method==='textDocument/didClose'){open=undefined;return;}
 if(m.method==='textDocument/hover'){
  if(m.params.position.line===99)return;
  if(mode==='server-request'){send({id:'attempted-edit',method:'workspace/applyEdit',params:{edit:{changes:{}}}});send({id:'workspace-folders',method:'workspace/workspaceFolders'});}
  send({id:m.id,result:{contents:{kind:'plaintext',value:process.env.SCOPED_TOKEN??'actual hover π'},...(mode==='opaque-key'?{[process.env.SCOPED_TOKEN]:'opaque result metadata'}:{})}});return;
 }
 if(m.method==='textDocument/definition'||m.method==='textDocument/references') {send({id:m.id,result:[{uri:mode==='outside'?pathToFileURL(process.platform==='win32'?'C:/outside-private.ts':'/outside-private.ts').href:open,range:{start:{line:0,character:0},end:{line:0,character:1}}}]});return;}
 if(m.method==='textDocument/documentSymbol'){send({id:m.id,result:[{name:'actualSymbol',kind:12,range:{start:{line:0,character:0},end:{line:0,character:2}},selectionRange:{start:{line:0,character:0},end:{line:0,character:1}}}]});return;}
 if(m.method==='workspace/symbol'){send({id:m.id,result:[{name:m.params.query,kind:12,location:{uri:open,range:{start:{line:0,character:0},end:{line:0,character:1}}}}]});return;}
 if(m.method==='shutdown'){send({id:m.id,result:null});return;}
 if(m.method==='exit')process.exit(0);
};
if(trigger){const timer=setInterval(()=>{if(open&&existsSync(trigger)){clearInterval(timer);diagnostics();}},10);timer.unref();}
process.stdin.on('data',chunk=>{buffer=Buffer.concat([buffer,chunk]);while(buffer.length){if(len===undefined){const sep=buffer.indexOf('\\r\\n\\r\\n');if(sep<0)return;len=Number(buffer.subarray(0,sep).toString().split(':')[1]);buffer=buffer.subarray(sep+4);}if(buffer.length<len)return;const value=JSON.parse(buffer.subarray(0,len).toString());buffer=buffer.subarray(len);len=undefined;handle(value);}}).on('end',()=>process.exit(0));
`;

async function lspFixture(run, mode = "", extra = {}) {
  return temporary(async (root) => {
    const script = path.join(root, "lsp-server.mjs"), log = path.join(root, "lsp-log.jsonl"), trigger = path.join(root, "trigger");
    await fs.writeFile(script, serverScript); await fs.writeFile(log, ""); await fs.writeFile(path.join(root, "input.ts"), "const π = 1;\n");
    const parsed = await parseLspServer(root, "fixture", { command: process.execPath, args: [script, log, mode, trigger], extensionToLanguage: { ".ts": "typescript" }, startupTimeoutMs: 3000, requestTimeoutMs: 1000, shutdownTimeoutMs: 500, ...extra });
    const descriptor = { ...parsed, id: "lsp:fixture", trusted: true, enabled: true, fingerprint: "b".repeat(64) };
    const readLog = async () => (await fs.readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const waitFor = async (predicate) => { const end = Date.now() + 3000; while (Date.now() < end) { const result = await predicate(); if (result) return result; await new Promise((resolve) => setTimeout(resolve, 10)); } throw new Error("LSP fixture wait timed out"); };
    await run({ root, descriptor, readLog, waitFor, trigger });
  });
}

test("real framed LSP client initializes, synchronizes UTF16 documents and returns navigation/diagnostics", async () => lspFixture(async ({ root, descriptor, readLog, waitFor }) => {
  let checked = 0;
  const connection = await connectLsp(descriptor, { workspaceRoot: root, beforeSend: async () => { checked++; } });
  try {
    const pushed = [];
    const off = connection.onDiagnostics((event) => pushed.push(event));
    const opened = await connection.openDocument("input.ts"); assert.equal(opened.languageId, "typescript");
    await waitFor(() => pushed.length); assert.equal(pushed[0].diagnostics[0].message, "actual diagnostics π");
    const hover = await connection.hover("input.ts", { line: 0, character: 1 }); assert.equal(hover.contents.value, "actual hover π");
    assert.equal((await connection.definition("input.ts", { line: 0, character: 1 }))[0].uri, pathToFileURL(path.join(root, "input.ts")).href);
    assert.equal((await connection.references("input.ts", { line: 0, character: 1 })).length, 1);
    assert.equal((await connection.documentSymbols("input.ts"))[0].name, "actualSymbol");
    assert.equal((await connection.workspaceSymbols("actualSymbol"))[0].name, "actualSymbol");
    const changed = await connection.changeDocument("input.ts", "const π = 2;\n"); assert.equal(changed.version, 2);
    await waitFor(async () => (await connection.diagnostics("input.ts"))[0]?.version === 2);
    assert.equal(pushed.filter((event) => event.version === 1).length, 1, "stale diagnostics must be discarded");
    const messages = await readLog(); assert.equal(messages[0].method, "initialize"); assert.equal(messages[0].params.rootUri, pathToFileURL(root).href);
    assert.deepEqual(messages[0].params.initializationOptions, { lint: true });
    assert.deepEqual(messages.find((entry) => entry.method === "workspace/didChangeConfiguration").params.settings, { fixtureLint: true });
    const change = messages.find((entry) => entry.method === "textDocument/didChange"); assert.equal(change.params.contentChanges[0].range.end.line, 1);
    assert.equal(change.params.contentChanges[0].text, "const π = 2;\n");
    assert.deepEqual((await Promise.all([connection.changeDocument("input.ts", "const π = 3;\n"), connection.changeDocument("input.ts", "const π = 4;\n")])).map((event) => event.version), [3, 4]);
    await waitFor(async () => (await connection.diagnostics("input.ts"))[0]?.version === 4);
    assert.deepEqual((await readLog()).filter((entry) => entry.method === "textDocument/didChange").map((entry) => entry.params.textDocument.version), [2, 3, 4]);
    await fs.writeFile(path.join(root, "input.ts"), "const π = 5;\r\n");
    assert.equal((await connection.syncDocument("input.ts")).version, 5);
    await waitFor(async () => (await connection.diagnostics("input.ts"))[0]?.version === 5);
    assert.ok(checked > 20);
    await connection.closeDocument("input.ts"); assert.deepEqual(await connection.diagnostics(), []); off();
  } finally { await connection.close(); }
  const messages = await readLog(); assert.ok(messages.some((entry) => entry.method === "shutdown")); assert.ok(messages.some((entry) => entry.method === "exit"));
}, "fragment", { initializationOptions: { lint: true }, settings: { fixtureLint: true } }));

test("LSP cancellation and timeout send real cancelRequest and leave the connection usable", async () => lspFixture(async ({ root, descriptor, readLog, waitFor }) => {
  const connection = await connectLsp(descriptor, { workspaceRoot: root, beforeSend: async () => {} });
  try {
    const controller = new AbortController();
    const waiting = connection.hover("input.ts", { line: 99, character: 0 }, { signal: controller.signal });
    await waitFor(async () => (await readLog()).some((entry) => entry.method === "textDocument/hover")); controller.abort();
    await assert.rejects(waiting, { name: "AbortError" });
    await assert.rejects(connection.hover("input.ts", { line: 99, character: 0 }, { timeoutMs: 100 }), /timed out/);
    await waitFor(async () => (await readLog()).filter((entry) => entry.method === "$/cancelRequest").length === 2);
    assert.equal((await connection.hover("input.ts", { line: 0, character: 0 })).contents.value, "actual hover π");
  } finally { await connection.close(); }
}));

test("cancelled LSP change rolls back the local cache so a later disk sync reaches the server", async () => lspFixture(async ({ root, descriptor, readLog }) => {
  let cancelChange = false, inspected = 0;
  const controller = new AbortController();
  const connection = await connectLsp(descriptor, { workspaceRoot: root, beforeSend: async () => {}, canReadFile: async () => { if (cancelChange && ++inspected === 2) controller.abort(); } });
  try {
    await connection.openDocument("input.ts");
    await fs.writeFile(path.join(root, "input.ts"), "const π = 42;\n");
    cancelChange = true;
    await assert.rejects(connection.changeDocument("input.ts", "const π = 42;\n", { signal: controller.signal }), { name: "AbortError" });
    cancelChange = false;
    assert.equal((await connection.syncDocument("input.ts")).version, 2);
    await connection.hover("input.ts", { line: 0, character: 0 });
    const changes = (await readLog()).filter((entry) => entry.method === "textDocument/didChange");
    assert.equal(changes.length, 1); assert.equal(changes[0].params.textDocument.version, 2); assert.equal(changes[0].params.contentChanges[0].text, "const π = 42;\n");
  } finally { await connection.close(); }
}));

test("LSP jails document reads, rejects server edits and filters locations outside the workspace", async () => {
  await lspFixture(async ({ root, descriptor, readLog, waitFor }) => {
    const connection = await connectLsp(descriptor, { workspaceRoot: root, beforeSend: async () => {} });
    try {
      await fs.writeFile(path.join(root, ".env.ts"), "private"); await assert.rejects(connection.openDocument(".env.ts"), /non-private/);
      await fs.link(path.join(root, "input.ts"), path.join(root, "hardlinked.ts"));
      try { await assert.rejects(connection.openDocument("hardlinked.ts"), /single-link/); }
      finally { await fs.unlink(path.join(root, "hardlinked.ts")); }
      await assert.rejects(connection.openDocument("../outside.ts"));
      await assert.rejects(connection.hover("input.ts", { line: -1, character: 0 }), /zero-based/);
      await connection.hover("input.ts", { line: 0, character: 0 });
      const rejected = await waitFor(async () => (await readLog()).find((entry) => entry.id === "attempted-edit" && entry.error));
      assert.equal(rejected.error.code, -32601);
      const folders = await waitFor(async () => (await readLog()).find((entry) => entry.id === "workspace-folders" && entry.result));
      assert.deepEqual(folders.result, [{ uri: pathToFileURL(root).href, name: path.basename(root) }]);
    } finally { await connection.close(); }
  }, "server-request");
  await lspFixture(async ({ root, descriptor }) => {
    const connection = await connectLsp(descriptor, { workspaceRoot: root, beforeSend: async () => {} });
    try { await assert.rejects(connection.definition("input.ts", { line: 0, character: 0 }), /out-of-workspace/); }
    finally { await connection.close(); }
  }, "outside");
});

test("LSP trust is checked before spawn, every operation and notification delivery; explicit credentials redact", async () => {
  const previousToken = process.env.HIVE_LSP_FIXTURE_TOKEN;
  process.env.HIVE_LSP_FIXTURE_TOKEN = "opaque-owner-test-value-239876";
  try {
    await lspFixture(async ({ root, descriptor, readLog, waitFor, trigger }) => {
      let trusted = true;
      await assert.rejects(connectLsp(descriptor, { workspaceRoot: root, beforeSend: async () => { throw new Error("trust revoked before spawn"); } }), /trust revoked/);
      assert.deepEqual(await readLog(), []);
      const connection = await connectLsp(descriptor, { workspaceRoot: root, beforeSend: async () => { if (!trusted) throw new Error("trust revoked"); } });
      try {
        const pushed = []; connection.onDiagnostics((event) => pushed.push(event));
        await connection.openDocument("input.ts"); await waitFor(() => pushed.length);
        assert.equal(pushed[0].diagnostics[0].message, "[REDACTED]");
        assert.equal((await connection.hover("input.ts", { line: 0, character: 0 })).contents.value, "[REDACTED]");
        trusted = false; await fs.writeFile(trigger, "notify");
        await waitFor(async () => { try { await connection.diagnostics(); return false; } catch { return true; } });
        await new Promise((resolve) => setTimeout(resolve, 75)); assert.equal(pushed.length, 1);
        await assert.rejects(connection.hover("input.ts", { line: 0, character: 0 }), /trust revoked|closed/);
      } finally { await connection.close(); }
    }, "", { envRefs: { SCOPED_TOKEN: "HIVE_LSP_FIXTURE_TOKEN" } });
    await lspFixture(async ({ root, descriptor }) => {
      const connection = await connectLsp(descriptor, { workspaceRoot: root, beforeSend: async () => {} });
      try {
        assert.ok(Object.hasOwn(connection.capabilities, "[REDACTED]"));
        const result = await connection.hover("input.ts", { line: 0, character: 0 });
        assert.ok(Object.hasOwn(result, "[REDACTED]"));
        assert.ok(!JSON.stringify({ capabilities: connection.capabilities, result }).includes(process.env.HIVE_LSP_FIXTURE_TOKEN));
      } finally { await connection.close(); }
    }, "opaque-key", { envRefs: { SCOPED_TOKEN: "HIVE_LSP_FIXTURE_TOKEN" } });
  } finally { if (previousToken === undefined) delete process.env.HIVE_LSP_FIXTURE_TOKEN; else process.env.HIVE_LSP_FIXTURE_TOKEN = previousToken; }
});

test("malformed or oversized LSP frames fail boundedly and do not hang shutdown", async () => {
  for (const mode of ["oversize", "bad-header"]) await lspFixture(async ({ root, descriptor }) => {
    await assert.rejects(connectLsp(descriptor, { workspaceRoot: root, beforeSend: async () => {} }), mode === "oversize" ? /exceeds 1 MiB/ : /one valid Content-Length/);
  }, mode);
});

test("LSP public commands and lazy agent tools use actual trusted catalog connections and disk refresh", async () => lspFixture(async ({ root, descriptor, readLog }) => {
  await fs.mkdir(path.join(root, ".hive"));
  const config = { version: 1, lspServers: { fixture: { command: descriptor.process.command, args: descriptor.process.args, extensionToLanguage: { ".ts": "typescript" } } } };
  await fs.writeFile(path.join(root, ".hive", "extensions.json"), JSON.stringify(config));
  const extensionOptions = { trustStateDir: path.join(root, "trust-state") };
  assert.match((await lspCommand(root, "list", extensionOptions)).join("\n"), /lsp:fixture.*untrusted/);
  assert.deepEqual(await readLog(), [], "discovery and list must not start a server");
  await lspCommand(root, "trust fixture", extensionOptions); await lspCommand(root, "enable fixture", extensionOptions);
  assert.match((await lspCommand(root, 'hover fixture "input.ts" 0 0', extensionOptions)).join("\n"), /actual hover π/);
  await fs.writeFile(path.join(root, "source with space.ts"), "const actual = true;\n");
  assert.match((await lspCommand(root, ["hover", "fixture", "source with space.ts", "0", "0"], extensionOptions)).join("\n"), /actual hover π/);
  assert.match((await lspCommand(root, "diagnostics fixture input.ts", extensionOptions)).join("\n"), /actual diagnostics π/);
  const before = (await readLog()).length;
  const access = await createLspToolAccess({ extensionRoot: root, workspaceRoot: root, serverIds: ["fixture"], extensionOptions, signal: new AbortController().signal });
  assert.equal((await readLog()).length, before, "tool preparation must remain inert");
  assert.equal(access.definitions[0].name, "lsp__fixture__query");
  try {
    const first = await access.execute("lsp__fixture__query", { operation: "hover", path: "input.ts", line: 0, character: 0 }, new AbortController().signal);
    assert.equal(first.ok, true); assert.match(first.output, /actual hover π/);
    await fs.writeFile(path.join(root, "input.ts"), "const π = 9;\n");
    assert.equal((await access.execute("lsp__fixture__query", { operation: "document_symbols", path: "input.ts" }, new AbortController().signal)).ok, true);
    assert.ok((await readLog()).some((entry) => entry.method === "textDocument/didChange" && entry.params.contentChanges[0].text === "const π = 9;\n"));
    await setExtensionState(root, "lsp:fixture", "untrust", extensionOptions);
    const revoked = await access.execute("lsp__fixture__query", { operation: "hover", path: "input.ts", line: 0, character: 0 }, new AbortController().signal);
    assert.equal(revoked.ok, false); assert.match(revoked.output, /untrusted/);
  } finally { await access.close(); }
}));

test("plugin agents are inspected without execution and explicit run dispatch preserves namespaced identity", async () => temporary(async (root) => {
  await fs.mkdir(path.join(root, ".hive")); await fs.mkdir(path.join(root, "plugin", "agents", "review"), { recursive: true });
  await fs.writeFile(path.join(root, "plugin", "agents", "review", "source.md"), agentText);
  await fs.writeFile(path.join(root, "plugin", "hive.plugin.json"), JSON.stringify({ version: 1, name: "fixture", agents: ["agents/review/source.md"] }));
  await fs.writeFile(path.join(root, ".hive", "extensions.json"), JSON.stringify({ version: 1, plugins: { fixture: { path: "plugin", enabled: false } } }));
  const options = { trustStateDir: path.join(root, "trust-state") };
  assert.match((await pluginComponentCommand(root, "agents", options)).join("\n"), /agent:fixture.review.reviewer.*untrusted/);
  assert.match((await pluginComponentCommand(root, "agent fixture.review.reviewer", options)).join("\n"), /Review the supplied file/);
  let called;
  const runOptions = { ...options, runAgent: async (id, objective) => { called = { id, objective }; return "actual runtime callback"; } };
  await assert.rejects(pluginComponentCommand(root, 'run-agent fixture.review.reviewer "inspect input"', runOptions), /trusted and enabled/);
  assert.equal(called, undefined);
  await setExtensionState(root, "plugin:fixture", "trust", options); await setExtensionState(root, "plugin:fixture", "enable", options);
  assert.deepEqual(await pluginComponentCommand(root, 'run-agent fixture.review.reviewer "inspect input"', runOptions), ["actual runtime callback"]);
  assert.deepEqual(called, { id: "agent:fixture.review.reviewer", objective: "inspect input" });
  assert.equal((await discoverExtensions(root, options)).diagnostics.length, 0);
}));
