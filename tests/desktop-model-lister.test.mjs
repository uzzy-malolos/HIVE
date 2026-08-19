import assert from "node:assert/strict";
import test from "node:test";

import { DesktopModelLister } from "../dist/desktop/model-lister.js";

function provider(overrides = {}) {
  return {
    id: "openai",
    name: "OpenAI",
    kind: "openai",
    authType: "api-key",
    approved: true,
    configured: true,
    ...overrides,
  };
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    json: async () => body,
  };
}

function assertSorted(models) {
  const ids = models.map((model) => model.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => a.localeCompare(b)));
}

test("lists OpenAI-compatible models from /models and sorts them", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({
      data: [
        { id: "zeta-9", context_length: 32_000, owned_by: "zeta" },
        { id: "alpha-1", context_length: 128_000, name: "Alpha" },
      ],
    });
  };

  const models = await DesktopModelLister.list(
    provider({ baseUrl: "https://api.example.com/v1" }),
    { providerId: "openai", kind: "api-key", secret: "sk-test" },
    fetchFn,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.example.com/v1/models");
  assert.equal(calls[0].init.method, "GET");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-test");
  assert.ok(calls[0].init.signal);
  assert.deepEqual(models.map((model) => model.id), ["alpha-1", "zeta-9"]);
  assert.equal(models[0].name, "Alpha");
  assert.equal(models[0].contextWindow, 128_000);
  assert.equal(models[1].contextWindow, 32_000);
});

test("lists DeepSeek models from its default baseUrl", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({
      data: [
        { id: "deepseek-chat", name: "DeepSeek V4 Flash", context_length: 128_000, owned_by: "DeepSeek" },
        { id: "deepseek-reasoner", name: "DeepSeek V4 Pro", context_length: 128_000, owned_by: "DeepSeek" },
      ],
    });
  };

  const models = await DesktopModelLister.list(
    provider({ id: "deepseek", name: "DeepSeek", kind: "openai-compatible", baseUrl: "https://api.deepseek.com/v1" }),
    { providerId: "deepseek", kind: "api-key", secret: "sk-deepseek" },
    fetchFn,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.deepseek.com/v1/models");
  assert.equal(calls[0].init.headers.Authorization, "Bearer sk-deepseek");
  assert.deepEqual(models.map((model) => model.id), ["deepseek-chat", "deepseek-reasoner"]);
  assert.equal(models[0].name, "DeepSeek V4 Flash");
});

test("lists Ollama tags from /api/tags", async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(url);
    return jsonResponse({
      models: [
        { name: "qwen2.5-coder:32b" },
        { model: "llama3.3:latest" },
      ],
    });
  };

  const models = await DesktopModelLister.list(
    provider({ id: "ollama", name: "Ollama", kind: "ollama", authType: "none", baseUrl: "http://127.0.0.1:11434" }),
    null,
    fetchFn,
  );

  assert.deepEqual(calls, ["http://127.0.0.1:11434/api/tags"]);
  assert.deepEqual(models.map((model) => model.id), ["llama3.3:latest", "qwen2.5-coder:32b"]);
});

test("lists Anthropic live models when credential secret is present", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({
      data: [
        { id: "claude-sonnet-4-6-20260515", display_name: "Claude Sonnet 4.6" },
        { id: "claude-opus-4-7-20260601", display_name: "Claude Opus 4.7" },
      ],
    });
  };

  const models = await DesktopModelLister.list(
    provider({ id: "anthropic", name: "Anthropic", kind: "anthropic" }),
    { providerId: "anthropic", kind: "api-key", secret: "sk-ant-test" },
    fetchFn,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://api.anthropic.com/v1/models");
  assert.equal(calls[0].init.headers["x-api-key"], "sk-ant-test");
  assert.equal(calls[0].init.headers["anthropic-version"], "2023-06-01");
  assert.deepEqual(models.map((m) => m.id), ["claude-opus-4-7-20260601", "claude-sonnet-4-6-20260515"]);
  assert.equal(models[0].name, "Claude Opus 4.7");
  assert.equal(models[1].name, "Claude Sonnet 4.6");
  assert.equal(models[0].ownedBy, "Anthropic");
});

test("Anthropic falls back to static catalog on 401 or network error", async () => {
  const models401 = await DesktopModelLister.list(
    provider({ id: "anthropic", name: "Anthropic", kind: "anthropic" }),
    { providerId: "anthropic", kind: "api-key", secret: "bad-key" },
    async () => jsonResponse({ error: "invalid_api_key" }, 401),
  );

  assert.ok(models401.some((model) => model.id.includes("claude")));
  assert.ok(models401.some((model) => model.name === "Claude Sonnet 4.6" || model.id === "claude-sonnet-4.6"));
  assertSorted(models401);

  const modelsError = await DesktopModelLister.list(
    provider({ id: "anthropic", name: "Anthropic", kind: "anthropic" }),
    { providerId: "anthropic", kind: "api-key", secret: "key" },
    async () => { throw new Error("fetch aborted"); },
  );
  assert.ok(modelsError.some((model) => model.id.includes("claude")));
});

test("Anthropic with no secret returns static catalog without calling fetch", async () => {
  let called = false;
  const models = await DesktopModelLister.list(
    provider({ id: "anthropic", name: "Anthropic", kind: "anthropic" }),
    null,
    async () => {
      called = true;
      throw new Error("network should not be used");
    },
  );

  assert.equal(called, false);
  assert.ok(models.some((model) => model.id.includes("claude")));
  assertSorted(models);
});

test("lists Google live models when credential secret is present and filters embeddings", async () => {
  const calls = [];
  const fetchFn = async (url, init) => {
    calls.push({ url, init });
    return jsonResponse({
      models: [
        { name: "models/gemini-3-flash", displayName: "Gemini 3 Flash", inputTokenLimit: 1_000_000 },
        { name: "models/text-embedding-004", displayName: "Text Embedding 004" },
        { name: "models/gemini-2.5-pro", displayName: "Gemini 2.5 Pro", inputTokenLimit: 1_000_000 },
        { name: "models/aqa", displayName: "AQA Model" },
      ],
    });
  };

  const models = await DesktopModelLister.list(
    provider({ id: "google", name: "Google", kind: "google" }),
    { providerId: "google", kind: "api-key", secret: "AIzaSyTest" },
    fetchFn,
  );

  assert.equal(calls.length, 1);
  assert.ok(calls[0].url.includes("key=AIzaSyTest"));
  assert.deepEqual(models.map((m) => m.id), ["gemini-2.5-pro", "gemini-3-flash"]);
  assert.equal(models[0].name, "Gemini 2.5 Pro");
  assert.equal(models[1].name, "Gemini 3 Flash");
  assert.equal(models[0].ownedBy, "Google");
});

test("Google falls back to static catalog on failure", async () => {
  const models = await DesktopModelLister.list(
    provider({ id: "google", name: "Google", kind: "google" }),
    { providerId: "google", kind: "api-key", secret: "bad-key" },
    async () => jsonResponse({ error: "permission denied" }, 403),
  );

  assert.ok(models.some((model) => model.id.includes("gemini")));
  assertSorted(models);
});

test("Google with no secret returns static catalog without calling fetch", async () => {
  let called = false;
  const models = await DesktopModelLister.list(
    provider({ id: "google", name: "Google", kind: "google" }),
    null,
    async () => {
      called = true;
      throw new Error("network should not be used");
    },
  );

  assert.equal(called, false);
  assert.ok(models.some((model) => model.id.includes("gemini")));
  assertSorted(models);
});

test("local providers return the default model without calling the network", async () => {
  let called = false;
  const models = await DesktopModelLister.list(
    provider({ id: "local", name: "Local model", kind: "local", authType: "none", defaultModel: "hive-local" }),
    null,
    async () => {
      called = true;
      return jsonResponse({ data: [] });
    },
  );

  assert.equal(called, false);
  assert.deepEqual(models, [{ id: "hive-local", name: "hive-local", ownedBy: "Local model" }]);
});

test("openai-compatible providers without a base URL do not send secrets to OpenAI", async () => {
  let called = false;
  const models = await DesktopModelLister.list(
    provider({
      id: "hive-cloud",
      name: "HIVE 0.1",
      kind: "openai-compatible",
      defaultModel: "hive-0.1",
      baseUrl: undefined,
    }),
    { providerId: "hive-cloud", kind: "bearer", secret: "hive-token" },
    async () => {
      called = true;
      return jsonResponse({ data: [] });
    },
  );

  assert.equal(called, false);
  assert.deepEqual(models.map((model) => model.id), ["hive-0.1"]);
});

test("failed OpenAI-compatible fetches fall back to the configured default model", async () => {
  const models = await DesktopModelLister.list(
    provider({ defaultModel: "gpt-4o-mini" }),
    null,
    async () => jsonResponse({ error: "nope" }, 401),
  );

  assert.deepEqual(models.map((model) => model.id), ["gpt-4o-mini"]);
});
