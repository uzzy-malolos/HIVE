import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { connectMcp, discoverExtensions, extensionCommand, loadSkill, runHooks, setExtensionState } from "../dist/extensions/index.js";

async function fixture(run) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hive-extensions-"));
  const root = path.join(temporary, "workspace"); const trustStateDir = path.join(temporary, "trust");
  await fs.mkdir(path.join(root, ".hive"), { recursive: true });
  const options = { trustStateDir };
  const write = async (file, value) => { const destination = path.join(root, file); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, value); return destination; };
  const config = (value) => write(".hive/extensions.json", JSON.stringify({ version: 1, ...value }));
  const activate = async (id) => { await setExtensionState(root, id, "trust", options); await setExtensionState(root, id, "enable", options); };
  try { await run({ root, options, write, config, activate, temporary }); }
  finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

const processServer = `
import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
if (process.argv[2]) writeFileSync(process.argv[2], String(process.pid));
const send = (id, result) => process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize') send(m.id,{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
 if(m.method==='tools/list') send(m.id,m.params.cursor ? {tools:[{name:'second',inputSchema:{type:'object'}}]} : {tools:[{name:'echo',description:'Echo fixture',inputSchema:{type:'object',properties:{value:{type:'string'}}}}],nextCursor:'next'});
 if(m.method==='tools/call' && m.params.name==='echo') send(m.id,{content:[{type:'text',text:m.params.arguments.value??''}],structuredContent:{received:true}});
 if(m.method==='tools/call' && m.params.name==='env') send(m.id,{content:[{type:'text',text:JSON.stringify({mapped:process.env.HIVE_EXPLICIT,unrelated:process.env.HIVE_NOT_EXPLICIT})}]});
 if(m.method==='tools/call' && m.params.name==='flood') process.stdout.write('x'.repeat(1024*1024+1));
 if(m.method==='tools/call' && m.params.name==='fail') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32000,message:'fixture rejected'}})+'\\n');
 if(m.method==='tools/call' && m.params.name==='wait' && process.argv[4]) writeFileSync(process.argv[4],String(m.id));
 if(m.method==='notifications/cancelled' && process.argv[3]) writeFileSync(process.argv[3],String(m.params.requestId));
}).on('close',()=>process.exit(0));
`;

test("discovery is inert and a cloned config cannot grant trust or execution", async () => fixture(async ({ root, options, write, config }) => {
  const marker = path.join(root, "started.txt");
  const server = await write("server.mjs", processServer);
  await config({ mcpServers: { fixture: { transport: "stdio", command: process.execPath, args: [server, marker], enabled: true } } });
  const catalog = await discoverExtensions(root, options);
  assert.equal(catalog.servers.length, 1); assert.equal(catalog.servers[0].trusted, false);
  assert.equal(catalog.servers[0].enabled, true);
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
  await assert.rejects(connectMcp(root, "fixture", options), /untrusted/);
  await assert.rejects(setExtensionState(root, "mcp:fixture", "enable", options), /Trust/);
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
}));

test("stdio MCP negotiates, paginates tools, calls real process and closes deterministically", async () => fixture(async ({ root, options, write, config, activate }) => {
  const marker = path.join(root, "started.txt");
  const server = await write("server.mjs", processServer);
  await config({ mcpServers: { fixture: { transport: "stdio", command: process.execPath, args: [server, marker] } } });
  await activate("mcp:fixture");
  const connection = await connectMcp(root, "fixture", options);
  const pid = Number(await fs.readFile(marker, "utf8"));
  assert.equal(connection.protocolVersion, "2025-11-25");
  assert.deepEqual((await connection.listTools()).map((entry) => entry.name), ["echo", "second"]);
  assert.deepEqual(await connection.callTool("echo", { value: "Real π result" }), { content: [{ type: "text", text: "Real π result" }], structuredContent: { received: true } });
  await assert.rejects(connection.callTool("fail", {}), /MCP error -32000: fixture rejected/);
  await connection.close(); await connection.close();
  assert.throws(() => process.kill(pid, 0));
  await assert.rejects(connection.listTools(), /closed/);
}));

test("stdio cancellation sends cancellation and leaves subsequent tool calls usable", async () => fixture(async ({ root, options, write, config, activate }) => {
  const marker = path.join(root, "started.txt"); const cancelled = path.join(root, "cancelled.txt"); const requested = path.join(root, "requested.txt");
  const server = await write("server.mjs", processServer);
  await config({ mcpServers: { fixture: { transport: "stdio", command: process.execPath, args: [server, marker, cancelled, requested] } } });
  await activate("mcp:fixture"); const connection = await connectMcp(root, "fixture", options);
  try {
    const abort = new AbortController();
    const pending = connection.callTool("wait", {}, { signal: abort.signal });
    const deadline = Date.now() + 3000;
    while (true) {
      try { await fs.access(requested); break; }
      catch (error) { if (error.code !== "ENOENT" || Date.now() >= deadline) throw error; }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    abort.abort(); await assert.rejects(pending, { name: "AbortError" });
    await connection.callTool("echo", { value: "Still alive" });
    assert.match(await fs.readFile(cancelled, "utf8"), /^\d+$/);
    await assert.rejects(connection.callTool("wait", {}, { timeoutMs: 100 }), /timed out/);
    assert.equal((await connection.callTool("echo", { value: "After timeout" })).content[0].text, "After timeout");
  } finally { await connection.close(); }
}));

test("unbounded or malformed stdio output rejects pending requests and terminates", async () => fixture(async ({ root, options, write, config, activate }) => {
  const server = await write("server.mjs", processServer);
  await config({ mcpServers: { fixture: { transport: "stdio", command: process.execPath, args: [server] } } });
  await activate("mcp:fixture"); const connection = await connectMcp(root, "fixture", options);
  await assert.rejects(connection.callTool("flood", {}), /message size limit/);
  await connection.close();
  const invalid = await write("invalid.mjs", "process.stdout.write('not-json\\n');setInterval(()=>{},1000);");
  await config({ mcpServers: { invalid: { transport: "stdio", command: process.execPath, args: [invalid] } } });
  await activate("mcp:invalid");
  await assert.rejects(connectMcp(root, "invalid", options), /Invalid MCP JSON-RPC response/);
}));

test("process environments expose only explicit references and infrastructure variables", async () => fixture(async ({ root, options, write, config, activate }) => {
  const previousExplicit = process.env.HIVE_EXPLICIT_TEST; const previousUnrelated = process.env.HIVE_NOT_EXPLICIT;
  process.env.HIVE_EXPLICIT_TEST = "explicit-visible-value"; process.env.HIVE_NOT_EXPLICIT = "must-not-leak";
  const server = await write("server.mjs", processServer);
  await config({ mcpServers: { fixture: { transport: "stdio", command: process.execPath, args: [server], envRefs: { HIVE_EXPLICIT: "HIVE_EXPLICIT_TEST" } } } });
  await activate("mcp:fixture");
  try {
    const connection = await connectMcp(root, "fixture", options);
    try { assert.equal((await connection.callTool("env", {})).content[0].text, '{"mapped":"[REDACTED]"}'); }
    finally { await connection.close(); }
  } finally {
    if (previousExplicit === undefined) delete process.env.HIVE_EXPLICIT_TEST; else process.env.HIVE_EXPLICIT_TEST = previousExplicit;
    if (previousUnrelated === undefined) delete process.env.HIVE_NOT_EXPLICIT; else process.env.HIVE_NOT_EXPLICIT = previousUnrelated;
  }
}));

test("opaque explicit credentials are scrubbed from MCP errors, initialization failures and all tool metadata", async () => fixture(async ({ root, options, write, config, activate }) => {
  const previous = process.env.HIVE_OPAQUE_TEST;
  const secret = "opaque-credential-without-known-prefix-".repeat(40); process.env.HIVE_OPAQUE_TEST = secret;
  const server = await write("opaque.mjs", `
    import readline from 'node:readline';
    const secret=process.env.SCOPED_CREDENTIAL;
    const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
    const fail=(id)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,error:{code:-32001,message:'Rejected '+secret}})+'\\n');
    readline.createInterface({input:process.stdin}).on('line',line=>{
      const m=JSON.parse(line);
      if(m.method==='initialize') {
        if(process.argv[2]==='init-error') return fail(m.id);
        return send(m.id,{protocolVersion:process.argv[2]==='invalid-version'?secret:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
      }
      if(m.method==='tools/list') {
        if(process.argv[2]==='list-error') return fail(m.id);
        return send(m.id,{tools:[{name:'opaque',description:'Description '+secret,inputSchema:{type:'object',properties:{value:{type:'string',default:secret}}}}]});
      }
      if(m.method==='tools/call') {process.stderr.write(secret);fail(m.id);}
    }).on('close',()=>process.exit(0));
  `);
  const rejectsRedacted = (promise) => assert.rejects(promise, (error) => {
    assert.ok(error instanceof Error); assert.doesNotMatch(error.message, /opaque-credential-without-known-prefix/);
    assert.doesNotMatch(error.stack, /opaque-credential-without-known-prefix/); assert.match(error.message, /\[REDACTED\]/); return true;
  });
  try {
    for (const mode of ["success", "init-error", "invalid-version", "list-error"]) {
      await config({ mcpServers: { fixture: { transport: "stdio", command: process.execPath, args: [server, mode], envRefs: { SCOPED_CREDENTIAL: "HIVE_OPAQUE_TEST" } } } });
      await activate("mcp:fixture");
      if (["init-error", "invalid-version"].includes(mode)) { await rejectsRedacted(connectMcp(root, "fixture", options)); continue; }
      const connection = await connectMcp(root, "fixture", options);
      try {
        if (mode === "list-error") { await rejectsRedacted(connection.listTools()); continue; }
        const tools = await connection.listTools(); assert.doesNotMatch(JSON.stringify(tools), /opaque-credential-without-known-prefix/);
        assert.equal(tools[0].description, "Description [REDACTED]");
        assert.equal(tools[0].inputSchema.properties.value.default, "[REDACTED]");
        await rejectsRedacted(connection.callTool("opaque", {}));
      } finally { await connection.close(); }
    }
  } finally { if (previous === undefined) delete process.env.HIVE_OPAQUE_TEST; else process.env.HIVE_OPAQUE_TEST = previous; }
}));

test("changed configuration revokes trust and disable/untrust are enforced", async () => fixture(async ({ root, options, write, config, activate }) => {
  const server = await write("server.mjs", processServer);
  const entry = { transport: "stdio", command: process.execPath, args: [server] };
  await config({ mcpServers: { fixture: entry } }); await activate("mcp:fixture");
  await setExtensionState(root, "mcp:fixture", "disable", options);
  await assert.rejects(connectMcp(root, "fixture", options), /disabled/);
  await setExtensionState(root, "mcp:fixture", "enable", options);
  await config({ mcpServers: { fixture: { ...entry, timeoutMs: 1000 } } });
  assert.equal((await discoverExtensions(root, options)).servers[0].trusted, false);
  await activate("mcp:fixture"); await setExtensionState(root, "mcp:fixture", "untrust", options);
  assert.equal((await discoverExtensions(root, options)).servers[0].trusted, false);
}));

test("invalid versions, secrets, URL credentials, insecure remote HTTP and escaped cwd fail closed", async () => fixture(async ({ root, options, config }) => {
  const cases = [
    { version: 2 },
    { mcpServers: { bad: { transport: "http", url: "http://example.com/mcp" } } },
    { mcpServers: { bad: { transport: "http", url: "https://user:password@example.com/mcp" } } },
    { mcpServers: { bad: { transport: "http", url: "https://example.com/mcp?token=abc" } } },
    { mcpServers: { bad: { transport: "stdio", command: "node", cwd: ".." } } },
    { mcpServers: { bad: { transport: "stdio", command: "node", env: { KEY: "secret" } } } },
    { mcpServers: { bad: { transport: "stdio", command: "node", args: ["--token", "plaintext"] } } },
    { hooks: { bad: { event: "anything", command: "node" } } },
  ];
  for (const input of cases) {
    await config(input); const catalog = await discoverExtensions(root, options);
    assert.ok(catalog.diagnostics.length, JSON.stringify(input)); assert.equal(catalog.servers.length, 0); assert.equal(catalog.hooks.length, 0);
  }
}));

test("missing required plugin directories, manifests, declared skills and configured skill roots invalidate partial catalogs", async () => fixture(async ({ root, options, write, config, activate }) => {
  const server = await write("server.mjs", processServer);
  const mcpServers = { fixture: { transport: "stdio", command: process.execPath, args: [server], enabled: true } };
  await config({ mcpServers }); await activate("mcp:fixture");
  await fs.mkdir(path.join(root, "plugins", "missing-manifest"), { recursive: true });
  await write("plugins/missing-skill/hive.plugin.json", JSON.stringify({ version: 1, name: "missing-skill", skills: ["skills/lost/SKILL.md"] }));
  const cases = [
    { plugins: { missing: { path: "plugins/missing" } } },
    { plugins: { "missing-manifest": { path: "plugins/missing-manifest" } } },
    { plugins: { "missing-skill": { path: "plugins/missing-skill" } } },
    { skillDirectories: ["missing-skills"] },
  ];
  for (const extra of cases) {
    await config({ mcpServers, ...extra }); const catalog = await discoverExtensions(root, options);
    assert.ok(catalog.diagnostics.length, JSON.stringify(extra));
    assert.equal(catalog.servers.length, 0); assert.equal(catalog.plugins.length, 0); assert.equal(catalog.hooks.length, 0); assert.equal(catalog.skills.length, 0);
    await assert.rejects(connectMcp(root, "fixture", options), /Unknown MCP server/);
  }
  await fs.rm(path.join(root, ".hive", "extensions.json"));
  assert.deepEqual((await discoverExtensions(root, options)).diagnostics, []);
}));

test("skills are discovered from bounded conventional directories and need content-bound trust", async () => fixture(async ({ root, options, write, activate }) => {
  await write(".hive/skills/local/SKILL.md", "---\nname: local\ndescription: Local fixture\n---\nUse this skill.\n");
  await write("skills/wrapper/skills/wrapped/SKILL.md", "---\nname: wrapped\n---\nWrapped skill.\n");
  await write("docs/unrelated/SKILL.md", "---\nname: do-not-discover\n---\n");
  assert.deepEqual((await discoverExtensions(root, options)).skills.map((entry) => entry.id).sort(), ["skill:local", "skill:wrapped"]);
  await assert.rejects(loadSkill(root, "local", options), /untrusted/);
  await activate("skill:local"); assert.match((await loadSkill(root, "local", options)).text, /Use this skill/);
  await write(".hive/skills/local/SKILL.md", "---\nname: local\n---\nChanged instructions.\n");
  await assert.rejects(loadSkill(root, "local", options), /untrusted/);
  await write(".hive/skills/large/SKILL.md", "a".repeat(65537));
  assert.match((await discoverExtensions(root, options)).diagnostics.join("\n"), /exceeds 65536/);
}));

test("symlinked skill directories and plugin contribution traversal cannot escape workspace", async () => fixture(async ({ root, options, write, config, temporary }) => {
  const outside = path.join(temporary, "outside"); await fs.mkdir(outside); await fs.writeFile(path.join(outside, "SKILL.md"), "---\nname: outside\n---\n");
  await fs.mkdir(path.join(root, ".hive", "skills"));
  await fs.symlink(outside, path.join(root, ".hive", "skills", "outside"), process.platform === "win32" ? "junction" : "dir");
  assert.match((await discoverExtensions(root, options)).diagnostics.join("\n"), /inside workspace/);
  await write("plugins/fixture/hive.plugin.json", JSON.stringify({ version: 1, name: "fixture", skills: ["../../../outside/SKILL.md"] }));
  await config({ plugins: { fixture: { path: "plugins/fixture", enabled: true } } });
  const catalog = await discoverExtensions(root, options);
  assert.equal(catalog.plugins.length, 0); assert.equal(catalog.skills.length, 0);
  assert.match(catalog.diagnostics.join("\n"), /inside workspace/);
}));

test("plugins contribute real scoped skills/MCP/hooks and whole-bundle enable/disable is enforced", async () => fixture(async ({ root, options, write, config, activate }) => {
  await write("plugins/fixture/skills/skill/SKILL.md", "---\nname: bundled\n---\nBundled skill.\n");
  await write("plugins/fixture/server.mjs", processServer);
  await write("plugins/fixture/hook.mjs", "process.stdout.write('plugin-hook');");
  await write("plugins/fixture/hive.plugin.json", JSON.stringify({ version: 1, name: "fixture", skills: ["skills/skill/SKILL.md"], mcpServers: { local: { transport: "stdio", command: process.execPath, args: ["server.mjs"] } }, hooks: { report: { event: "session_end", command: process.execPath, args: ["hook.mjs"] } } }));
  await config({ plugins: { fixture: { path: "plugins/fixture" } } });
  const initial = await discoverExtensions(root, options);
  assert.equal(initial.servers[0].id, "mcp:fixture.local"); assert.equal(initial.skills[0].id, "skill:fixture.bundled");
  await activate("plugin:fixture");
  assert.match((await loadSkill(root, "fixture.bundled", options)).text, /Bundled skill/);
  const connection = await connectMcp(root, "mcp:fixture.local", options); await connection.close();
  assert.equal((await runHooks(root, "session_end", {}, options))[0].output, "plugin-hook");
  await setExtensionState(root, "plugin:fixture", "disable", options);
  await assert.rejects(loadSkill(root, "fixture.bundled", options), /disabled/);
  assert.deepEqual(await runHooks(root, "session_end", {}, options), []);
}));

test("trusted hooks receive bounded JSON, expose nonzero exit, timeout and output-limit failures", async () => fixture(async ({ root, options, write, config, activate }) => {
  await write("echo-hook.mjs", "let text='';process.stdin.on('data',v=>text+=v).on('end',()=>process.stdout.write(JSON.parse(text).input.message));");
  await write("fail-hook.mjs", "process.stderr.write('visible failure');process.exitCode=7;");
  await write("wait-hook.mjs", "setInterval(()=>{},1000);");
  await write("large-hook.mjs", "process.stdout.write('x'.repeat(65537));");
  const hooks = Object.fromEntries(["echo", "fail", "wait", "large"].map((name) => [name, { event: "prompt_submit", command: process.execPath, args: [`${name}-hook.mjs`], timeoutMs: name === "wait" ? 100 : 1000 }]));
  await config({ hooks });
  assert.deepEqual(await runHooks(root, "prompt_submit", { message: "Untrusted" }, options), []);
  for (const name of Object.keys(hooks)) await activate(`hook:${name}`);
  const results = await runHooks(root, "prompt_submit", { message: "real hook input" }, options);
  assert.equal(results[0].output, "real hook input"); assert.equal(results[0].ok, true);
  assert.equal(results[1].exitCode, 7); assert.equal(results[1].output, "visible failure");
  assert.match(results[2].output, /timed out/); assert.match(results[3].output, /output exceeded/);
  await assert.rejects(runHooks(root, "prompt_submit", "x".repeat(65536), options), /input exceeded/);
}));

async function withHttp(run) {
  const requests = []; const sockets = new Set(); const waiters = [];
  const waitForRequest = (predicate) => {
    const existing = requests.find(predicate); if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => waiters.push({ predicate, resolve }));
  };
  const server = http.createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const message = body ? JSON.parse(body) : undefined; const entry = { method: request.method, headers: request.headers, url: request.url, message }; requests.push(entry);
    for (const waiter of [...waiters]) if (waiter.predicate(entry)) { waiters.splice(waiters.indexOf(waiter), 1); waiter.resolve(entry); }
    if (request.method === "DELETE") { response.writeHead(204); response.end(); return; }
    if (message.method === "initialize" && request.url === "/init-error") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Rejected " + request.headers.authorization?.slice(7) } })); return; }
    if (message.method === "initialize") { response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "fixture-session" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "http-fixture", version: "1" } } })); return; }
    if (message.id === "held-ping" && message.method === undefined) return;
    if (message.id === undefined || message.method === undefined) { response.writeHead(202); response.end(); return; }
    if (message.method === "tools/list" && request.url.startsWith("/slow-")) { response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders(); return; }
    if (message.method === "tools/list") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "echo", description: request.headers.authorization ? "Authorized " + request.headers.authorization.slice(7) : "Echo", inputSchema: { type: "object" } }] } })); return; }
    if (message.method !== "tools/call") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } })); return; }
    if (message.params.name === "bearererror") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32000, message: "Rejected " + request.headers.authorization?.slice(7) } })); return; }
    if (message.params.name === "nested_ping") { response.writeHead(200, { "content-type": "text/event-stream" }); response.write('data: ' + JSON.stringify({ jsonrpc: "2.0", id: "held-ping", method: "ping" }) + '\n\n'); return; }
    if (message.params.name === "wait") { response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders(); return; }
    if (message.params.name === "wrong_id") { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: 99999, result: { content: [] } })); return; }
    if (message.params.name === "large") { response.writeHead(200, { "content-type": "application/json" }); response.end('"' + 'x'.repeat(1024 * 1024 + 1) + '"'); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write('id: prime\r\ndata:\r\n\r\n');
    response.write('event: message\r\ndata: ' + JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } }) + '\r\n\r\n');
    response.write('data: ' + JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: message.params.arguments.value ?? "HTTP result" }] } }) + '\r\n\r\n');
    response.end();
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${server.address().port}/mcp`;
  try { await run({ url, requests, waitForRequest }); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); }
}

test("Streamable HTTP negotiates JSON, consumes POST SSE, propagates sessions/version and deletes session", async () => withHttp(async ({ url, requests }) => fixture(async ({ root, options, config, activate }) => {
  await config({ mcpServers: { fixture: { transport: "http", url } } }); await activate("mcp:fixture");
  const connection = await connectMcp(root, "fixture", options);
  assert.equal((await connection.listTools())[0].name, "echo");
  assert.equal((await connection.callTool("echo", { value: "HTTP π" })).content[0].text, "HTTP π");
  await connection.close();
  assert.equal(requests.at(-1).method, "DELETE");
  const probe = requests.find((request) => request.message?.method === "server/discover");
  assert.equal(probe, requests[0]); assert.equal(probe.headers["mcp-protocol-version"], "2026-07-28"); assert.equal(probe.headers["mcp-method"], "server/discover"); assert.equal(probe.headers["mcp-session-id"], undefined);
  assert.deepEqual(probe.message.params._meta["io.modelcontextprotocol/clientCapabilities"], {});
  const initialization = requests.find((request) => request.message?.method === "initialize");
  assert.equal(initialization, requests[1]); assert.equal(initialization.headers["mcp-protocol-version"], "2025-11-25"); assert.equal(initialization.headers["mcp-session-id"], undefined);
  for (const request of requests.filter((request) => request !== probe && request !== initialization)) { assert.equal(request.headers["mcp-session-id"], "fixture-session"); assert.equal(request.headers["mcp-protocol-version"], "2025-06-18"); }
  assert.equal(requests.filter((request) => request.message?.method === "tools/call").length, 1);
  assert.equal(requests.some((request) => request.headers.cookie), false);
  assert.equal(requests[0].headers.accept, "application/json, text/event-stream");
}))); 

test("HTTP cancellation, size limits and response correlation fail boundedly without replaying tools", async () => withHttp(async ({ url, requests }) => fixture(async ({ root, options, config, activate }) => {
  await config({ mcpServers: { fixture: { transport: "http", url, timeoutMs: 1000 } } }); await activate("mcp:fixture");
  const connection = await connectMcp(root, "fixture", options);
  try {
    await assert.rejects(connection.callTool("wrong_id", {}), /id does not match/);
    await assert.rejects(connection.callTool("large", {}), /message size limit/);
    await assert.rejects(connection.callTool("wait", {}, { timeoutMs: 100 }), /timed out/);
    assert.equal((await connection.callTool("echo", {})).content[0].text, "HTTP result");
    assert.equal(requests.filter((entry) => entry.message?.params?.name === "wait").length, 1);
    assert.ok(requests.some((entry) => entry.message?.method === "notifications/cancelled"));
  } finally { await connection.close(); }
}))); 

test("HTTP bearer values are scrubbed from errors, initialization diagnostics and descriptions", async () => withHttp(async ({ url }) => fixture(async ({ root, options, config, activate }) => {
  const previous = process.env.HIVE_OPAQUE_BEARER_TEST; const secret = "opaque-http-credential-without-pattern"; process.env.HIVE_OPAQUE_BEARER_TEST = secret;
  const rejectsRedacted = (promise) => assert.rejects(promise, (error) => {
    assert.ok(error instanceof Error); assert.equal(error.message.includes(secret), false); assert.equal(error.stack.includes(secret), false); assert.match(error.message, /\[REDACTED\]/); return true;
  });
  try {
    await config({ mcpServers: { fixture: { transport: "http", url, bearerTokenEnv: "HIVE_OPAQUE_BEARER_TEST" } } }); await activate("mcp:fixture");
    const connection = await connectMcp(root, "fixture", options);
    try { assert.equal((await connection.listTools())[0].description, "Authorized [REDACTED]"); await rejectsRedacted(connection.callTool("bearererror", {})); }
    finally { await connection.close(); }
    await config({ mcpServers: { fixture: { transport: "http", url: new URL("/init-error", url).toString(), bearerTokenEnv: "HIVE_OPAQUE_BEARER_TEST" } } }); await activate("mcp:fixture");
    await rejectsRedacted(connectMcp(root, "fixture", options));
  } finally { if (previous === undefined) delete process.env.HIVE_OPAQUE_BEARER_TEST; else process.env.HIVE_OPAQUE_BEARER_TEST = previous; }
}))); 

test("MCP command cancellation covers doctor/tools/call and nested server request replies", { timeout: 5000 }, async () => withHttp(async ({ url, requests, waitForRequest }) => fixture(async ({ root, options, config, activate }) => {
  for (const action of ["doctor", "tools", "call"]) {
    const endpoint = action === "call" ? url : new URL(`/slow-${action}`, url).toString();
    await config({ mcpServers: { fixture: { transport: "http", url: endpoint, timeoutMs: 120000 } } }); await activate("mcp:fixture");
    const abort = new AbortController();
    const pending = extensionCommand(root, "mcp", action === "call" ? "call fixture nested_ping {}" : `${action} fixture`, { ...options, signal: abort.signal });
    if (action === "call") await waitForRequest((entry) => entry.message?.id === "held-ping");
    else await waitForRequest((entry) => entry.url === `/slow-${action}` && entry.message?.method === "tools/list");
    const started = performance.now(); abort.abort(); await assert.rejects(pending, { name: "AbortError" });
    assert.ok(performance.now() - started < 1000, `${action} cancellation should settle promptly`);
    assert.ok(requests.some((entry) => entry.method === "DELETE" && entry.url === new URL(endpoint).pathname));
  }
}))); 

test("extension command dispatcher controls real configured MCP and trusted skill state", async () => fixture(async ({ root, options, write, config }) => {
  const server = await write("server.mjs", processServer);
  await config({ mcpServers: { fixture: { transport: "stdio", command: process.execPath, args: [server] } } });
  assert.match((await extensionCommand(root, "mcp", "list", options)).join("\n"), /untrusted/);
  await extensionCommand(root, "mcp", "trust fixture", options); await extensionCommand(root, "mcp", "enable fixture", options);
  assert.match((await extensionCommand(root, "mcp", "doctor fixture", options)).join("\n"), /connected/);
  assert.match((await extensionCommand(root, "mcp", 'call fixture echo {"value":"dispatcher result"}', options)).join("\n"), /dispatcher result/);
  assert.match((await extensionCommand(root, "mcp", "tools fixture", options)).join("\n"), /Echo fixture/);
  await assert.rejects(extensionCommand(root, "mcp", "call fixture echo []", options), /JSON object/);
  await assert.rejects(extensionCommand(root, "mcp", "unsupported fixture", options), /Unknown/);
}));
