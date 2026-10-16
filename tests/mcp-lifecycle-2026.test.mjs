import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { connectMcp, setExtensionState } from "../dist/extensions/index.js";
import { createMcpClientHost } from "../dist/extensions/mcp-client-host.js";
import { mcpHeader, toolHeaderSchema, toolParameterHeaders } from "../dist/extensions/mcp-lifecycle.js";

const version = "2026-07-28", prefix = "io.modelcontextprotocol/";
const capabilities = { tools: { listChanged: true }, resources: { subscribe: true, listChanged: true }, prompts: { listChanged: true } };
const complete = (value = {}) => ({ resultType: "complete", ...value });
const form = { method: "elicitation/create", params: { mode: "form", message: "Choose the fixture label", requestedSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false } } };
const tools = [
  { name: "bridge", inputSchema: { type: "object", properties: { nested: { type: "object", properties: { region: { type: "string", "x-mcp-header": "Region" }, count: { type: "integer", "x-mcp-header": "Count" }, enabled: { type: "boolean", "x-mcp-header": "Enabled" } } } } } },
  { name: "invalid", inputSchema: { type: "object", properties: { secret: { type: "number", "x-mcp-header": "Invalid" } } } },
];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) { const end = Date.now() + 5000; while (Date.now() < end) { const value = await predicate(); if (value) return value; await delay(10); } throw new Error("Expected fixture event was not received"); }
async function workspace(run) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hive-mcp-lifecycle-")), root = path.join(temporary, "project");
  const options = { trustStateDir: path.join(temporary, "trust") }; await fs.mkdir(path.join(root, ".hive"), { recursive: true });
  const configure = async (descriptor) => { await fs.writeFile(path.join(root, ".hive", "extensions.json"), JSON.stringify({ version: 1, mcpServers: { fixture: descriptor } })); await setExtensionState(root, "mcp:fixture", "trust", options); await setExtensionState(root, "mcp:fixture", "enable", options); };
  try { await run({ temporary, root, options, configure }); }
  finally { assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir())); assert.ok(path.basename(temporary).startsWith("hive-mcp-lifecycle-")); await fs.rm(temporary, { recursive: true, force: true }); }
}
async function httpFixture(run, mode = "modern") {
  const requests = [], streams = new Map();
  const emit = (response, value) => response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", ...value })}\n\n`);
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method !== "POST") { requests.push({ http: request.method, headers: request.headers }); response.writeHead(405).end(); return; }
      let body = ""; for await (const part of request) body += part; const message = JSON.parse(body); requests.push({ http: "POST", headers: request.headers, ...message });
      const reply = (result, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result })); };
      if (message.id === undefined) { response.writeHead(202).end(); return; }
      if (message.method === "server/discover") {
        if (mode === "legacy") { response.writeHead(400).end(); return; }
        if (mode === "unavailable") { response.writeHead(503).end(); return; }
        if (["unsupported", "header-error", "header-error-null-id", "header-error-wrong-id"].includes(mode)) { response.writeHead(400, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: mode === "header-error-null-id" ? null : mode === "header-error-wrong-id" ? 987654 : message.id, error: mode === "unsupported" ? { code: -32022, message: "Unsupported protocol version", data: { supported: ["2027-01-01"], requested: version } } : { code: -32020, message: "Header mismatch" } })); return; }
        reply(complete({ supportedVersions: [version], capabilities, _meta: { [`${prefix}serverInfo`]: { name: "modern-http", version: "1" } } })); return;
      }
      if (message.method === "initialize") { response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "legacy-session" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", capabilities, serverInfo: { name: "legacy", version: "1" } } })); return; }
      if (message.method === "tools/list") { reply(mode === "legacy" ? { tools } : complete({ tools })); return; }
      if (message.method === "subscriptions/listen") {
        response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders(); streams.set(message.id, { response, message }); response.on("close", () => streams.delete(message.id));
        const metadata = { [`${prefix}subscriptionId`]: mode === "wrong-subscription" ? message.id + 1 : message.id };
        if (mode === "early-notification") emit(response, { method: "notifications/tools/list_changed", params: { _meta: metadata } });
        else emit(response, { method: "notifications/subscriptions/acknowledged", params: { _meta: metadata, notifications: message.params.notifications } });
        return;
      }
      if (message.method === "tools/call") {
        if (mode === "sse-ids") { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(`id: unicode-κόσμος\nretry: 999999\ndata: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/message", params: { level: "info", data: "in-flight only" } })}\n\n`); response.end(`id: unicode-κόσμος\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: complete({ content: [{ type: "text", text: "modern SSE complete" }] }) })}\n\n`); return; }
        if (mode === "disconnect" || mode === "server-request" || mode === "wait" || mode === "configured-timeout" || mode === "unrequested-change") {
          response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders();
          if (mode === "disconnect") response.end("id: must-not-resume\ndata:\n\n");
          if (mode === "server-request") emit(response, { id: "forbidden", method: "roots/list", params: {} });
          if (mode === "unrequested-change") emit(response, { method: "notifications/tools/list_changed", params: {} });
          if (mode === "wait" || mode === "configured-timeout") { streams.set(message.id, { response, message }); response.on("close", () => streams.delete(message.id)); }
          return;
        }
        if (mode === "loop" || mode === "invalid-input" || !message.params.inputResponses && message.params.arguments?.input) { reply({ resultType: "input_required", inputRequests: mode === "invalid-input" ? { bad: { method: "danger/run", params: {} } } : { answer: form }, requestState: "opaque\nstate\u0000unchanged" }); return; }
        reply(mode === "legacy" ? { content: [{ type: "text", text: "legacy result" }] } : complete({ content: [{ type: "text", text: "modern result" }], structuredContent: { inputResponses: message.params.inputResponses, requestState: message.params.requestState } })); return;
      }
      if (message.method === "resources/read") { reply(complete({ contents: [{ uri: message.params.uri, text: "fixture resource" }] })); return; }
      reply(complete());
    } catch { if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await workspace(async (context) => { await context.configure({ transport: "http", url: `http://127.0.0.1:${server.address().port}/mcp`, timeoutMs: mode === "configured-timeout" ? 100 : 5000 }); await run({ ...context, requests, streams, emit }); }); }
  finally { for (const { response } of streams.values()) response.end(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test("2026 HTTP discovers once and sends stateless metadata plus exact mirrored tool headers", async () => httpFixture(async (fixture) => {
  const connection = await connectMcp(fixture.root, "fixture", fixture.options);
  try {
    assert.equal(connection.protocolVersion, version); assert.deepEqual((await connection.listTools()).map((tool) => tool.name), ["bridge"]);
    await connection.callTool("bridge", { nested: { region: "Hello, 世界\r\nX-Bad: value", count: 42, enabled: false } });
    for (const entry of fixture.requests) { assert.equal(entry.http, "POST"); assert.equal(entry.headers["mcp-protocol-version"], version); assert.equal(entry.headers["mcp-method"], entry.method); assert.equal(entry.params._meta[`${prefix}protocolVersion`], version); assert.deepEqual(entry.params._meta[`${prefix}clientCapabilities`], {}); assert.equal(entry.headers["mcp-session-id"], undefined); assert.equal(entry.headers["last-event-id"], undefined); }
    const call = fixture.requests.find((entry) => entry.method === "tools/call"); assert.equal(call.headers["mcp-name"], "bridge"); assert.equal(call.headers["mcp-param-region"], `=?base64?${Buffer.from("Hello, 世界\r\nX-Bad: value").toString("base64")}?=`); assert.equal(call.headers["x-bad"], undefined); assert.equal(call.headers["mcp-param-count"], "42"); assert.equal(call.headers["mcp-param-enabled"], "false");
    await assert.rejects(connection.callTool("invalid", {}), /Unknown or invalid/); assert.equal(fixture.requests.filter((entry) => entry.method === "tools/call").length, 1);
    assert.equal((await connection.readResource("fixture://resource")).contents[0].text, "fixture resource"); await assert.rejects(connection.listTasks(), /Modern MCP tasks do not support tasks\/list/);
  } finally { await connection.close(); }
  assert.equal(fixture.requests.some((entry) => entry.http !== "POST" || ["initialize", "notifications/initialized"].includes(entry.method)), false);
}));

test("2026 HTTP MRTR uses the approved private form callback and echoes opaque state in a fresh request only", async () => httpFixture(async (fixture) => {
  const inputs = []; const host = createMcpClientHost({ serverId: "mcp:fixture", requestInput: async (request) => { inputs.push(request); return { action: "accept", content: { label: "owner fixture answer" } }; } });
  const connection = await connectMcp(fixture.root, "fixture", { ...fixture.options, incoming: host });
  try {
    const result = await connection.callTool("bridge", { input: true }); assert.equal(result.structuredContent.inputResponses.answer.content.label, "owner fixture answer"); assert.equal(inputs.length, 1);
    const calls = fixture.requests.filter((entry) => entry.method === "tools/call"); assert.equal(calls.length, 2); assert.notEqual(calls[0].id, calls[1].id); assert.equal(calls[1].params.requestState, "opaque\nstate\u0000unchanged"); assert.deepEqual(calls[0].params.arguments, calls[1].params.arguments);
    await connection.callTool("bridge", {}); const last = fixture.requests.at(-1); assert.equal(last.params.requestState, undefined); assert.equal(last.params.inputResponses, undefined);
  } finally { await connection.close(); }
}));

test("2026 MRTR cancellation during elicitation releases no answer or continuation", async () => httpFixture(async (fixture) => {
  let prompted = false;
  const host = createMcpClientHost({ serverId: "mcp:fixture", requestInput: async (_request, signal) => { prompted = true; return new Promise((resolve) => { signal.addEventListener("abort", () => resolve({ action: "cancel" }), { once: true }); }); } });
  const connection = await connectMcp(fixture.root, "fixture", { ...fixture.options, incoming: host }), controller = new AbortController();
  try { const pending = connection.callTool("bridge", { input: true }, { signal: controller.signal }); const rejected = assert.rejects(pending, (error) => error.name === "AbortError"); await until(() => prompted); controller.abort(); await rejected; assert.equal(fixture.requests.filter((entry) => entry.method === "tools/call").length, 1); }
  finally { await connection.close(); }
}));

test("2026 MRTR rechecks trust after owner input and sends no continuation after revocation", async () => httpFixture(async (fixture) => {
  let release, prompted = false;
  const host = createMcpClientHost({ serverId: "mcp:fixture", requestInput: async () => { prompted = true; return new Promise((resolve) => { release = resolve; }); } });
  const connection = await connectMcp(fixture.root, "fixture", { ...fixture.options, incoming: host });
  try { const pending = connection.callTool("bridge", { input: true }); const rejected = assert.rejects(pending, /trust|configuration|input is unavailable/); await until(() => prompted); await setExtensionState(fixture.root, "mcp:fixture", "untrust", fixture.options); release({ action: "accept", content: { label: "answer after revoke" } }); await rejected; assert.equal(fixture.requests.filter((entry) => entry.method === "tools/call").length, 1); }
  finally { await connection.close(); }
}));

for (const [mode, pattern] of [["unsupported", /unsupported modern protocol/], ["header-error", /Header mismatch/], ["header-error-null-id", /Header mismatch/], ["header-error-wrong-id", /response id does not match/], ["unavailable", /503/]]) test(`2026 HTTP ${mode} never downgrades or performs initialize`, async () => httpFixture(async (fixture) => {
  await assert.rejects(connectMcp(fixture.root, "fixture", fixture.options), pattern); assert.equal(fixture.requests.some((entry) => entry.method === "initialize"), false);
}, mode));

test("legacy HTTP fallback keeps initialized sessions, legacy metadata and existing tool calls", async () => httpFixture(async (fixture) => {
  const connection = await connectMcp(fixture.root, "fixture", fixture.options);
  try { assert.equal(connection.protocolVersion, "2025-11-25"); assert.equal((await connection.callTool("bridge", {})).content[0].text, "legacy result"); const init = fixture.requests.find((entry) => entry.method === "initialize"); assert.equal(init.id, 1); const call = fixture.requests.find((entry) => entry.method === "tools/call"); assert.equal(call.headers["mcp-session-id"], "legacy-session"); assert.equal(call.params._meta, undefined); }
  finally { await connection.close(); }
}, "legacy"));

test("2026 subscriptions use acknowledged POST filters and correlate updates without GET or resumption", async () => httpFixture(async (fixture) => {
  const connection = await connectMcp(fixture.root, "fixture", fixture.options), updates = [], changes = [];
  try {
    connection.onResourceUpdated((uri) => updates.push(uri)); connection.onListChanged((kind) => changes.push(kind));
    await connection.subscribeResource("fixture://watched"); await connection.startBackground();
    const [id, stream] = [...fixture.streams][0]; assert.deepEqual(stream.message.params.notifications.resourceSubscriptions, ["fixture://watched"]);
    fixture.emit(stream.response, { method: "notifications/resources/updated", params: { uri: "fixture://watched", _meta: { [`${prefix}subscriptionId`]: id } } }); fixture.emit(stream.response, { method: "notifications/tools/list_changed", params: { _meta: { [`${prefix}subscriptionId`]: id } } });
    await until(() => updates.length && changes.length); assert.deepEqual(updates, ["fixture://watched"]); assert.deepEqual(changes, ["tools"]);
    await connection.unsubscribeResource("fixture://watched"); const last = fixture.requests.filter((entry) => entry.method === "subscriptions/listen").at(-1); assert.equal(last.params.notifications.resourceSubscriptions, undefined);
    await connection.stopBackground(); await until(() => fixture.streams.size === 0); assert.equal(fixture.requests.some((entry) => entry.http !== "POST" || entry.method === "notifications/cancelled" || entry.method.startsWith("resources/sub")), false);
  } finally { await connection.close(); }
}));

for (const mode of ["wrong-subscription", "early-notification"]) test(`2026 subscription rejects ${mode} before delivering unrequested events`, async () => httpFixture(async (fixture) => {
  const connection = await connectMcp(fixture.root, "fixture", fixture.options), events = [];
  try { connection.onListChanged((kind) => events.push(kind)); await assert.rejects(connection.startBackground(), /subscription|acknowledgment/i); assert.deepEqual(events, []); }
  finally { await connection.close(); }
}, mode));

for (const [mode, pattern] of [["disconnect", /not replayed/], ["server-request", /input_required/], ["invalid-input", /Unsupported MCP input/], ["unrequested-change", /acknowledged subscription/]]) test(`2026 ${mode} fails without replay or unsafe callback`, async () => httpFixture(async (fixture) => {
  const connection = await connectMcp(fixture.root, "fixture", fixture.options);
  try { await assert.rejects(connection.callTool("bridge", {}), pattern); assert.equal(fixture.requests.filter((entry) => entry.method === "tools/call").length, 1); assert.equal(fixture.requests.some((entry) => entry.http === "GET" || entry.id === "forbidden"), false); }
  finally { await connection.close(); }
}, mode));

test("2026 HTTP cancellation closes the request stream and does not send legacy cancellation RPC", async () => httpFixture(async (fixture) => {
  const connection = await connectMcp(fixture.root, "fixture", fixture.options), controller = new AbortController();
  try { const pending = connection.callTool("bridge", {}, { signal: controller.signal }); const rejected = assert.rejects(pending, (error) => error.name === "AbortError"); await until(() => fixture.streams.size); controller.abort(); await rejected; await until(() => fixture.streams.size === 0); assert.equal(fixture.requests.some((entry) => entry.method === "notifications/cancelled"), false); }
  finally { await connection.close(); }
}, "wait"));

test("2026 HTTP ignores obsolete SSE resumption ids and retry hints without replay", async () => httpFixture(async (fixture) => {
  const connection = await connectMcp(fixture.root, "fixture", fixture.options);
  try { assert.equal((await connection.callTool("bridge", {})).content[0].text, "modern SSE complete"); assert.equal(fixture.requests.filter((entry) => entry.method === "tools/call").length, 1); assert.equal(fixture.requests.some((entry) => entry.http === "GET"), false); }
  finally { await connection.close(); }
}, "sse-ids"));

test("2026 requests retain the configured server timeout when no per-call timeout is supplied", async () => httpFixture(async (fixture) => {
  const connection = await connectMcp(fixture.root, "fixture", { ...fixture.options, timeoutMs: 5000 });
  try { await connection.listTools({ timeoutMs: 5000 }); await assert.rejects(connection.callTool("bridge", {}), /timed out after 100ms/); await until(() => fixture.streams.size === 0); assert.equal(fixture.requests.filter((entry) => entry.method === "tools/call").length, 1); }
  finally { await connection.close(); }
}, "configured-timeout"));

test("2026 MRTR refuses absent capability and bounds repeated input rounds", async () => httpFixture(async (fixture) => {
  let connection = await connectMcp(fixture.root, "fixture", fixture.options);
  try { await assert.rejects(connection.callTool("bridge", {}), /input is unavailable/); assert.equal(fixture.requests.filter((entry) => entry.method === "tools/call").length, 1); } finally { await connection.close(); }
  const host = createMcpClientHost({ serverId: "mcp:fixture", requestInput: async () => ({ action: "decline" }) }); connection = await connectMcp(fixture.root, "fixture", { ...fixture.options, incoming: host });
  try { await assert.rejects(connection.callTool("bridge", {}), /exceeded 8 rounds/); assert.equal(fixture.requests.filter((entry) => entry.method === "tools/call").length, 9); } finally { await connection.close(); }
}, "loop"));

const stdioSource = `
import readline from 'node:readline'; import {appendFileSync} from 'node:fs';
const log=process.argv[2],mode=process.argv[3];const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);appendFileSync(log,JSON.stringify(m)+'\\n');if(m.id===undefined)return;
if(m.method==='server/discover'){if(mode==='legacy'){send({id:m.id,error:{code:-32602,message:'Initialize first'}});return;}send({id:m.id,result:{resultType:'complete',supportedVersions:['${version}'],capabilities:${JSON.stringify(capabilities)}}});return;}
if(m.method==='initialize'){send({id:m.id,result:{protocolVersion:'2025-11-25',capabilities:${JSON.stringify(capabilities)},serverInfo:{name:'legacy-stdio',version:'1'}}});return;}
if(m.method==='subscriptions/listen'){send({method:'notifications/subscriptions/acknowledged',params:{_meta:{'${prefix}subscriptionId':m.id},notifications:m.params.notifications}});for(const uri of m.params.notifications.resourceSubscriptions||[])send({method:'notifications/resources/updated',params:{uri,_meta:{'${prefix}subscriptionId':m.id}}});return;}
if(m.method==='tools/call'&&!m.params.inputResponses&&mode!=='legacy'){send({id:m.id,result:{resultType:'input_required',inputRequests:{roots:{method:'roots/list',params:{}}},requestState:'opaque-state'}});return;}
send({id:m.id,result:{...(mode==='legacy'?{}:{resultType:'complete'}),content:[{type:'text',text:JSON.stringify(m.params.inputResponses||{})}]}});
}).on('close',()=>process.exit(0));
`;
for (const mode of ["modern", "legacy"]) test(`real stdio ${mode} lifecycle, metadata and cancellation`, async () => workspace(async (fixture) => {
  const script = path.join(fixture.root, "lifecycle-fixture.mjs"), log = path.join(fixture.root, "messages.jsonl"); await fs.writeFile(script, stdioSource); await fs.writeFile(log, "");
  await fixture.configure({ transport: "stdio", command: process.execPath, args: [script, log, mode], timeoutMs: 5000 });
  const connection = await connectMcp(fixture.root, "fixture", { ...fixture.options, roots: true }), updates = [];
  try {
    assert.equal(connection.protocolVersion, mode === "modern" ? version : "2025-11-25"); const result = await connection.callTool("bridge", {});
    if (mode === "modern") { assert.equal(JSON.parse(result.content[0].text).roots.roots[0].name, "Project"); connection.onResourceUpdated((uri) => updates.push(uri)); await connection.subscribeResource("fixture://stdio"); await connection.startBackground(); await until(() => updates.length); assert.deepEqual(updates, ["fixture://stdio"]); await connection.stopBackground(); }
  } finally { await connection.close(); }
  const messages = (await fs.readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(messages[0].method, "server/discover"); assert.equal(messages[0].id, -1);
  if (mode === "modern") { assert.equal(messages.some((entry) => entry.method === "initialize"), false); for (const entry of messages.filter((entry) => entry.id !== undefined)) { assert.equal(entry.params._meta[`${prefix}protocolVersion`], version); assert.deepEqual(entry.params._meta[`${prefix}clientCapabilities`], { roots: {} }); } const subscription = messages.find((entry) => entry.method === "subscriptions/listen"); assert.ok(messages.some((entry) => entry.method === "notifications/cancelled" && entry.params.requestId === subscription.id)); }
  else assert.equal(messages.find((entry) => entry.method === "initialize").id, 1);
}));

test("2026 stdio startup timeout cannot write a subscription after a delayed trust recheck", async () => workspace(async (fixture) => {
  const script = path.join(fixture.root, "delayed-lifecycle.mjs"), log = path.join(fixture.root, "delayed-messages.jsonl"); await fs.writeFile(script, stdioSource); await fs.writeFile(log, "");
  await fixture.configure({ transport: "stdio", command: process.execPath, args: [script, log, "modern"], timeoutMs: 5000 });
  const connection = await connectMcp(fixture.root, "fixture", fixture.options), original = fs.realpath; let checks = 0;
  try {
    fs.realpath = async (...args) => { if (args[0] === fixture.root && ++checks >= 2) await delay(250); return original(...args); };
    await assert.rejects(connection.startBackground({ timeoutMs: 100 }), /acknowledgment timed out/); await delay(275);
    assert.ok(checks >= 2); const messages = (await fs.readFile(log, "utf8")).trim().split("\n").map((line) => JSON.parse(line)); assert.equal(messages.some((entry) => entry.method === "subscriptions/listen"), false);
  } finally { fs.realpath = original; await connection.close(); }
}));

test("modern header annotation validation rejects invalid paths, duplicates, types and injection", () => {
  const valid = toolHeaderSchema(tools[0].inputSchema); assert.equal(valid.length, 3); assert.deepEqual(toolParameterHeaders(valid, { nested: { region: null } }), {});
  assert.throws(() => toolParameterHeaders(valid, { nested: { count: 1.5 } }), /primitive type/);
  for (const schema of [
    { type: "object", properties: { value: { type: "string", "x-mcp-header": "Bad\r\nInjected" } } },
    { type: "object", properties: { value: { type: "number", "x-mcp-header": "Bad" } } },
    { type: "object", properties: { value: { type: "array", items: { type: "string", "x-mcp-header": "Bad" } } } },
    { type: "object", properties: { a: { type: "string", "x-mcp-header": "Same" }, b: { type: "string", "x-mcp-header": "same" } } },
    { type: "object", allOf: [{ properties: { value: { type: "string", "x-mcp-header": "Bad" } } }] },
  ]) assert.throws(() => toolHeaderSchema(schema), /Invalid MCP|header must be a nonempty string without control characters/);
  assert.equal(mcpHeader(" padded "), `=?base64?${Buffer.from(" padded ").toString("base64")}?=`); assert.equal(mcpHeader("=?base64?literal?="), `=?base64?${Buffer.from("=?base64?literal?=").toString("base64")}?=`);
});
