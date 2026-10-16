import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverExtensions, setExtensionState } from "../dist/extensions/catalog.js";
import { runHooks } from "../dist/extensions/hooks.js";
import { claudeHookOutcome, importClaudeHooks, matchesClaudeHook, parseClaudeHookConfiguration } from "../dist/extensions/claude-hooks.js";
import { claudeHookPrompt, claudeMcpHookInput, parseClaudeHookEvaluation } from "../dist/extensions/claude-hook-handlers.js";
import { compatibleManifest } from "../dist/extensions/marketplace-compat.js";

const advanced = (type, fields, event = "PreToolUse", nativeEvent = "before_tool", extra = {}) => ({ event: nativeEvent, timeoutMs: 5000, claude: { event, handler: { type, ...fields }, ...extra } });
const file = (name, value) => ({ name, bytes: Buffer.from(JSON.stringify(value)), executable: false });
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
const bounded = (promise, label, ms = 5000) => { let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label)), ms); })]).finally(() => clearTimeout(timer)); };

async function fixture(run) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hive-advanced-hooks-"));
  const root = path.join(temporary, "project"), options = { trustStateDir: path.join(temporary, "trust") };
  await fs.mkdir(path.join(root, ".hive"), { recursive: true });
  const write = async (name, value) => { const target = path.join(root, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, value); return target; };
  const config = (hooks) => write(".hive/extensions.json", JSON.stringify({ version: 1, hooks }));
  const activate = async () => {
    const catalog = await discoverExtensions(root, options); assert.deepEqual(catalog.diagnostics, []);
    for (const hook of catalog.hooks) { await setExtensionState(root, hook.id, "trust", options); await setExtensionState(root, hook.id, "enable", options); }
  };
  try { await run({ root, temporary, options, write, config, activate }); }
  finally { assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir())); assert.ok(path.basename(temporary).startsWith("hive-advanced-hooks-")); await fs.rm(temporary, { recursive: true, force: true }); }
}

async function endpoint(run) {
  const requests = [], entered = deferred(), closed = deferred(), released = deferred(); let mode = "json";
  const server = http.createServer(async (request, response) => {
    try {
      let raw = ""; for await (const chunk of request) raw += chunk;
      requests.push({ method: request.method, url: request.url, headers: request.headers, input: raw ? JSON.parse(raw) : null }); entered.resolve();
      response.on("close", () => { if (!response.writableEnded) closed.resolve(); });
      if (mode === "stall") { response.writeHead(200, { "content-type": "application/json" }); response.flushHeaders(); return; }
      if (mode === "redirect") { response.writeHead(302, { location: "/must-not-follow" }).end(); return; }
      if (mode === "error") { response.writeHead(500).end("Private response must not be surfaced"); return; }
      if (mode === "text") { response.end("unexpected body"); return; }
      if (mode === "large") { response.end("x".repeat(65537)); return; }
      if (mode === "utf8") { response.end(Buffer.from([0xc3, 0x28])); return; }
      if (mode === "allow") { response.end(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } })); return; }
      if (mode === "empty") { response.writeHead(204).end(); return; }
      if (mode === "rotate") await released.promise;
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: `Gate rejected ${request.headers["x-test-credential"] ?? "fixture"}`, additionalContext: `Credential echo ${request.headers["x-test-credential"] ?? "none"}` } }));
    } catch { response.writeHead(500).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try { await run({ requests, url: `http://127.0.0.1:${server.address().port}/hook`, entered: entered.promise, closed: closed.promise, release() { released.resolve(); }, setMode(value) { mode = value; } }); }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); }
}

test("Claude imports all advanced handler types without commands or execution", () => {
  const hooks = importClaudeHooks([], "C:/ignored-plugin", [{ PreToolUse: [{ matcher: "Edit|Write", hooks: [
    { type: "http", url: "https://hooks.example.test/check", headers: { Authorization: "Bearer ${HOOK_KEY}" }, allowedEnvVars: ["HOOK_KEY"] },
    { type: "prompt", prompt: "Check the task\n$ARGUMENTS", continueOnBlock: true },
    { type: "agent", prompt: "Inspect the implementation", timeout: 65 },
    { type: "mcp_tool", server: "plugin:fixture:scanner", tool: "scan", input: { path: "${tool_input.file_path}" } },
  ] }] }]);
  assert.equal(Object.keys(hooks).length, 4);
  assert.deepEqual(Object.values(hooks).map((value) => value.claude.handler.type), ["http", "prompt", "agent", "mcp_tool"]);
  for (const hook of Object.values(hooks)) { assert.equal(hook.event, "before_tool"); assert.equal(hook.command, undefined); assert.equal(hook.args, undefined); }
  assert.equal(hooks["claude-agent-3"], undefined); assert.equal(Object.values(hooks)[2].timeoutMs, 65000);
});

test("Claude hook schemas reject unsupported event/type combinations and execution fields", () => {
  const parse = (event, native, handler) => parseClaudeHookConfiguration({ event, handler }, native);
  assert.throws(() => parse("SessionStart", "session_start", { type: "http", url: "https://example.test/hook" }), /does not support/);
  assert.throws(() => parse("SessionEnd", "session_end", { type: "prompt", prompt: "Check" }), /does not support/);
  assert.throws(() => parse("PermissionRequest", "permission_request", { type: "agent", prompt: "Check" }), /does not support/);
  assert.throws(() => parse("SessionStart", "session_start", { type: "mcp_tool", server: "fixture", tool: "scan" }), /unavailable/);
  assert.throws(() => parse("PreToolUse", "before_tool", { type: "agent", prompt: "Check", continueOnBlock: true }), /unsupported field/);
  assert.throws(() => parse("Stop", "stop", { type: "prompt", prompt: "Check", command: "node" }), /unsupported field/);
  assert.throws(() => parseClaudeHookConfiguration({ event: "Stop", matcher: "anything" }, "stop"), /matchers/);
  assert.throws(() => importClaudeHooks([], "/unused", [{ PreToolUse: [{ hooks: [{ type: "http", url: "https://example.test", async: true }] }] }]), /unsupported field/);
});

test("HTTP hook configuration rejects URL credentials, unsafe headers and literal credential values", () => {
  const parse = (handler) => parseClaudeHookConfiguration({ event: "PreToolUse", handler: { type: "http", ...handler } }, "before_tool");
  for (const url of ["http://example.com/hook", "https://user:private@example.com/hook", "https://example.com/hook#fragment", "https://example.com?api_key=opaque", "https://127.0.0.1/hook", "file:///tmp/hook"]) assert.throws(() => parse({ url }), /HTTPS|credentials/);
  for (const headers of [{ Authorization: "Bearer opaque-literal" }, { "x-api-key": "opaque" }, { Host: "elsewhere.test" }, { Cookie: "account=private" }, { "X-Name": "before\r\nafter" }, { "X-Name": "safe", "x-name": "duplicate" }]) assert.throws(() => parse({ url: "https://example.test", headers }), /header/);
  assert.throws(() => parse({ url: "https://example.test", allowedEnvVars: ["NAME", "NAME"] }), /unique/);
  assert.equal(parse({ url: "http://127.0.0.1:8080/hook", headers: { Authorization: "Bearer $MY_KEY" }, allowedEnvVars: ["MY_KEY"] }).handler.type, "http");
});

test("real trusted HTTP hook receives canonical JSON and allowlisted headers; echoes are redacted", async () => fixture(async (context) => endpoint(async (http) => {
  const envName = "HIVE_ADVANCED_HOOK_TEST_KEY", previous = process.env[envName], secret = "opaque-hook-credential-91023";
  process.env[envName] = secret;
  try {
    await context.config({ gate: advanced("http", { url: http.url, headers: { "X-Test-Credential": `$${envName}`, "X-Public": "fixture", "X-Unlisted": "$PATH", Authorization: `Bearer \${${envName}}` }, allowedEnvVars: [envName] }) });
    assert.deepEqual(await runHooks(context.root, "before_tool", {}, context.options), []); assert.equal(http.requests.length, 0);
    await context.activate();
    const [result] = await runHooks(context.root, "before_tool", { sessionId: "actual-session", tool: "edit_file", workspace: context.root, input: { path: "src/file.ts", search: "old", replacement: "new" } }, context.options);
    assert.equal(result.ok, true); assert.equal(result.blocked, true); assert.equal(http.requests.length, 1);
    const request = http.requests[0]; assert.equal(request.method, "POST"); assert.equal(request.headers["content-type"], "application/json");
    assert.equal(request.headers["x-test-credential"], secret); assert.equal(request.headers.authorization, `Bearer ${secret}`); assert.equal(request.headers["x-unlisted"], ""); assert.equal(request.headers.cookie, undefined);
    assert.equal(request.input.hook_event_name, "PreToolUse"); assert.equal(request.input.session_id, "actual-session"); assert.equal(request.input.tool_name, "Edit"); assert.equal(request.input.tool_input.file_path, path.join(context.root, "src", "file.ts"));
    assert.ok(!JSON.stringify(result).includes(secret)); assert.match(result.additionalContext, /\[REDACTED\]/); assert.match(result.diagnostics[0], /\[REDACTED\]/);
  } finally { if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous; }
})));

test("HTTP hook failures honor onFailure and never follow redirects or expose response bodies", async () => fixture(async (context) => endpoint(async (http) => {
  for (const mode of ["redirect", "error", "text", "large", "utf8"]) {
    http.setMode(mode); await context.config({ gate: advanced("http", { url: http.url }) }); await context.activate();
    const [result] = await runHooks(context.root, "before_tool", {}, context.options); assert.equal(result.ok, false, mode); assert.equal(result.blocked, false, mode); assert.ok(!result.output.includes("Private response"));
    await context.config({ gate: advanced("http", { url: http.url }, "PreToolUse", "before_tool", { onFailure: "block" }) }); await context.activate();
    const [blocked] = await runHooks(context.root, "before_tool", {}, context.options); assert.equal(blocked.ok, false); assert.equal(blocked.blocked, true);
  }
  assert.equal(http.requests.filter((entry) => entry.url === "/must-not-follow").length, 0);
  http.setMode("empty"); const [empty] = await runHooks(context.root, "before_tool", {}, context.options); assert.equal(empty.ok, true); assert.equal(empty.blocked, false);
})));

test("advanced hooks cannot grant permissions through HTTP JSON", async () => fixture(async (context) => endpoint(async (http) => {
  http.setMode("allow"); await context.config({ gate: advanced("http", { url: http.url }, "PreToolUse", "before_tool", { onFailure: "block" }) }); await context.activate();
  const [result] = await runHooks(context.root, "before_tool", {}, context.options); assert.equal(result.ok, false); assert.equal(result.blocked, true); assert.match(result.output, /cannot approve/);
})));

test("cancelling an HTTP hook closes the actual owned connection", async () => fixture(async (context) => endpoint(async (http) => {
  http.setMode("stall"); await context.config({ gate: advanced("http", { url: http.url }) }); await context.activate();
  const controller = new AbortController(); const running = runHooks(context.root, "before_tool", {}, { ...context.options, signal: controller.signal });
  await bounded(http.entered, "HTTP hook was not entered"); controller.abort(); await assert.rejects(running, { name: "AbortError" }); await bounded(http.closed, "Aborted HTTP hook socket did not close");
})));

test("per-hook HTTP deadlines abort rather than waiting for stalled body streams", async () => fixture(async (context) => endpoint(async (http) => {
  http.setMode("stall"); await context.config({ gate: { ...advanced("http", { url: http.url }, "PreToolUse", "before_tool", { onFailure: "block" }), timeoutMs: 100 } }); await context.activate();
  const [result] = await bounded(runHooks(context.root, "before_tool", {}, context.options), "Hook ignored its deadline"); assert.equal(result.ok, false); assert.equal(result.blocked, true); await bounded(http.closed, "Timed-out HTTP socket did not close");
})));

test("prompt expansion preserves literal dollars and quotes hook input as data", () => {
  const input = { prompt: "actual user task", tool_input: { path: "a $ARGUMENTS file" } };
  const expanded = claudeHookPrompt("Check $ARGUMENTS and literal \\$ARGUMENTS; \\$1.00", input);
  assert.ok(expanded.includes(JSON.stringify(input))); assert.ok(expanded.endsWith("literal $ARGUMENTS; $1.00"));
  assert.equal(claudeHookPrompt("Check this", input), `Check this\n\nHook input JSON:\n${JSON.stringify(input)}`);
});

test("prompt decisions implement denial/continuation semantics and preserve requested model metadata", async () => fixture(async (context) => {
  const requests = []; let evaluation = { ok: false, reason: "Inspect the unsafe edit" };
  const host = { async evaluate(request) { requests.push(request); return evaluation; } };
  await context.config({ gate: advanced("prompt", { prompt: "Check $ARGUMENTS", model: "explicit-owner-model" }) }); await context.activate();
  let [result] = await runHooks(context.root, "before_tool", { tool: "edit_file", input: { path: "a.ts" } }, { ...context.options, claudeHookHost: host });
  assert.equal(result.ok, true); assert.equal(result.blocked, true); assert.equal(result.stop, true); assert.equal(requests[0].model, "explicit-owner-model"); assert.equal(requests[0].maxTurns, 1); assert.equal(requests[0].input.tool_name, "Edit");
  await context.config({ gate: advanced("prompt", { prompt: "Check", continueOnBlock: true }) }); await context.activate();
  [result] = await runHooks(context.root, "before_tool", {}, { ...context.options, claudeHookHost: host }); assert.equal(result.blocked, true); assert.equal(result.stop, undefined);
  evaluation = { ok: true }; [result] = await runHooks(context.root, "before_tool", {}, { ...context.options, claudeHookHost: host }); assert.equal(result.blocked, false); assert.equal(result.stop, undefined);
}));

test("Stop and SubagentStop use real verifier continuation and prompt impossible escape", async () => fixture(async (context) => {
  let evaluation = { ok: false, reason: "Read the missing evidence" }; const requests = [];
  const host = { async evaluate(request) { requests.push(request); return evaluation; } };
  await context.config({ gate: advanced("prompt", { prompt: "Check completion" }, "Stop", "stop") }); await context.activate();
  let [result] = await runHooks(context.root, "stop", { lastAssistantMessage: "Actual final answer", stop_hook_active: true }, { ...context.options, claudeHookHost: host });
  assert.equal(result.continuation, evaluation.reason); assert.equal(result.stop, undefined); assert.equal(requests[0].input.last_assistant_message, "Actual final answer"); assert.equal(requests[0].input.stop_hook_active, true);
  evaluation = { ...evaluation, impossible: true }; [result] = await runHooks(context.root, "stop", {}, { ...context.options, claudeHookHost: host }); assert.equal(result.continuation, undefined);
  evaluation = { ok: false, reason: "Inspect one more file" }; await context.config({ gate: advanced("agent", { prompt: "Inspect completion" }, "SubagentStop", "subagent_stop") }); await context.activate();
  [result] = await runHooks(context.root, "subagent_stop", { taskId: "actual-child", role: "builder", lastAssistantMessage: "Child summary" }, { ...context.options, claudeHookHost: host });
  assert.equal(result.continuation, evaluation.reason); assert.equal(requests.at(-1).maxTurns, 50); assert.equal(requests.at(-1).input.agent_id, "actual-child"); assert.equal(requests.at(-1).input.agent_type, "builder");
}));

test("model decisions and missing host capabilities fail closed at the input boundary", async () => fixture(async (context) => {
  for (const [raw, type] of [[{}, "prompt"], [{ ok: "true" }, "prompt"], [{ ok: false }, "prompt"], [{ ok: false, reason: "No", impossible: true }, "agent"], [{ ok: true, reason: "yes", permissionDecision: "allow" }, "agent"], [{ ok: true, impossible: true }, "prompt"]]) assert.throws(() => parseClaudeHookEvaluation(raw, type), /decision|reason|unsupported|impossible/);
  await context.config({ gate: advanced("prompt", { prompt: "Check" }) }); await context.activate();
  const [missing] = await runHooks(context.root, "before_tool", {}, context.options); assert.equal(missing.ok, false); assert.equal(missing.blocked, true); assert.match(missing.output, /trusted host/);
  const [invalid] = await runHooks(context.root, "before_tool", {}, { ...context.options, claudeHookHost: { async evaluate() { return { ok: false }; } } }); assert.equal(invalid.ok, false); assert.equal(invalid.blocked, true);
}));

test("model hook timeout signals the host and bounds an uncooperative evaluator", async () => fixture(async (context) => {
  const aborted = deferred(); await context.config({ gate: { ...advanced("agent", { prompt: "Inspect" }), timeoutMs: 100 } }); await context.activate();
  const [result] = await bounded(runHooks(context.root, "before_tool", {}, { ...context.options, claudeHookHost: { async evaluate({ signal }) { signal.addEventListener("abort", () => aborted.resolve()); await new Promise(() => {}); } } }), "Uncooperative host exceeded bounded deadline");
  assert.equal(result.ok, false); assert.equal(result.blocked, true); await bounded(aborted.promise, "Host did not receive cancellation");
}));

test("fresh trust validation blocks a later advanced hook after the first verifier revokes it", async () => fixture(async (context) => {
  const calls = []; await context.config({ first: advanced("prompt", { prompt: "First" }), second: advanced("agent", { prompt: "Second" }) }); await context.activate();
  const results = await runHooks(context.root, "before_tool", {}, { ...context.options, claudeHookHost: { async evaluate(request) { calls.push(request.hookId); await setExtensionState(context.root, "hook:second", "untrust", context.options); return { ok: true }; } } });
  assert.deepEqual(calls, ["hook:first"]); assert.equal(results.length, 2); assert.equal(results[1].ok, false); assert.equal(results[1].blocked, true); assert.match(results[1].output, /trust or configuration changed/);
}));

test("MCP hook input performs bounded typed substitutions and rejects inherited property access", () => {
  assert.deepEqual(claudeMcpHookInput({ path: "${tool_input.file_path}", count: "${tool_input.count}", text: "prefix:${tool_name}", items: ["${tool_input.enabled}"] }, { tool_name: "Read", tool_input: { file_path: "a.ts", count: 2, enabled: true } }), { path: "a.ts", count: 2, text: "prefix:Read", items: [true] });
  for (const path of ["${tool_input.missing}", "${tool_input.__proto__}", "${constructor}"]) assert.throws(() => claudeMcpHookInput({ path }, { tool_input: {} }), /path|missing/);
  assert.throws(() => claudeMcpHookInput({ text: "prefix ${tool_input}" }, { tool_input: {} }), /scalar/);
});

test("trusted MCP tool hooks delegate exact scoped server/tool with canonical input and no implicit fallback", async () => fixture(async (context) => {
  const requests = []; await context.config({ gate: advanced("mcp_tool", { server: "plugin:fixture:scanner", tool: "scan", input: { path: "${tool_input.file_path}" } }) }); await context.activate();
  const host = { async evaluate() { throw new Error("must not evaluate"); }, async callMcpTool(request) { requests.push(request); return { content: [{ type: "text", text: JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Scanner findings" } }) }] }; } };
  const [result] = await runHooks(context.root, "before_tool", { tool: "read_file", input: { path: "file with spaces.ts" } }, { ...context.options, claudeHookHost: host });
  assert.equal(result.ok, true); assert.equal(result.blocked, true); assert.equal(requests.length, 1); assert.equal(requests[0].server, "plugin:fixture:scanner"); assert.equal(requests[0].tool, "scan"); assert.equal(requests[0].input.path, path.join(context.root, "file with spaces.ts"));
  const [missing] = await runHooks(context.root, "before_tool", { tool: "read_file", input: { path: "a.ts" } }, context.options); assert.equal(missing.ok, false); assert.match(missing.output, /fresh per-tool approval/);
}));

test("advanced marketplace plugin import stays inert until plugin trust and enable", async () => fixture(async (context) => endpoint(async (http) => {
  const destination = path.join(context.root, "plugins", "fixture");
  const converted = compatibleManifest([file(".claude-plugin/plugin.json", { name: "fixture", version: "1.0.0" }), file("hooks/hooks.json", { hooks: { PreToolUse: [{ hooks: [{ type: "http", url: http.url }, { type: "prompt", prompt: "Check" }, { type: "agent", prompt: "Inspect" }] }] } })], "fixture", destination, {});
  for (const entry of converted.files) await context.write(path.join("plugins", "fixture", entry.name), entry.bytes);
  await context.write(".hive/extensions.json", JSON.stringify({ version: 1, plugins: { fixture: { path: "plugins/fixture" } } }));
  const discovered = await discoverExtensions(context.root, context.options); assert.deepEqual(discovered.diagnostics, []); assert.equal(discovered.hooks.length, 3); assert.equal(http.requests.length, 0);
  assert.deepEqual(await runHooks(context.root, "before_tool", {}, context.options), []);
  await setExtensionState(context.root, "plugin:fixture", "trust", context.options); await setExtensionState(context.root, "plugin:fixture", "enable", context.options);
  const calls = []; const results = await runHooks(context.root, "before_tool", {}, { ...context.options, claudeHookHost: { async evaluate(request) { calls.push(request.type); return { ok: true }; } } });
  assert.equal(http.requests.length, 1); assert.deepEqual(calls, ["prompt", "agent"]); assert.equal(results.length, 3);
})));

test("new event matchers use real subagent type and provider failure category", () => {
  assert.equal(matchesClaudeHook(parseClaudeHookConfiguration({ event: "SubagentStart", matcher: "^fixture:reviewer$" }, "subagent_start"), { agent_type: "fixture:reviewer" }), true);
  assert.equal(matchesClaudeHook(parseClaudeHookConfiguration({ event: "StopFailure", matcher: "authentication_failed" }, "stop_failure"), { error: "authentication_failed" }), true);
  assert.equal(matchesClaudeHook(parseClaudeHookConfiguration({ event: "StopFailure", matcher: "rate_limit" }, "stop_failure"), { error: "server_error" }), false);
});

test("PermissionRequest exit 2 keeps normal approval and explicit JSON denial remains enforced", () => {
  const configuration = { event: "PermissionRequest" };
  assert.equal(claudeHookOutcome(configuration, "", "nonblocking notice", 2).blocked, false);
  assert.equal(claudeHookOutcome(configuration, JSON.stringify({ hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "deny", message: "denied by policy" } } }), "", 0).blocked, true);
  assert.equal(claudeHookOutcome({ ...configuration, onFailure: "block" }, "", "explicit HIVE failure policy", 2).blocked, true);
});

test("HTTP hook redacts the dispatched credential after its environment value rotates", async () => fixture(async (context) => endpoint(async (http) => {
  const name = "HIVE_ROTATING_HOOK_TEST_KEY", previous = process.env[name], oldValue = "opaque-before-rotation-fixture", newValue = "opaque-after-rotation-fixture";
  process.env[name] = oldValue;
  try {
    await context.config({ gate: advanced("http", { url: http.url, headers: { "X-Test-Credential": `$${name}` }, allowedEnvVars: [name] }) }); await context.activate(); http.setMode("rotate");
    const pending = runHooks(context.root, "before_tool", {}, context.options);
    await http.entered; process.env[name] = newValue; http.release();
    const results = await pending; assert.equal(http.requests[0].headers["x-test-credential"], oldValue);
    assert.ok(!JSON.stringify(results).includes(oldValue)); assert.ok(!JSON.stringify(results).includes(newValue)); assert.match(JSON.stringify(results), /REDACTED/);
  } finally { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; http.release(); }
})));
