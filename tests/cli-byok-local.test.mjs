import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { runCoderCli } from "../dist/cli.js";
import { ProviderRegistry } from "../dist/providers/registry.js";
import { providerCatalog, providerCommand, providerCommandArguments } from "../dist/providers/commands.js";
import { executeTuiCommand, parseTuiCommand } from "../dist/tui/commands.js";
import { initialState } from "../dist/tui/state.js";
import { acceptPicker } from "../dist/tui/picker.js";
import { CliConversationStore } from "../dist/tui/conversations.js";
import { GoogleAdapter } from "../dist/providers/adapters/google.js";
import { buildProviderConfig } from "../dist/providers/setup.js";
import { runProviderSetupWizard } from "../dist/ui/setup.js";

const exec = promisify(execFile);
async function fixture(t, response) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-byok-local-"));
  const globalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "hive-byok-global-"));
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push({ url: req.url, method: req.method, authorization: req.headers.authorization });
    if (response) return response(req, res);
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data: [{ id: "org/local-model" }] }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); server.close(); await fs.rm(root, { recursive: true, force: true }); await fs.rm(globalRoot, { recursive: true, force: true }); });
  await exec("git", ["init", "-b", "main"], { cwd: root });
  const nested = path.join(root, "nested"); await fs.mkdir(nested);
  return { root, globalRoot, nested, requests, server, url: `http://127.0.0.1:${server.address().port}/v1`,
    registry: new ProviderRegistry(root), options: { globalRoot } };
}

test("CLI BYOK and local presets save references, preserve defaults, and configure the canonical repository root", async (t) => {
  const { root, nested, registry, url, requests } = await fixture(t);
  const local = await runCoderCli(["providers", "add", "--id", "local-test", "--preset", "local", "--base-url", url, "--model", "org/local-model", "--json"], { cwd: nested });
  assert.equal(local.exitCode, 0, local.output); assert.equal(JSON.parse(local.output).configRoot, root);
  assert.equal((await registry.get("local-test")).authType, "none");
  const cloud = await runCoderCli(["providers", "add", "--id", "byok-test", "--preset", "openai", "--model", "chosen-cloud-model", "--api-key-env", "HIVE_BYOK_REFERENCE_ONLY", "--json"], { cwd: nested });
  assert.equal(cloud.exitCode, 0, cloud.output);
  const provider = await registry.get("byok-test"); assert.equal(provider.apiKeyEnv, "HIVE_BYOK_REFERENCE_ONLY"); assert.equal(provider.approved, false);
  assert.deepEqual(await registry.getRoles(), {}); assert.equal(requests.length, 0, "registration and listing never contact model endpoints");
  await assert.rejects(fs.access(path.join(nested, ".hive/providers.json")), { code: "ENOENT" });
  const presets = JSON.parse((await runCoderCli(["providers", "presets", "--json"], { cwd: root })).output);
  assert.ok(presets.some(row => row.mode === "byok" && row.id === "anthropic"));
  assert.ok(presets.some(row => row.mode === "local" && row.id === "local"));
});

test("in-session connection picker exposes BYOK and local setup without executing its command templates", async (t) => {
  const { root, registry, requests, options } = await fixture(t);
  const run = (command, state = initialState()) => executeTuiCommand(parseTuiCommand(command), state, root, undefined, { providerOptions: options });
  const connected = await run("/connect");
  assert.deepEqual(connected.state.picker.items.map(item => item.insert), ["/providers setup byok", "/providers setup local", "/providers setup subscription"]);
  const local = await run("/connect local");
  for (const preset of ["ollama", "local", "hermes"]) assert.ok(local.state.picker.items.some(item => item.insert.includes(`--preset ${preset} --model`)), `Missing local setup choice: ${preset}`);
  const byok = await run("/connect byok");
  for (const preset of ["google", "anthropic", "opencode", "kilo", "cline"]) assert.ok(byok.state.picker.items.some(item => item.insert.includes(`--preset ${preset} --model`)), `Missing BYOK setup choice: ${preset}`);
  const selected = acceptPicker("", local.state.picker);
  assert.equal(selected.submit, false); assert.match(selected.input, /--preset ollama --model $/);
  const model = await run("/model");
  assert.ok(model.state.picker.items.some(item => item.label === "Add BYOK provider"));
  assert.ok(model.state.picker.items.some(item => item.label === "Add local provider"));
  assert.deepEqual(await registry.list(), []); assert.deepEqual(requests, []);
});

test("terminal local setup tests, approves, discovers and selects a real no-key endpoint without changing role defaults", async (t) => {
  const { nested, root, registry, url, requests, options } = await fixture(t);
  let state = initialState(); const turns = [];
  const invoke = async command => {
    const result = await executeTuiCommand(parseTuiCommand(command), state, nested, update => { state = update(state); }, {
      providerOptions: options, persistSession: true,
      runSession: async request => { turns.push(request); return { id: "provider-choice-test", status: "completed", finalReport: { result: "Selected route reached the coding runner" } }; },
    });
    state = result.state; await result.runtime?.completion; return state;
  };
  await invoke(`/providers add --id local-choice --preset local --base-url ${url} --model org/local-model`);
  assert.equal((await registry.get("local-choice")).approved, false);
  await invoke("/providers test local-choice"); assert.equal(state.taskStatus, "complete");
  await invoke("/providers approve local-choice");
  await invoke("/providers models local-choice");
  assert.ok(state.picker.items.some(item => item.insert === "/model local-choice/org/local-model"));
  await invoke("/model local-choice/org/local-model");
  await invoke("Use the selected local provider");
  assert.deepEqual(turns[0].providerOverride, { providerId: "local-choice", model: "org/local-model" });
  assert.ok(requests.every(request => request.method === "GET" && request.authorization === undefined));
  assert.deepEqual(await registry.getRoles(), {});
  const saved = await new CliConversationStore(nested).load(state.conversation.id);
  assert.deepEqual(saved.model, { providerId: "local-choice", model: "org/local-model" });
  assert.equal((await new ProviderRegistry(root).get("local-choice")).authType, "none");
});

test("project providers shadow global choices consistently, including unapproved project registrations", async (t) => {
  const { root, registry, globalRoot, options, url } = await fixture(t);
  const global = new ProviderRegistry(globalRoot);
  for (const id of ["shared", "global-only"]) {
    await global.add({ id, name: id, kind: "local", baseUrl: url, authType: "none", defaultModel: "global-model" }); await global.approve(id);
  }
  await registry.add({ id: "shared", name: "Project shadow", kind: "local", baseUrl: url, authType: "none", defaultModel: "project-model" });
  const catalog = await providerCatalog(root, options);
  assert.equal(catalog.rows.filter(row => row.provider.id === "shared").length, 1);
  assert.equal(catalog.rows.find(row => row.provider.id === "shared").scope, "project");
  const result = await executeTuiCommand(parseTuiCommand("/model"), initialState(), root, undefined, { providerOptions: options });
  assert.ok(result.state.picker.items.some(item => item.insert === "/model global-only/global-model"));
  assert.ok(!result.state.picker.items.some(item => item.insert.startsWith("/model shared/")));
  await assert.rejects(executeTuiCommand(parseTuiCommand("/model shared/global-model"), initialState(), root, undefined, { providerOptions: options }), /approved/);
  assert.ok((await providerCommand(root, ["list"], options)).lines.some(line => line.includes("global-only") && line.includes("global")));
});

test("provider argument parsing and validation reject unknown flags and key values before persistence", async (t) => {
  const { root, registry, options, url } = await fixture(t);
  assert.deepEqual(providerCommandArguments('add --id "quoted-id" --model org/local:latest'), ["add", "--id", "quoted-id", "--model", "org/local:latest"]);
  assert.throws(() => providerCommandArguments('add --id "unclosed'), /quoted/);
  for (const args of [
    ["add", "--id", "bad", "--preset", "local", "--model", "valid", "--base-url", url, "--unknown", "value"],
    ["add", "--id", "bad", "--id", "duplicate", "--preset", "local", "--model", "valid"],
    ["add", "--id", "bad", "--preset", "openai", "--model", "valid", "--api-key-env", "sk-test-do-not-persist-this-value"],
  ]) await assert.rejects(providerCommand(root, args, options));
  assert.deepEqual(await registry.list(), []);
  const headless = await runCoderCli(["providers", "setup", "--json"], { cwd: root });
  assert.equal(headless.exitCode, 1); assert.match(headless.output, /requires a terminal/);
});

test("custom BYOK picker templates collect the required endpoint and actual model before registration", async (t) => {
  const { root, registry, options, url, requests } = await fixture(t);
  const setup = await executeTuiCommand(parseTuiCommand("/connect byok"), initialState(), root, undefined, { providerOptions: options });
  for (const preset of ["custom", "hive-cloud"]) {
    const selected = setup.state.picker.items.findIndex(item => item.insert.includes(`--preset ${preset} `));
    assert.ok(selected >= 0);
    const accepted = acceptPicker("", { ...setup.state.picker, selected });
    assert.equal(accepted.submit, false); assert.match(accepted.input, /--base-url <endpoint>/);
    const completed = accepted.input.replace("<endpoint>", url) + "org/local-model";
    await executeTuiCommand(parseTuiCommand(completed), initialState(), root, undefined, { providerOptions: options });
    const provider = await registry.get(`my-${preset}`);
    assert.equal(provider.baseUrl, url); assert.equal(provider.defaultModel, "org/local-model"); assert.equal(provider.approved, false);
    assert.equal(provider.authType, "bearer", "a BYOK custom endpoint retains its key reference even on loopback");
  }
  assert.equal(requests.length, 0); assert.deepEqual(await registry.getRoles(), {});
});

test("public provider JSON whitelists metadata and redacts secrets from manually edited legacy configurations", async (t) => {
  const { root, registry, options, url } = await fixture(t);
  const secret = "opaque-fixture-value-for-projection";
  const previous = process.env.HIVE_SECRET_PROJECTION; process.env.HIVE_SECRET_PROJECTION = secret;
  t.after(() => { if (previous === undefined) delete process.env.HIVE_SECRET_PROJECTION; else process.env.HIVE_SECRET_PROJECTION = previous; });
  await registry.add({ id: "legacy", name: "Legacy", kind: "local", authType: "bearer", apiKeyEnv: "HIVE_SECRET_PROJECTION", baseUrl: url, defaultModel: "fixture" });
  const stored = await registry.get("legacy");
  await fs.writeFile(path.join(root, ".hive/providers.json"), JSON.stringify([{ ...stored, defaultModel: secret,
    baseUrl: url.replace("http://", `http://user:${secret}@`) + `?key=${secret}#${secret}`, apiKey: secret, notes: secret }]));
  const listed = await providerCommand(root, ["list"], options);
  for (const text of [JSON.stringify(listed.data), listed.lines.join("\n")]) assert.equal(text.includes(secret), false);
  assert.equal(listed.data[0].apiKey, undefined); assert.equal(listed.data[0].notes, undefined);
  assert.equal(listed.data[0].defaultModel, "[REDACTED]"); assert.equal(listed.data[0].baseUrl, url);
  const cli = await runCoderCli(["providers", "list", "--json"], { cwd: root });
  assert.equal(cli.exitCode, 0, cli.output); assert.equal(cli.output.includes(secret), false); assert.equal(JSON.parse(cli.output)[0].apiKey, undefined);
  const approved = await providerCommand(root, ["approve", "legacy"], options);
  assert.equal(approved.lines.join("\n").includes(secret), false);
  const picker = await executeTuiCommand(parseTuiCommand("/model"), initialState(), root, undefined, { providerOptions: options });
  assert.equal(JSON.stringify(picker.state.picker).includes(secret), false, "legacy credential-bearing model IDs cannot become composer templates");
  const credentialLikeModel = `sk-proj-${"x".repeat(64)}`;
  assert.throws(() => buildProviderConfig({ id: "not-secret", preset: "local", model: credentialLikeModel }), /credential/);
});

test("explicit Google key references cannot approve or generate through another ambient credential", async (t) => {
  const { root, registry } = await fixture(t);
  const names = ["GEMINI_API_KEY", "GOOGLE_API_KEY", "HIVE_SELECTED_GOOGLE_KEY"];
  const before = new Map(names.map(name => [name, process.env[name]]));
  process.env.GEMINI_API_KEY = "ambient-gemini-fixture"; process.env.GOOGLE_API_KEY = "ambient-google-fixture"; delete process.env.HIVE_SELECTED_GOOGLE_KEY;
  const originalFetch = global.fetch; let fetched = false;
  global.fetch = async () => { fetched = true; throw new Error("The unselected account must not be contacted"); };
  t.after(() => { global.fetch = originalFetch; for (const [name, value] of before) { if (value === undefined) delete process.env[name]; else process.env[name] = value; } });
  const config = { ...buildProviderConfig({ id: "google-selected", preset: "google", model: "chosen-model", apiKeyEnv: "HIVE_SELECTED_GOOGLE_KEY" }), approved: false };
  const adapter = new GoogleAdapter();
  assert.equal((await adapter.healthCheck(config)).ok, false);
  await assert.rejects(adapter.complete(config, { model: "chosen-model", prompt: "test" }), /HIVE_SELECTED_GOOGLE_KEY/);
  await assert.rejects(adapter.streamComplete(config, { model: "chosen-model", prompt: "test" }, () => {}), /HIVE_SELECTED_GOOGLE_KEY/);
  const answers = ["1", "google", "google-wizard", "", "chosen-model", "HIVE_SELECTED_GOOGLE_KEY"];
  await runProviderSetupWizard(registry, { question: async () => { assert.ok(answers.length); return answers.shift(); }, write: () => {} });
  assert.equal((await registry.get("google-wizard")).approved, false);
  assert.equal(fetched, false);
  assert.equal((await adapter.healthCheck({ ...config, apiKeyEnv: undefined })).ok, true, "legacy implicit configs retain their documented default environment lookup");
  assert.deepEqual(await new ProviderRegistry(root).getRoles(), {});
});

test("CLI verification resolves globally configured providers and preserves project shadowing", async (t) => {
  const { root, globalRoot, registry, url, requests } = await fixture(t, async (req, res) => {
    if (req.method === "GET") { res.setHeader("content-type", "application/json"); res.end('{"data":[]}'); return; }
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); const marker = /HIVE_VERIFY_[a-f0-9]+/.exec(body.messages.at(-1).content)?.[0];
    if (!marker) { res.writeHead(400); res.end(); return; }
    if (body.stream) { res.writeHead(200, { "content-type": "text/event-stream" }); res.end(`data: ${JSON.stringify({ choices: [{ delta: { content: marker } }] })}\n\ndata: [DONE]\n\n`); }
    else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ choices: [{ message: { content: marker } }] })); }
  });
  const global = new ProviderRegistry(globalRoot);
  await global.add({ id: "global-verify", name: "Global local endpoint", kind: "local", baseUrl: url, authType: "none", defaultModel: "fixture-model" }); await global.approve("global-verify");
  const env = { ...process.env, USERPROFILE: globalRoot, HOME: globalRoot };
  const args = [path.resolve("bin/hive.mjs"), "providers", "verify", "global-verify", "--json"];
  const first = await exec(process.execPath, args, { cwd: root, env, timeout: 10000 });
  assert.equal(JSON.parse(first.stdout).status, "passed");
  const before = requests.length;
  await registry.add({ id: "global-verify", name: "Unapproved project shadow", kind: "local", baseUrl: url, authType: "none", defaultModel: "different-model" });
  await assert.rejects(exec(process.execPath, args, { cwd: root, env, timeout: 10000 }), error => {
    assert.match(JSON.parse(error.stdout).error, /not approved/); return true;
  });
  assert.equal(requests.length, before, "an unapproved project shadow cannot silently select a global account");
});

test("cancelling terminal model discovery closes its actual HTTP request without selecting or approving anything", async (t) => {
  let arrived; const arrival = new Promise(resolve => { arrived = resolve; });
  let closed; const closure = new Promise(resolve => { closed = resolve; });
  const { root, registry, url, options } = await fixture(t, (_req, res) => { res.on("close", closed); res.writeHead(200, { "content-type": "application/json" }); res.write('{"data":['); arrived(); });
  await registry.add({ id: "slow", name: "Slow local endpoint", kind: "local", baseUrl: url, authType: "none", defaultModel: "unused" });
  let state = initialState();
  const result = await executeTuiCommand(parseTuiCommand("/providers models slow"), state, root, update => { state = update(state); }, { providerOptions: options });
  state = result.state; await arrival; result.runtime.cancel(); await result.runtime.completion;
  await Promise.race([closure, new Promise((_, reject) => setTimeout(() => reject(new Error("Model discovery connection remained open")), 1000).unref())]);
  assert.equal((await registry.get("slow")).approved, false); assert.equal(state.conversation?.model, undefined);
});
