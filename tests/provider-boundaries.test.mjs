import assert from "node:assert/strict";
import test from "node:test";
import http from "node:http";
import { once } from "node:events";
import { ProviderRouter } from "../dist/coding/provider-router.js";
import { OpenAiCompatibleAdapter } from "../dist/providers/adapters/openai-compatible.js";
import { ProviderRegistry } from "../dist/providers/registry.js";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const image = { mimeType: "image/png", data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC" };
const config = { id: "fixture", kind: "local", name: "fixture", approved: true, authType: "none", defaultModel: "fixture", createdAt: "2026-10-16", updatedAt: "2026-10-16" };
function router(adapter, { provider = config, health, onDegradedRoute, fallback } = {}) {
  const providers = [provider, ...(fallback ? [fallback] : [])];
  const registry = {
    get: async (id) => providers.find((row) => row.id === id),
    getRoles: async () => ({ builder: { provider: provider.id, model: "fixture" }, ...(fallback ? { fallback: { provider: fallback.id, model: "fixture" } } : {}) }),
    test: async (id) => health ? health(id) : ({ ok: true, message: "fixture", providerId: id }),
    getAdapter: async (id) => ({ config: providers.find((row) => row.id === id), adapter }),
  };
  return new ProviderRouter({ projectRoot: process.cwd(), sessionId: "boundary-fixture", projectRegistry: registry, globalRegistry: registry, onDegradedRoute });
}

function fixtureEnvironment(t, values) {
  for (const [reference, value] of Object.entries(values)) {
    const original = process.env[reference];
    if (value === undefined) delete process.env[reference];
    else process.env[reference] = value;
    t.after(() => { if (original === undefined) delete process.env[reference]; else process.env[reference] = original; });
  }
}

const opaqueCredential = 'opaque/fixture+value?part="quoted"\\end';
const escapedCredential = JSON.stringify(opaqueCredential).slice(1, -1);
const encodedCredential = encodeURIComponent(opaqueCredential);
const credentialForms = [opaqueCredential, escapedCredential, encodedCredential, encodedCredential.replace(/%[A-F0-9]{2}/gu, (escape) => escape.toLowerCase())];
const privateConfig = { ...config, authType: "api-key", apiKeyEnv: "HIVE_BOUNDARY_FIXTURE_KEY" };
function assertNoCredential(value) {
  for (const credential of credentialForms) assert.equal(value.includes(credential), false);
}

test("coding provider requests redact credential assignments and preserve request-only images and cancellation", async () => {
  const controller = new AbortController();
  let actual;
  const client = router({ complete: async (_config, input) => { actual = input; return { output: "done" }; } });
  await client.complete({ role: "builder", prompt: "API_KEY=fixture-private-credential", systemPrompt: "password=fixture-private-password", images: [image], signal: controller.signal });
  assert.equal(actual.signal, controller.signal);
  assert.equal(actual.prompt.includes("fixture-private-credential"), false);
  assert.equal(actual.systemPrompt.includes("fixture-private-password"), false);
  assert.deepEqual(actual.images, [image]);
});

test("echoed image bytes never enter buffered results or provider error reports", async () => {
  const result = await router({ complete: async () => ({ output: `Image: ${image.data}` }) }).complete({ role: "builder", prompt: "describe", images: [image] });
  assert.equal(result.output, "Image: [IMAGE DATA REDACTED]");
  await assert.rejects(router({ complete: async () => { throw new Error(`Rejected ${image.data}`); } }).complete({ role: "builder", prompt: "describe", images: [image] }), (error) => {
    assert.equal(error.message.includes(image.data), false);
    assert.match(error.message, /IMAGE DATA REDACTED/);
    return true;
  });
});

test("fragmented image echoes are held before release and ordinary streaming text remains intact", async () => {
  for (const text of [`Description ${image.data} end`, "This is ordinary prose with image-like letters iVB. i"]) {
    const chunks = [];
    const result = await router({ streamComplete: async (_config, input, onChunk) => {
      assert.deepEqual(input.images, [image]);
      for (const character of text) onChunk(character);
      return { output: text };
    } }).streamComplete({ role: "builder", prompt: "describe", images: [image] }, (chunk) => chunks.push(chunk));
    assert.equal(chunks.join(""), text.replace(image.data, "[IMAGE DATA REDACTED]"));
    assert.equal(result.output, chunks.join(""));
    assert.equal(chunks.some((chunk) => chunk.includes(image.data)), false);
  }
});

test("opaque configured credentials and their encoded forms never enter buffered prompts, results or errors", async (t) => {
  fixtureEnvironment(t, { HIVE_BOUNDARY_FIXTURE_KEY: opaqueCredential });
  for (const echo of credentialForms) {
    let actual;
    const result = await router({ complete: async (_config, input) => { actual = input; return { output: `Echo ${echo}; done` }; } }, { provider: privateConfig })
      .complete({ role: "builder", prompt: `User ${echo}`, systemPrompt: `Instruction ${echo}` });
    assertNoCredential(actual.prompt);
    assertNoCredential(actual.systemPrompt);
    assert.equal(result.output, "Echo [REDACTED]; done");
    await assert.rejects(router({ complete: async () => { throw new Error(`Rejected ${echo}`); } }, { provider: privateConfig })
      .complete({ role: "builder", prompt: "fixture" }), (error) => { assertNoCredential(error.message); assert.match(error.message, /Rejected \[REDACTED\]/u); return true; });
  }
});

test("credential snapshots precede health failures and remain private across fallback diagnostics and prompts", async (t) => {
  fixtureEnvironment(t, { HIVE_BOUNDARY_FIXTURE_KEY: opaqueCredential, HIVE_BOUNDARY_FALLBACK_KEY: "opaque-secondary-route-value" });
  for (const method of ["resolve", "complete", "streamComplete"]) {
    const client = router({ complete: async () => { throw new Error("Unhealthy routes cannot generate"); } }, {
      provider: privateConfig,
      health: () => {
        delete process.env.HIVE_BOUNDARY_FIXTURE_KEY;
        return { ok: false, message: `Health ${encodedCredential}` };
      },
    });
    process.env.HIVE_BOUNDARY_FIXTURE_KEY = opaqueCredential;
    const operation = method === "resolve" ? client.resolve("builder")
      : method === "complete" ? client.complete({ role: "builder", prompt: "fixture" })
      : client.streamComplete({ role: "builder", prompt: "fixture" }, () => assert.fail("Unhealthy routes cannot stream"));
    await assert.rejects(operation, (error) => { assertNoCredential(error.message); assert.match(error.message, /Health \[REDACTED\]/u); return true; });
  }
  process.env.HIVE_BOUNDARY_FIXTURE_KEY = opaqueCredential;
  const diagnostics = [];
  const client = router({ complete: async (_config, input) => {
    assertNoCredential(input.prompt);
    assertNoCredential(input.systemPrompt);
    return { output: `Fallback ${opaqueCredential}` };
  } }, { provider: privateConfig, fallback: { ...config, id: "secondary", apiKeyEnv: "HIVE_BOUNDARY_FALLBACK_KEY" },
    health: (id) => id === "fixture" ? { ok: false, message: `Primary failed ${opaqueCredential}; opaque-secondary-route-value` } : { ok: true, message: "ready" },
    onDegradedRoute: (_route, failures) => diagnostics.push(...failures),
  });
  assert.equal((await client.complete({ role: "builder", prompt: opaqueCredential, systemPrompt: encodedCredential })).output, "Fallback [REDACTED]");
  assertNoCredential(diagnostics.join(" "));
  assert.equal(diagnostics.join(" ").includes("opaque-secondary-route-value"), false);
});

test("fragmented raw, URI and JSON credential echoes are withheld before callbacks and ordinary suffixes are flushed", async (t) => {
  fixtureEnvironment(t, { HIVE_BOUNDARY_FIXTURE_KEY: opaqueCredential });
  for (const echo of credentialForms) {
    const text = `Before ${echo}; after ${opaqueCredential.slice(0, 6)}`;
    const chunks = [];
    const result = await router({ streamComplete: async (_config, input, onChunk) => {
      assertNoCredential(input.prompt);
      assertNoCredential(input.systemPrompt);
      for (const character of text) {
        onChunk(character);
        // No proper credential prefix can escape while its echo is incomplete.
        assert.equal(chunks.join("").includes(echo.slice(0, 8)), false);
      }
      return { output: text };
    } }, { provider: privateConfig }).streamComplete({ role: "builder", prompt: opaqueCredential, systemPrompt: encodedCredential }, (chunk) => chunks.push(chunk));
    assert.equal(chunks.join(""), `Before [REDACTED]; after ${opaqueCredential.slice(0, 6)}`);
    assert.equal(result.output, chunks.join(""));
    assertNoCredential(result.output);
  }
});

test("overlapping credential literals and repeated image prefixes stream without leaking or duplicating output", async (t) => {
  fixtureEnvironment(t, { HIVE_BOUNDARY_FIXTURE_KEY: "abc", HIVE_BOUNDARY_FIXTURE_TOKEN: "abcabc" });
  const chunks = [];
  const repeatedImage = { ...image, data: "xyzxyz" };
  const text = "Start abcabc, abc, xyzxyz; end xy";
  const result = await router({ streamComplete: async (_config, _input, onChunk) => {
    for (const character of text) onChunk(character);
    return { output: text };
  } }, { provider: { ...privateConfig, tokenEnv: "HIVE_BOUNDARY_FIXTURE_TOKEN" } }).streamComplete({ role: "builder", prompt: "fixture", images: [repeatedImage] }, (chunk) => chunks.push(chunk));
  assert.equal(result.output, "Start [REDACTED], [REDACTED], [IMAGE DATA REDACTED]; end xy");
  assert.equal(chunks.join(""), result.output);
});

test("stream failures and buffered fallback sanitize captured credentials without repeating partial output", async (t) => {
  fixtureEnvironment(t, { HIVE_BOUNDARY_FIXTURE_KEY: opaqueCredential });
  let buffered = 0;
  const chunks = [];
  const adapter = { streamComplete: async (_config, _input, onChunk) => {
    onChunk(opaqueCredential.slice(0, 8));
    throw new Error(`Streaming unavailable ${encodedCredential}`);
  }, complete: async () => { buffered += 1; return { output: `Buffered ${opaqueCredential}` }; } };
  const result = await router(adapter, { provider: privateConfig }).streamComplete({ role: "builder", prompt: "fixture" }, (chunk) => chunks.push(chunk));
  assert.equal(buffered, 1);
  assert.deepEqual(chunks, ["Buffered [REDACTED]"]);
  assert.equal(result.output, chunks.join(""));
  adapter.streamComplete = async (_config, _input, onChunk) => { onChunk("Public prefix "); throw new Error(`Failed ${opaqueCredential}`); };
  chunks.length = 0;
  await assert.rejects(router(adapter, { provider: privateConfig }).streamComplete({ role: "builder", prompt: "fixture" }, (chunk) => chunks.push(chunk)), (error) => { assertNoCredential(error.message); assert.match(error.message, /Failed \[REDACTED\]/u); return true; });
  assert.deepEqual(chunks, ["Public prefix "]);
  assert.equal(buffered, 1);
});

test("cancellation discards late adapter chunks and never forwards a credential-bearing abort reason", async (t) => {
  fixtureEnvironment(t, { HIVE_BOUNDARY_FIXTURE_KEY: opaqueCredential });
  const controller = new AbortController();
  let lateChunk;
  let started;
  const ready = new Promise((resolve) => { started = resolve; });
  const chunks = [];
  const client = router({ streamComplete: async (_config, _input, onChunk) => { lateChunk = onChunk; started(); return new Promise(() => {}); } }, { provider: privateConfig });
  const operation = client.streamComplete({ role: "builder", prompt: "fixture", signal: controller.signal }, (chunk) => chunks.push(chunk));
  await ready;
  controller.abort(new Error(`Stop ${opaqueCredential}`));
  await assert.rejects(operation, (error) => { assert.equal(error.name, "AbortError"); assertNoCredential(error.message); return true; });
  lateChunk(`Late ${opaqueCredential}`);
  assert.deepEqual(chunks, []);
});

test("credential capture refreshes independently of health caching and never scans unrelated environment values", async (t) => {
  fixtureEnvironment(t, { HIVE_BOUNDARY_FIXTURE_KEY: opaqueCredential, HIVE_BOUNDARY_UNRELATED: "unrelated-environment-value" });
  let healthChecks = 0;
  let echo = opaqueCredential;
  const client = router({ complete: async () => ({ output: `${echo}; unrelated-environment-value` }) }, { provider: privateConfig,
    health: () => { healthChecks += 1; return { ok: true, message: "ready" }; },
  });
  assert.equal((await client.complete({ role: "builder", prompt: "fixture" })).output, "[REDACTED]; unrelated-environment-value");
  echo = "fresh-opaque-credential-value";
  process.env.HIVE_BOUNDARY_FIXTURE_KEY = echo;
  assert.equal((await client.complete({ role: "builder", prompt: "fixture" })).output, "[REDACTED]; unrelated-environment-value");
  assert.equal(healthChecks, 1);
  client.clearHealthCache();
  await client.complete({ role: "builder", prompt: "fixture" });
  assert.equal(healthChecks, 2);
});

test("native legacy credentials capture only each adapter's selected default", async (t) => {
  fixtureEnvironment(t, { OPENAI_API_KEY: "opaque-native-openai", OPENROUTER_API_KEY: "opaque-native-openrouter", ANTHROPIC_API_KEY: "opaque-native-anthropic", GEMINI_API_KEY: "opaque-native-gemini", GOOGLE_API_KEY: "opaque-unselected-google" });
  for (const [kind, secret] of [["openai", process.env.OPENAI_API_KEY], ["openrouter", process.env.OPENROUTER_API_KEY], ["anthropic", process.env.ANTHROPIC_API_KEY], ["google", process.env.GEMINI_API_KEY]]) {
    const result = await router({ complete: async () => ({ output: `${secret}; opaque-unselected-google` }) }, { provider: { ...config, kind } }).complete({ role: "builder", prompt: "fixture" });
    assert.equal(result.output, "[REDACTED]; opaque-unselected-google");
  }
  delete process.env.GEMINI_API_KEY;
  assert.equal((await router({ complete: async () => ({ output: "opaque-unselected-google" }) }, { provider: { ...config, kind: "google" } }).complete({ role: "builder", prompt: "fixture" })).output, "[REDACTED]");
});

test("cancelling a real local provider request closes the HTTP connection", async (t) => {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    response.write(": connected\n\n");
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  server.on("request", (request) => { request.on("close", resolveClosed); });
  const controller = new AbortController();
  const request = new OpenAiCompatibleAdapter().streamComplete({ ...config, baseUrl: `http://127.0.0.1:${server.address().port}/v1` }, { prompt: "fixture", model: "fixture", signal: controller.signal }, () => {});
  await once(server, "request");
  controller.abort();
  await assert.rejects(request, (error) => error.name === "AbortError");
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("HTTP connection stayed open after cancellation")), 2000).unref())]);
});

test("cancelling provider routing also closes its in-flight health connection", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-health-cancel-"));
  let closeResponse;
  const closed = new Promise((resolve) => { closeResponse = resolve; });
  const server = http.createServer((_request, response) => { response.on("close", closeResponse); });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); server.close(); await fs.rm(root, { recursive: true, force: true }); });
  const registry = new ProviderRegistry(root);
  await registry.add({ ...config, baseUrl: `http://127.0.0.1:${server.address().port}/v1` });
  await registry.approve("fixture");
  await registry.setRole("builder", "fixture", "fixture");
  const client = new ProviderRouter({ projectRoot: root, sessionId: "health-cancellation", projectRegistry: registry, globalRegistry: registry });
  const controller = new AbortController();
  const completion = client.complete({ role: "builder", prompt: "fixture", signal: controller.signal });
  await once(server, "request");
  controller.abort();
  await assert.rejects(completion, (error) => error.name === "AbortError");
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("Health connection stayed open")), 2000).unref())]);
});
