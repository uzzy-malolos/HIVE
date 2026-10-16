import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildProviderConfig, PROVIDER_SETUP_PRESETS } from "../dist/providers/setup.js";
import { listProviderModels } from "../dist/providers/models.js";
import { OpenAiCompatibleAdapter } from "../dist/providers/adapters/openai-compatible.js";
import { ProviderRegistry } from "../dist/providers/registry.js";

const gateways = [
  { id: "opencode", base: "https://opencode.ai/inference/openai/v1", catalog: "/inference/v1/models", env: "OPENCODE_API_KEY" },
  { id: "kilo", base: "https://ai-gateway.kilo.ai/api/v1", catalog: "/api/v1/models", env: "KILO_API_KEY" },
  { id: "cline", base: "https://api.cline.bot/api/v1", catalog: "/api/v1/models", env: "CLINE_API_KEY" },
  { id: "hermes", base: "http://127.0.0.1:8645/v1", catalog: "/v1/models" },
];
function config(id) { return { ...buildProviderConfig({ id: `fixture-${id}`, preset: id, model: "explicit-fixture-model" }), approved: true, createdAt: "2026-10-17T00:00:00Z", updatedAt: "2026-10-17T00:00:00Z" }; }
function environment(t, key, value) { const before = process.env[key]; if (value === undefined) delete process.env[key]; else process.env[key] = value; t.after(() => { if (before === undefined) delete process.env[key]; else process.env[key] = before; }); }
async function network(t, respond) {
  const received = [], server = http.createServer(async (request, response) => { let body = ""; for await (const chunk of request) body += chunk; received.push({ path: request.url, method: request.method, authorization: request.headers.authorization, body: body ? JSON.parse(body) : undefined }); respond(request, response, body); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  const origin = `http://127.0.0.1:${server.address().port}`, nativeFetch = globalThis.fetch, requested = [];
  t.mock.method(globalThis, "fetch", async (url, options) => { requested.push(String(url)); const target = new URL(String(url)); return nativeFetch(`${origin}${target.pathname}${target.search}`, options); });
  return { received, requested };
}

test("gateway presets use public endpoints and references while preserving generic provider defaults", () => {
  for (const gateway of gateways) {
    const preset = PROVIDER_SETUP_PRESETS.find((entry) => entry.id === gateway.id), entry = config(gateway.id);
    assert.equal(preset.baseUrl, gateway.base); assert.equal(entry.baseUrl, gateway.base); assert.equal(entry.apiKeyEnv, gateway.env); assert.equal(entry.authType, gateway.env ? "bearer" : "none"); assert.equal(entry.kind, gateway.env ? "openai-compatible" : "local"); assert.equal(entry.defaultModel, "explicit-fixture-model"); assert.equal("defaultModel" in preset, false);
  }
  assert.match(PROVIDER_SETUP_PRESETS.find((entry) => entry.id === "opencode").label, /Chat Completions/);
  assert.throws(() => buildProviderConfig({ id: "generic", kind: "openai-compatible" }), /Base URL is required/);
  assert.equal(buildProviderConfig({ id: "generic", kind: "openai-compatible", baseUrl: "https://owner.example/v1" }).apiKeyEnv, "CUSTOM_API_KEY");
  assert.equal(buildProviderConfig({ id: "generic-local", kind: "local" }).baseUrl, "http://127.0.0.1:1234/v1");
  const subscription = PROVIDER_SETUP_PRESETS.find((entry) => entry.id === "chatgpt");
  assert.equal(subscription.mode, "subscription"); assert.equal(subscription.kind, "chatgpt-subscription"); assert.equal(subscription.apiKeyEnv, undefined, "subscription sign-in is separate from API-key setup");
});

for (const gateway of gateways) test(`${gateway.id} preset discovery sends only explicit auth and uses its documented catalog`, async (t) => {
  const secret = `opaque-account-fixture-${gateway.id}`; if (gateway.env) environment(t, gateway.env, secret);
  environment(t, "OPENAI_API_KEY", "ambient-openai-fixture-must-not-be-sent");
  const wire = await network(t, (_request, response) => response.writeHead(200, { "content-type": "application/json" }).end('{"data":[{"id":"served-model-b"},{"id":"served-model-a"},{"id":"served-model-b"}]}'));
  const entry = config(gateway.id), before = JSON.stringify(entry);
  assert.deepEqual(await listProviderModels(entry), ["served-model-a", "served-model-b"]); assert.equal(JSON.stringify(entry), before);
  assert.deepEqual(wire.requested, [new URL(gateway.catalog, gateway.base).href]); assert.equal(wire.received.length, 1); assert.equal(wire.received[0].path, gateway.catalog); assert.equal(wire.received[0].method, "GET"); assert.equal(wire.received[0].authorization, gateway.env ? `Bearer ${secret}` : undefined); assert.equal(wire.received[0].body, undefined);
});

test("OpenCode's shared model catalog route applies only to its exact documented compatible base", async (t) => {
  environment(t, "OPENCODE_API_KEY", "opaque-opencode-fixture"); const wire = await network(t, (_request, response) => response.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}'));
  for (const baseUrl of ["https://opencode.ai/inference/openai/v1/", "https://opencode.ai/inference/openai/v1/other", "https://opencode.ai.other.example/inference/openai/v1", "https://owner.example/inference/openai/v1"]) await listProviderModels({ ...config("opencode"), baseUrl });
  await listProviderModels({ ...config("opencode"), kind: "custom" });
  assert.deepEqual(wire.requested, ["https://opencode.ai/inference/v1/models", "https://opencode.ai/inference/openai/v1/other/models", "https://opencode.ai.other.example/inference/openai/v1/models", "https://owner.example/inference/openai/v1/models", "https://opencode.ai/inference/openai/v1/models"]);
});

test("BYOK gateway discovery refuses missing configured credentials without borrowing ambient keys", async (t) => {
  for (const gateway of gateways.filter((entry) => entry.env)) environment(t, gateway.env, undefined);
  environment(t, "OPENAI_API_KEY", "ambient-openai-fixture-must-not-be-used"); t.mock.method(globalThis, "fetch", () => assert.fail("Missing BYOK must not contact any provider"));
  for (const gateway of gateways.filter((entry) => entry.env)) await assert.rejects(listProviderModels(config(gateway.id)), /missing or empty/);
});

test("gateway model errors never echo credentials or a remote response body", async (t) => {
  const secret = "opaque-sensitive-gateway-fixture"; environment(t, "KILO_API_KEY", secret);
  await network(t, (_request, response) => response.writeHead(401, { "content-type": "application/json" }).end(JSON.stringify({ error: { message: `Rejected ${secret}` } })));
  await assert.rejects(listProviderModels(config("kilo")), (error) => { assert.match(error.message, /HTTP 401/); assert.equal(error.message.includes(secret), false); return true; });
});

test("gateway health checks use the same catalog routing as discovery without generating", async (t) => {
  for (const gateway of gateways.filter((entry) => entry.env)) environment(t, gateway.env, `opaque-health-fixture-${gateway.id}`);
  const wire = await network(t, (_request, response) => response.writeHead(200, { "content-type": "application/json" }).end('{"data":[]}')), adapter = new OpenAiCompatibleAdapter();
  for (const gateway of gateways) assert.equal((await adapter.healthCheck(config(gateway.id))).ok, true);
  assert.deepEqual(wire.requested, gateways.map((gateway) => new URL(gateway.catalog, gateway.base).href)); assert.ok(wire.received.every((request) => request.method === "GET" && request.body === undefined));
});

test("gateway presets retain working buffered/streaming adapter auth and explicit model routing", async (t) => {
  for (const gateway of gateways.filter((entry) => entry.env)) environment(t, gateway.env, `opaque-adapter-fixture-${gateway.id}`);
  const wire = await network(t, (_request, response, body) => {
    if (JSON.parse(body).stream) response.writeHead(200, { "content-type": "text/event-stream" }).end('data: {"choices":[{"delta":{"content":"stream fixture"}}]}\n\ndata: [DONE]\n\n');
    else response.writeHead(200, { "content-type": "application/json" }).end('{"choices":[{"message":{"content":"buffered fixture"}}]}');
  });
  const adapter = new OpenAiCompatibleAdapter();
  for (const gateway of gateways) {
    const entry = config(gateway.id), input = { prompt: "public fixture prompt", model: "explicit-request-model", maxOutputTokens: 25 }, chunks = [];
    assert.equal((await adapter.complete(entry, input)).output, "buffered fixture"); assert.equal((await adapter.streamComplete(entry, input, (chunk) => chunks.push(chunk))).output, "stream fixture"); assert.deepEqual(chunks, ["stream fixture"]);
    const requests = wire.received.slice(-2); for (const request of requests) { assert.equal(request.authorization, gateway.env ? `Bearer opaque-adapter-fixture-${gateway.id}` : undefined); assert.equal(request.body.model, "explicit-request-model"); assert.equal(request.body.max_tokens, 25); assert.equal(request.path, `${new URL(gateway.base).pathname}/chat/completions`); }
  }
});

test("registering a gateway preserves existing provider/role selections and stores references only", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-gateway-presets-"));
  t.after(async () => { assert.equal(path.dirname(root), path.resolve(os.tmpdir())); assert.ok(path.basename(root).startsWith("hive-gateway-presets-")); await fs.rm(root, { recursive: true, force: true }); });
  await fs.mkdir(path.join(root, ".hive"), { recursive: true });
  const original = { ...config("hermes"), id: "existing-local", approved: true }, roles = { builder: { provider: "existing-local", model: "existing-owner-model" } };
  await fs.writeFile(path.join(root, ".hive", "providers.json"), JSON.stringify([original])); await fs.writeFile(path.join(root, ".hive", "provider-roles.json"), JSON.stringify(roles));
  const registry = new ProviderRegistry(root), roleBefore = await fs.readFile(path.join(root, ".hive", "provider-roles.json"), "utf8");
  await registry.add(buildProviderConfig({ id: "new-kilo", preset: "kilo", model: "owner-selected-model" }));
  assert.deepEqual((await registry.list())[0], original); assert.equal((await registry.list())[1].approved, false); assert.equal(await fs.readFile(path.join(root, ".hive", "provider-roles.json"), "utf8"), roleBefore);
  const saved = JSON.parse(await fs.readFile(path.join(root, ".hive", "providers.json"), "utf8"))[1]; assert.equal(saved.apiKeyEnv, "KILO_API_KEY"); assert.equal("apiKey" in saved, false); assert.equal("token" in saved, false);
});
