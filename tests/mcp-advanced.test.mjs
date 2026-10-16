import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { connectMcp, setExtensionState } from "../dist/extensions/index.js";

const capabilities = { tools: { listChanged: true }, resources: { listChanged: true }, prompts: { listChanged: true }, completions: {} };
const handlers = `
const capabilities = ${JSON.stringify(capabilities)};
let generation=0;
const resultFor = (m, mode='') => {
 if(m.method==='initialize') return {protocolVersion:'2025-11-25',capabilities:mode==='tools-only'?{tools:{}}:capabilities,serverInfo:{name:'advanced-fixture',version:'1'}};
 if(mode==='opaque') {
  if(m.method==='resources/list')return {resources:[{uri:'fixture://private',name:'private',description:process.env.SCOPED_CREDENTIAL}]};
  if(m.method==='resources/read')return {contents:[{uri:'fixture://private',text:process.env.SCOPED_CREDENTIAL}]};
  if(m.method==='prompts/list')return {prompts:[{name:'private',description:process.env.SCOPED_CREDENTIAL}]};
  if(m.method==='prompts/get')return {description:process.env.SCOPED_CREDENTIAL,messages:[{role:'user',content:{type:'text',text:process.env.SCOPED_CREDENTIAL}}]};
  if(m.method==='completion/complete')return {completion:{values:[process.env.SCOPED_CREDENTIAL]}};
 }
 if(m.method==='tools/list') return {tools:[{name:'echo',inputSchema:{type:'object'}}]};
 if(m.method==='resources/list') {
  if(mode==='duplicate') return {resources:[{uri:'fixture://same',name:'one'},{uri:'fixture://same',name:'two'}]};
  if(mode==='cursor') return {resources:[],nextCursor:'same'};
  if(mode==='pages') return {resources:[],nextCursor:String(Number(m.params.cursor??0)+1)};
  if(mode==='count') return {resources:Array.from({length:257},(_,i)=>({uri:'fixture://'+i,name:String(i)}))};
  if(mode==='aggregate') return {resources:Array.from({length:40},(_,i)=>({uri:'fixture://'+(m.params.cursor??'first')+'/'+i,name:String(i),description:'x'.repeat(16_384)})),nextCursor:'second'};
  return m.params.cursor?{resources:[{uri:'fixture://binary',name:'binary',mimeType:'application/octet-stream',size:3}]}:{resources:[{uri:'fixture://readme',name:'readme-'+generation,title:'Project README',description:'Server-managed content'}],nextCursor:'resources-next'};
 }
 if(m.method==='resources/templates/list') return m.params.cursor?{resourceTemplates:[{uriTemplate:'fixture://binary/{name}',name:'binary'}]}:{resourceTemplates:[{uriTemplate:'fixture://docs/{path}',name:'docs',mimeType:'text/plain'}],nextCursor:'templates-next'};
 if(m.method==='resources/read') {
  if(m.params.uri==='fixture://invalid') return {contents:[{uri:m.params.uri,text:'one',blob:'dHdv'}]};
  if(m.params.uri==='fixture://bad-base64') return {contents:[{uri:m.params.uri,blob:'not base64!'}]};
  return {contents:m.params.uri==='fixture://binary'?[{uri:m.params.uri,blob:'AAEC',mimeType:'application/octet-stream'}]:[{uri:m.params.uri,text:'Real server text π\\nsecond line',mimeType:'text/plain'}]};
 }
 if(m.method==='prompts/list') return m.params.cursor?{prompts:[{name:'explain'}]}:{prompts:[{name:'review',title:'Review',arguments:[{name:'code',description:'Source code',required:true}]}],nextCursor:'prompts-next'};
 if(m.method==='prompts/get') {
  if(m.params.name==='invalid-role') return {messages:[{role:'system',content:{type:'text',text:'invalid'}}]};
  if(m.params.name==='invalid-type') return {messages:[{role:'user',content:{type:'execute',command:'no'}}]};
  return {description:'Review source',messages:[{role:'user',content:{type:'text',text:m.params.arguments.code??''}},{role:'assistant',content:{type:'image',data:'AAEC',mimeType:'image/png'}},{role:'user',content:{type:'audio',data:'AAEC',mimeType:'audio/wav'}},{role:'user',content:{type:'resource',resource:{uri:'fixture://readme',text:'Embedded documentation'}}},{role:'user',content:{type:'resource_link',uri:'fixture://binary',name:'binary'}}]};
 }
 if(m.method==='completion/complete') {
  if(m.params.argument.value==='invalid') return {completion:{values:Array(101).fill('x')}};
  if(m.params.argument.value==='bad-total') return {completion:{values:['one'],total:0}};
  return {completion:{values:[m.params.argument.value+'thon',m.params.context?.arguments?.language??'default'],total:2,hasMore:false}};
 }
 if(m.method==='tools/call') return {content:[{type:'text',text:'done'}]};
 return {};
};
`;
const processServer = `
import readline from 'node:readline';
import {appendFileSync,existsSync} from 'node:fs';
${handlers}
const log=process.argv[2], mode=process.argv[3]??'';
const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
const pending=new Map();
let rootRequested=false;
if(process.argv[4])setInterval(()=>{if(!rootRequested&&existsSync(process.argv[4])){rootRequested=true;send({id:'autonomous-roots',method:'roots/list',params:{}});}},10);
readline.createInterface({input:process.stdin}).on('line',line=>{
 const m=JSON.parse(line);appendFileSync(log,JSON.stringify(m)+'\\n');
 if(!m.method) {const request=pending.get(m.id);if(request){pending.delete(m.id);send({id:request,result:{content:[{type:'text',text:JSON.stringify(m)}]}});}return;}
 if(m.method==='notifications/initialized') {
  if(mode==='unadvertised')send({method:'notifications/tools/list_changed'});
  return;
 }
 if(m.method==='notifications/cancelled')return;
 if(m.method==='tools/call' && ['roots','sampling','elicitation'].includes(m.params.name)) {
  const method=m.params.name==='roots'?'roots/list':m.params.name==='sampling'?'sampling/createMessage':'elicitation/create';
  const id='server-'+m.id;pending.set(id,m.id);send({id,method,params:{roots:['file:///outside'],messages:[{role:'user',content:{type:'text',text:'must not spend'}}]}});return;
 }
 if(m.method==='tools/call' && m.params.name==='changed') {
  generation++;
  for(const kind of ['tools','resources','prompts'])send({method:'notifications/'+kind+'/list_changed'});
 }
 if(m.method==='resources/read' && m.params.uri==='fixture://wait')return;
 if(m.method==='prompts/get' && m.params.name==='wait')return;
 send({id:m.id,result:resultFor(m,mode)});
}).on('close',()=>process.exit(0));
`;

async function fixture(run, mode = "") {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hive-mcp-advanced-"));
  const root = path.join(temporary, "workspace"); const options = { trustStateDir: path.join(temporary, "trust") };
  await fs.mkdir(path.join(root, ".hive"), { recursive: true });
  const script = path.join(root, "server.mjs"); const log = path.join(root, "requests.jsonl"); const rootRequest = path.join(root, "request-roots");
  await fs.writeFile(script, processServer);
  const entry = { transport: "stdio", command: process.execPath, args: [script, log, mode, rootRequest] };
  const config = async (value = entry) => fs.writeFile(path.join(root, ".hive", "extensions.json"), JSON.stringify({ version: 1, mcpServers: { fixture: value } }));
  await config();
  await setExtensionState(root, "mcp:fixture", "trust", options); await setExtensionState(root, "mcp:fixture", "enable", options);
  const readLog = async () => (await fs.readFile(log, "utf8")).trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) { const match = (await readLog()).find(predicate); if (match) return match; await new Promise((resolve) => setTimeout(resolve, 10)); }
    throw new Error("Fixture did not receive the expected request");
  };
  try { await run({ root, options, config, entry, readLog, waitFor, rootRequest }); }
  finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

test("advanced stdio discovers paginated resources, templates, prompts and reads actual text/binary", async () => fixture(async ({ root, options, readLog }) => {
  const connection = await connectMcp(root, "fixture", options);
  try {
    assert.deepEqual(connection.capabilities, capabilities);
    assert.deepEqual((await connection.listResources()).map((entry) => entry.uri), ["fixture://readme", "fixture://binary"]);
    assert.deepEqual((await connection.listResourceTemplates()).map((entry) => entry.uriTemplate), ["fixture://docs/{path}", "fixture://binary/{name}"]);
    assert.deepEqual((await connection.listPrompts()).map((entry) => entry.name), ["review", "explain"]);
    assert.equal((await connection.readResource("fixture://readme")).contents[0].text, "Real server text π\nsecond line");
    assert.deepEqual((await connection.readResource("fixture://binary")).contents[0], { uri: "fixture://binary", mimeType: "application/octet-stream", blob: "AAEC" });
    const methods = (await readLog()).map((message) => message.method);
    for (const method of ["resources/list", "resources/templates/list", "prompts/list"]) assert.equal(methods.filter((value) => value === method).length, 2);
    // No client roots, sampling or elicitation are advertised implicitly.
    const opened = await readLog();
    assert.equal(opened[0].method, "server/discover");
    assert.equal(opened[0].params._meta["io.modelcontextprotocol/protocolVersion"], "2026-07-28");
    assert.deepEqual(opened[0].params._meta["io.modelcontextprotocol/clientCapabilities"], {});
    assert.deepEqual(opened.find((message) => message.method === "initialize").params.capabilities, {});
  } finally { await connection.close(); }
}));

test("prompts preserve all supported content variants and completions send resolved argument context", async () => fixture(async ({ root, options, readLog }) => {
  const connection = await connectMcp(root, "fixture", options);
  try {
    const prompt = await connection.getPrompt("review", { code: "const π = 1;\nconsole.log(π)" });
    assert.equal(prompt.messages[0].content.text, "const π = 1;\nconsole.log(π)");
    assert.deepEqual(prompt.messages.map((message) => message.content.type), ["text", "image", "audio", "resource", "resource_link"]);
    const completed = await connection.complete({ type: "ref/prompt", name: "review" }, { name: "framework", value: "py" }, { context: { arguments: { language: "python" } } });
    assert.deepEqual(completed, { completion: { values: ["python", "python"], total: 2, hasMore: false } });
    assert.deepEqual((await readLog()).find((message) => message.method === "completion/complete").params.context, { arguments: { language: "python" } });
    assert.deepEqual((await connection.complete({ type: "ref/resource", uri: "fixture://docs/{path}" }, { name: "path", value: "" })).completion.values, ["thon", "default"]);
  } finally { await connection.close(); }
}));

test("roots remain private by default and explicit sharing returns only the canonical project root", async () => fixture(async ({ root, options, readLog }) => {
  for (const shared of [false, true]) {
    const connection = await connectMcp(root, "fixture", { ...options, roots: shared });
    try {
      const reply = JSON.parse((await connection.callTool("roots", {})).content[0].text);
      if (!shared) { assert.equal(reply.error.code, -32601); assert.equal(reply.result, undefined); }
      else assert.deepEqual(reply.result, { roots: [{ uri: pathToFileURL(await fs.realpath(root)).href, name: "Project" }] });
      const initialized = (await readLog()).filter((message) => message.method === "initialize").at(-1);
      assert.deepEqual(initialized.params.capabilities, shared ? { roots: {} } : {});
      for (const name of ["sampling", "elicitation"]) assert.equal(JSON.parse((await connection.callTool(name, {})).content[0].text).error.code, -32601);
    } finally { await connection.close(); }
  }
}));

test("advertised list changes reach observers and subsequent discovery fetches fresh lists", async () => fixture(async ({ root, options, readLog }) => {
  const connection = await connectMcp(root, "fixture", options); const changed = [];
  try {
    const before = await connection.listResources();
    const unsubscribe = connection.onListChanged((kind) => changed.push(kind));
    connection.onListChanged(() => { throw new Error("observer cannot break transport"); });
    await connection.callTool("changed", {});
    assert.deepEqual(changed, ["tools", "resources", "prompts"]);
    const after = await connection.listResources(); assert.notEqual(before[0].name, after[0].name);
    unsubscribe(); await connection.callTool("changed", {}); assert.equal(changed.length, 3);
    assert.equal((await readLog()).filter((message) => message.method === "resources/list").length, 4);
  } finally { await connection.close(); }
}));

test("missing capabilities fail before requests and unadvertised list notifications are ignored", async () => fixture(async ({ root, options, readLog }) => {
  const connection = await connectMcp(root, "fixture", options); const changed = [];
  try {
    connection.onListChanged((kind) => changed.push(kind));
    await assert.rejects(connection.listResources(), /does not advertise resources/);
    await assert.rejects(connection.listResourceTemplates(), /does not advertise resources/);
    await assert.rejects(connection.readResource("fixture://readme"), /does not advertise resources/);
    await assert.rejects(connection.listPrompts(), /does not advertise prompts/);
    await assert.rejects(connection.getPrompt("review", {}), /does not advertise prompts/);
    await assert.rejects(connection.complete({ type: "ref/prompt", name: "review" }, { name: "value", value: "" }), /does not advertise completions/);
    await connection.callTool("changed", {}); assert.deepEqual(changed, []);
    assert.equal((await readLog()).some((message) => /^(?:resources|prompts|completion)\//u.test(message.method ?? "")), false);
  } finally { await connection.close(); }
}, "tools-only"));

for (const [mode, expected] of [["duplicate", /duplicate entry/], ["cursor", /repeated cursor/], ["pages", /exceeded 16 pages/], ["count", /count exceeds 256/], ["aggregate", /catalog exceeded message size limit/]]) {
  test(`resource discovery rejects ${mode} catalogs`, async () => fixture(async ({ root, options }) => {
    const connection = await connectMcp(root, "fixture", options);
    try { await assert.rejects(connection.listResources(), expected); }
    finally { await connection.close(); }
  }, mode));
}

test("root disclosure choice and public capabilities cannot be mutated after negotiation", async () => fixture(async ({ root, options }) => {
  const selected = { ...options, roots: false };
  const connection = await connectMcp(root, "fixture", selected);
  try {
    selected.roots = true; connection.capabilities.resources = undefined;
    assert.equal(JSON.parse((await connection.callTool("roots", {})).content[0].text).error.code, -32601);
    assert.equal((await connection.listResources()).length, 2);
  } finally { await connection.close(); }
}));

test("advanced inputs and malformed content/completion results fail explicitly", async () => fixture(async ({ root, options, readLog }) => {
  const connection = await connectMcp(root, "fixture", options);
  try {
    await assert.rejects(connection.readResource("relative/path"), /absolute URI/);
    await assert.rejects(connection.getPrompt("review", { code: 12 }), /bounded string/);
    await assert.rejects(connection.complete({ type: "ref/unknown", name: "review" }, { name: "code", value: "" }), /reference type/);
    await assert.rejects(connection.complete({ type: "ref/prompt", name: "review" }, { name: "code", value: "" }, { context: { arguments: { language: false } } }), /bounded string/);
    assert.deepEqual((await readLog()).filter((message) => message.id !== undefined).map((message) => message.method), ["server/discover", "initialize"]);
    await assert.rejects(connection.readResource("fixture://invalid"), /exactly one/);
    await assert.rejects(connection.readResource("fixture://bad-base64"), /base64 encoding/);
    await assert.rejects(connection.getPrompt("invalid-role", {}), /role must be user or assistant/);
    await assert.rejects(connection.getPrompt("invalid-type", {}), /Unsupported MCP prompt content type/);
    await assert.rejects(connection.complete({ type: "ref/prompt", name: "review" }, { name: "value", value: "invalid" }), /at most 100/);
    await assert.rejects(connection.complete({ type: "ref/prompt", name: "review" }, { name: "value", value: "bad-total" }), /total must be/);
  } finally { await connection.close(); }
}));

test("advanced cancellation/timeout preserve connection usability and do not replay requests", async () => fixture(async ({ root, options, waitFor, readLog }) => {
  const connection = await connectMcp(root, "fixture", options);
  try {
    const controller = new AbortController(); const pending = connection.readResource("fixture://wait", { signal: controller.signal });
    const sent = await waitFor((message) => message.method === "resources/read" && message.params.uri === "fixture://wait");
    controller.abort(); await assert.rejects(pending, { name: "AbortError" });
    await waitFor((message) => message.method === "notifications/cancelled" && message.params.requestId === sent.id);
    await assert.rejects(connection.getPrompt("wait", {}, { timeoutMs: 100 }), /timed out/);
    assert.equal((await connection.readResource("fixture://binary")).contents[0].blob, "AAEC");
    assert.equal((await readLog()).filter((message) => message.method === "resources/read" && message.params.uri === "fixture://wait").length, 1);
    const cancelled = new AbortController(); cancelled.abort();
    await assert.rejects(connection.listPrompts({ signal: cancelled.signal }), { name: "AbortError" });
  } finally { await connection.close(); }
}));

test("open connections reject changed config, revoked trust and disabled servers before later requests", async () => fixture(async ({ root, options, config, entry, readLog }) => {
  let initializedCount = 0;
  for (const change of ["config", "untrust", "disable"]) {
    await config(); await setExtensionState(root, "mcp:fixture", "trust", options); await setExtensionState(root, "mcp:fixture", "enable", options);
    const connection = await connectMcp(root, "fixture", { ...options, roots: true });
    try {
      initializedCount += 1;
      const deadline = Date.now() + 3000;
      while ((await readLog()).filter((message) => message.method === "notifications/initialized").length < initializedCount) {
        if (Date.now() >= deadline) throw new Error("Fixture did not record initialization completion");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (change === "config") await config({ ...entry, timeoutMs: 1000 });
      else await setExtensionState(root, "mcp:fixture", change, options);
      const count = (await readLog()).length;
      await assert.rejects(connection.listResources(), /trust or configuration changed/);
      await assert.rejects(connection.callTool("roots", {}), /trust or configuration changed/);
      await assert.rejects(connection.listTools(), /trust or configuration changed/);
      assert.equal((await readLog()).length, count);
    } finally { await connection.close(); }
  }
}));

test("server-initiated roots requests revalidate revoked trust without a client API call", async () => fixture(async ({ root, options, rootRequest, waitFor }) => {
  const connection = await connectMcp(root, "fixture", { ...options, roots: true });
  try {
    await setExtensionState(root, "mcp:fixture", "untrust", options);
    await fs.writeFile(rootRequest, "request");
    const response = await waitFor((message) => message.id === "autonomous-roots" && !message.method);
    assert.equal(response.error.code, -32000); assert.equal(response.result, undefined);
    assert.equal(JSON.stringify(response).includes(pathToFileURL(root).href), false);
    await assert.rejects(connection.listResources(), /trust or configuration changed/);
  } finally { await connection.close(); }
}));

test("advanced resource/prompt/completion results scrub explicitly referenced opaque credentials", async () => fixture(async ({ root, options, config, entry }) => {
  const previous = process.env.HIVE_MCP_ADVANCED_PRIVATE;
  const secret = "opaque-credential-without-recognized-prefix";
  process.env.HIVE_MCP_ADVANCED_PRIVATE = secret;
  await config({ ...entry, envRefs: { SCOPED_CREDENTIAL: "HIVE_MCP_ADVANCED_PRIVATE" } });
  await setExtensionState(root, "mcp:fixture", "trust", options); await setExtensionState(root, "mcp:fixture", "enable", options);
  let connection;
  try {
    connection = await connectMcp(root, "fixture", options);
    const values = [await connection.listResources(), await connection.readResource("fixture://private"), await connection.listPrompts(), await connection.getPrompt("private"), await connection.complete({ type: "ref/prompt", name: "private" }, { name: "value", value: "" })];
    for (const value of values) { assert.equal(JSON.stringify(value).includes(secret), false); assert.match(JSON.stringify(value), /\[REDACTED\]/u); }
  } finally {
    await connection?.close();
    if (previous === undefined) delete process.env.HIVE_MCP_ADVANCED_PRIVATE; else process.env.HIVE_MCP_ADVANCED_PRIVATE = previous;
  }
}, "opaque"));

async function httpFixture(run) {
  const requests = []; const sockets = new Set(); let pendingReply;
  // Use the same fixture behavior over real Streamable HTTP; the source is local
  // test code, and the production client still validates every received message.
  const resultFor = new Function(`${handlers};return resultFor;`)();
  const server = http.createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += chunk;
    const message = body ? JSON.parse(body) : undefined; requests.push({ message, headers: request.headers, method: request.method });
    if (request.method === "DELETE") { response.writeHead(204); response.end(); return; }
    if (message?.method === "tools/call" && message.params.name === "roots") {
      response.writeHead(200, { "content-type": "text/event-stream" });
      pendingReply = { response, id: message.id };
      response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", id: "server-roots", method: "roots/list", params: {} })}\n\n`); return;
    }
    if (message?.id === "server-roots" && !message.method) {
      response.writeHead(202); response.end();
      pendingReply.response.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: pendingReply.id, result: { content: [{ type: "text", text: JSON.stringify(message) }] } })}\n\n`); return;
    }
    if (!message?.method || message.id === undefined) { response.writeHead(202); response.end(); return; }
    if (message.method === "resources/read" && message.params.uri === "fixture://wait") { response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders(); return; }
    if (message.method === "initialize") { response.writeHead(200, { "content-type": "application/json", "mcp-session-id": "advanced-session" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: resultFor(message) })); return; }
    response.writeHead(200, { "content-type": "text/event-stream" });
    if (message.method === "resources/list") response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/resources/list_changed" })}\n\n`);
    response.end(`data: ${JSON.stringify({ jsonrpc: "2.0", id: message.id, result: resultFor(message) })}\n\n`);
  });
  server.on("connection", (socket) => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run({ url: `http://127.0.0.1:${server.address().port}/mcp`, requests }); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise((resolve) => server.close(resolve)); }
}

test("advanced Streamable HTTP handles resources/prompts/completion, in-band notifications and explicit roots", async () => httpFixture(async ({ url, requests }) => fixture(async ({ root, options, config }) => {
  await config({ transport: "http", url }); await setExtensionState(root, "mcp:fixture", "trust", options); await setExtensionState(root, "mcp:fixture", "enable", options);
  const connection = await connectMcp(root, "fixture", { ...options, roots: true }); const changed = [];
  try {
    connection.onListChanged((kind) => changed.push(kind));
    assert.equal((await connection.listResources()).length, 2); assert.deepEqual(changed, ["resources", "resources"]);
    assert.equal((await connection.listResourceTemplates()).length, 2);
    assert.equal((await connection.listPrompts()).length, 2);
    assert.equal((await connection.readResource("fixture://binary")).contents[0].blob, "AAEC");
    assert.equal((await connection.getPrompt("review", { code: "HTTP source" })).messages[0].content.text, "HTTP source");
    assert.deepEqual((await connection.complete({ type: "ref/prompt", name: "review" }, { name: "language", value: "py" })).completion.values, ["python", "default"]);
    assert.equal(JSON.parse((await connection.callTool("roots", {})).content[0].text).result.roots[0].uri, pathToFileURL(await fs.realpath(root)).href);
    await assert.rejects(connection.readResource("fixture://wait", { timeoutMs: 100 }), /timed out/);
    assert.equal(requests.filter((entry) => entry.message?.method === "resources/read" && entry.message.params.uri === "fixture://wait").length, 1);
  } finally { await connection.close(); }
  assert.equal(requests.at(-1).method, "DELETE");
  const probe = requests.find((request) => request.message?.method === "server/discover");
  assert.equal(probe.headers["mcp-protocol-version"], "2026-07-28");
  assert.equal(probe.headers["mcp-session-id"], undefined);
  const initialization = requests.find((request) => request.message?.method === "initialize");
  assert.equal(initialization.headers["mcp-protocol-version"], "2025-11-25");
  assert.equal(initialization.headers["mcp-session-id"], undefined);
  for (const request of requests.filter((request) => request !== probe && request !== initialization)) assert.equal(request.headers["mcp-session-id"], "advanced-session");
})));
