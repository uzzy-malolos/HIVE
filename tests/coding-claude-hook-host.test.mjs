import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { execFile } from "node:child_process";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createCodingClaudeHookHost } from "../dist/coding/claude-hook-host.js";
import { ProviderRouter } from "../dist/coding/provider-router.js";
import { ProviderRegistry } from "../dist/providers/registry.js";
import { setExtensionState } from "../dist/extensions/catalog.js";

const execFileAsync = promisify(execFile);

async function fixture(run) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hive-claude-host-"));
  const root = path.join(temporary, "project"); await fs.mkdir(path.join(root, ".hive"), { recursive: true });
  const requests = [], outputs = []; let schemaVersion = 1, failModel = false, fixtureError;
  const modelStarted = Promise.withResolvers();
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET") {
        if (request.url.endsWith("/models")) { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "selected-model" }] })); }
        else response.writeHead(405).end();
        return;
      }
      if (request.method === "DELETE") { requests.push({ method: "DELETE" }); response.writeHead(200).end(); return; }
      let raw = ""; for await (const chunk of request) raw += chunk;
      const message = JSON.parse(raw);
      if (request.url === "/mcp") {
        requests.push({ kind: "mcp", message });
        if (message.id === undefined) { response.writeHead(202).end(); return; }
        const result = message.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "claude-host-fixture", version: "1" } }
          : message.method === "tools/list" ? { tools: [{ name: "verify", description: "Read fixture status", inputSchema: { type: "object", properties: { value: { type: schemaVersion === 1 ? "string" : "number" } } } }] }
          : { content: [{ type: "text", text: JSON.stringify({ decision: "allow", fixture: true }) }] };
        response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result })); return;
      }
      requests.push({ kind: "model", message, url: request.url }); modelStarted.resolve();
      if (failModel) { response.writeHead(503).end("Unavailable fixture"); return; }
      const output = outputs.shift();
      if (output === undefined) throw new Error("No model fixture response queued");
      response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ choices: [{ message: { content: typeof output === "string" ? output : JSON.stringify(output) } }] }));
    } catch (error) { fixtureError = error; response.writeHead(500).end(); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const extensionOptions = { trustStateDir: path.join(temporary, "trust") };
  const config = { version: 1, hooks: {
    prompt: { event: "before_tool", claude: { event: "PreToolUse", handler: { type: "prompt", prompt: "Verify fixture" } } },
    agent: { event: "before_tool", claude: { event: "PreToolUse", handler: { type: "agent", prompt: "Verify fixture" } } },
    mcp: { event: "before_tool", claude: { event: "PreToolUse", handler: { type: "mcp_tool", server: "fixture", tool: "verify", input: {} } } },
  }, mcpServers: { fixture: { transport: "http", url: `${origin}/mcp`, timeoutMs: 5000 } } };
  await fs.writeFile(path.join(root, ".hive", "extensions.json"), JSON.stringify(config));
  for (const id of ["hook:prompt", "hook:agent", "hook:mcp", "mcp:fixture"]) {
    await setExtensionState(root, id, "trust", extensionOptions); await setExtensionState(root, id, "enable", extensionOptions);
  }
  const registry = new ProviderRegistry(root);
  await registry.add({ id: "primary", name: "Fixture primary", kind: "local", authType: "none", baseUrl: `${origin}/primary/v1`, defaultModel: "configured-default" });
  await registry.approve("primary"); await registry.setRole("builder", "primary", "selected-model");
  await registry.add({ id: "fallback", name: "Fixture fallback", kind: "local", authType: "none", baseUrl: `${origin}/fallback/v1`, defaultModel: "fallback-model" });
  await registry.approve("fallback"); await registry.setRole("fallback", "fallback", "fallback-model");
  const router = new ProviderRouter({ projectRoot: root, sessionId: "hook-host-test", projectRegistry: registry, globalRegistry: new ProviderRegistry(path.join(temporary, "global")) });
  const permissions = [];
  const host = (requestPermission = async (request) => { permissions.push(request); return true; }) => createCodingClaudeHookHost({ cwd: root, router, extensionOptions, requestPermission });
  const evaluate = (options = {}) => ({ hookId: "hook:prompt", event: "PreToolUse", type: "prompt", prompt: "Verify this fixture input", input: { tool_name: "Write" }, cwd: root, maxTurns: 1, signal: new AbortController().signal, ...options });
  try { await run({ root, registry, router, extensionOptions, outputs, requests, permissions, host, evaluate, modelStarted, changeSchema() { schemaVersion += 1; }, failModel() { failModel = true; } }); if (fixtureError) throw fixtureError; }
  finally { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); assert.equal(path.dirname(temporary), path.resolve(os.tmpdir())); await fs.rm(temporary, { recursive: true, force: true }); }
}

test("default Claude prompt host executes approved actual selected provider without changing roles", async () => fixture(async (f) => {
  const roles = await f.registry.getRoles(); f.outputs.push({ ok: false, reason: "fixture denial", impossible: true });
  assert.deepEqual(await f.host().evaluate(f.evaluate()), { ok: false, reason: "fixture denial", impossible: true });
  const calls = f.requests.filter((request) => request.kind === "model"); assert.equal(calls.length, 1); assert.match(calls[0].url, /primary/); assert.equal(calls[0].message.model, "selected-model");
  assert.equal(calls[0].message.max_tokens, 2048); assert.equal(f.permissions.length, 1); assert.equal(f.permissions[0].input.providerId, "primary"); assert.equal(f.permissions[0].alwaysAsk, true);
  assert.deepEqual(await f.registry.getRoles(), roles);
}));

test("hook model selection inherits or uses only an explicitly configured model on the selected provider", async () => fixture(async (f) => {
  await assert.rejects(f.host().evaluate(f.evaluate({ model: "invented-other-model" })), /configured model/);
  assert.equal(f.requests.filter((request) => request.kind === "model").length, 0);
  f.outputs.push({ ok: true }); await f.host().evaluate(f.evaluate({ model: "configured-default" }));
  assert.equal(f.requests.find((request) => request.kind === "model").message.model, "configured-default");
}));

test("model hook approvals decline, missing callbacks and cancellation fail closed before generation", async () => fixture(async (f) => {
  await assert.rejects(f.host(async () => false).evaluate(f.evaluate()), /not authorized/);
  await assert.rejects(createCodingClaudeHookHost({ cwd: f.root, router: f.router, extensionOptions: f.extensionOptions }).evaluate(f.evaluate()), /approval callback/);
  const controller = new AbortController(); const pending = f.host(async () => { controller.abort(); return new Promise(() => {}); }).evaluate(f.evaluate({ signal: controller.signal }));
  await assert.rejects(pending, { name: "AbortError" }); assert.equal(f.requests.filter((request) => request.kind === "model").length, 0);
}));

test("failed selected hook provider never silently invokes configured fallback", async () => fixture(async (f) => {
  f.failModel(); await assert.rejects(f.host().evaluate(f.evaluate()), /failed|503|unavailable/i);
  assert.equal(f.requests.filter((request) => request.kind === "model").length, 1); assert.ok(f.requests.filter((request) => request.kind === "model").every((request) => request.url.includes("/primary/")));
}));

test("verifier agent reads actual jailed source after separate approval and returns strict decision", async () => fixture(async (f) => {
  await fs.writeFile(path.join(f.root, "fixture.ts"), "export const actualFixture = 42;\n");
  f.outputs.push({ toolCalls: [{ name: "read_file", arguments: { path: "fixture.ts" } }] }, { ok: true, reason: "Source contains actualFixture" });
  assert.deepEqual(await f.host().evaluate(f.evaluate({ hookId: "hook:agent", type: "agent", maxTurns: 3 })), { ok: true, reason: "Source contains actualFixture" });
  assert.deepEqual(f.permissions.map((request) => request.tool), ["claude_hook_model", "read_file", "claude_hook_model"]);
  const last = f.requests.filter((request) => request.kind === "model").at(-1); assert.match(JSON.stringify(last.message), /actualFixture = 42/);
  assert.equal(await fs.readFile(path.join(f.root, "fixture.ts"), "utf8"), "export const actualFixture = 42;\n");
  await assert.rejects(fs.access(path.join(f.root, ".hivemind")), { code: "ENOENT" });
}));

test("verifier rejects writes, commands, private paths and external escapes without accessing them", async () => fixture(async (f) => {
  await fs.writeFile(path.join(f.root, ".env"), "SECRET=unpublished-fixture-secret\n");
  for (const call of [{ name: "write_file", arguments: { path: "owned.txt", content: "blocked" } }, { name: "run_command", arguments: { command: "node --version" } }, { name: "read_file", arguments: { path: ".env" } }, { name: "read_file", arguments: { path: "../outside.txt" } }]) {
    f.outputs.push({ toolCalls: [call] }); await assert.rejects(f.host().evaluate(f.evaluate({ hookId: "hook:agent", type: "agent", maxTurns: 2 })), /prohibited|private|escaping/);
  }
  await assert.rejects(fs.access(path.join(f.root, "owned.txt")), { code: "ENOENT" });
  assert.ok(f.requests.filter((request) => request.kind === "model").every((request) => !JSON.stringify(request.message).includes("unpublished-fixture-secret")));
}));

test("verifier literal search omits private files and refuses aliased or hard-linked source", async () => fixture(async (f) => {
  await fs.writeFile(path.join(f.root, "source.ts"), "export const fixtureFact = 7;\n"); await fs.writeFile(path.join(f.root, ".env"), "fixtureFact=private-answer\n");
  f.outputs.push({ toolCalls: [{ name: "search_text", arguments: { query: "fixtureFact" } }] }, { ok: true });
  await f.host().evaluate(f.evaluate({ hookId: "hook:agent", type: "agent", maxTurns: 2 }));
  const last = f.requests.filter((request) => request.kind === "model").at(-1); assert.match(JSON.stringify(last.message), /fixtureFact = 7/); assert.doesNotMatch(JSON.stringify(last.message), /private-answer/);
  await fs.link(path.join(f.root, ".env"), path.join(f.root, "alias.txt")); f.outputs.push({ toolCalls: [{ name: "read_file", arguments: { path: "alias.txt" } }] });
  await assert.rejects(f.host().evaluate(f.evaluate({ hookId: "hook:agent", type: "agent", maxTurns: 2 })), /linked/);
}));

test("strict decisions reject surrounding prose, extra fields, agent impossible and invalid turn limits", async () => fixture(async (f) => {
  for (const output of ['prefix {"ok":true}', { ok: true, permissionDecision: "allow" }, { ok: false, impossible: true, reason: "forbidden agent field" }]) {
    f.outputs.push(output); await assert.rejects(f.host().evaluate(f.evaluate({ hookId: "hook:agent", type: "agent", maxTurns: 1 })));
  }
  await assert.rejects(f.host().evaluate(f.evaluate({ type: "agent", maxTurns: 51 })), /turn limit/);
  f.outputs.push({ toolCalls: [{ name: "list_directory", arguments: {} }] }); await assert.rejects(f.host().evaluate(f.evaluate({ hookId: "hook:agent", type: "agent", maxTurns: 1 })), /1-turn limit/);
}));

test("verifier diff reads raw changed/deleted index blobs without executing repository filters or fsmonitor", async () => fixture(async (f) => {
  const git = (args) => execFileAsync("git", args, { cwd: f.root, windowsHide: true });
  await git(["init", "--quiet"]);
  await fs.writeFile(path.join(f.root, "tracked.ts"), "export const rawValue = 1;\n"); await fs.writeFile(path.join(f.root, "removed.ts"), "export const removedValue = true;\n");
  await fs.writeFile(path.join(f.root, ".env"), "private-diff-fixture-value=first\n");
  await git(["add", "tracked.ts", "removed.ts", ".env"]); await git(["-c", "user.name=Hook Fixture", "-c", "user.email=hook-fixture@example.invalid", "commit", "--quiet", "-m", "fixture baseline"]);
  const marker = path.join(f.root, "filter-executed.txt"), script = path.join(f.root, "filter-fixture.mjs");
  await fs.writeFile(script, `import {writeFileSync} from 'node:fs';writeFileSync(${JSON.stringify(marker)},'unexpected execution');process.stdin.pipe(process.stdout);`);
  const program = `"${process.execPath.replaceAll("\\", "/")}" "${script.replaceAll("\\", "/")}"`;
  await git(["config", "filter.hookfixture.clean", program]); await git(["config", "filter.hookfixture.process", program]); await git(["config", "diff.hookfixture.textconv", program]); await git(["config", "core.fsmonitor", program]);
  await fs.writeFile(path.join(f.root, ".gitattributes"), "*.ts filter=hookfixture diff=hookfixture\n");
  await fs.writeFile(path.join(f.root, "tracked.ts"), "export const rawValue = 2;\n"); await fs.rm(path.join(f.root, "removed.ts")); await fs.writeFile(path.join(f.root, ".env"), "private-diff-fixture-value=changed\n");
  f.outputs.push({ toolCalls: [{ name: "inspect_diff", arguments: {} }] }, { ok: true });
  await f.host().evaluate(f.evaluate({ hookId: "hook:agent", type: "agent", maxTurns: 2 }));
  const last = f.requests.filter((request) => request.kind === "model").at(-1); const text = JSON.stringify(last.message);
  const prompt = JSON.parse(last.message.messages.find((message) => message.role === "user").content);
  const diff = JSON.parse(prompt.history[0].result);
  assert.match(text, /rawValue = 1/); assert.match(text, /rawValue = 2/); assert.match(text, /removedValue/); assert.equal(diff.changes.find((entry) => entry.path === "removed.ts").after, null); assert.doesNotMatch(text, /private-diff-fixture-value/);
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
}));

test("hook trust revoked during model approval prevents generation", async () => fixture(async (f) => {
  const host = f.host(async () => { await setExtensionState(f.root, "hook:prompt", "untrust", f.extensionOptions); return true; });
  await assert.rejects(host.evaluate(f.evaluate()), /trust or configuration changed/); assert.equal(f.requests.filter((request) => request.kind === "model").length, 0);
}));

test("MCP hook executes real trusted HTTP tool only after current schema approval and closes", async () => fixture(async (f) => {
  const result = await f.host().callMcpTool({ hookId: "hook:mcp", server: "fixture", tool: "verify", input: { value: "fixture" }, signal: new AbortController().signal });
  assert.match(result.content[0].text, /fixture/); assert.equal(f.permissions.length, 1); assert.equal(f.permissions[0].external, true); assert.equal(f.permissions[0].input.inputSchema.properties.value.type, "string");
  assert.equal(f.requests.filter((request) => request.kind === "mcp" && request.message.method === "tools/call").length, 1);
}));

test("MCP pending approval schema or trust changes prevent tool execution", async () => fixture(async (f) => {
  const request = { hookId: "hook:mcp", server: "fixture", tool: "verify", input: {}, signal: new AbortController().signal };
  await assert.rejects(f.host(async () => { f.changeSchema(); return true; }).callMcpTool(request), /changed during approval/);
  await assert.rejects(f.host(async () => { await setExtensionState(f.root, "mcp:fixture", "untrust", f.extensionOptions); return true; }).callMcpTool(request), /trust or configuration changed/);
  assert.equal(f.requests.filter((request) => request.kind === "mcp" && request.message.method === "tools/call").length, 0);
}));
