import assert from "node:assert/strict";
import { once } from "node:events";
import http from "node:http";
import test from "node:test";
import { listProviderModels } from "../dist/providers/models.js";
import { buildProviderConfig } from "../dist/providers/setup.js";

function provider(overrides = {}) {
  return { id: "fixture", name: "Fixture", kind: "local", authType: "none", approved: false,
    createdAt: "2026-10-16T00:00:00Z", updatedAt: "2026-10-16T00:00:00Z", ...overrides };
}

async function fixture(t, respond) {
  const requests = [];
  const server = http.createServer((request, response) => {
    requests.push({ url: request.url, method: request.method, authorization: request.headers.authorization });
    response.setHeader("content-type", "application/json");
    respond(request, response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, server, requests };
}

function environment(t, key, value) {
  const previous = process.env[key];
  if (value === undefined) delete process.env[key]; else process.env[key] = value;
  t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
}

test("local OpenAI-compatible discovery lists actual models without approval, generation, or ambient credentials", async (t) => {
  environment(t, "OPENAI_API_KEY", "ambient-provider-key-must-not-be-used");
  environment(t, "HIVE_MODELS_UNUSED", "configured-but-auth-none");
  const { baseUrl, requests } = await fixture(t, (_request, response) => response.end(JSON.stringify({ data: [{ id: "z/model" }, { id: "a-model" }, { id: "z/model" }] })));
  const config = provider({ baseUrl: `${baseUrl}/v1/`, apiKeyEnv: "HIVE_MODELS_UNUSED", defaultModel: "not-a-fallback" });
  const before = JSON.stringify(config);
  assert.deepEqual(await listProviderModels(config), ["a-model", "z/model"]);
  assert.equal(JSON.stringify(config), before);
  assert.deepEqual(requests, [{ url: "/v1/models", method: "GET", authorization: undefined }]);
});

test("Ollama discovery reads only installed tag names and has no fabricated default-model fallback", async (t) => {
  let empty = false;
  const { baseUrl, requests } = await fixture(t, (_request, response) => response.end(JSON.stringify({ models: empty ? [] : [{ name: "qwen:latest", model: "ignored-alias" }, { model: "llama:small" }] })));
  const config = provider({ kind: "ollama", baseUrl, defaultModel: "uninstalled-model" });
  assert.deepEqual(await listProviderModels(config), ["llama:small", "qwen:latest"]);
  empty = true;
  assert.deepEqual(await listProviderModels(config), []);
  assert.ok(requests.every((request) => request.url === "/api/tags" && request.method === "GET" && request.authorization === undefined));
});

test("BYOK sends only the explicitly referenced API key or bearer token", async (t) => {
  environment(t, "OPENAI_API_KEY", "ambient-key");
  environment(t, "HIVE_MODELS_API_KEY", "explicit-api-key-value");
  environment(t, "HIVE_MODELS_TOKEN", "explicit-bearer-value");
  const { baseUrl, requests } = await fixture(t, (_request, response) => response.end('{"data":[{"id":"actual-model"}]}'));
  await listProviderModels(provider({ kind: "custom", baseUrl, authType: "api-key", apiKeyEnv: "HIVE_MODELS_API_KEY" }));
  await listProviderModels(provider({ kind: "openai-compatible", baseUrl, authType: "bearer", tokenEnv: "HIVE_MODELS_TOKEN" }));
  assert.deepEqual(requests.map((request) => request.authorization), ["Bearer explicit-api-key-value", "Bearer explicit-bearer-value"]);
  for (const config of [provider({ baseUrl, authType: "api-key" }), provider({ baseUrl, authType: "api-key", apiKeyEnv: "HIVE_MODELS_MISSING" })]) {
    await assert.rejects(listProviderModels(config), /explicit credential|missing or empty/);
  }
  assert.equal(requests.length, 2);
});

test("local discovery accepts the conventional localhost alias", async (t) => {
  const { baseUrl, requests } = await fixture(t, (_request, response) => response.end('{"data":[]}'));
  assert.deepEqual(await listProviderModels(provider({ baseUrl: baseUrl.replace("127.0.0.1", "localhost") })), []);
  assert.equal(requests.length, 1);
});

test("invalid or non-loopback plaintext endpoints fail before a request without echoing URL secrets", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Invalid endpoint must not fetch"));
  for (const baseUrl of ["http://example.test", "http://192.168.1.2:1234/v1", "http://localhost.evil.test/v1", "ftp://127.0.0.1", "https://user:opaque-url-secret@example.test", "https://example.test?key=opaque-url-secret", "https://example.test#opaque-url-secret", "https://example.test\n", "https://example.test/\u001b", "https:\\example.test"]) {
    await assert.rejects(listProviderModels(provider({ baseUrl })), (error) => {
      assert.equal(String(error).includes("opaque-url-secret"), false);
      return /URL|HTTPS/.test(error.message);
    });
  }
  await assert.rejects(listProviderModels(provider()), /explicit provider base URL/);
});

test("HTTP failure preserves exact status without reading or echoing sensitive body", async (t) => {
  const secret = "server-opaque-error-secret";
  const { baseUrl } = await fixture(t, (_request, response) => { response.statusCode = 429; response.end(JSON.stringify({ error: secret })); });
  await assert.rejects(listProviderModels(provider({ baseUrl, defaultModel: "not-returned" })), (error) => {
    assert.match(error.message, /HTTP 429/);
    assert.equal(String(error).includes(secret), false);
    return true;
  });
});

test("redirects never forward BYOK credentials or follow another endpoint", async (t) => {
  environment(t, "HIVE_MODELS_KEY", "explicit-redirect-key");
  const { baseUrl, requests } = await fixture(t, (_request, response) => { response.statusCode = 302; response.setHeader("location", "/elsewhere"); response.end("private error body"); });
  await assert.rejects(listProviderModels(provider({ baseUrl, authType: "api-key", apiKeyEnv: "HIVE_MODELS_KEY" })), /could not complete the HTTP request/);
  assert.equal(requests.length, 1);
});

test("discovery rejects invalid JSON, schema, terminal controls, oversized IDs and echoed credentials", async (t) => {
  environment(t, "HIVE_MODELS_SECRET", "opaque-configured-model-key");
  let body;
  const { baseUrl } = await fixture(t, (_request, response) => response.end(body));
  const config = provider({ baseUrl, authType: "api-key", apiKeyEnv: "HIVE_MODELS_SECRET" });
  for (const value of [null, [], {}, { data: [null] }, { data: [{ id: 5 }] }, { data: [{ id: "\u001b]52;c;abc\u0007" }] }, { data: [{ id: "unsafe\u202Emodel" }] }, { data: [{ id: "é".repeat(129) }] }, { data: [{ id: "prefix-opaque-configured-model-key" }] }, { data: [{ id: "sk-12345678901234567890" }] }]) {
    body = JSON.stringify(value);
    await assert.rejects(listProviderModels(config), (error) => {
      assert.equal(String(error).includes("opaque-configured-model-key"), false);
      assert.equal(String(error).includes("\u001b"), false);
      return /invalid|sensitive/.test(error.message);
    });
  }
  body = "not json with opaque-configured-model-key";
  await assert.rejects(listProviderModels(config), /invalid JSON/);
});

test("response bytes and model counts are bounded with no partial model fallback", async (t) => {
  let body = JSON.stringify({ data: Array.from({ length: 4097 }, (_, id) => ({ id: `model-${id}` })) });
  const { baseUrl } = await fixture(t, (_request, response) => { response.flushHeaders(); response.end(body); });
  await assert.rejects(listProviderModels(provider({ baseUrl })), /oversized model list/);
  body = " ".repeat(8 * 1024 * 1024 + 1);
  await assert.rejects(listProviderModels(provider({ baseUrl })), /8 MiB/);
});

test("rich unpaginated public model catalogs fit the measured metadata budget", async (t) => {
  const models = Array.from({ length: 600 }, (_, id) => ({ id: `actual-model-${id}`, description: "Model metadata. ".repeat(128) }));
  const body = JSON.stringify({ data: models });
  assert.ok(Buffer.byteLength(body) > 256 * 1024);
  const { baseUrl } = await fixture(t, (_request, response) => response.end(body));
  const discovered = await listProviderModels(provider({ kind: "openrouter", baseUrl }));
  assert.equal(discovered.length, 600);
  assert.deepEqual(new Set(discovered), new Set(models.map((model) => model.id)));
});

test("request deadline includes a stalled response body and cancellation closes the connection", async (t) => {
  let received;
  let disconnected;
  const arrived = new Promise((resolve) => { received = resolve; });
  const closed = new Promise((resolve) => { disconnected = resolve; });
  const { baseUrl } = await fixture(t, (_request, response) => {
    response.on("close", disconnected);
    response.flushHeaders();
    response.write('{"data":[');
    received();
  });
  const controller = new AbortController();
  const listing = listProviderModels(provider({ baseUrl }), { signal: controller.signal, timeoutMs: 5000 });
  await arrived;
  controller.abort(new Error("private-cancellation-secret"));
  await assert.rejects(listing, (error) => error.name === "AbortError" && !String(error).includes("private-cancellation-secret"));
  await Promise.race([closed, new Promise((_, reject) => setTimeout(() => reject(new Error("Connection remained open")), 1000).unref())]);
  await assert.rejects(listProviderModels(provider({ baseUrl }), { timeoutMs: 100 }), /timed out/);
});

test("pre-aborted requests, invalid limits, unsafe credentials and unsupported OAuth never fetch", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Must fail before network access"));
  environment(t, "HIVE_MODELS_UNSAFE", "private\nheader");
  const config = provider({ baseUrl: "http://127.0.0.1:1" });
  for (const timeoutMs of [0, 99, 120001, 1.5, NaN]) await assert.rejects(listProviderModels(config, { timeoutMs }), /timeout/);
  await assert.rejects(listProviderModels(config, { signal: AbortSignal.abort("secret-abort-reason") }), { name: "AbortError" });
  await assert.rejects(listProviderModels(provider({ ...config, authType: "api-key", apiKeyEnv: "HIVE_MODELS_UNSAFE" })), /valid HTTP header/);
  await assert.rejects(listProviderModels(provider({ ...config, kind: "oauth" })), /not supported/);
  await assert.rejects(listProviderModels(provider({ ...config, authType: "oauth" })), /explicit API-key or bearer/);
});

test("Anthropic uses its documented listing endpoint, explicit key and bounded cursor pagination", async (t) => {
  environment(t, "HIVE_MODELS_ANTHROPIC", "explicit-anthropic-model-key");
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    seen.push({ url: String(url), headers: init.headers, method: init.method, redirect: init.redirect });
    return Response.json(seen.length === 1 ? { data: [{ id: "claude-fixture-a" }], has_more: true, last_id: "claude-fixture-a" } : { data: [{ id: "claude-fixture-b" }], has_more: false, last_id: "claude-fixture-b" });
  });
  assert.deepEqual(await listProviderModels(provider({ kind: "anthropic", authType: "api-key", apiKeyEnv: "HIVE_MODELS_ANTHROPIC" })), ["claude-fixture-a", "claude-fixture-b"]);
  assert.equal(seen[0].url, "https://api.anthropic.com/v1/models?limit=512");
  assert.match(seen[1].url, /after_id=claude-fixture-a/);
  assert.equal(seen[0].headers["x-api-key"], "explicit-anthropic-model-key");
  assert.equal(seen[0].headers["anthropic-version"], "2023-06-01");
  assert.ok(seen.every((request) => request.method === "GET" && request.redirect === "error" && !request.url.includes("explicit-anthropic-model-key")));
});

test("Google lists only generateContent models, follows pages and keeps explicit BYOK out of URLs", async (t) => {
  environment(t, "HIVE_MODELS_GOOGLE", "explicit-google-model-key");
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    seen.push({ url: String(url), headers: init.headers });
    return Response.json(seen.length === 1 ? { models: [{ name: "models/gemini-fixture", supportedGenerationMethods: ["generateContent"] }, { name: "models/embedding-fixture", supportedGenerationMethods: ["embedContent"] }], nextPageToken: "cursor+/=" } : { models: [{ name: "models/gemini-second", supportedGenerationMethods: ["generateContent"] }] });
  });
  assert.deepEqual(await listProviderModels(provider({ kind: "google", authType: "api-key", apiKeyEnv: "HIVE_MODELS_GOOGLE" })), ["gemini-fixture", "gemini-second"]);
  assert.equal(seen[0].url, "https://generativelanguage.googleapis.com/v1beta/models?pageSize=512");
  assert.equal(new URL(seen[1].url).searchParams.get("pageToken"), "cursor+/=");
  assert.equal(seen[0].headers["x-goog-api-key"], "explicit-google-model-key");
  assert.ok(seen.every((request) => !request.url.includes("explicit-google-model-key")));
});

test("fixed native API endpoints reject overrides before credential resolution or requests", async (t) => {
  t.mock.method(globalThis, "fetch", () => assert.fail("Invalid override must not fetch"));
  for (const kind of ["anthropic", "google"]) {
    await assert.rejects(listProviderModels(provider({ kind, baseUrl: "https://other-provider.test/v1", authType: "api-key", apiKeyEnv: "HIVE_MODELS_MISSING" })), /does not support a custom base URL/);
  }
});

test("native setup origin and canonical API base discover through the same official URL and key headers", async (t) => {
  environment(t, "HIVE_MODELS_NATIVE", "explicit-native-model-key");
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    seen.push({ url: String(url), headers: init.headers });
    return Response.json(new URL(url).hostname === "api.anthropic.com"
      ? { data: [{ id: "native-fixture" }], has_more: false }
      : { models: [{ name: "models/native-fixture", supportedGenerationMethods: ["generateContent"] }] });
  });
  for (const [preset, origin, apiPath, keyHeader] of [
    ["anthropic", "https://api.anthropic.com", "/v1", "x-api-key"],
    ["google", "https://generativelanguage.googleapis.com", "/v1beta", "x-goog-api-key"],
  ]) {
    const start = seen.length;
    for (const baseUrl of [origin, `${origin}${apiPath}/`]) {
      const config = provider(buildProviderConfig({ id: preset, preset, baseUrl, model: "native-fixture", apiKeyEnv: "HIVE_MODELS_NATIVE" }));
      assert.equal(config.authType, "api-key");
      assert.deepEqual(await listProviderModels(config), ["native-fixture"]);
    }
    assert.equal(seen[start].url, seen[start + 1].url);
    assert.equal(new URL(seen[start].url).pathname, `${apiPath}/models`);
    assert.equal(seen[start].headers[keyHeader], "explicit-native-model-key");
    assert.equal(seen[start].headers.Authorization, undefined);
  }
});

test("legacy native bearer configs resolve only explicit apiKeyEnv as the API key", async (t) => {
  environment(t, "HIVE_MODELS_NATIVE_LEGACY", "explicit-legacy-native-key");
  environment(t, "HIVE_MODELS_NATIVE_TOKEN", "unrelated-native-token");
  const seen = [];
  t.mock.method(globalThis, "fetch", async (url, init) => {
    seen.push({ url: String(url), headers: init.headers });
    return Response.json(new URL(url).hostname === "api.anthropic.com"
      ? { data: [{ id: "legacy-fixture" }], has_more: false }
      : { models: [{ name: "models/legacy-fixture", supportedGenerationMethods: ["generateContent"] }] });
  });
  for (const [kind, keyHeader] of [["anthropic", "x-api-key"], ["google", "x-goog-api-key"]]) {
    const config = provider({ kind, authType: "bearer", apiKeyEnv: "HIVE_MODELS_NATIVE_LEGACY", tokenEnv: "HIVE_MODELS_NATIVE_TOKEN" });
    assert.deepEqual(await listProviderModels(config), ["legacy-fixture"]);
    assert.equal(seen.at(-1).headers[keyHeader], "explicit-legacy-native-key");
    assert.equal(seen.at(-1).headers.Authorization, undefined);
    const requestsBefore = seen.length;
    await assert.rejects(listProviderModels(provider({ kind, authType: "bearer", tokenEnv: "HIVE_MODELS_NATIVE_TOKEN" })), /requires apiKeyEnv; tokenEnv is not supported/);
    await assert.rejects(listProviderModels(provider({ kind, authType: "api-key", tokenEnv: "HIVE_MODELS_NATIVE_TOKEN" })), /requires apiKeyEnv; tokenEnv is not supported/);
    assert.equal(seen.length, requestsBefore, "tokenEnv-only native configurations must fail before fetching");
  }
});

test("provider cursor loops and malformed native responses fail explicitly", async (t) => {
  let body = { data: [{ id: "actual-model" }], has_more: true, last_id: "same-cursor" };
  t.mock.method(globalThis, "fetch", async () => Response.json(body));
  const config = provider({ kind: "anthropic" });
  await assert.rejects(listProviderModels(config), /repeated model pagination cursor/);
  body = { data: [], has_more: "true" };
  await assert.rejects(listProviderModels(config), /invalid model pagination/);
  body = { models: [{ name: "models/invalid", supportedGenerationMethods: "generateContent" }] };
  await assert.rejects(listProviderModels(provider({ kind: "google" })), /invalid Google model capabilities/);
});

test("transport errors cannot echo configured credentials or request URLs", async (t) => {
  environment(t, "HIVE_MODELS_TRANSPORT", "opaque-transport-key");
  t.mock.method(globalThis, "fetch", async () => { throw new Error("opaque-transport-key https://private-endpoint.test/v1"); });
  await assert.rejects(listProviderModels(provider({ baseUrl: "https://private-endpoint.test/v1", authType: "api-key", apiKeyEnv: "HIVE_MODELS_TRANSPORT" })), (error) => {
    assert.equal(String(error).includes("opaque-transport-key"), false);
    assert.equal(String(error).includes("private-endpoint"), false);
    return /could not complete/.test(error.message);
  });
});
