import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { connectMcp, setExtensionState } from "../dist/extensions/index.js";
import { mcpSseEvents } from "../dist/extensions/mcp-stream.js";
import { parseTask, parseTaskList } from "../dist/extensions/mcp-tasks.js";

const capabilities = { tools: { listChanged: true }, resources: { subscribe: true }, tasks: { list: {}, cancel: {}, requests: { tools: { call: {} } } } };
const task = (status = "working", id = "task-one") => ({ taskId: id, status, createdAt: "2025-11-25T10:00:00Z", lastUpdatedAt: "2025-11-25T10:00:01Z", ttl: 60_000, pollInterval: 100 });
const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
async function until(predicate) { const end = Date.now() + 5000; while (Date.now() < end) { const value = await predicate(); if (value) return value; await delay(10); } throw new Error("Expected fixture event was not received"); }

async function workspace(run, descriptor) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hive-mcp-background-")); const root = path.join(temporary, "project");
  const options = { trustStateDir: path.join(temporary, "trust") }; await fs.mkdir(path.join(root, ".hive"), { recursive: true });
  const config = async (entry) => { await fs.writeFile(path.join(root, ".hive", "extensions.json"), JSON.stringify({ version: 1, mcpServers: { fixture: entry } })); await setExtensionState(root, "mcp:fixture", "trust", options); await setExtensionState(root, "mcp:fixture", "enable", options); };
  try { if (descriptor) await config(descriptor); await run({ root, options, config }); }
  finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

async function httpFixture(run, mode = "normal") {
  const requests = []; const streams = new Set(); let gets = 0; let calls = 0; let subscription = false; let current = task();
  const emit = (response, value, id) => response.write(`${id ? `id: ${id}\r\n` : ""}data: ${JSON.stringify({ jsonrpc: "2.0", ...value })}\r\n\r\n`);
  const broadcast = (value, id) => { for (const stream of streams) emit(stream, value, id); };
  const server = http.createServer(async (request, response) => {
    requests.push({ method: request.method, headers: request.headers });
    if (request.method === "DELETE") { response.writeHead(200).end(); return; }
    if (request.method === "GET") {
      gets += 1;
      if (mode === "unsupported") { response.writeHead(405).end(); return; }
      if (mode === "expired") { response.writeHead(404).end(); return; }
      if (mode === "reauth") { response.writeHead(401).end(); return; }
      response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders();
      if (mode === "post-resume") { emit(response, { id: 3, result: { content: [{ type: "text", text: "resumed result" }] } }, "post-final"); response.end(); return; }
      streams.add(response); request.on("close", () => streams.delete(response));
      if (mode === "reconnect" && gets === 1) { response.write("id: cursor-one\r\ndata:\r\nretry: 100\r\n\r\n"); response.end(); }
      if (mode === "reconnect" && gets === 2) emit(response, { method: "notifications/resources/updated", params: { uri: "fixture://watched" } }, "cursor-two");
      if (mode === "huge") response.write(`data: ${"x".repeat(1024 * 1024 + 1)}`);
      return;
    }
    let body = ""; for await (const part of request) body += part; const message = JSON.parse(body); requests.at(-1).message = message;
    if (!message.method) { response.writeHead(202).end(); return; }
    if (!Object.hasOwn(message, "id")) { response.writeHead(202).end(); return; }
    let result = {};
    if (message.method === "initialize") result = { protocolVersion: "2025-11-25", capabilities: mode === "no-tasks" ? { tools: {}, resources: {} } : capabilities, serverInfo: { name: "background-fixture", version: "1" } };
    if (message.method === "tools/list") result = { tools: [{ name: "long", inputSchema: { type: "object" }, execution: { taskSupport: "optional" } }, { name: "required", inputSchema: { type: "object" }, execution: { taskSupport: "required" } }, { name: "plain", inputSchema: { type: "object" } }] };
    if (message.method === "resources/subscribe") subscription = true;
    if (message.method === "resources/unsubscribe") subscription = false;
    if (message.method === "tools/call") {
      calls += 1;
      if (mode === "task-timeout") return;
      if (mode === "post-resume") { response.writeHead(200, { "content-type": "text/event-stream" }); response.end("id: post-cursor\ndata:\nretry: 100\n\n"); return; }
      result = message.params.task ? { task: current } : { content: [{ type: "text", text: "normal result" }] };
    }
    if (message.method === "tasks/get") result = current;
    if (message.method === "tasks/list") result = { tasks: [current], ...(message.params.cursor ? {} : { nextCursor: "page-two" }) };
    if (message.method === "tasks/cancel") { current = task("cancelled"); result = current; }
    if (message.method === "tasks/result") result = { content: [{ type: "text", text: "actual deferred result" }], structuredContent: { done: true } };
    response.writeHead(200, { "content-type": "application/json", ...(message.method === "initialize" ? { "mcp-session-id": "fixture-session" } : {}) }); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await workspace((context) => run({ ...context, requests, broadcast, emit, streams, get gets() { return gets; }, get calls() { return calls; }, get subscribed() { return subscription; }, complete() { current = task("completed"); broadcast({ method: "notifications/tasks/status", params: current }); } }), { transport: "http", url: `http://127.0.0.1:${server.address().port}/mcp` }); }
  finally { for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test("HTTP background streams are opt-in, carry session headers, and subscriptions deliver only selected URIs", async () => httpFixture(async (fixture) => {
  const { root, options } = fixture; const connection = await connectMcp(root, "fixture", options); const updates = [];
  try {
    assert.equal(fixture.gets, 0); connection.onResourceUpdated((uri) => updates.push(uri));
    await connection.startBackground(); await connection.subscribeResource("fixture://watched"); await connection.subscribeResource("fixture://watched");
    assert.equal(fixture.requests.filter((entry) => entry.message?.method === "resources/subscribe").length, 1);
    fixture.broadcast({ method: "notifications/resources/updated", params: { uri: "fixture://outside" } });
    fixture.broadcast({ method: "notifications/resources/updated", params: { uri: "fixture://watched" } });
    await until(() => updates.length); assert.deepEqual(updates, ["fixture://watched"]);
    const get = fixture.requests.find((entry) => entry.method === "GET"); assert.equal(get.headers["mcp-session-id"], "fixture-session"); assert.equal(get.headers["mcp-protocol-version"], "2025-11-25");
    await connection.unsubscribeResource("fixture://watched"); await connection.unsubscribeResource("fixture://watched");
    fixture.broadcast({ method: "notifications/resources/updated", params: { uri: "fixture://watched" } }); await delay(50); assert.equal(updates.length, 1);
    await connection.stopBackground(); await until(() => fixture.streams.size === 0);
  } finally { await connection.close(); }
}));

test("background GET reconnects with Last-Event-ID and never replays tool calls", async () => httpFixture(async (fixture) => {
  const connection = await connectMcp(fixture.root, "fixture", fixture.options); const updates = [];
  try {
    connection.onResourceUpdated((uri) => updates.push(uri)); await connection.subscribeResource("fixture://watched"); await connection.startBackground();
    await until(() => updates.length); assert.equal(fixture.gets, 2);
    assert.equal(fixture.requests.filter((entry) => entry.method === "GET")[1].headers["last-event-id"], "cursor-one"); assert.equal(fixture.calls, 0);
  } finally { await connection.close(); }
}, "reconnect"));

test("POST SSE resumes via GET without repeating a side effect", async () => httpFixture(async (fixture) => {
  const connection = await connectMcp(fixture.root, "fixture", fixture.options);
  try {
    // initialize=1 and tools/list=2, so the call is request 3.
    await connection.listTools(); const result = await connection.callTool("long", {});
    assert.equal(result.content[0].text, "resumed result"); assert.equal(fixture.calls, 1);
    assert.equal(fixture.requests.find((entry) => entry.method === "GET").headers["last-event-id"], "post-cursor");
  } finally { await connection.close(); }
}, "post-resume"));

for (const [mode, pattern] of [["unsupported", /HTTP 405/], ["expired", /session expired/], ["reauth", /authorization|authentication|OAuth/i]]) {
  test(`background ${mode} failure is explicit and does not retry a tool`, async () => httpFixture(async (fixture) => {
    const connection = await connectMcp(fixture.root, "fixture", fixture.options);
    try { await assert.rejects(connection.startBackground(), pattern); assert.equal(fixture.gets, 1); assert.equal(fixture.calls, 0); }
    finally { await connection.close(); }
  }, mode));
}

test("quiet background streams stop after trust revocation and cancellation closes owned stream", async () => httpFixture(async (fixture) => {
  const connection = await connectMcp(fixture.root, "fixture", fixture.options); const errors = [];
  try {
    connection.onBackgroundError((error) => errors.push(error.message)); await connection.startBackground();
    await setExtensionState(fixture.root, "mcp:fixture", "untrust", fixture.options);
    await until(() => errors.length); await until(() => fixture.streams.size === 0); assert.match(errors[0], /trust|configuration/);
    await assert.rejects(connection.getTask("task-one"), /trust|configuration/); assert.equal(fixture.calls, 0);
  } finally { await connection.close(); }
}));

test("task negotiation, polling, deferred result, pagination and status push preserve one call", async () => httpFixture(async (fixture) => {
  const connection = await connectMcp(fixture.root, "fixture", fixture.options); const statuses = [];
  try {
    connection.onTaskStatus((value) => statuses.push(value.status)); await connection.startBackground();
    const created = await connection.callToolTask("long", { input: "one" }, { ttl: 5000 }); assert.equal(created.task.status, "working"); assert.equal(fixture.calls, 1);
    assert.equal((await connection.getTask("task-one")).pollInterval, 100);
    assert.equal((await connection.listTasks()).nextCursor, "page-two"); assert.equal((await connection.listTasks({ cursor: "page-two" })).nextCursor, undefined);
    fixture.complete(); await until(() => statuses.length); assert.deepEqual(statuses, ["completed"]);
    assert.equal((await connection.getTaskResult("task-one")).structuredContent.done, true);
    await assert.rejects(connection.callToolTask("plain", {}), /does not allow task/);
    await assert.rejects(connection.callTool("required", {}), /requires task/);
    assert.equal(fixture.calls, 1);
    const call = fixture.requests.find((entry) => entry.message?.method === "tools/call").message; assert.deepEqual(call.params.task, { ttl: 5000 });
  } finally { await connection.close(); }
}));

test("explicit task cancellation targets the running task once without resubmitting work", async () => httpFixture(async (fixture) => {
  const connection = await connectMcp(fixture.root, "fixture", fixture.options);
  try {
    await connection.callToolTask("long", {}); assert.equal((await connection.cancelTask("task-one")).status, "cancelled");
    assert.equal(fixture.calls, 1); assert.equal(fixture.requests.filter((entry) => entry.message?.method === "tasks/cancel").length, 1);
  } finally { await connection.close(); }
}));

test("task creation timeout never replays tools/call or sends ordinary request cancellation", async () => httpFixture(async (fixture) => {
  const connection = await connectMcp(fixture.root, "fixture", fixture.options);
  try {
    await assert.rejects(connection.callToolTask("long", {}, { timeoutMs: 100 }), /timed out/); await delay(30);
    assert.equal(fixture.calls, 1); assert.equal(fixture.requests.some((entry) => entry.message?.method === "notifications/cancelled"), false);
  } finally { await connection.close(); }
}, "task-timeout"));

test("unadvertised tasks and subscriptions fail before contacting unsupported methods", async () => httpFixture(async (fixture) => {
  const connection = await connectMcp(fixture.root, "fixture", fixture.options);
  try {
    await assert.rejects(connection.callToolTask("long", {}), /does not advertise tasks/); await assert.rejects(connection.listTasks(), /does not advertise tasks/); await assert.rejects(connection.subscribeResource("fixture://watched"), /does not advertise resource subscriptions/);
    assert.equal(fixture.calls, 0); assert.equal(fixture.requests.some((entry) => /^tasks\//.test(entry.message?.method ?? "")), false);
  } finally { await connection.close(); }
}, "no-tasks"));

test("background incoming requests receive cancellation and close aborts pending host work", async () => httpFixture(async (fixture) => {
  let signal; const connection = await connectMcp(fixture.root, "fixture", { ...fixture.options, incoming: { capabilities: { elicitation: { form: {} } }, request: async (_method, _params, incomingSignal) => { signal = incomingSignal; return new Promise(() => {}); } } });
  try {
    await connection.startBackground(); fixture.broadcast({ id: "server-request", method: "elicitation/create", params: { message: "Confirm" } }); await until(() => signal);
    fixture.broadcast({ method: "notifications/cancelled", params: { requestId: "server-request" } }); await until(() => signal.aborted);
    await until(() => fixture.requests.some((entry) => entry.message?.id === "server-request" && entry.message?.error?.code === -32800));
    signal = undefined; fixture.broadcast({ id: "close-request", method: "elicitation/create", params: { message: "Confirm again" } }); await until(() => signal);
    await connection.close(); assert.equal(signal.aborted, true);
  } finally { await connection.close(); }
}));

test("explicit bearer credentials are scrubbed before server requests reach host approval handlers", async () => httpFixture(async (fixture) => {
  const reference = "HIVE_BACKGROUND_TEST_CREDENTIAL"; const previous = process.env[reference]; const opaque = "opaque-fixture-reference-4e61f0a1899c"; process.env[reference] = opaque;
  let received;
  try {
    const settings = JSON.parse(await fs.readFile(path.join(fixture.root, ".hive", "extensions.json"), "utf8")); await fixture.config({ ...settings.mcpServers.fixture, bearerTokenEnv: reference });
    const connection = await connectMcp(fixture.root, "fixture", { ...fixture.options, incoming: { capabilities: { elicitation: { form: {} } }, request: async (_method, params) => { received = params; return { result: { action: "decline" } }; } } });
    try {
      await connection.startBackground(); fixture.broadcast({ id: "credential-echo", method: "elicitation/create", params: { message: `Server echoed ${opaque}` } });
      await until(() => received); assert.equal(JSON.stringify(received).includes(opaque), false); assert.match(received.message, /redacted/i);
    } finally { await connection.close(); }
  } finally { if (previous === undefined) delete process.env[reference]; else process.env[reference] = previous; }
}));

test("host factories receive canonical server ids and related-task metadata survives replies while malformed ids never reach the host", async () => httpFixture(async (fixture) => {
  let handled = 0; let factoryServer;
  const connection = await connectMcp(fixture.root, "fixture", { ...fixture.options, mcpHost(serverId) { factoryServer = serverId; return { capabilities: { elicitation: { form: {} } }, request: async () => { handled += 1; return { result: { action: "decline", _meta: { custom: "preserved" } } }; } }; } });
  try {
    assert.equal(factoryServer, "mcp:fixture"); await connection.startBackground();
    fixture.broadcast({ id: "related-host", method: "elicitation/create", params: { message: "Task input", _meta: { "io.modelcontextprotocol/related-task": { taskId: "task-one" } } } });
    const response = await until(() => fixture.requests.find((entry) => entry.message?.id === "related-host" && entry.message?.result)?.message);
    assert.deepEqual(response.result._meta, { custom: "preserved", "io.modelcontextprotocol/related-task": { taskId: "task-one" } }); assert.equal(handled, 1);
    fixture.broadcast({ id: "invalid-related-host", method: "elicitation/create", params: { message: "Invalid task input", _meta: { "io.modelcontextprotocol/related-task": { taskId: 12 } } } });
    const invalid = await until(() => fixture.requests.find((entry) => entry.message?.id === "invalid-related-host" && entry.message?.error)?.message);
    assert.equal(invalid.error.code, -32602); assert.equal(handled, 1);
  } finally { await connection.close(); }
}));

test("SSE parser bounds an event, supports split CRLF and UTF8, and permits aggregate streams over 1MiB", async () => {
  const values = ["id: a\r", "\ndata: {\"value\":\"π\"}\r\n\r", "\n", ...Array.from({ length: 20 }, () => `data: ${"x".repeat(60_000)}\n\n`)];
  const bytes = new TextEncoder().encode(values.join("")); let position = 0;
  const body = new ReadableStream({ pull(controller) { if (position === bytes.length) return controller.close(); const end = Math.min(bytes.length, position + 7999); controller.enqueue(bytes.slice(position, end)); position = end; } });
  const events = []; for await (const event of mcpSseEvents(body, new AbortController().signal)) events.push(event);
  assert.equal(events.length, 21); assert.deepEqual(JSON.parse(events[0].data), { value: "π" }); assert.equal(events[0].id, "a");
  const oversized = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(`data: ${"x".repeat(1024 * 1024 + 1)}`)); controller.close(); } });
  await assert.rejects(async () => { for await (const _event of mcpSseEvents(oversized, new AbortController().signal)) {} }, /size limit/);
});

test("task parsers reject malformed statuses, timestamps, TTL, duplicate ids and oversized pages", () => {
  for (const change of [{ status: "unknown" }, { createdAt: "yesterday" }, { ttl: -1 }, { pollInterval: 0.5 }, { lastUpdatedAt: "2025-11-24T00:00:00Z" }]) assert.throws(() => parseTask({ ...task(), ...change }));
  assert.throws(() => parseTaskList({ tasks: [task(), task()] }), /duplicate/); assert.throws(() => parseTaskList({ tasks: Array(257).fill(task()) }), /256/);
});

test("stdio subscriptions, status notifications and incoming cancellation work without HTTP background GET", async () => workspace(async ({ root, options, config }) => {
  const script = path.join(root, "fixture.mjs");
  await fs.writeFile(script, `import readline from 'node:readline';const send=x=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...x})+'\\n');const task=${JSON.stringify(task())};readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.method)return;if(m.method==='initialize')return send({id:m.id,result:{protocolVersion:'2025-11-25',capabilities:${JSON.stringify(capabilities)},serverInfo:{name:'stdio-background',version:'1'}}});if(!Object.hasOwn(m,'id'))return;if(m.method==='resources/subscribe'){send({method:'notifications/resources/updated',params:{uri:m.params.uri}});return send({id:m.id,result:{}});}if(m.method==='tools/list')return send({id:m.id,result:{tools:[{name:'long',inputSchema:{type:'object'},execution:{taskSupport:'optional'}}]}});if(m.method==='tools/call'){send({id:m.id,result:{task}});setTimeout(()=>send({method:'notifications/tasks/status',params:{...task,status:'completed'}}),10);return;}if(m.method==='tasks/get')return send({id:m.id,result:task});send({id:m.id,result:{}});});`);
  await config({ transport: "stdio", command: process.execPath, args: [script] }); const connection = await connectMcp(root, "fixture", options); const updates = []; const statuses = [];
  try {
    connection.onResourceUpdated((uri) => updates.push(uri)); connection.onTaskStatus((value) => statuses.push(value.status)); await connection.startBackground();
    await connection.subscribeResource("fixture://watched"); assert.deepEqual(updates, ["fixture://watched"]);
    assert.equal((await connection.callToolTask("long", {})).task.taskId, "task-one"); await until(() => statuses.length); assert.deepEqual(statuses, ["completed"]);
  } finally { await connection.close(); }
}));

test("stdio cancelled notifications abort the specific pending host request and return cancellation", async () => workspace(async ({ root, options, config }) => {
  const script = path.join(root, "cancel-fixture.mjs");
  await fs.writeFile(script, `
import readline from 'node:readline';
const send = value => process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
let outer;
readline.createInterface({input:process.stdin}).on('line', line => {
 const m=JSON.parse(line);
 if(m.id==='stdio-host'&&!m.method){send({id:outer,result:{content:[{type:'text',text:JSON.stringify(m)}]}});return;}
 if(m.method==='initialize'){send({id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'cancel-fixture',version:'1'}}});return;}
 if(m.method==='tools/list'){send({id:m.id,result:{tools:[]}});return;}
 if(m.method==='tools/call'){outer=m.id;send({id:'stdio-host',method:'elicitation/create',params:{message:'Question'}});setTimeout(()=>send({method:'notifications/cancelled',params:{requestId:'stdio-host'}}),40);}
});`);
  await config({ transport: "stdio", command: process.execPath, args: [script] }); let signal;
  const connection = await connectMcp(root, "fixture", { ...options, incoming: { capabilities: { elicitation: { form: {} } }, request: async (_method, _params, value) => { signal = value; return new Promise(() => {}); } } });
  try { const reply = JSON.parse((await connection.callTool("ask", {})).content[0].text); assert.equal(reply.error.code, -32800); assert.equal(signal.aborted, true); assert.deepEqual(await connection.listTools(), []); }
  finally { await connection.close(); }
}));

test("concurrent stdio RPC cancellation preserves host work belonging to another pending request", async () => workspace(async ({ root, options, config }) => {
  const script = path.join(root, "concurrent-fixture.mjs");
  await fs.writeFile(script, `
import readline from 'node:readline';
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n'); let requestA;
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);
 if(m.method==='initialize')return send({id:m.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'concurrent-fixture',version:'1'}}});
 if(m.method==='tools/call'&&m.params.name==='A'){requestA=m.id;send({id:'host-A',method:'elicitation/create',params:{message:'Input for A'}});return;}
 if(m.id==='host-A'&&!m.method)return send({id:requestA,result:{content:[{type:'text',text:m.error?'A was cancelled':'A survived'}]}});
});`);
  await config({ transport: "stdio", command: process.execPath, args: [script] }); let signal; let release;
  const connection = await connectMcp(root, "fixture", { ...options, incoming: { capabilities: { elicitation: { form: {} } }, request: async (_method, _params, value) => { signal = value; return new Promise((resolve) => { release = () => resolve({ result: { action: "decline" } }); }); } } });
  try {
    const operationA = connection.callTool("A", {}, { timeoutMs: 2000 }).then((value) => ({ value }), (error) => ({ error })); await until(() => signal);
    await assert.rejects(connection.callTool("B", {}, { timeoutMs: 100 }), /timed out/); assert.equal(signal.aborted, false);
    release(); const result = await operationA; assert.equal(result.error, undefined); assert.equal(result.value.content[0].text, "A survived");
    signal = undefined; const cancelA = new AbortController();
    const cancelledA = connection.callTool("A", {}, { signal: cancelA.signal }).then(() => undefined, (error) => error);
    await until(() => signal); cancelA.abort(); assert.equal((await cancelledA).name, "AbortError"); await until(() => signal.aborted);
  } finally { await connection.close(); }
}));
