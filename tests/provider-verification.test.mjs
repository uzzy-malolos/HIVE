import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProviderRegistry } from "../dist/providers/registry.js";
import { verifyProvider } from "../dist/providers/verification.js";
import { runCoderCli } from "../dist/cli.js";
import { getAdapterForKind } from "../dist/providers/health.js";

async function fixture(t, respond) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-verification-tests-"));
  const bodies = [];
  const server = http.createServer(async (request, response) => {
    if (request.method === "GET") { response.setHeader("content-type", "application/json"); response.end('{"data":[]}'); return; }
    let text = "";
    for await (const chunk of request) text += chunk;
    const body = JSON.parse(text);
    bodies.push(body);
    await respond(body, response, bodies);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); server.close(); await fs.rm(root, { recursive: true, force: true }); });
  const registry = new ProviderRegistry(root);
  await registry.add({ id: "fixture", kind: "local", name: "Fixture", authType: "none", defaultModel: "fixture-model", baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
  await registry.approve("fixture");
  return { root, registry, bodies, server };
}

function send(body, response, output) {
  if (body.stream) {
    response.writeHead(200, { "content-type": "text/event-stream" });
    for (const part of [output.slice(0, 6), output.slice(6)]) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  } else { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ choices: [{ message: { content: output } }], usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 } })); }
}

test("verification uses one explicit model for real HTTP buffered, streaming and isolated file-write checks", async (t) => {
  let builderTurn = 0;
  const { root, registry, bodies } = await fixture(t, (body, response) => {
    const user = body.messages.find((message) => message.role === "user").content;
    const marker = /HIVE_VERIFY_[a-f0-9]+/.exec(user)[0];
    const coding = body.messages.some((message) => message.role === "system" && message.content.includes("HIVE builder subagent"));
    if (coding) {
      const system = body.messages.find((message) => message.role === "system").content;
      for (const name of ["read_file", "create_file", "write_file"]) assert.ok(system.includes(`"name":"${name}"`), `${name} must be discoverable`);
      for (const name of ["run_command", "run_test", "apply_patch", "edit_file"]) assert.equal(system.includes(`"name":"${name}"`), false, `${name} is unavailable in the verifier`);
      assert.ok(system.includes('"required":["path","content"]'), "the model must receive the actual write argument contract");
    }
    const output = coding ? JSON.stringify(builderTurn++ === 0
      ? { done: false, toolCalls: [{ name: "create_file", arguments: { path: "probe.txt", content: `${marker}\n` } }] }
      : { done: true, summary: "Probe created" }) : marker;
    send(body, response, output);
  });
  const before = await fs.readFile(path.join(root, ".hive/providers.json"), "utf8");
  const report = await verifyProvider(registry, "fixture", { coding: true, model: "different/model", maxOutputTokens: 128 });
  assert.equal(report.status, "passed", JSON.stringify(report));
  assert.deepEqual(report.checks.map((check) => check.name), ["health", "buffered", "streaming", "coding"]);
  assert.ok(report.checks.every((check) => check.status === "passed"));
  assert.equal(bodies.length, 4);
  assert.ok(bodies.every((body) => body.model === "different/model" && body.max_tokens === 128));
  assert.equal(await fs.readFile(path.join(root, ".hive/providers.json"), "utf8"), before);
  assert.deepEqual((await fs.readdir(root)).sort(), [".hive"]);
  assert.equal(JSON.stringify(report).includes("HIVE_VERIFY_"), false);
});

test("CLI verification parses flags without rewriting roles and saves a non-overwriting JSON report", async (t) => {
  const { root, bodies } = await fixture(t, (body, response) => {
    const marker = /HIVE_VERIFY_[a-f0-9]+/.exec(body.messages.at(-1).content)[0];
    send(body, response, marker);
  });
  const result = await runCoderCli(["providers", "verify", "fixture", "--model", "chosen/model", "--max-output-tokens", "64", "--timeout-ms", "5000", "--output", "verification.json", "--json"], { cwd: root });
  assert.equal(result.exitCode, 0, result.output);
  const report = JSON.parse(result.output);
  assert.equal(report.model, "chosen/model");
  assert.equal(report.maxOutputTokensPerRequest, 64);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "verification.json"), "utf8")).status, "passed");
  await assert.rejects(fs.access(path.join(root, ".hive/provider-roles.json")), { code: "ENOENT" });
  const requestsBeforeRepeat = bodies.length;
  const repeated = await runCoderCli(["providers", "verify", "fixture", "--output", "verification.json", "--json"], { cwd: root });
  assert.equal(repeated.exitCode, 1);
  assert.match(repeated.output, /exists|overwrite/);
  assert.equal(bodies.length, requestsBeforeRepeat, "an invalid report destination must fail before additional provider requests");
});

test("coding verification keeps exact-content guards and the two-call limit when a provider repeats denied writes", async (t) => {
  const { root, registry, bodies } = await fixture(t, (body, response) => {
    const user = body.messages.find((message) => message.role === "user").content;
    const marker = /HIVE_VERIFY_[a-f0-9]+/.exec(user)[0];
    const coding = body.messages.some((message) => message.role === "system");
    send(body, response, coding
      ? JSON.stringify({ done: false, toolCalls: [{ name: "create_file", arguments: { path: "probe.txt", content: "wrong content\n" } }] })
      : marker);
  });
  const report = await verifyProvider(registry, "fixture", { coding: true, maxOutputTokens: 512 });
  assert.equal(report.status, "failed");
  assert.deepEqual(report.checks.map((check) => check.status), ["passed", "passed", "passed", "failed"]);
  assert.match(report.checks.at(-1).detail, /2 tool-call limit/);
  assert.equal(bodies.length, 5, "coding retains three model turns after buffered and streaming checks");
  assert.ok(bodies.every((body) => body.max_tokens === 512));
  assert.deepEqual(await fs.readdir(root), [".hive"]);
  assert.equal(JSON.stringify(report).includes("HIVE_VERIFY_"), false);
});

test("failed health never calls generation and records failed and skipped checks honestly", async () => {
  let generated = false;
  const config = { id: "unavailable", kind: "local", approved: true, defaultModel: "missing", baseUrl: "http://127.0.0.1:1" };
  const report = await verifyProvider({ getAdapter: async () => ({ config, adapter: { healthCheck: async () => ({ ok: false, message: "offline" }), complete: async () => { generated = true; throw new Error("must not execute"); } } }) }, config.id, { coding: true });
  assert.equal(report.status, "failed");
  assert.equal(generated, false);
  assert.deepEqual(report.checks.map((check) => check.status), ["failed", "skipped", "skipped", "skipped"]);
});

test("verification rejects unapproved providers and invalid limits before generation", async (t) => {
  const { registry, bodies } = await fixture(t, () => assert.fail("No completion should occur"));
  await registry.add({ id: "unapproved", kind: "local", name: "not approved", authType: "none", defaultModel: "test" });
  await assert.rejects(verifyProvider(registry, "unapproved"), /approved/);
  for (const maxOutputTokens of [0, -1, 1.5, 32769, NaN]) await assert.rejects(verifyProvider(registry, "fixture", { maxOutputTokens }), /maxOutputTokens/);
  assert.equal(bodies.length, 0);
});

test("failed and timed-out generation remains failed and cancellation closes owned HTTP requests", async (t) => {
  let arrived;
  let disconnected;
  const arrival = new Promise((resolve) => { arrived = resolve; });
  const closed = new Promise((resolve) => { disconnected = resolve; });
  const { registry } = await fixture(t, (_body, response) => { response.on("close", disconnected); arrived(); });
  const controller = new AbortController();
  const reportPromise = verifyProvider(registry, "fixture", { signal: controller.signal, timeoutMs: 5000 });
  await arrival;
  controller.abort();
  const report = await reportPromise;
  assert.equal(report.status, "cancelled");
  assert.ok(report.checks.some((check) => check.status === "failed"));
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("Provider connection stayed open after cancellation")), 1000).unref())]);
  const timeout = await verifyProvider(registry, "fixture", { timeoutMs: 100 });
  assert.equal(timeout.status, "failed");
  assert.ok(timeout.checks.some((check) => /timed out/.test(check.detail)));
});

test("opaque configured credential values cannot leak from verification failures", async () => {
  const secret = "opaque-verification-credential";
  const previous = process.env.HIVE_VERIFY_TEST_KEY;
  process.env.HIVE_VERIFY_TEST_KEY = secret;
  try {
    const config = { id: "private", kind: "local", approved: true, defaultModel: "fixture", apiKeyEnv: "HIVE_VERIFY_TEST_KEY" };
    const report = await verifyProvider({ getAdapter: async () => ({ config, adapter: { healthCheck: async () => ({ ok: false, message: `bad key ${secret}` }) } }) }, "private");
    assert.equal(JSON.stringify(report).includes(secret), false);
    assert.match(report.checks[0].detail, /REDACTED/);
  } finally { if (previous === undefined) delete process.env.HIVE_VERIFY_TEST_KEY; else process.env.HIVE_VERIFY_TEST_KEY = previous; }
});

for (const kind of ["anthropic", "google"]) {
  test(`${kind} verification rejects ignored endpoint overrides before any health or generation request`, async () => {
    let called = false;
    const config = { id: "wrong-origin", kind, approved: true, defaultModel: "fixture", baseUrl: "https://configured-proxy.invalid/v1" };
    await assert.rejects(verifyProvider({ getAdapter: async () => ({ config, adapter: { healthCheck: async () => { called = true; }, complete: async () => { called = true; } } }) }, config.id), /does not support this baseUrl override/);
    assert.equal(called, false);
  });
}

for (const kind of ["openai", "openrouter", "local", "anthropic", "google", "ollama"]) {
  test(`${kind} maps explicit verification token limits without changing default requests`, async (t) => {
    const bodies = [];
    t.mock.method(globalThis, "fetch", async (_url, init) => {
      bodies.push(JSON.parse(init.body));
      const payload = kind === "anthropic" ? { content: [{ text: "done" }] } : kind === "google" ? { candidates: [{ content: { parts: [{ text: "done" }] } }] } : kind === "ollama" ? { message: { content: "done" } } : { choices: [{ message: { content: "done" } }] };
      return new Response(JSON.stringify(payload), { status: 200, headers: { "content-type": "application/json" } });
    });
    const adapter = getAdapterForKind(kind);
    const config = { id: "limits", kind, authType: "none", defaultModel: "fixture", baseUrl: "https://fixture.invalid/v1" };
    await adapter.complete(config, { prompt: "fixture", model: "fixture", maxOutputTokens: 73 }, { kind: "api-key", secret: "fixture-request-key" });
    const actual = bodies[0];
    assert.equal(kind === "openai" ? actual.max_completion_tokens : kind === "google" ? actual.generationConfig.maxOutputTokens : kind === "ollama" ? actual.options.num_predict : actual.max_tokens, 73);
    await adapter.complete(config, { prompt: "fixture", model: "fixture" }, { kind: "api-key", secret: "fixture-request-key" });
    assert.equal(bodies[1].max_completion_tokens, undefined);
    assert.equal(bodies[1].generationConfig, undefined);
    assert.equal(bodies[1].options, undefined);
    assert.equal(bodies[1].max_tokens, kind === "anthropic" ? 4096 : undefined);
  });
}
