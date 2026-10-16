import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { connectMcp, extensionCommand, setExtensionState } from "../dist/extensions/index.js";
import { createMcpClientHost } from "../dist/extensions/mcp-client-host.js";
import { parseModernTask, parseModernTaskHandle } from "../dist/extensions/mcp-tasks.js";
import { invokeMcpContext, mcpContextDefinitions } from "../dist/coding/mcp-context-tools.js";
import { createExtensionToolExecutor } from "../dist/coding/extension-tools.js";
import { StructuredAgentLoop } from "../dist/coding/agent-loop.js";
import { executeTuiCommand, parseTuiCommand } from "../dist/tui/commands.js";
import { initialState } from "../dist/tui/state.js";

const version = "2026-07-28", prefix = "io.modelcontextprotocol/", extension = `${prefix}tasks`;
const id = "fixture-task-6e17187d", complete = (value = {}) => ({ resultType: "complete", ...value });
const base = { taskId: id, status: "working", createdAt: "2026-10-17T01:00:00Z", lastUpdatedAt: "2026-10-17T01:00:00Z", ttlMs: 600_000, pollIntervalMs: 10 };
const capabilities = { tools: {}, extensions: { [extension]: {} } };
const form = { method: "elicitation/create", params: { mode: "form", message: "Choose a fixture label", requestedSchema: { type: "object", properties: { label: { type: "string" } }, required: ["label"], additionalProperties: false } } };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate) { const deadline = Date.now() + 5000; while (Date.now() < deadline) { const value = await predicate(); if (value) return value; await sleep(10); } throw new Error("Expected modern task fixture event was not received"); }

const stdioSource = `
import readline from 'node:readline';import {appendFileSync,readFileSync} from 'node:fs';
const [log,stateFile,mode]=process.argv.slice(2),subscriptions=new Set();
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);appendFileSync(log,JSON.stringify(m)+'\\n');if(m.id===undefined)return;
 const result=value=>send({id:m.id,result:value}),task=()=>JSON.parse(readFileSync(stateFile,'utf8'));
 if(m.method==='server/discover'){result({resultType:'complete',supportedVersions:['${version}'],capabilities:mode==='no-extension'?{tools:{}}:${JSON.stringify(capabilities)}});return;}
 if(m.method==='tools/list'){result({resultType:'complete',tools:[{name:'bridge',inputSchema:{type:'object'}}]});return;}
 if(m.method==='tools/call'){
   if(m.params.arguments.kind==='wait')return;
   if(m.params.arguments.kind==='immediate'){result({resultType:'complete',content:[{type:'text',text:'immediate fixture result'}]});return;}
   if(m.params.arguments.kind==='mrtr'&&!m.params.inputResponses){result({resultType:'input_required',inputRequests:{shared:${JSON.stringify(form)}},requestState:'opaque-pre-task'});return;}
   result({resultType:'task',...task()});return;
 }
 if(m.method==='subscriptions/listen'){subscriptions.add(m.id);send({method:'notifications/subscriptions/acknowledged',params:{_meta:{'${prefix}subscriptionId':m.id},notifications:m.params.notifications}});return;}
 if(m.method==='tasks/get'){for(const subscription of subscriptions)send({method:'notifications/tasks',params:{...task(),_meta:{'${prefix}subscriptionId':subscription}}});result({resultType:'complete',...task()});return;}
 if(m.method==='tasks/update'||m.method==='tasks/cancel'){result({resultType:'complete'});return;}
 if(m.method==='resources/read'){result({resultType:'task',...task()});return;}
 send({id:m.id,error:{code:-32601,message:'Unsupported fixture method'}});
}).on('close',()=>process.exit(0));
`;

async function fixture(transport, run, mode = "normal") {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hive-modern-tasks-")), root = path.join(temporary, "project");
  const options = { trustStateDir: path.join(temporary, "trust") }, messages = [], streams = new Map();
  let releaseAcknowledgement; const acknowledged = new Promise((resolve) => { releaseAcknowledgement = resolve; });
  const stateFile = path.join(temporary, "task.json"), log = path.join(temporary, "messages.jsonl");
  let task = structuredClone(base), server, connection, fixtureFailure;
  const emit = (response, value) => response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", ...value })}\n\n`);
  await fs.mkdir(path.join(root, ".hive"), { recursive: true }); await fs.writeFile(stateFile, JSON.stringify(task)); await fs.writeFile(log, "");
  try {
    let descriptor;
    if (transport === "stdio") {
      const script = path.join(temporary, "task-fixture.mjs"); await fs.writeFile(script, stdioSource);
      descriptor = { transport, command: process.execPath, args: [script, log, stateFile, mode], timeoutMs: 5000 };
    } else {
      server = http.createServer(async (request, response) => {
        try {
          assert.equal(request.method, "POST"); let body = ""; for await (const chunk of request) body += chunk;
          const message = JSON.parse(body); messages.push({ ...message, http: request.method, headers: request.headers });
          const reply = (value) => { response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: value })); };
          if (message.id === undefined) { response.writeHead(202).end(); return; }
          if (message.method === "server/discover") { reply(complete({ supportedVersions: [version], capabilities: mode === "no-extension" ? { tools: {}, resources: {} } : { ...capabilities, resources: {} } })); return; }
          if (message.method === "tools/list") { reply(complete({ tools: [{ name: "bridge", inputSchema: { type: "object" } }] })); return; }
          if (message.method === "tools/call") {
            if (message.params.arguments.kind === "wait") { response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders(); streams.set(message.id, { response, message }); response.on("close", () => streams.delete(message.id)); return; }
            if (message.params.arguments.kind === "immediate") { reply(complete({ content: [{ type: "text", text: "immediate fixture result" }] })); return; }
            if (message.params.arguments.kind === "mrtr" && !message.params.inputResponses) { reply({ resultType: "input_required", inputRequests: { shared: form }, requestState: "opaque-pre-task" }); return; }
            reply({ resultType: "task", ...task }); return;
          }
          if (message.method === "subscriptions/listen") {
            response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders(); streams.set(message.id, { response, message }); response.on("close", () => streams.delete(message.id));
            if (mode === "delayed-ack") await acknowledged;
            const notifications = mode === "unrequested-task" ? { taskIds: ["not-requested"] } : message.params.notifications;
            emit(response, { method: "notifications/subscriptions/acknowledged", params: { _meta: { [`${prefix}subscriptionId`]: message.id }, notifications } }); return;
          }
          if (message.method === "tasks/get") {
            for (const [subscription, stream] of streams) if (stream.message.method === "subscriptions/listen") emit(stream.response, { method: "notifications/tasks", params: { ...task, _meta: { [`${prefix}subscriptionId`]: subscription } } });
            reply(complete(task)); return;
          }
          if (message.method === "tasks/update" || message.method === "tasks/cancel") { reply(complete()); return; }
          if (message.method === "resources/read") { reply({ resultType: "task", ...task }); return; }
          response.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported fixture method" } }));
        } catch (error) { fixtureFailure = error; if (!response.headersSent) response.writeHead(500); response.end(); }
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); descriptor = { transport, url: `http://127.0.0.1:${server.address().port}/mcp`, timeoutMs: 5000 };
    }
    await fs.writeFile(path.join(root, ".hive", "extensions.json"), JSON.stringify({ version: 1, mcpServers: { fixture: descriptor } }));
    await setExtensionState(root, "mcp:fixture", "trust", options); await setExtensionState(root, "mcp:fixture", "enable", options);
    const context = {
      root, options, streams, releaseAcknowledgement,
      connect: async (additional = {}) => { connection = await connectMcp(root, "fixture", { ...options, ...additional }); return connection; },
      messages: async () => transport === "http" ? messages : (await fs.readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
      setTask: async (value) => { task = { ...base, ...value }; await fs.writeFile(stateFile, JSON.stringify(task)); },
    };
    await run(context); if (fixtureFailure) throw fixtureFailure;
  } finally {
    await connection?.close(); for (const stream of streams.values()) stream.response.end();
    if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir())); assert.ok(path.basename(temporary).startsWith("hive-modern-tasks-")); await fs.rm(temporary, { recursive: true, force: true });
  }
}

test("modern task schema keeps millisecond fields and distinguishes detailed terminal/input states", () => {
  assert.deepEqual(parseModernTaskHandle(base), { ...base, protocolVersion: version });
  assert.throws(() => parseModernTaskHandle({ ...base, status: ["working"] }), /Invalid MCP task status/);
  assert.equal(parseModernTask({ ...base, status: "completed", result: { content: [], isError: true } }).result.isError, true);
  assert.equal(parseModernTask({ ...base, status: "failed", error: { code: -32603, message: "fixture fault" } }).error.code, -32603);
  for (const value of [{ ...base, ttlMs: -1 }, { ...base, status: ["working"] }, { ...base, status: "completed" }, { ...base, status: "input_required" }, { ...base, status: "failed", error: { code: "bad", message: "invalid" } }, { ...base, ttlMs: undefined, ttl: 20 }]) assert.throws(() => parseModernTask(value));
  assert.throws(() => parseModernTask({ ...base, status: "input_required", inputRequests: { unsafe: { method: "shell/run", params: {} } } }), /Unsupported MCP task input/);
});

for (const transport of ["http", "stdio"]) {
  test(`modern ${transport} server-directed task creation uses one submission and no legacy task flag`, async () => fixture(transport, async (context) => {
    const connection = await context.connect(); const result = await connection.callTool("bridge", { operation: "start" });
    assert.equal(result.task.taskId, id); assert.equal(result.task.ttlMs, base.ttlMs); assert.equal(result.task.protocolVersion, version); assert.equal(result.task.ttl, undefined);
    const requests = await context.messages(), calls = requests.filter((entry) => entry.method === "tools/call"); assert.equal(calls.length, 1); assert.equal(calls[0].params.task, undefined); assert.deepEqual(calls[0].params._meta[`${prefix}clientCapabilities`].extensions, { [extension]: {} });
    assert.equal(requests.some((entry) => entry.method.startsWith("tasks/")), false); await assert.rejects(connection.callToolTask("bridge", {}, { ttl: 200 }), /server-selected ttlMs/); assert.equal((await context.messages()).filter((entry) => entry.method === "tools/call").length, 1);
  }));

  test(`modern ${transport} task-call also accepts an immediate result without resubmitting`, async () => fixture(transport, async (context) => {
    const connection = await context.connect(); assert.equal((await connection.callToolTask("bridge", { kind: "immediate" })).content[0].text, "immediate fixture result");
    assert.equal((await context.messages()).filter((entry) => entry.method === "tools/call").length, 1);
  }));

  test(`modern ${transport} status/result use tasks/get and cancellation stays an acknowledgment`, async () => fixture(transport, async (context) => {
    const connection = await context.connect(); assert.equal((await connection.getTask(id)).status, "working"); await assert.rejects(connection.getTaskResult(id), /is working/);
    assert.deepEqual(await connection.cancelTask(id), { taskId: id, cancellationRequested: true }); assert.equal((await connection.getTask(id)).status, "working");
    await context.setTask({ status: "completed", result: { content: [{ type: "text", text: "real asynchronous result" }], isError: true } });
    assert.equal((await connection.getTaskResult(id)).content[0].text, "real asynchronous result"); assert.equal((await connection.getTaskResult(id)).isError, true);
    await context.setTask({ status: "failed", error: { code: -32603, message: "fixture execution failure" } }); await assert.rejects(connection.getTaskResult(id), /failed \(-32603\)/);
    await assert.rejects(connection.listTasks(), /do not support tasks\/list/);
    const requests = await context.messages(); assert.equal(requests.some((entry) => ["tasks/list", "tasks/result"].includes(entry.method)), false);
    if (transport === "http") for (const request of requests.filter((entry) => entry.method.startsWith("tasks/"))) { assert.equal(request.headers["mcp-name"], id); assert.equal(request.headers["mcp-method"], request.method); }
  }));

  test(`modern ${transport} task input uses approved host form, roots and sampling exactly once`, async () => fixture(transport, async (context) => {
    let forms = 0, samples = 0, approvals = 0;
    const host = createMcpClientHost({ serverId: "mcp:fixture", requestInput: async () => { forms += 1; return { action: "accept", content: { label: "owner fixture response" } }; }, requestPermission: async () => { approvals += 1; return true; }, resolveSampling: async () => ({ providerId: "local-fixture", model: "fixture-model", complete: async () => { samples += 1; return "approved fixture sample"; } }) });
    const connection = await context.connect({ incoming: host, roots: true });
    await context.setTask({ status: "input_required", inputRequests: { owner: form, roots: { method: "roots/list", params: {} }, sample: { method: "sampling/createMessage", params: { messages: [{ role: "user", content: { type: "text", text: "Summarize this fixture" } }], maxTokens: 20 } } } });
    assert.deepEqual(await connection.updateTask(id), { taskId: id, updatedInputKeys: ["owner", "roots", "sample"] });
    assert.deepEqual(await connection.updateTask(id), { taskId: id, updatedInputKeys: [] }); assert.equal(forms, 1); assert.equal(samples, 1); assert.equal(approvals, 2);
    const update = (await context.messages()).filter((entry) => entry.method === "tasks/update"); assert.equal(update.length, 1); assert.equal(update[0].params.inputResponses.owner.content.label, "owner fixture response"); assert.equal(update[0].params.inputResponses.roots.roots[0].name, "Project"); assert.equal(update[0].params.inputResponses.sample.content.text, "approved fixture sample"); assert.equal(update[0].params.requestState, undefined); assert.equal(update[0].params.inputResponses.owner._meta, undefined);
    await context.setTask({ status: "input_required", inputRequests: { owner: { ...form, params: { ...form.params, message: "Different input for reused key" } } } }); await assert.rejects(connection.updateTask(id), /reused an input request key/); assert.equal(forms, 1);
  }));

  test(`modern ${transport} MRTR and task input keys have separate lifetimes`, async () => fixture(transport, async (context) => {
    let forms = 0; const host = createMcpClientHost({ serverId: "mcp:fixture", requestInput: async () => { forms += 1; return { action: "decline" }; } });
    const connection = await context.connect({ incoming: host }); assert.equal((await connection.callTool("bridge", { kind: "mrtr" })).task.taskId, id);
    await context.setTask({ status: "input_required", inputRequests: { shared: form } }); await connection.updateTask(id); assert.equal(forms, 2);
    const messages = await context.messages(), calls = messages.filter((entry) => entry.method === "tools/call"); assert.equal(calls.length, 2); assert.equal(calls[1].params.requestState, "opaque-pre-task"); assert.equal(calls[1].params.inputResponses.shared.action, "decline"); assert.equal(messages.filter((entry) => entry.method === "tasks/update").length, 1);
  }));

  test(`modern ${transport} task input cancellation and timeout release no continuation`, async () => fixture(transport, async (context) => {
    let prompted = 0; const host = createMcpClientHost({ serverId: "mcp:fixture", requestInput: async (_request, signal) => { prompted += 1; return new Promise((resolve) => { signal.addEventListener("abort", () => resolve({ action: "cancel" }), { once: true }); }); } });
    const connection = await context.connect({ incoming: host }); await context.setTask({ status: "input_required", inputRequests: { owner: form } });
    const controller = new AbortController(), pending = connection.updateTask(id, { signal: controller.signal }), rejected = assert.rejects(pending, (error) => error.name === "AbortError"); await until(() => prompted === 1); controller.abort(); await rejected;
    await assert.rejects(connection.updateTask(id, { timeoutMs: 100 }), /tasks\/update timed out after 100ms/); assert.equal(prompted, 2); const messages = await context.messages(); assert.equal(messages.some((entry) => entry.method === "tasks/update" || entry.method === "tasks/cancel"), false);
  }));

  test(`modern ${transport} trust revocation after owner input prevents tasks/update`, async () => fixture(transport, async (context) => {
    let release, prompted = false; const host = createMcpClientHost({ serverId: "mcp:fixture", requestInput: async () => { prompted = true; return new Promise((resolve) => { release = resolve; }); } });
    const connection = await context.connect({ incoming: host }); await context.setTask({ status: "input_required", inputRequests: { owner: form } });
    const pending = connection.updateTask(id), rejected = assert.rejects(pending, /trust|configuration|not authorized/); await until(() => prompted); await setExtensionState(context.root, "mcp:fixture", "untrust", context.options); release({ action: "accept", content: { label: "late owner response" } }); await rejected;
    assert.equal((await context.messages()).some((entry) => entry.method === "tasks/update"), false);
  }));

  test(`modern ${transport} task notifications require taskIds and carry complete state`, async () => fixture(transport, async (context) => {
    const connection = await context.connect(), notifications = []; connection.onTaskStatus((task) => notifications.push(task)); await connection.subscribeTask(id); await connection.startBackground();
    await context.setTask({ status: "completed", result: { content: [{ type: "text", text: "pushed completion" }] } }); await connection.getTask(id); await until(() => notifications.length); assert.equal(notifications[0].result.content[0].text, "pushed completion");
    const subscription = (await context.messages()).find((entry) => entry.method === "subscriptions/listen"); assert.deepEqual(subscription.params.notifications.taskIds, [id]);
    await connection.unsubscribeTask(id); await connection.stopBackground();
  }));

  test(`modern ${transport} malformed task IDs and unavailable input never start work`, async () => fixture(transport, async (context) => {
    const connection = await context.connect(); await assert.rejects(connection.getTask("invalid\nheader"), /task id/); await context.setTask({ taskId: "other-task" }); await assert.rejects(connection.getTask(id), /id does not match/);
    await context.setTask({ status: "input_required", inputRequests: { owner: form } }); await assert.rejects(connection.updateTask(id), /input is unavailable/); assert.equal((await context.messages()).some((entry) => entry.method === "tasks/update"), false);
  }));

  test(`modern ${transport} absent extension refuses task responses without downgrading`, async () => fixture(transport, async (context) => {
    const connection = await context.connect(); await assert.rejects(connection.callTool("bridge", {}), /Invalid or unsupported MCP resultType/); await assert.rejects(connection.getTask(id), /does not advertise/); assert.equal((await context.messages()).some((entry) => entry.method === "initialize"), false);
  }, "no-extension"));

  test(`modern ${transport} approved agent context advertises and executes task continuation/subscriptions`, async () => fixture(transport, async (context) => {
    const host = createMcpClientHost({ serverId: "mcp:fixture", requestInput: async () => ({ action: "decline" }) }), connection = await context.connect({ incoming: host });
    const definitions = mcpContextDefinitions("mcp:fixture", connection.capabilities), operations = definitions.map((entry) => entry.operation);
    for (const operation of ["task_status", "task_result", "cancel_task", "continue_task", "subscribe_task", "unsubscribe_task"]) assert.ok(operations.includes(operation)); assert.equal(operations.includes("list_tasks"), false);
    const continuation = definitions.find((entry) => entry.operation === "continue_task"); assert.deepEqual(Object.keys(continuation.definition.inputSchema.properties), ["taskId"]);
    await context.setTask({ status: "input_required", inputRequests: { owner: form } });
    assert.deepEqual(await invokeMcpContext(connection, "continue_task", { taskId: id }), { taskId: id, updatedInputKeys: ["owner"] });
    await assert.rejects(invokeMcpContext(connection, "continue_task", { taskId: id, inputResponses: { owner: { action: "accept" } } }), /unsupported field/);
    assert.deepEqual(await invokeMcpContext(connection, "subscribe_task", { taskId: id }), { subscribedTask: id }); assert.deepEqual(await invokeMcpContext(connection, "unsubscribe_task", { taskId: id }), { unsubscribedTask: id }); await connection.stopBackground();
  }));

  test(`modern ${transport} command frontdoor submits once, continues through host, and cancels task watching`, async () => fixture(transport, async (context) => {
    const host = createMcpClientHost({ serverId: "mcp:fixture", requestInput: async () => ({ action: "accept", content: { label: "command owner answer" } }) }), options = { ...context.options, mcpHost: () => host };
    const created = JSON.parse((await extensionCommand(context.root, "mcp", "task-call fixture bridge {}", options))[0]); assert.equal(created.task.taskId, id);
    await context.setTask({ status: "input_required", inputRequests: { owner: form } });
    const continued = JSON.parse((await extensionCommand(context.root, "mcp", `task-continue fixture ${id}`, options))[0]); assert.deepEqual(continued, { taskId: id, updatedInputKeys: ["owner"] }); assert.equal(JSON.stringify(continued).includes("command owner answer"), false);
    const controller = new AbortController(), progress = [], watching = extensionCommand(context.root, "mcp", `task-subscribe fixture ${id}`, { ...options, signal: controller.signal, onProgress: (line) => progress.push(line) }), rejected = assert.rejects(watching, (error) => error.name === "AbortError"); await until(() => progress.some((line) => line.includes("subscribed and watching"))); controller.abort(); await rejected;
    const messages = await context.messages(); assert.equal(messages.filter((entry) => entry.method === "tools/call").length, 1); assert.equal(messages.filter((entry) => entry.method === "tasks/update").length, 1);
  }));
}

test("modern HTTP invalid subscription acknowledgments reject unrequested task IDs", async () => fixture("http", async (context) => {
  const connection = await context.connect(); await connection.subscribeTask(id); await assert.rejects(connection.startBackground(), /unrequested task subscription/);
}, "unrequested-task"));

test("modern HTTP creation timeout does not replay or cancel an unknown durable task", async () => fixture("http", async (context) => {
  const connection = await context.connect(); await assert.rejects(connection.callTool("bridge", { kind: "wait" }, { timeoutMs: 100 }), /timed out/); await until(() => context.streams.size === 0);
  const messages = await context.messages(); assert.equal(messages.filter((entry) => entry.method === "tools/call").length, 1); assert.equal(messages.some((entry) => entry.method === "tasks/cancel" || entry.http === "GET" || entry.method === "notifications/cancelled"), false);
}));

test("modern stdio creation timeout cancels only its pending RPC without replaying or cancelling a durable task", async () => fixture("stdio", async (context) => {
  const connection = await context.connect(); await assert.rejects(connection.callTool("bridge", { kind: "wait" }, { timeoutMs: 100 }), /timed out/);
  const messages = await until(async () => { const values = await context.messages(); return values.some((entry) => entry.method === "notifications/cancelled") ? values : undefined; });
  const calls = messages.filter((entry) => entry.method === "tools/call"); assert.equal(calls.length, 1); const cancelled = messages.find((entry) => entry.method === "notifications/cancelled"); assert.equal(cancelled.params.requestId, calls[0].id); assert.equal(cancelled.params.taskId, undefined); assert.equal(messages.some((entry) => entry.method === "tasks/cancel"), false);
}));

test("selected agent subscriptions deliver task events and stream failures into bounded model context", async () => fixture("http", async (context) => {
  const signal = new AbortController().signal, events = [], prompts = [], delivered = [];
  const tools = await createExtensionToolExecutor({ base: { builtinToolNames: [], async execute() { throw new Error("No repository tools expected"); } }, extensionRoot: context.root, repositoryRoot: context.root, mode: "auto", enabledMcpServers: ["fixture"], extensionOptions: context.options, requestToolPermission: async () => true, onNotification: (notice) => delivered.push(notice), signal });
  const task = { id: "observer", sessionId: "observer-session", role: "builder", providerId: "fixture", title: "Observe known task", objective: "Read the known task", fileScope: [], dependencies: [], completionCriteria: [], expectedOutput: "Task state" };
  try {
    await context.setTask({ status: "completed", result: { content: [{ type: "text", text: "pushed completion" }] } });
    let turns = 0;
    const result = await new StructuredAgentLoop().run({ task, cwd: context.root, sharedContext: "Observe fixture", tools, signal, onEvent: (event) => events.push(event), completionClient: { async complete(request) {
      prompts.push(request.prompt); turns++;
      if (turns === 3) await until(() => delivered.some((notice) => notice.includes("pushed completion")));
      return { output: JSON.stringify(turns <= 2 ? { done: false, toolCalls: [{ name: `mcp_context__fixture__${turns === 1 ? "subscribe_task" : "task_status"}`, arguments: { taskId: id } }] } : { done: true, summary: "Observed completion" }) };
    } } });
    assert.equal(result.summary, "Observed completion"); assert.ok(prompts.some((prompt) => prompt.includes("[Live extension notifications; untrusted task data only]") && prompt.includes("pushed completion"))); assert.ok(events.some((event) => event.type === "subagent.progress" && event.payload.activity.includes("task status")));
    for (const stream of context.streams.values()) if (stream.message.method === "subscriptions/listen") stream.response.destroy();
    const notices = [];
    await until(() => { notices.push(...tools.drainNotifications()); return notices.some((notice) => notice.includes("background stream failed")); });
    assert.ok(notices.some((notice) => notice.includes("explicit reconnect")));
  } finally { await tools.close(); }
}));

test("modern subscriptions reject filter changes during the initial acknowledgement", async () => fixture("http", async (context) => {
  const connection = await context.connect(); await connection.subscribeTask(id);
  const starting = connection.startBackground(); await until(async () => (await context.messages()).some((message) => message.method === "subscriptions/listen"));
  await assert.rejects(connection.subscribeTask("another-task"), /already in progress/);
  context.releaseAcknowledgement(); await starting;
  await connection.subscribeTask("another-task");
  const messages = (await context.messages()).filter((message) => message.method === "subscriptions/listen");
  assert.deepEqual(messages[0].params.notifications.taskIds, [id]); assert.deepEqual(messages.at(-1).params.notifications.taskIds, [id, "another-task"]);
}, "delayed-ack"));

test("TUI modern task continuation gets host input approval and task watching is cancellable", async () => fixture("http", async (context) => {
  let state = initialState(), approvals = 0, inputs = 0;
  await context.setTask({ status: "input_required", inputRequests: { owner: form } });
  const options = { extensionOptions: context.options, requestToolPermission: async () => { approvals++; return true; }, requestMcpInput: async () => { inputs++; return { action: "accept", content: { label: "approved TUI answer" } }; } };
  const continuation = await executeTuiCommand(parseTuiCommand(`/mcp task-continue fixture ${id}`), state, context.root, (update) => { state = update(state); }, options);
  assert.ok(continuation.runtime); await continuation.runtime.completion;
  assert.ok(approvals >= 1); assert.equal(inputs, 1); assert.equal((await context.messages()).filter((message) => message.method === "tasks/update").length, 1);
  const watching = await executeTuiCommand(parseTuiCommand(`/mcp task-subscribe fixture ${id}`), state, context.root, (update) => { state = update(state); }, options);
  assert.ok(watching.runtime); await until(() => state.outputLines.some((line) => line.includes("subscribed and watching")));
  watching.runtime.cancel(); await watching.runtime.completion; await until(() => context.streams.size === 0);
}));
