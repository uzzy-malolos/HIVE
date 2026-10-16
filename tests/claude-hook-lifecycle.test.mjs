import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createQueenSession } from "../dist/coding/runtime.js";
import { createExtensionToolExecutor } from "../dist/coding/extension-tools.js";
import { StructuredAgentLoop } from "../dist/coding/agent-loop.js";
import { setExtensionState } from "../dist/extensions/catalog.js";

const execute = promisify(execFile);
const task = { id: "hook-builder", sessionId: "hook-session", role: "builder", title: "Inspect", objective: "Read input.txt", status: "working", providerId: "fixture", dependencies: [], fileScope: ["input.txt"], expectedOutput: "Evidence", completionCriteria: [], validationCommands: [], depth: 0, attempt: 1, maxAttempts: 1, createdAt: "2026-10-17T00:00:00.000Z" };

async function fixture(run, behavior = "normal") {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hive-hook-lifecycle-")); const root = path.join(temporary, "project");
  await fs.mkdir(path.join(root, ".hive"), { recursive: true });
  const extensionOptions = { trustStateDir: path.join(temporary, "trust") }, requests = [], approvals = [];
  const log = path.join(temporary, "events.jsonl"), script = path.join(root, ".hive", "hook.mjs");
  await fs.writeFile(script, `import fs from 'node:fs';let raw='';for await(const part of process.stdin)raw+=part;const input=JSON.parse(raw),log=process.argv[2],kind=process.argv[3];let old=[];try{old=fs.readFileSync(log,'utf8').trim().split('\\n').filter(Boolean).map(JSON.parse)}catch(e){if(e.code!=='ENOENT')throw e}fs.appendFileSync(log,JSON.stringify(input)+'\\n');
if(input.hook_event_name==='SubagentStart')process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'SubagentStart',additionalContext:'LIVE_SUBAGENT_START_CONTEXT'}}));
if(input.hook_event_name==='SubagentStop'&&kind==='subagent-continue'&&input.agent_type==='builder'&&!old.some(e=>e.hook_event_name==='SubagentStop'&&e.agent_type==='builder'))process.stdout.write(JSON.stringify({decision:'block',reason:'LIVE_SUBAGENT_CONTINUATION: read the evidence again'}));
if(input.hook_event_name==='Stop'&&(kind==='stop-continue'||kind.startsWith('plan-stop-'))&&!old.some(e=>e.hook_event_name==='Stop'))process.stdout.write(JSON.stringify({decision:'block',reason:'LIVE_STOP_CONTINUATION: verify the scoped evidence again'}));
if(input.hook_event_name==='PermissionRequest'&&kind==='permission-deny')process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PermissionRequest',decision:{behavior:'deny',message:'LIVE_PERMISSION_DENIAL'}}}));`);
  await fs.writeFile(path.join(root, ".gitignore"), ".hive/\n.hivemind/\n"); await fs.writeFile(path.join(root, "input.txt"), "Actual unchanged fixture evidence\n");
  for (const args of [["init", "-b", "main"], ["config", "user.email", "fixture@example.test"], ["config", "user.name", "Hook lifecycle fixture"], ["config", "core.autocrlf", "false"], ["add", "."], ["commit", "-m", "Hook fixture baseline"]]) await execute("git", args, { cwd: root });
  const configure = async (definitions) => {
    const hooks = Object.fromEntries(definitions.map(([event, native]) => [event, { event: native, command: process.execPath, args: [script, log, behavior], claude: { event } }]));
    await fs.writeFile(path.join(root, ".hive", "extensions.json"), JSON.stringify({ version: 1, hooks }));
    for (const event of Object.keys(hooks)) { await setExtensionState(root, `hook:${event}`, "trust", extensionOptions); await setExtensionState(root, `hook:${event}`, "enable", extensionOptions); }
  };
  let fixtureError;
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "owner-hook-model" }] })); return; }
      let raw = ""; for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw), system = body.messages.find((entry) => entry.role === "system")?.content ?? "", prompt = body.messages.find((entry) => entry.role === "user")?.content ?? ""; requests.push({ body, system, prompt });
      if (behavior === "provider-failure" && system.includes("HIVE Planner")) { response.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: "intentional lifecycle provider failure" } })); return; }
      let output = { done: true, summary: "Actual fixture evidence inspected", data: { status: "passed", findings: [] } };
      if (system.includes("HIVE Planner")) output = { summary: "Inspect the source evidence", architecture: "One narrow read-only task", risks: [], acceptanceCriteria: ["Actual input was read"], validationCommands: ["node --version"], tasks: [{ key: "inspect", role: "builder", title: "Inspect input", objective: "Read input.txt and report actual evidence", dependencies: [], fileScope: ["input.txt"], expectedOutput: "Read evidence", completionCriteria: ["Input inspected"], validationCommands: [] }] };
      else if (/HIVE (?:builder|fixer) subagent/u.test(system) && !prompt.includes("[Tool results 1]")) output = { done: false, toolCalls: [{ name: "read_file", arguments: { path: "input.txt" } }] };
      if (behavior === "plan-stop-continue" && system.includes("HIVE Planner") && prompt.includes("LIVE_STOP_CONTINUATION")) { output.summary = "Revised plan after stop feedback"; output.tasks.push({ ...output.tasks[0], key: "verify-more", title: "Additional verification", objective: "Inspect additional.txt", fileScope: ["additional.txt"] }); }
      if (behavior === "plan-stop-budget" && system.includes("HIVE Planner") && prompt.includes("LIVE_STOP_CONTINUATION")) output.tasks = Array.from({ length: 5 }, (_, index) => ({ ...output.tasks[0], key: `more-${index}`, objective: `Inspect extra-${index}.txt`, fileScope: [`extra-${index}.txt`] }));
      const text = JSON.stringify(output);
      if (body.stream) { response.writeHead(200, { "content-type": "text/event-stream" }); response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`); }
      else { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ choices: [{ message: { content: text } }] })); }
    } catch (error) { fixtureError = error; response.writeHead(500).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const provider = { id: "fixture", name: "Fixture", kind: "local", authType: "none", approved: true, baseUrl: `http://127.0.0.1:${server.address().port}/v1`, defaultModel: "unchanged-default", createdAt: "2026-10-17", updatedAt: "2026-10-17" };
  const roles = Object.fromEntries(["queen", "planner", "scout", "builder", "validator", "reviewer", "fixer"].map((role) => [role, { provider: "fixture", model: "owner-hook-model" }]));
  await fs.writeFile(path.join(root, ".hive", "providers.json"), JSON.stringify([provider])); await fs.writeFile(path.join(root, ".hive", "provider-roles.json"), JSON.stringify(roles));
  const original = await fs.readFile(path.join(root, ".hive", "provider-roles.json"));
  try {
    await run({ root, temporary, extensionOptions, requests, approvals, configure, log, async events() { try { return (await fs.readFile(log, "utf8")).trim().split("\n").filter(Boolean).map(JSON.parse); } catch (error) { if (error.code === "ENOENT") return []; throw error; } },
      async start(extra = {}) { const runtime = await createQueenSession({ repositoryPath: root, objective: "Inspect the actual scoped input", mode: "auto", approvalPolicy: "changes", maxAgents: 1, maxRetries: 0, extensionOptions, requestToolPermission: async (request) => { approvals.push(request); return true; }, ...extra }); return { ...runtime, record: await runtime.orchestrator.run() }; },
    });
    if (fixtureError) throw fixtureError;
    assert.deepEqual(await fs.readFile(path.join(root, ".hive", "provider-roles.json")), original);
  } finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir())); assert.ok(path.basename(temporary).startsWith("hive-hook-lifecycle-")); await fs.rm(temporary, { recursive: true, force: true }); }
}

test("actual Queen subagents receive start context and continue the same bounded builder after SubagentStop", async () => fixture(async (f) => {
  await f.configure([["SubagentStart", "subagent_start"], ["SubagentStop", "subagent_stop"]]);
  const { record } = await f.start(); assert.equal(record.status, "completed", JSON.stringify(record.finalReport)); assert.equal(record.verdict, "ACCEPTED", JSON.stringify(record.finalReport));
  const events = await f.events(), starts = events.filter((event) => event.hook_event_name === "SubagentStart"), stops = events.filter((event) => event.hook_event_name === "SubagentStop");
  for (const role of ["builder", "validator", "reviewer"]) { assert.ok(starts.some((event) => event.agent_type === role), `${role} start was not emitted`); assert.ok(stops.some((event) => event.agent_type === role), `${role} stop was not emitted`); }
  const builderStops = stops.filter((event) => event.agent_type === "builder"); assert.equal(builderStops.length, 2); assert.equal(builderStops[0].stop_hook_active, false); assert.equal(builderStops[1].stop_hook_active, true); assert.equal(builderStops[0].agent_id, builderStops[1].agent_id);
  assert.equal(record.tasks.filter((entry) => entry.role === "builder").length, 1);
  const builderRequests = f.requests.filter((entry) => entry.system.includes("HIVE builder subagent")); assert.ok(builderRequests.some((entry) => `${entry.system}\n${entry.prompt}`.includes("LIVE_SUBAGENT_START_CONTEXT"))); assert.ok(builderRequests.some((entry) => entry.prompt.includes("LIVE_SUBAGENT_CONTINUATION")));
  assert.ok(f.requests.every((entry) => entry.body.model === "owner-hook-model"));
}, "subagent-continue"));

test("actual Queen Stop continuation runs scoped work and refreshes validation and review before final completion", async () => fixture(async (f) => {
  await f.configure([["Stop", "stop"]]);
  const { record } = await f.start(); assert.equal(record.status, "completed", JSON.stringify(record.finalReport)); assert.equal(record.verdict, "ACCEPTED", JSON.stringify(record.finalReport));
  const events = (await f.events()).filter((event) => event.hook_event_name === "Stop"); assert.equal(events.length, 2); assert.equal(events[0].stop_hook_active, false); assert.equal(events[1].stop_hook_active, true);
  const continuation = record.tasks.find((entry) => entry.objective.includes("LIVE_STOP_CONTINUATION")); assert.ok(continuation, "Stop feedback was not executed as work"); assert.deepEqual(continuation.fileScope, ["input.txt"]); assert.equal(continuation.status, "completed");
  assert.ok(f.requests.filter((entry) => entry.system.includes("HIVE validator subagent")).length >= 2, "Continuation must rerun validation"); assert.ok(f.requests.filter((entry) => entry.system.includes("HIVE reviewer subagent")).length >= 2, "Continuation must rerun review");
  assert.equal(await fs.readFile(path.join(f.root, "input.txt"), "utf8"), "Actual unchanged fixture evidence\n");
}, "stop-continue"));

test("actual provider failure emits observational StopFailure instead of successful Stop", async () => fixture(async (f) => {
  await f.configure([["StopFailure", "stop_failure"], ["Stop", "stop"]]);
  const { record } = await f.start(); assert.equal(record.status, "failed");
  const events = await f.events(); assert.equal(events.filter((event) => event.hook_event_name === "Stop").length, 0); const failure = events.find((event) => event.hook_event_name === "StopFailure"); assert.ok(failure); assert.ok(failure.error); assert.match(JSON.stringify(failure), /intentional lifecycle provider failure|provider|request|failed/iu);
}, "provider-failure"));

test("plan-mode Stop feedback replaces the persisted plan with validated executable tasks", async () => fixture(async (f) => {
  await f.configure([["Stop", "stop"]]);
  const { record, store } = await f.start({ mode: "plan" });
  assert.equal(record.status, "completed", JSON.stringify(record.finalReport));
  assert.equal(record.plan.summary, "Revised plan after stop feedback"); assert.equal(record.plan.taskIds.length, 2);
  const revised = record.plan.taskIds.map((taskId) => record.tasks.find((entry) => entry.id === taskId));
  assert.ok(revised.some((entry) => entry.fileScope.includes("additional.txt"))); assert.ok(revised.every((entry) => entry.status === "skipped"));
  const saved = await store.load(record.id); assert.deepEqual(saved.plan, record.plan);
  assert.equal(f.requests.filter((entry) => entry.system.includes("HIVE Planner")).length, 2);
}, "plan-stop-continue"));

test("plan-mode stop revisions respect the remaining session task budget", async () => fixture(async (f) => {
  await f.configure([["Stop", "stop"]]); const { record } = await f.start({ mode: "plan", maxTasks: 6 });
  assert.equal(record.status, "failed"); assert.ok(record.tasks.length <= 6); assert.match(record.finalReport.outstanding.join("\n"), /replanning.*task budget/);
  assert.equal(record.plan.taskIds.length, 1, "An oversized replacement must never register a partial executable graph");
}, "plan-stop-budget"));

test("PermissionRequest denial precedes ordinary approval and prevents actual tool side effects", async () => fixture(async (f) => {
  await f.configure([["PermissionRequest", "permission_request"]]); let approvals = 0, executions = 0;
  const tools = await createExtensionToolExecutor({ extensionRoot: f.root, repositoryRoot: f.root, mode: "auto", extensionOptions: f.extensionOptions, signal: new AbortController().signal,
    base: { builtinToolNames: ["run_command"], async execute() { executions++; return { ok: true, output: "must not execute" }; } }, requestToolPermission: async () => { approvals++; return true; },
  });
  try { const result = await tools.execute("run_command", { command: "node --version" }, task, new AbortController().signal); assert.equal(result.ok, false); assert.equal(result.metadata.permissionDenied, true); assert.equal(approvals, 0); assert.equal(executions, 0); const [event] = await f.events(); assert.equal(event.hook_event_name, "PermissionRequest"); assert.equal(event.tool_name, "Bash"); assert.equal(event.session_id, task.sessionId); }
  finally { await tools.close(); }
}, "permission-deny"));

test("completion callbacks stay inside the same iteration budget and propagate cancellation", async () => {
  let generations = 0, checks = 0;
  await assert.rejects(new StructuredAgentLoop().run({ task, cwd: process.cwd(), sharedContext: "Fixture", maxTurns: 3, signal: new AbortController().signal, tools: { builtinToolNames: [], async execute() { throw new Error("No tools expected"); } }, completionClient: { async complete() { generations++; return { output: JSON.stringify({ done: true, summary: "Candidate completion" }) }; } }, beforeFinish: async () => { checks++; return "Keep inspecting actual evidence"; } }), /iteration|budget|maximum|limit/iu);
  assert.equal(generations, 3); assert.equal(checks, 3);
  const controller = new AbortController();
  await assert.rejects(new StructuredAgentLoop().run({ task, cwd: process.cwd(), sharedContext: "Fixture", signal: controller.signal, tools: { builtinToolNames: [], async execute() { throw new Error("No tools expected"); } }, completionClient: { async complete() { return { output: JSON.stringify({ done: true, summary: "Candidate completion" }) }; } }, beforeFinish: async () => { controller.abort(); return "Continue"; } }), { name: "AbortError" });
});
