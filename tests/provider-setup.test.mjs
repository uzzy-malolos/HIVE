import assert from "node:assert/strict";
import { once } from "node:events";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ProviderRegistry } from "../dist/providers/registry.js";
import { buildProviderConfig, providerLaunchCommand, PROVIDER_SETUP_PRESETS } from "../dist/providers/setup.js";
import { runProviderSetupWizard } from "../dist/ui/setup.js";

async function registryFixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-provider-setup-"));
  t.after(async () => {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith("hive-provider-setup-"));
    await fs.rm(root, { recursive: true, force: true });
  });
  return { root, registry: new ProviderRegistry(root) };
}

async function serverFixture(t, respond = (_request, response) => { response.writeHead(200, { "content-type": "application/json" }); response.end('{"data":[{"id":"served-model"}]}'); }) {
  const server = http.createServer(respond);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { server, baseUrl: `http://127.0.0.1:${server.address().port}/v1` };
}

function wizardIO(answers) {
  const prompts = [];
  const output = [];
  let index = 0;
  return {
    prompts, output,
    options: {
      async question(prompt) { prompts.push(prompt); assert.ok(index < answers.length, `Unexpected question: ${prompt}`); return answers[index++]; },
      write(message) { output.push(message); },
    },
    assertConsumed() { assert.equal(index, answers.length); },
  };
}

test("provider presets distinguish BYOK and local without invented model IDs", () => {
  for (const id of ["openai", "anthropic", "google", "openrouter", "custom", "ollama", "local"]) assert.ok(PROVIDER_SETUP_PRESETS.some((entry) => entry.id === id));
  assert.equal(PROVIDER_SETUP_PRESETS.find((entry) => entry.id === "ollama").mode, "local");
  assert.equal(PROVIDER_SETUP_PRESETS.find((entry) => entry.id === "local").baseUrl, "http://127.0.0.1:1234/v1");
  for (const preset of PROVIDER_SETUP_PRESETS) {
    assert.equal("model" in preset, false);
    assert.equal("defaultModel" in preset, false);
    if (preset.mode === "subscription") {
      assert.equal(buildProviderConfig({ id: "subscription", preset: preset.id }).defaultModel, undefined);
      assert.throws(() => buildProviderConfig({ id: "subscription", preset: preset.id, baseUrl: "https://provider.example/v1" }), /endpoint overrides/);
    } else assert.throws(() => buildProviderConfig({ id: "missing-model", preset: preset.id, baseUrl: "https://provider.example/v1" }), /Model ID/);
  }
  const config = buildProviderConfig({ id: "my-openai", preset: "openai", model: "exact-model" });
  assert.deepEqual(config, { id: "my-openai", name: "my-openai", kind: "openai", baseUrl: "https://api.openai.com/v1", authType: "bearer", apiKeyEnv: "OPENAI_API_KEY", defaultModel: "exact-model" });
  assert.equal(buildProviderConfig({ id: "legacy", kind: "openai" }).defaultModel, undefined, "legacy explicit-kind registration can bind a model later");
});

test("provider setup validates IDs, models, references, and credential-free endpoints before persistence", () => {
  const valid = { id: "my-provider", preset: "custom", model: "owner/model:tag", baseUrl: "https://provider.example/v1", apiKeyEnv: "MY_PROVIDER_KEY" };
  assert.equal(buildProviderConfig(valid).defaultModel, "owner/model:tag");
  for (const patch of [
    { id: "../../outside" }, { id: "bad\u001b[31m" }, { id: "a".repeat(65) },
    { model: "" }, { model: "model\nname" }, { model: "two words" }, { model: "x".repeat(257) },
    { apiKeyEnv: "sk-do-not-persist-a-key" }, { apiKeyEnv: "KEY=value" }, { apiKeyEnv: "" },
    { apiKeyEnv: `AIza${"A".repeat(35)}` }, { apiKeyEnv: `hf_${"A".repeat(25)}` }, { apiKeyEnv: `AKIA${"A".repeat(16)}` },
    { apiKeyEnv: "NAME\nOTHER" }, { apiKeyEnv: "X".repeat(129) },
    { baseUrl: "https://secret:password@provider.example/v1" }, { baseUrl: "https://provider.example/v1?key=secret" },
    { baseUrl: "https://provider.example/v1#secret" }, { baseUrl: "https://provider.example\\@evil.example/v1" },
    { baseUrl: "http://provider.example/v1" }, { baseUrl: "http://192.168.1.5/v1" }, { baseUrl: "file:///private" },
    { baseUrl: "https://provider.example/\npath" }, { preset: "unsupported" }, { kind: "anthropic" },
  ]) assert.throws(() => buildProviderConfig({ ...valid, ...patch }), undefined, JSON.stringify(patch));
  assert.throws(() => buildProviderConfig({ id: "unsupported", kind: "oauth", model: "model", baseUrl: valid.baseUrl }), /supported/);
});

test("provider launch commands quote shell metacharacters and apostrophes without restricting actual model IDs", () => {
  assert.equal(providerLaunchCommand("my-provider", "owner/model:tag"), "hive --model my-provider/owner/model:tag");
  const model = "served'$(Get-Date);value`name";
  assert.equal(providerLaunchCommand("my-provider", model), process.platform === "win32"
    ? "hive --model 'my-provider/served''$(Get-Date);value`name'"
    : "hive --model 'my-provider/served'\\''$(Get-Date);value`name'");
});

test("local setup requires no key and accepts conventional loopback endpoint formats", () => {
  const ollama = buildProviderConfig({ id: "local-ollama", preset: "ollama", model: "installed:tag" });
  assert.equal(ollama.authType, "none");
  assert.equal(ollama.apiKeyEnv, undefined);
  for (const baseUrl of ["http://127.0.0.1:1234/v1/", "http://127.2.3.4:1234/v1", "http://[::1]:1234/v1", "http://localhost:1234/v1"]) {
    const local = buildProviderConfig({ id: "local", preset: "local", model: "served-model", baseUrl });
    assert.equal(local.authType, "none");
    assert.equal(local.apiKeyEnv, undefined);
    assert.ok(!local.baseUrl.endsWith("/"));
  }
  const authenticated = buildProviderConfig({ id: "local-auth", preset: "local", model: "served-model", apiKeyEnv: "LOCAL_SERVER_TOKEN" });
  assert.equal(authenticated.authType, "bearer");
  assert.equal(authenticated.apiKeyEnv, "LOCAL_SERVER_TOKEN");
  assert.throws(() => buildProviderConfig({ id: "ollama-auth", preset: "ollama", model: "model", apiKeyEnv: "TOKEN" }), /does not send API keys/);
  for (const kind of ["openai-compatible", "custom"]) {
    const legacy = buildProviderConfig({ id: "legacy-local", kind, baseUrl: "http://localhost:1234/v1" });
    assert.equal(legacy.authType, "none");
    assert.equal(legacy.apiKeyEnv, undefined);
  }
  assert.equal(buildProviderConfig({ id: "byok-local-proxy", preset: "custom", model: "model", baseUrl: "http://localhost:1234/v1" }).apiKeyEnv, "CUSTOM_API_KEY", "a BYOK preset retains its key-reference contract even when explicitly targeting a loopback proxy");
});

test("native Anthropic and Google setup cannot silently ignore a configured proxy endpoint", () => {
  for (const preset of ["anthropic", "google"]) {
    assert.throws(() => buildProviderConfig({ id: preset, preset, model: "model", baseUrl: "https://proxy.example/v1" }), /fixed official endpoint/);
    const config = buildProviderConfig({ id: preset, preset, model: "model" });
    assert.equal(config.kind, preset);
    assert.equal(config.authType, "api-key", "native model discovery and inference use the provider's API-key authentication contract");
  }
});

test("local wizard tests a real server, approves successful setup, and preserves existing role assignments by default", async (t) => {
  const { root, registry } = await registryFixture(t);
  const requests = [];
  const { baseUrl } = await serverFixture(t, (request, response) => {
    requests.push({ method: request.method, path: request.url, authorization: request.headers.authorization });
    response.writeHead(200, { "content-type": "application/json" }); response.end('{"data":[]}');
  });
  await registry.add({ id: "existing", name: "Existing", kind: "local", baseUrl, authType: "none", defaultModel: "old-model" });
  await registry.approve("existing");
  await registry.setRole("builder", "existing", "old-model");
  const roleBytes = await fs.readFile(path.join(root, ".hive/provider-roles.json"));
  const io = wizardIO(["2", "local", "my-local", baseUrl, "served-model", "", ""]);
  await runProviderSetupWizard(registry, io.options);
  io.assertConsumed();
  const config = await registry.get("my-local");
  assert.equal(config.approved, true);
  assert.equal(config.defaultModel, "served-model");
  assert.equal(config.authType, "none");
  assert.equal(config.apiKeyEnv, undefined);
  assert.deepEqual(requests, [{ method: "GET", path: "/v1/models", authorization: undefined }]);
  assert.deepEqual(await fs.readFile(path.join(root, ".hive/provider-roles.json")), roleBytes);
  assert.match(io.output.join("\n"), /hive --model my-local\/served-model/);
  assert.match(io.output.join("\n"), /hive providers verify my-local --coding/);
});

test("BYOK wizard saves only an environment reference and does not approve a missing key", async (t) => {
  const { root, registry } = await registryFixture(t);
  let requests = 0;
  const { baseUrl } = await serverFixture(t, (_request, response) => { requests++; response.end("{}"); });
  const name = "HIVE_SETUP_TEST_MISSING_KEY";
  const prior = process.env[name];
  delete process.env[name];
  t.after(() => { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; });
  const io = wizardIO(["1", "custom", "my-byok", baseUrl, "served-model", name]);
  await runProviderSetupWizard(registry, io.options);
  io.assertConsumed();
  assert.equal((await registry.get("my-byok")).approved, false);
  assert.equal(requests, 0);
  const saved = await fs.readFile(path.join(root, ".hive/providers.json"), "utf8");
  assert.equal(JSON.parse(saved)[0].apiKeyEnv, name);
  assert.match(io.output.join("\n"), /remains unapproved/);
  assert.doesNotMatch(io.output.join("\n"), /is approved/);
  await assert.rejects(fs.access(path.join(root, ".hive/provider-roles.json")), { code: "ENOENT" });
});

test("BYOK wizard uses an ephemeral environment key without saving or printing its value", async (t) => {
  const { root, registry } = await registryFixture(t);
  const secret = "opaque-private-setup-token";
  const name = "HIVE_SETUP_TEST_KEY";
  const prior = process.env[name];
  process.env[name] = secret;
  t.after(() => { if (prior === undefined) delete process.env[name]; else process.env[name] = prior; });
  let authorization;
  const { baseUrl } = await serverFixture(t, (request, response) => { authorization = request.headers.authorization; response.end("{}"); });
  const io = wizardIO(["1", "custom", "authenticated", baseUrl, "served-model", name, "n"]);
  await runProviderSetupWizard(registry, io.options);
  io.assertConsumed();
  assert.equal(authorization, `Bearer ${secret}`);
  assert.equal((await registry.get("authenticated")).approved, true);
  assert.equal((await fs.readFile(path.join(root, ".hive/providers.json"), "utf8")).includes(secret), false);
  assert.equal(io.output.join("\n").includes(secret), false);
  assert.equal(io.prompts.join("\n").includes(secret), false);
});

test("wizard binds coding defaults only after an explicit yes and preserves unrelated role settings", async (t) => {
  const { registry } = await registryFixture(t);
  const { baseUrl } = await serverFixture(t);
  await registry.add({ id: "old", name: "Old", kind: "local", authType: "none", baseUrl });
  await registry.approve("old");
  await registry.setRole("studyBuddy", "old", "study-model");
  await registry.setRole("builder", "old", "old-model");
  const io = wizardIO(["2", "local", "chosen", baseUrl, "chosen-model", "", "yes"]);
  await runProviderSetupWizard(registry, io.options);
  io.assertConsumed();
  const roles = await registry.getRoles();
  for (const role of ["queen", "planner", "scout", "builder", "validator", "reviewer", "fixer", "synthesis"]) assert.deepEqual(roles[role], { provider: "chosen", model: "chosen-model" });
  assert.deepEqual(roles.studyBuddy, { provider: "old", model: "study-model" });
});

test("wizard cancellation aborts a real health request and leaves the saved provider unapproved", async (t) => {
  const { registry } = await registryFixture(t);
  let arrived;
  let closed;
  const arrival = new Promise((resolve) => { arrived = resolve; });
  const disconnected = new Promise((resolve) => { closed = resolve; });
  const { baseUrl } = await serverFixture(t, (request) => { request.on("close", closed); arrived(); });
  const controller = new AbortController();
  const io = wizardIO(["2", "local", "cancelled", baseUrl, "served-model", ""]);
  const pending = runProviderSetupWizard(registry, { ...io.options, signal: controller.signal });
  await arrival;
  controller.abort();
  await assert.rejects(pending, /abort/i);
  await Promise.race([disconnected, new Promise((_, reject) => setTimeout(() => reject(new Error("Health request stayed open after cancellation")), 1000).unref())]);
  assert.equal((await registry.get("cancelled")).approved, false);
});

test("wizard health timeouts remain unapproved and never prompt to rewrite roles", async (t) => {
  const { registry } = await registryFixture(t);
  const { baseUrl } = await serverFixture(t, () => {});
  const io = wizardIO(["2", "local", "timeout", baseUrl, "served-model", ""]);
  await runProviderSetupWizard(registry, { ...io.options, healthTimeoutMs: 100 });
  io.assertConsumed();
  assert.equal((await registry.get("timeout")).approved, false);
  assert.match(io.output.join("\n"), /timed out/);
  assert.equal(io.prompts.some((prompt) => prompt.includes("default coding roles")), false);
});

test("wizard rejects inline credentials and missing model IDs without creating configuration", async (t) => {
  for (const values of [
    ["1", "custom", "unsafe", "https://provider.example/v1", "model", "sk-private-key"],
    ["2", "ollama", "unsafe", "http://127.0.0.1:11434", ""],
  ]) {
    const { root, registry } = await registryFixture(t);
    const io = wizardIO(values);
    await assert.rejects(runProviderSetupWizard(registry, io.options));
    assert.deepEqual(await registry.list(), []);
    await assert.rejects(fs.access(path.join(root, ".hive/providers.json")), { code: "ENOENT" });
  }
});
