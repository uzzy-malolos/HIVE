import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createMcpClientHost, validateMcpUserInput } from "../dist/extensions/mcp-client-host.js";
import { createCodingMcpHostFactory } from "../dist/coding/mcp-host.js";
import { connectMcp } from "../dist/extensions/mcp.js";
import { setExtensionState } from "../dist/extensions/catalog.js";
import { ProviderRouter } from "../dist/coding/provider-router.js";
import { ProviderRegistry } from "../dist/providers/registry.js";
import { createQueenSession } from "../dist/coding/runtime.js";
import { runQueenTuiSession } from "../dist/tui/runtime-adapter.js";

const signal = () => new AbortController().signal;
const sampling = (overrides = {}) => ({ messages: [{ role: "user", content: { type: "text", text: "Explain the supplied fixture fact" } }], maxTokens: 37, ...overrides });
const schema = { type: "object", properties: {
  title: { type: "string", minLength: 2, maxLength: 30 }, count: { type: "integer", minimum: 1, maximum: 9 }, ratio: { type: "number", minimum: 0, maximum: 1 }, enabled: { type: "boolean" },
  choice: { type: "string", enum: ["one", "two"] }, titled: { type: "string", oneOf: [{ const: "small", title: "Small" }, { const: "large", title: "Large" }] },
  tags: { type: "array", items: { type: "string", enum: ["a", "b", "c"] }, minItems: 1, maxItems: 2 },
}, required: ["title", "count", "ratio", "enabled", "choice", "titled", "tags"], additionalProperties: false };
const formContent = { title: "Actual owner answer", count: 4, ratio: 0.5, enabled: true, choice: "two", titled: "large", tags: ["a", "c"] };
const form = (requestedSchema = schema) => ({ mode: "form", message: "Choose the fixture options", requestedSchema });
const urlRequest = { mode: "url", message: "Complete the external action manually", url: "https://example.test/authorize?state=fixture", elicitationId: "fixture-consent" };
const decode = (result) => JSON.parse(result.content[0].text);
const deadline = (promise, label, ms = 5000) => {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} was not observed`)), ms); })]).finally(() => clearTimeout(timer));
};
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };

const stdioBridge = `
import readline from 'node:readline';
import {appendFileSync} from 'node:fs';
const log=process.argv[2], pending=new Map();let sequence=0;
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{
 const message=JSON.parse(line);appendFileSync(log,JSON.stringify(message)+'\\n');
 if(!message.method){const original=pending.get(message.id);if(original!==undefined){pending.delete(message.id);send({id:original,result:{content:[{type:'text',text:JSON.stringify(message)}]}});}return;}
 if(message.method==='initialize'){send({id:message.id,result:{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'real-host-stdio-fixture',version:'1'}}});return;}
 if(message.method==='tools/list'){send({id:message.id,result:{tools:[{name:'bridge',inputSchema:{type:'object'}}]}});return;}
 if(message.method==='tools/call'){const id='host-request-'+(++sequence);pending.set(id,message.id);send({id,method:message.params.arguments.method,params:message.params.arguments.params});return;}
 if(message.id!==undefined)send({id:message.id,result:{}});
}).on('close',()=>process.exit(0));
`;

async function workspace(run) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hive-mcp-client-host-"));
  const root = path.join(temporary, "project"); await fs.mkdir(path.join(root, ".hive"), { recursive: true });
  const extensionOptions = { trustStateDir: path.join(temporary, "trust") };
  const configure = async (entry) => {
    await fs.writeFile(path.join(root, ".hive", "extensions.json"), JSON.stringify({ version: 1, mcpServers: { fixture: entry } }));
    await setExtensionState(root, "mcp:fixture", "trust", extensionOptions); await setExtensionState(root, "mcp:fixture", "enable", extensionOptions);
  };
  try { await run({ root, extensionOptions, configure }); }
  finally {
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(temporary).startsWith("hive-mcp-client-host-"));
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

async function protocolFixture(transport, run) {
  await workspace(async (context) => {
    const messages = [], bridges = new Map(); const streams = new Set(); let server; let fixtureFailure;
    let sequence = 0;
    let readMessages;
    if (transport === "stdio") {
      const script = path.join(context.root, "mcp-client-host-fixture.mjs"), log = path.join(context.root, "mcp-client-host-messages.jsonl");
      await fs.writeFile(script, stdioBridge); await fs.writeFile(log, "");
      await context.configure({ transport: "stdio", command: process.execPath, args: [script, log], timeoutMs: 10_000 });
      readMessages = async () => (await fs.readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
    } else {
      const emit = (response, value) => response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", ...value })}\n\n`);
      server = http.createServer(async (request, response) => {
        try {
          if (request.method === "DELETE") { messages.push({ http: "DELETE" }); response.writeHead(200).end(); return; }
          if (request.method === "GET") { messages.push({ http: "GET" }); response.writeHead(405).end(); return; }
          let body = ""; for await (const chunk of request) body += chunk;
          const message = JSON.parse(body); messages.push(message);
          if (!message.method) {
            response.writeHead(202).end(); const bridge = bridges.get(message.id);
            if (bridge) { bridges.delete(message.id); emit(bridge.response, { id: bridge.id, result: { content: [{ type: "text", text: JSON.stringify(message) }] } }); bridge.response.end(); }
            return;
          }
          if (message.id === undefined) { response.writeHead(202).end(); return; }
          if (message.method === "tools/call") {
            const id = `http-host-request-${++sequence}`;
            response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders();
            streams.add(response); response.on("close", () => streams.delete(response));
            bridges.set(id, { id: message.id, response });
            emit(response, { id, method: message.params.arguments.method, params: message.params.arguments.params }); return;
          }
          const result = message.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "real-host-http-fixture", version: "1" } } : message.method === "tools/list" ? { tools: [{ name: "bridge", inputSchema: { type: "object" } }] } : {};
          response.writeHead(200, { "content-type": "application/json", ...(message.method === "initialize" ? { "mcp-session-id": "host-fixture-session" } : {}) });
          response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
        } catch (error) { fixtureFailure = error; response.writeHead(500).end(); }
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      await context.configure({ transport: "http", url: `http://127.0.0.1:${server.address().port}/mcp`, timeoutMs: 10_000 });
      readMessages = async () => messages;
    }
    let connection;
    const connect = async (incoming) => { connection = await connectMcp(context.root, "fixture", { ...context.extensionOptions, incoming }); return connection; };
    try {
      await run({ ...context, connect, readMessages, async invoke(method, params, options) { return decode(await connection.callTool("bridge", { method, params }, options)); } });
      if (fixtureFailure) throw fixtureFailure;
    } finally {
      await connection?.close();
      for (const stream of streams) stream.end();
      if (server) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
    }
  });
}

async function modelFixture(context, run) {
  const calls = []; const firstGeneration = deferred(), closedGeneration = deferred(); let failPrimary = false, stallPrimary = false, codingMode = false;
  const keyName = "HIVE_MCP_HOST_FIXTURE_KEY", key = "opaque-owner-fixture-value-67890";
  const previous = process.env[keyName]; process.env[keyName] = key;
  const server = http.createServer(async (request, response) => {
    const which = request.url.startsWith("/fallback/") ? "fallback" : "primary";
    try {
      if (request.method === "GET") { calls.push({ which, kind: "health", authorization: request.headers.authorization }); response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "selected-fixture-model" }] })); return; }
      let raw = ""; for await (const part of request) raw += part;
      const body = JSON.parse(raw); calls.push({ which, kind: "generation", body, authorization: request.headers.authorization }); firstGeneration.resolve(body);
      response.on("close", () => { if (!response.writableEnded) closedGeneration.resolve(true); });
      if (which === "primary" && stallPrimary) { response.writeHead(200, { "content-type": "application/json" }); response.flushHeaders(); return; }
      response.setHeader("content-type", "application/json");
      if (which === "primary" && failPrimary) { response.writeHead(500); response.end(JSON.stringify({ error: { message: "intentional primary generation failure" } })); return; }
      const system = body.messages.find((message) => message.role === "system")?.content ?? "", prompt = body.messages.find((message) => message.role === "user")?.content ?? "";
      let output = `Private generated fixture answer; credential echo ${key}`;
      if (codingMode && system.includes("HIVE Planner")) output = JSON.stringify({ summary: "Exercise approved MCP host requests", architecture: "One scoped host-integration task", risks: [], acceptanceCriteria: ["MCP host callbacks completed"], validationCommands: ["node --version"], tasks: [{ key: "host", role: "builder", title: "Invoke host callbacks", objective: "Invoke the selected MCP host without accessing unrelated data", dependencies: [], fileScope: ["README.md"], expectedOutput: "Actual callback results", completionCriteria: ["Sampling and form callbacks observed"], validationCommands: [] }] });
      else if (codingMode && system.includes("HIVE builder subagent") && !prompt.includes("[Tool results 1]")) output = JSON.stringify({ done: false, toolCalls: [
        { name: "mcp__fixture__bridge", arguments: { method: "sampling/createMessage", params: sampling({ maxTokens: 17 }) } },
        { name: "mcp__fixture__bridge", arguments: { method: "elicitation/create", params: form({ type: "object", properties: { projectName: { type: "string" } }, required: ["projectName"], additionalProperties: false }) } },
      ] });
      else if (codingMode && /HIVE (?:builder|validator|reviewer|fixer) subagent/u.test(system)) output = JSON.stringify({ done: true, summary: "Actual MCP host callbacks completed", data: { status: "passed", findings: [] } });
      if (body.stream) { response.writeHead(200, { "content-type": "text/event-stream" }); response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: output } }] })}\n\n`); response.end("data: [DONE]\n\n"); }
      else response.end(JSON.stringify({ choices: [{ message: { content: output } }], usage: { prompt_tokens: 7, completion_tokens: 5, total_tokens: 12 } }));
    } catch (error) { response.writeHead(500).end(JSON.stringify({ error: { message: error.message } })); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const providers = ["primary", "fallback"].map((id) => ({ id: `${id}-fixture`, name: id, kind: "local", baseUrl: `${base}/${id}/v1`, authType: "api-key", apiKeyEnv: keyName, defaultModel: `${id}-saved-default`, approved: true, createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z" }));
  const roles = { builder: { provider: "primary-fixture", model: "builder-saved-default" }, fallback: { provider: "fallback-fixture", model: "fallback-saved-default" } };
  const providerFile = path.join(context.root, ".hive", "providers.json"), roleFile = path.join(context.root, ".hive", "provider-roles.json");
  await fs.writeFile(providerFile, JSON.stringify(providers, null, 2)); await fs.writeFile(roleFile, JSON.stringify(roles, null, 2));
  const before = [await fs.readFile(providerFile), await fs.readFile(roleFile)];
  try {
    await run({ calls, key, keyName, firstGeneration: firstGeneration.promise, closedGeneration: closedGeneration.promise,
      setFailure() { failPrimary = true; }, setStall() { stallPrimary = true; }, setCodingMode() { codingMode = true; },
      host(extra = {}) { return createCodingMcpHostFactory({ cwd: context.root, provider: { providerId: "primary-fixture", model: "selected-fixture-model" }, requestPermission: async () => true, ...extra })("mcp:fixture"); },
    });
    assert.deepEqual(await fs.readFile(providerFile), before[0], "sampling must preserve provider defaults and metadata byte-for-byte");
    assert.deepEqual(await fs.readFile(roleFile), before[1], "sampling must preserve role defaults byte-for-byte");
  } finally { if (previous === undefined) delete process.env[keyName]; else process.env[keyName] = previous; server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

for (const transport of ["stdio", "http"]) {
  test(`${transport}: actual MCP requests perform approved local-provider sampling and form/URL elicitation`, async () => protocolFixture(transport, async (context) => modelFixture(context, async (model) => {
    const approvals = [], input = [];
    let formAction = "accept", urlAction = "accept";
    const host = model.host({ requestPermission: async (request) => { approvals.push(request); return true; }, requestInput: async (request) => { input.push(request); const action = request.mode === "form" ? formAction : urlAction; return action === "accept" ? { action, content: request.mode === "form" ? formContent : { ignoredPrivate: "must never reach server" } } : { action }; } });
    await context.connect(host);
    const generated = await context.invoke("sampling/createMessage", sampling({ modelPreferences: { hints: [{ name: "unapproved-other-model" }] }, includeContext: "none" }));
    assert.equal(generated.result.model, "selected-fixture-model"); assert.match(generated.result.content.text, /Private generated fixture answer/);
    assert.ok(!JSON.stringify(generated).includes(model.key)); assert.match(generated.result.content.text, /\[REDACTED\]/);
    assert.deepEqual(approvals.map((entry) => entry.tool), ["mcp_sampling", "mcp_sampling_result"]); assert.ok(approvals.every((entry) => entry.external && entry.alwaysAsk));
    assert.equal(approvals[0].input.maxTokens, 37); assert.equal(approvals[0].input.provider, "primary-fixture");
    const generations = model.calls.filter((entry) => entry.kind === "generation"); assert.equal(generations.length, 1); assert.equal(generations[0].which, "primary");
    assert.equal(generations[0].authorization, `Bearer ${model.key}`); assert.equal(generations[0].body.model, "selected-fixture-model"); assert.equal(generations[0].body.max_tokens, 37);
    assert.ok(!JSON.stringify(generations[0].body).includes("unapproved-other-model"));
    assert.equal((await context.invoke("elicitation/create", form())).result.content.title, formContent.title);
    assert.deepEqual((await context.invoke("elicitation/create", urlRequest)).result, { action: "accept" });
    assert.equal(input[1].url, urlRequest.url); assert.equal(input[1].elicitationId, "fixture-consent");
    for (const action of ["decline", "cancel"]) {
      formAction = action; urlAction = action;
      assert.deepEqual((await context.invoke("elicitation/create", form())).result, { action });
      assert.deepEqual((await context.invoke("elicitation/create", urlRequest)).result, { action });
    }
    const initialize = (await context.readMessages()).find((message) => message.method === "initialize");
    assert.deepEqual(initialize.params.capabilities, { sampling: {}, elicitation: { form: {}, url: {} } });
    assert.equal((await context.readMessages()).some((message) => message.http === "GET"), false);
  })));
}

test("declining sampling input does not generate; declining output never releases the generated answer", async () => protocolFixture("stdio", async (context) => modelFixture(context, async (model) => {
  let approveInput = false;
  await context.connect(model.host({ requestPermission: async (request) => request.tool === "mcp_sampling" && approveInput }));
  const declinedInput = await context.invoke("sampling/createMessage", sampling());
  assert.equal(declinedInput.error?.code, -32000); assert.equal(declinedInput.result, undefined); assert.equal(model.calls.filter((entry) => entry.kind === "generation").length, 0);
  approveInput = true;
  const declinedOutput = await context.invoke("sampling/createMessage", sampling());
  assert.equal(declinedOutput.error?.code, -32000); assert.equal(declinedOutput.result, undefined); assert.equal(model.calls.filter((entry) => entry.kind === "generation").length, 1);
  assert.ok(!JSON.stringify(declinedOutput).includes("Private generated fixture answer"));
  assert.ok(!(await context.readMessages()).some((message) => !message.method && JSON.stringify(message).includes("Private generated fixture answer")));
})));

test("sampling generation failure never invokes a configured fallback model or changes saved defaults", async () => protocolFixture("http", async (context) => modelFixture(context, async (model) => {
  model.setFailure(); await context.connect(model.host());
  const reply = await context.invoke("sampling/createMessage", sampling());
  assert.equal(reply.error?.code, -32602); assert.match(reply.error.message, /primary generation failure/);
  assert.equal(model.calls.filter((entry) => entry.which === "fallback").length, 0, "sampling must never health-check or generate with a fallback");
  assert.equal(model.calls.filter((entry) => entry.kind === "generation").length, 1);
})));

test("allowFallback:false without an explicit provider applies to role routes and output-token validation", async () => workspace(async (context) => modelFixture(context, async (model) => {
  model.setFailure(); const router = new ProviderRouter({ projectRoot: context.root, sessionId: "mcp-host-no-fallback" });
  await assert.rejects(router.complete({ role: "builder", allowFallback: false, maxOutputTokens: 29, prompt: "one approved request", signal: signal() }), /primary generation failure/);
  const chunks = [];
  await assert.rejects(router.streamComplete({ role: "builder", allowFallback: false, maxOutputTokens: 31, prompt: "one approved stream", signal: signal() }, (chunk) => chunks.push(chunk)), /primary generation failure/);
  assert.deepEqual(chunks, []);
  assert.equal(model.calls.filter((entry) => entry.which === "fallback").length, 0);
  // Existing router contract retries a pre-output streaming failure once buffered
  // with the same selected provider/model; allowFallback:false forbids route substitution.
  const generations = model.calls.filter((entry) => entry.kind === "generation");
  assert.deepEqual(generations.map((entry) => entry.body.max_tokens), [29, 31, 31]);
  assert.deepEqual(generations.map((entry) => entry.body.stream === true), [false, true, false]);
  assert.ok(generations.every((entry) => entry.which === "primary" && entry.body.model === "builder-saved-default"));
  assert.equal(model.calls.find((entry) => entry.kind === "generation").body.model, "builder-saved-default");
  const generated = model.calls.filter((entry) => entry.kind === "generation").length;
  for (const maxOutputTokens of [0, 32769, 1.5]) await assert.rejects(router.complete({ role: "builder", allowFallback: false, maxOutputTokens, prompt: "invalid token cap", signal: signal() }), /maxOutputTokens/);
  assert.equal(model.calls.filter((entry) => entry.kind === "generation").length, generated, "invalid caps must be refused before a generation POST");
})));

test("cancelling actual stdio sampling after the provider request is observed closes its HTTP response", async () => protocolFixture("stdio", async (context) => modelFixture(context, async (model) => {
  model.setStall(); await context.connect(model.host());
  const controller = new AbortController();
  const pending = context.invoke("sampling/createMessage", sampling(), { signal: controller.signal });
  const observed = await deadline(model.firstGeneration, "model generation POST"); assert.equal(observed.max_tokens, 37);
  controller.abort(); await assert.rejects(pending, { name: "AbortError" });
  assert.equal(await deadline(model.closedGeneration, "provider response socket close"), true);
  assert.equal(model.calls.filter((entry) => entry.kind === "generation").length, 1);
  assert.equal(model.calls.filter((entry) => entry.which === "fallback").length, 0);
})));

test("concurrent approvals reserve no more than the 32768-token connection budget", async () => {
  const barrier = deferred(); const arrived = deferred(); let approvals = 0, generated = 0;
  const host = createMcpClientHost({ serverId: "mcp:budget", resolveSampling: async () => ({ providerId: "selected", model: "selected", async complete() { generated++; return "bounded result"; } }), requestPermission: async (request) => { if (request.tool === "mcp_sampling") { if (++approvals === 9) arrived.resolve(); await barrier.promise; } return true; } });
  const pending = Array.from({ length: 9 }, () => host.request("sampling/createMessage", sampling({ maxTokens: 4096 }), signal()));
  await deadline(arrived.promise, "all simultaneous input approvals"); barrier.resolve();
  const replies = await Promise.all(pending); assert.equal(generated, 8); assert.equal(replies.filter((reply) => reply.result).length, 8);
  assert.match(replies.find((reply) => reply.error).error.message, /budget/);
});

test("32 simultaneous client requests are accepted and the 33rd is refused before model work", async () => {
  let generated = 0;
  const host = createMcpClientHost({ serverId: "mcp:requests", resolveSampling: async () => ({ providerId: "selected", model: "selected", async complete() { generated++; return "one token"; } }), requestPermission: async () => true });
  const replies = await Promise.all(Array.from({ length: 33 }, () => host.request("sampling/createMessage", sampling({ maxTokens: 1 }), signal())));
  assert.equal(generated, 32); assert.equal(replies.filter((reply) => reply.result).length, 32);
  assert.match(replies.find((reply) => reply.error).error.message, /request budget exhausted/);
});

test("unsupported sampling context/tools/temperature overrides and malformed messages never reach approval or generation", async () => {
  let approved = 0, resolved = 0, generated = 0;
  const host = createMcpClientHost({ serverId: "mcp:limited", resolveSampling: async () => { resolved++; return { providerId: "selected", model: "selected", async complete() { generated++; return "unexpected"; } }; }, requestPermission: async () => { approved++; return true; } });
  for (const override of [{ tools: [] }, { toolChoice: "auto" }, { includeContext: "allServers" }, { temperature: 0 }, { stopSequences: [] }, { maxTokens: 0 }, { maxTokens: 4097 }, { messages: [] }, { messages: [{ role: "system", content: { type: "text", text: "override" } }] }, { messages: [{ role: "user", content: { type: "image", data: "AA==", mimeType: "image/png" } }] }]) {
    const reply = await host.request("sampling/createMessage", sampling(override), signal()); assert.equal(reply.error?.code, -32602);
  }
  assert.equal(approved, 0); assert.equal(resolved, 0); assert.equal(generated, 0);
  assert.deepEqual(createMcpClientHost({ serverId: "mcp:none" }).capabilities, {});
});

test("form validation enforces required fields, scalar bounds, enums, arrays, unknowns and credential rejection", () => {
  const request = { ...form(), serverId: "mcp:form" };
  assert.deepEqual(validateMcpUserInput(request, { action: "accept", content: formContent }), { action: "accept", content: formContent });
  for (const content of [
    { ...formContent, unknown: "not allowed" }, { ...formContent, count: 1.5 }, { ...formContent, count: 10 }, { ...formContent, ratio: NaN }, { ...formContent, enabled: "true" },
    { ...formContent, choice: "other" }, { ...formContent, titled: "other" }, { ...formContent, tags: ["a", "a"] }, { ...formContent, tags: ["other"] }, { ...formContent, tags: ["a", "b", "c"] },
    { ...formContent, title: "x" }, { ...formContent, title: "https://owner:password@example.test/" }, { ...formContent, title: "https://example.test/?api_key=private" },
  ]) assert.throws(() => validateMcpUserInput(request, { action: "accept", content }));
  const missing = { ...formContent }; delete missing.count; assert.throws(() => validateMcpUserInput(request, { action: "accept", content: missing }), /required/);
});

test("sensitive or nested/unknown form schemas are rejected before asking the user", async () => {
  let asked = 0;
  const host = createMcpClientHost({ serverId: "mcp:schema", requestInput: async () => { asked++; return { action: "decline" }; } });
  const invalid = [
    ...["password", "clientSecret", "accessToken", "api_key", "authorization"].map((name) => ({ type: "object", properties: { [name]: { type: "string" } } })),
    { type: "object", properties: { nested: { type: "object", properties: { x: { type: "string" } } } } },
    { type: "object", properties: { x: { type: "string", unexpected: true } } },
    { type: "object", properties: { answer: { type: "string", title: "Password" } } },
    { type: "object", properties: { answer: { type: "string", description: "Enter your API key" } } },
    { type: "object", title: "Supply your access token", properties: { answer: { type: "string" } } },
    { type: "object", properties: { x: { type: "string" } }, required: ["unknown"] },
    { type: "object", properties: {}, unexpected: true },
    { type: "object", properties: {}, additionalProperties: true },
    { type: "object", properties: {}, additionalProperties: "false" },
    { type: "object", properties: { x: { type: "array", items: { type: "string", enum: ["a"], unexpected: true } } } },
  ];
  for (const requestedSchema of invalid) {
    const reply = await host.request("elicitation/create", form(requestedSchema), signal());
    assert.equal(reply.error?.code, -32602, `Invalid schema reached the human callback: ${JSON.stringify(requestedSchema)}`);
  }
  assert.equal(asked, 0);
});

test("URL elicitation is manual HTTPS without userinfo; accept/decline/cancel never submit content", async () => {
  let action = "accept", asked = 0;
  const host = createMcpClientHost({ serverId: "mcp:url", requestInput: async (request) => { asked++; assert.equal(request.mode, "url"); assert.equal(request.elicitationId, "fixture-consent"); return action === "accept" ? { action, content: { password: "never return this" } } : { action }; } });
  for (action of ["accept", "decline", "cancel"]) assert.deepEqual((await host.request("elicitation/create", urlRequest, signal())).result, { action });
  for (const url of ["http://example.test/", "https://user:password@example.test/", "https://user@example.test/", "javascript:alert(1)", "file:///private"]) assert.equal((await host.request("elicitation/create", { ...urlRequest, url }, signal())).error?.code, -32602);
  assert.equal(asked, 3);
});

test("human input cancellation propagates through a real HTTP server-initiated request", async () => protocolFixture("http", async (context) => {
  const asked = deferred(), aborted = deferred();
  const host = createMcpClientHost({ serverId: "mcp:fixture", requestInput: async (_request, inputSignal) => {
    asked.resolve(); return new Promise((_, reject) => { inputSignal.addEventListener("abort", () => { aborted.resolve(true); reject(new DOMException("Owner cancelled", "AbortError")); }, { once: true }); });
  } });
  await context.connect(host); const controller = new AbortController();
  const pending = context.invoke("elicitation/create", urlRequest, { signal: controller.signal });
  await deadline(asked.promise, "actual human input request"); controller.abort();
  await assert.rejects(pending, { name: "AbortError" }); assert.equal(await deadline(aborted.promise, "human input signal abort"), true);
}));

test("a supplied actual session router preserves its saved binding over a different current default", async () => protocolFixture("http", async (context) => modelFixture(context, async (model) => {
  const router = new ProviderRouter({ projectRoot: context.root, sessionId: "saved-mcp-route", sessionBindings: [{ role: "builder", providerId: "primary-fixture", model: "saved-session-selected-model" }] });
  const approvals = [];
  const host = model.host({ provider: undefined, router, requestPermission: async (request) => { approvals.push(request); return true; } });
  await context.connect(host);
  const response = await context.invoke("sampling/createMessage", sampling({ maxTokens: 23 }));
  assert.equal(response.result.model, "saved-session-selected-model"); assert.equal(approvals[0].input.model, "saved-session-selected-model");
  const generated = model.calls.filter((entry) => entry.kind === "generation"); assert.equal(generated.length, 1); assert.equal(generated[0].body.model, "saved-session-selected-model"); assert.equal(generated[0].body.max_tokens, 23);
  assert.equal((await new ProviderRegistry(context.root).getRoles()).builder.model, "builder-saved-default");
})));

for (const entrypoint of ["queen", "tui"]) {
  test(`${entrypoint}: the default MCP host uses the actual coding router and forwards owner input callbacks`, async () => protocolFixture("stdio", async (context) => modelFixture(context, async (model) => {
    const execute = promisify(execFile);
    await execute("git", ["init", "-b", "main"], { cwd: context.root });
    await execute("git", ["config", "user.email", "fixture@example.test"], { cwd: context.root }); await execute("git", ["config", "user.name", "MCP host fixture"], { cwd: context.root }); await execute("git", ["config", "core.autocrlf", "false"], { cwd: context.root });
    await fs.writeFile(path.join(context.root, ".gitignore"), ".hive/\n.hivemind/\nmcp-client-host-*\n"); await fs.writeFile(path.join(context.root, "README.md"), "QUEEN_PRIVATE_REPOSITORY_CONTEXT\n");
    await execute("git", ["add", ".gitignore", "README.md"], { cwd: context.root }); await execute("git", ["commit", "-m", "MCP host fixture baseline"], { cwd: context.root });
    model.setCodingMode();
    const approvals = [], inputs = [], events = [];
    const requestToolPermission = async (request) => { approvals.push(request); return true; };
    const requestMcpInput = async (request) => { inputs.push(request); return { action: "accept", content: { projectName: "actual owner project" } }; };
    let record;
    const expectedModel = entrypoint === "queen" ? "injected-session-selected-model" : "explicit-tui-selected-model";
    if (entrypoint === "queen") {
      const registry = new ProviderRegistry(context.root);
      const providerRegistries = { project: { get: (id) => registry.get(id), test: (id, requestSignal) => registry.test(id, requestSignal), getAdapter: (id) => registry.getAdapter(id), getRoles: async () => Object.fromEntries(["queen", "planner", "scout", "builder", "validator", "reviewer", "fixer"].map((role) => [role, { provider: "primary-fixture", model: expectedModel }])) } };
      const session = await createQueenSession({ repositoryPath: context.root, objective: "QUEEN_PRIVATE_TASK_CONTEXT exercise approved host", mode: "auto", approvalPolicy: "changes", maxAgents: 1, maxRetries: 0,
        providerRegistries, enabledMcpServers: ["fixture"], extensionOptions: context.extensionOptions, requestToolPermission, requestMcpInput, signal: signal(), onEvent: (event) => events.push(event) });
      record = await session.orchestrator.run();
    } else {
      record = await runQueenTuiSession({ cwd: context.root, objective: "QUEEN_PRIVATE_TASK_CONTEXT exercise approved TUI host", codeMode: "auto", approvalPolicy: "changes", providerOverride: { providerId: "primary-fixture", model: expectedModel },
        enabledMcpServers: ["fixture"], extensionOptions: context.extensionOptions, requestToolPermission, requestMcpInput, signal: signal(), onEvent: (event) => events.push(event) });
    }
    assert.equal(record.status, "completed", JSON.stringify(record.finalReport)); assert.equal(record.verdict, "ACCEPTED", JSON.stringify(record.finalReport));
    const sampled = model.calls.filter((entry) => entry.kind === "generation" && entry.body.messages.some((message) => typeof message.content === "string" && message.content.includes("explicitly approved MCP sampling request")));
    assert.equal(sampled.length, 1); assert.equal(sampled[0].body.model, expectedModel); assert.equal(sampled[0].body.max_tokens, 17);
    assert.ok(!JSON.stringify(sampled[0].body).includes("QUEEN_PRIVATE_TASK_CONTEXT")); assert.ok(!JSON.stringify(sampled[0].body).includes("QUEEN_PRIVATE_REPOSITORY_CONTEXT"));
    assert.equal(approvals.find((request) => request.tool === "mcp_sampling").input.model, expectedModel);
    assert.ok(approvals.some((request) => request.tool === "mcp_sampling_result"));
    assert.equal(inputs.length, 1); assert.equal(inputs[0].mode, "form"); assert.equal(inputs[0].serverId, "mcp:fixture");
    assert.ok(model.calls.some((entry) => entry.kind === "generation" && entry.body.messages.some((message) => typeof message.content === "string" && message.content.includes("actual owner project"))));
    assert.ok(events.some((event) => event.type === "subagent.tool_result" && event.payload.ok));
    assert.equal((await new ProviderRegistry(context.root).getRoles()).builder.model, "builder-saved-default");
  })));
}
