import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import test from "node:test";
import { discoverExtensions, loadPluginAgent, loadSkill, setExtensionState, connectMcp, marketplaceCommand, installMarketplacePlugin } from "../dist/extensions/index.js";
import { createExtensionToolExecutor } from "../dist/coding/extension-tools.js";
import { createQueenSession } from "../dist/coding/runtime.js";

const execute = promisify(execFile);
async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hive-plugin-runtime-"));
  const root = path.join(directory, "workspace"), options = { trustStateDir: path.join(directory, "trust") };
  await fs.mkdir(path.join(root, ".hive"), { recursive: true });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const write = async (file, text) => { const target = path.join(root, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, text); };
  const plugin = async (name, fields = {}) => { let config = { version: 1 }; try { config = JSON.parse(await fs.readFile(path.join(root, ".hive/extensions.json"), "utf8")); } catch (error) { if (error.code !== "ENOENT") throw error; } const plugins = { ...config.plugins, [name]: { path: `plugins/${name}`, enabled: false } }; await write(`plugins/${name}/hive.plugin.json`, JSON.stringify({ version: 1, name, pluginVersion: "1.0.0", ...fields })); await write(".hive/extensions.json", JSON.stringify({ ...config, plugins })); };
  const activate = async (id) => { await setExtensionState(root, id, "trust", options); await setExtensionState(root, id, "enable", options); };
  return { root, options, write, plugin, activate };
}

const mcpScript = `import readline from 'node:readline';import fs from 'node:fs';
readline.createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!('id'in m))return;
const reply=result=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
if(m.method==='server/discover')return process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'Legacy fixture'}})+'\\n');
if(m.method==='initialize'){fs.appendFileSync(process.argv[2],'initialized\\n');return reply({protocolVersion:'2025-11-25',serverInfo:{name:'dependency-fixture',version:'1'},capabilities:{tools:{}}});}
if(m.method==='tools/list')return reply({tools:[{name:'read',inputSchema:{type:'object'},description:'Read fixture'}]});
if(m.method==='tools/call'){fs.appendFileSync(process.argv[2],'called\\n');return reply({content:[{type:'text',text:'actual result'}]});}reply({});});`;

test("dependency requirements gate real MCP startup and every later request without granting trust or enabling code", async (t) => {
  const f = await fixture(t), marker = path.join(f.root, "wire-events.txt");
  await f.plugin("parent", { dependencies: [{ name: "base", version: "^2.0.0" }], mcpServers: { fixture: { transport: "stdio", command: process.execPath, args: ["server.mjs", marker] } } });
  await f.write("plugins/parent/server.mjs", mcpScript); await f.activate("plugin:parent");
  let catalog = await discoverExtensions(f.root, f.options); assert.deepEqual(catalog.diagnostics, []);
  assert.match(catalog.plugins[0].blockedReason, /installed dependency base/); assert.equal(catalog.servers[0].trusted, true);
  await assert.rejects(connectMcp(f.root, "parent.fixture", f.options), /installed dependency base/);
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
  await f.plugin("base", { pluginVersion: "2.3.1" });
  await assert.rejects(connectMcp(f.root, "parent.fixture", f.options), /trusted, enabled dependency/);
  await f.activate("plugin:base");
  const connection = await connectMcp(f.root, "parent.fixture", f.options);
  try {
    assert.equal((await connection.callTool("read", {})).content[0].text, "actual result");
    const before = await fs.readFile(marker, "utf8");
    await setExtensionState(f.root, "plugin:base", "untrust", f.options);
    await assert.rejects(connection.callTool("read", {}), /trusted, enabled dependency/);
    assert.equal(await fs.readFile(marker, "utf8"), before);
  } finally { await connection.close(); }
  catalog = await discoverExtensions(f.root, f.options); assert.equal(catalog.plugins.find((entry) => entry.name === "base").trusted, false);
});

test("dependency cycles, version mismatches and missing versions stay inspectable and fail closed", async (t) => {
  const f = await fixture(t);
  const fields = (dependency) => ({ dependencies: [dependency], skills: ["skills/guide/SKILL.md"] });
  await f.plugin("a", fields("b")); await f.write("plugins/a/skills/guide/SKILL.md", "A skill");
  await f.plugin("b", fields("a")); await f.write("plugins/b/skills/guide/SKILL.md", "B skill");
  await f.activate("plugin:a"); await f.activate("plugin:b");
  const catalog = await discoverExtensions(f.root, f.options); assert.equal(catalog.plugins.length, 2); assert.deepEqual(catalog.diagnostics, []);
  await assert.rejects(loadSkill(f.root, "skill:a.guide", f.options), /dependency cycle/);
  await f.plugin("a", fields({ name: "b", version: "^2" })); await f.activate("plugin:a");
  await f.plugin("b", { pluginVersion: "3.0.0" }); await f.activate("plugin:b");
  await assert.rejects(loadSkill(f.root, "skill:a.guide", f.options), /requires plugin:b version/);
  await f.plugin("b", { pluginVersion: "2.9.0" }); await f.activate("plugin:b");
  assert.equal((await loadSkill(f.root, "skill:a.guide", f.options)).text, "A skill");
});

test("agent skill preload prefers its own namespace, binds current content and respects explicit-only skill policy", async (t) => {
  const f = await fixture(t);
  await f.plugin("review", { agents: ["agents/inspector.md"], skills: ["skills/guide/SKILL.md"] });
  await f.write("plugins/review/agents/inspector.md", "---\nname: inspector\ndescription: Inspect source\nskills: [guide, review:guide]\n---\nSpecialist instructions\n");
  await f.write("plugins/review/skills/guide/SKILL.md", "---\nname: guide\n---\nOWN_SKILL_BODY\n");
  await f.write(".hive/skills/guide/SKILL.md", "---\nname: guide\n---\nGLOBAL_BODY_MUST_NOT_WIN\n");
  await f.activate("plugin:review");
  const first = await loadPluginAgent(f.root, "review.inspector", f.options);
  assert.deepEqual(first.preloadedSkillIds, ["skill:review.guide"]); assert.equal(first.instructions.split("OWN_SKILL_BODY").length, 2); assert.doesNotMatch(first.instructions, /GLOBAL_BODY/);
  await f.write("plugins/review/skills/guide/SKILL.md", "UPDATED_SKILL_BODY\n");
  await assert.rejects(loadPluginAgent(f.root, first.id, f.options), /untrusted/);
  await f.activate("skill:review.guide");
  const updated = await loadPluginAgent(f.root, first.id, f.options); assert.notEqual(updated.fingerprint, first.fingerprint); assert.match(updated.instructions, /UPDATED_SKILL_BODY/);
  for (const policy of ["true", '"true"', "unsupported-policy"]) {
    await f.write("plugins/review/skills/guide/SKILL.md", `---\nname: guide\ndisable-model-invocation: ${policy}\n---\nEXPLICIT_ONLY\n`); await f.activate("skill:review.guide");
    await assert.rejects(loadPluginAgent(f.root, first.id, f.options), /disables automatic/);
    assert.match((await loadSkill(f.root, "skill:review.guide", f.options)).text, /EXPLICIT_ONLY/);
  }
  for (const policy of ['"disable-model-invocation": true', "'disable-model-invocation': true", '"disable\\u002dmodel-invocation": true', "disable-model-invocation: false\ndisable-model-invocation: true", 'policy: {"disable-model-invocation": true}', "<<: *policy", "? disable-model-invocation\n: true", '"disable-model-\\\ninvocation": true']) {
    await f.write("plugins/review/skills/guide/SKILL.md", `---\nname: guide\n${policy}\n---\nEXPLICIT_ONLY\n`); await f.activate("skill:review.guide");
    await assert.rejects(loadPluginAgent(f.root, first.id, f.options), /disables automatic|policy|policies/);
    assert.match((await loadSkill(f.root, "skill:review.guide", f.options)).text, /EXPLICIT_ONLY/);
  }
  for (const document of ["---\nname: guide\ndisable-model-invocation: true\n---   \nEXPLICIT_ONLY", "--- \t\r\nname: guide\r\ndisable-model-invocation: true\r\n---\t\r\nEXPLICIT_ONLY", "---\nname: guide\ndisable-model-invocation: true\nEXPLICIT_ONLY"]) {
    await f.write("plugins/review/skills/guide/SKILL.md", document); await f.activate("skill:review.guide");
    await assert.rejects(loadPluginAgent(f.root, first.id, f.options), /disables automatic|Unterminated/);
  }
  await f.write("plugins/review/skills/guide/SKILL.md", "---\nname: guide\n'disable-model-invocation': false\n---\nAUTOMATIC_ALLOWED\n"); await f.activate("skill:review.guide");
  assert.match((await loadPluginAgent(f.root, first.id, f.options)).instructions, /AUTOMATIC_ALLOWED/);
});

test("marketplace agent skill names resolve original plugin namespaces and ambiguous cross-market references fail clearly", async (t) => {
  const f = await fixture(t);
  for (const market of ["team-a", "team-b"]) {
    await f.write(`${market}/.claude-plugin/marketplace.json`, JSON.stringify({ name: market, plugins: [{ name: "review", source: "./review" }] }));
    await f.write(`${market}/review/.claude-plugin/plugin.json`, JSON.stringify({ name: "review", version: "1.2.3", agents: ["./agents/inspector.md"] }));
    await f.write(`${market}/review/agents/inspector.md`, "---\nname: inspector\ndescription: Inspect own skill\nskills: review:guide\n---\nOriginal namespace\n");
    await f.write(`${market}/review/skills/guide/SKILL.md`, `---\nname: guide\n---\nSKILL_FROM_${market}\n`);
    await marketplaceCommand(f.root, `add "${path.join(f.root, market)}"`, f.options);
    await installMarketplacePlugin(f.root, `review@${market}`, f.options); await f.activate(`plugin:review.${market}`);
  }
  const own = await loadPluginAgent(f.root, "review.team-a.inspector", f.options);
  assert.deepEqual(own.preloadedSkillIds, ["skill:review.team-a.guide"]); assert.match(own.instructions, /SKILL_FROM_team-a/); assert.doesNotMatch(own.instructions, /SKILL_FROM_team-b/);
  await f.plugin("consumer", { agents: ["agents/inspector.md"] });
  await f.write("plugins/consumer/agents/inspector.md", "---\nname: inspector\ndescription: Inspect dependency skill\nskills: review:guide\n---\nConsumer\n"); await f.activate("plugin:consumer");
  await assert.rejects(loadPluginAgent(f.root, "consumer.inspector", f.options), /ambiguous preloaded skill plugin/);
  await f.write("plugins/consumer/agents/inspector.md", "---\nname: inspector\ndescription: Inspect explicit skill\nskills: [skill:review.team-b.guide]\n---\nConsumer\n"); await f.activate("plugin:consumer");
  const explicit = await loadPluginAgent(f.root, "consumer.inspector", f.options); assert.deepEqual(explicit.preloadedSkillIds, ["skill:review.team-b.guide"]); assert.match(explicit.instructions, /SKILL_FROM_team-b/);
});

test("PostToolUseFailure reports actual failures only, keeps native after hooks and does not run successful Claude hooks", async (t) => {
  const f = await fixture(t), log = path.join(f.root, "hook-events.jsonl");
  await f.write("hook.mjs", "import fs from 'node:fs';let raw='';for await(const c of process.stdin)raw+=c;fs.appendFileSync(process.argv[2],JSON.stringify({kind:process.argv[3],input:JSON.parse(raw)})+'\\n');");
  const hook = (event, kind, claude) => ({ event, command: process.execPath, args: ["hook.mjs", log, kind], ...(claude ? { claude: { event: claude } } : {}) });
  await f.write(".hive/extensions.json", JSON.stringify({ version: 1, hooks: { success: hook("after_tool", "success", "PostToolUse"), failure: hook("after_tool_failure", "failure", "PostToolUseFailure"), native: hook("after_tool", "native") } }));
  for (const id of ["hook:success", "hook:failure", "hook:native"]) await f.activate(id);
  let calls = 0, allow = true;
  const executor = await createExtensionToolExecutor({ extensionRoot: f.root, repositoryRoot: f.root, mode: "auto", extensionOptions: f.options, signal: new AbortController().signal,
    requestToolPermission: async () => allow, base: { builtinToolNames: ["read_file", "run_command"], async execute(_name, args) { calls++; if (args.fail) throw new Error("Actual fixture IO failure"); return { ok: true, output: "Actual success" }; } } });
  const task = { id: "bee-hook", sessionId: "session-hook", role: "builder", fileScope: ["input.txt"] };
  try {
    assert.equal((await executor.execute("read_file", {}, task, new AbortController().signal)).ok, true);
    assert.equal((await executor.execute("read_file", { fail: true }, task, new AbortController().signal)).ok, false);
    const entries = (await fs.readFile(log, "utf8")).trim().split("\n").map(JSON.parse);
    assert.equal(entries.filter((entry) => entry.kind === "success").length, 1); assert.equal(entries.filter((entry) => entry.kind === "native").length, 2);
    const failed = entries.find((entry) => entry.kind === "failure").input; assert.equal(failed.error, "Actual fixture IO failure"); assert.equal(failed.is_interrupt, false); assert.ok(failed.duration_ms >= 0);
    const before = await fs.readFile(log, "utf8"); allow = false;
    assert.equal((await executor.execute("run_command", { command: "must not run" }, task, new AbortController().signal)).metadata.permissionDenied, true);
    await assert.rejects(executor.execute("read_file", {}, task, AbortSignal.abort()), { name: "AbortError" });
    assert.equal(calls, 2); assert.equal(await fs.readFile(log, "utf8"), before);
  } finally { await executor.close(); }
});

test("real Queen requests preload trusted agent skills and expose their original-root reference tool without replacing the chosen model", async (t) => {
  const f = await fixture(t);
  await f.write(".gitignore", ".hive/\n.hivemind/\n"); await f.write("input.txt", "Actual source\n");
  await f.plugin("review", { agents: ["agents/inspector.md"], skills: ["skills/guide/SKILL.md"] });
  await f.write("plugins/review/agents/inspector.md", "---\nname: inspector\ndescription: Inspect selected skill\ntools: Read, Skill\nskills: guide\nmodel: opus\n---\nSPECIALIST_BODY\n");
  await f.write("plugins/review/skills/guide/SKILL.md", "---\nname: guide\n---\nPRELOADED_SKILL_BODY: read references/details.md\n");
  await f.write("plugins/review/skills/guide/references/details.md", "REAL_REFERENCED_INSTRUCTION\n");
  for (const args of [["init", "-b", "main"], ["config", "user.email", "fixture@example.test"], ["config", "user.name", "Plugin fixture"], ["config", "core.autocrlf", "false"], ["add", "."], ["commit", "-m", "Fixture baseline"]]) await execute("git", args, { cwd: f.root });
  await f.activate("plugin:review");
  const requests = []; let failure;
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "owner-selected-model" }] })); return; }
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw), system = body.messages.find((message) => message.role === "system")?.content ?? "", prompt = body.messages.find((message) => message.role === "user")?.content ?? ""; requests.push({ body, system, prompt });
      let result = { done: true, summary: "Skill inspected", data: { status: "passed", findings: [] } };
      if (system.includes("HIVE Planner")) result = { summary: "Inspect skill", architecture: "One task", risks: [], acceptanceCriteria: ["Referenced instruction read"], validationCommands: ["node --version"], tasks: [{ key: "inspect", role: "builder", title: "Inspect", objective: "Read selected skill reference", dependencies: [], fileScope: ["input.txt"], expectedOutput: "Reference evidence", completionCriteria: ["Reference read"], validationCommands: [] }] };
      else if (system.includes("HIVE builder subagent") && !prompt.includes("[Tool results 1]")) result = { done: false, toolCalls: [{ name: "read_skill_reference", arguments: { skillId: "skill:review.guide", path: "references/details.md" } }] };
      const output = JSON.stringify(result);
      if (body.stream) { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: output } }] })}\n\ndata: [DONE]\n\n`); }
      else { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ choices: [{ message: { content: output } }] })); }
    } catch (error) { failure = error; response.writeHead(500).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); return new Promise((resolve) => server.close(resolve)); });
  const provider = { id: "fixture", name: "Fixture", kind: "local", authType: "none", approved: true, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, defaultModel: "unchanged-default", createdAt: "2026-10-17", updatedAt: "2026-10-17" };
  const roles = Object.fromEntries(["queen", "planner", "scout", "builder", "validator", "reviewer", "fixer"].map((role) => [role, { provider: "fixture", model: "owner-selected-model" }]));
  await f.write(".hive/providers.json", JSON.stringify([provider])); await f.write(".hive/provider-roles.json", JSON.stringify(roles));
  const before = await fs.readFile(path.join(f.root, ".hive/provider-roles.json"));
  const { orchestrator } = await createQueenSession({ repositoryPath: f.root, objective: "Inspect the selected instructions", mode: "auto", approvalPolicy: "changes", maxAgents: 1, maxRetries: 0, pluginAgentId: "review.inspector", extensionOptions: f.options, requestToolPermission: async () => true });
  const record = await orchestrator.run(); if (failure) throw failure;
  assert.equal(record.pluginAgentId, "agent:review.inspector");
  assert.equal(record.status, "completed", JSON.stringify(record.finalReport)); assert.equal(record.verdict, "ACCEPTED", JSON.stringify(record.finalReport));
  const builders = requests.filter((entry) => entry.system.includes("HIVE builder subagent")); assert.ok(builders.length >= 2);
  assert.ok(builders.every((entry) => entry.system.includes("PRELOADED_SKILL_BODY") && entry.system.includes("SPECIALIST_BODY")));
  assert.ok(builders.some((entry) => entry.prompt.includes("REAL_REFERENCED_INSTRUCTION"))); assert.ok(requests.every((entry) => entry.body.model === "owner-selected-model"));
  assert.deepEqual(await fs.readFile(path.join(f.root, ".hive/provider-roles.json")), before);
});
