import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import { once } from "node:events";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runCoderCli } from "../dist/cli.js";
import { executeTuiCommand, parseTuiCommand } from "../dist/tui/commands.js";
import { initialState } from "../dist/tui/state.js";
import { discoverExtensions, getMcpOAuthStatus, setExtensionState } from "../dist/extensions/index.js";

async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "hive-extension-workflows-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const root = path.join(directory, "workspace");
  await fs.mkdir(root);
  return { root, directory, extensionOptions: { trustStateDir: path.join(directory, "trust"), authStateDir: path.join(directory, "auth") } };
}

async function until(condition) {
  for (let count = 0; count < 400 && !condition(); count += 1) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(condition(), "Expected extension progress did not arrive");
}

function cipher() {
  const key = randomBytes(32);
  return { kind: "isolated-test-aes-gcm", async encrypt(bytes) {
    const iv = randomBytes(12); const operation = createCipheriv("aes-256-gcm", key, iv);
    const encrypted = Buffer.concat([operation.update(bytes), operation.final()]);
    return Buffer.concat([iv, operation.getAuthTag(), encrypted]);
  }, async decrypt(bytes) {
    const data = Buffer.from(bytes); const operation = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
    operation.setAuthTag(data.subarray(12, 28)); return Buffer.concat([operation.update(data.subarray(28)), operation.final()]);
  } };
}

async function oauthFixture(t) {
  const fixture = await temporary(t);
  let origin;
  let calls = 0;
  let verifierChallenge;
  const methods = [];
  const secret = "opaque-fixture-oauth-token";
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, origin);
    const json = (value, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    if (url.pathname === "/mcp" && request.method === "GET") { response.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` }); response.end(); return; }
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return json({ resource: `${origin}/mcp`, authorization_servers: [origin], scopes_supported: ["read"] });
    if (url.pathname === "/.well-known/oauth-authorization-server") return json({ issuer: origin, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"], response_types_supported: ["code"] });
    if (url.pathname === "/authorize") {
      assert.equal(url.searchParams.get("code_challenge_method"), "S256");
      verifierChallenge = url.searchParams.get("code_challenge");
      const callback = new URL(url.searchParams.get("redirect_uri")); callback.searchParams.set("state", url.searchParams.get("state")); callback.searchParams.set("code", "fixture-code"); callback.searchParams.set("iss", origin);
      response.writeHead(302, { location: callback.href }); response.end(); return;
    }
    let raw = ""; for await (const chunk of request) raw += chunk;
    if (url.pathname === "/token") {
      const form = new URLSearchParams(raw);
      assert.equal(form.get("client_id"), "fixture-client");
      assert.equal(form.get("resource"), `${origin}/mcp`);
      assert.ok(verifierChallenge && form.get("code_verifier"));
      return json({ access_token: secret, token_type: "Bearer", expires_in: 3600, scope: "read" });
    }
    if (url.pathname === "/mcp" && request.method === "DELETE") { response.writeHead(204); response.end(); return; }
    if (url.pathname === "/mcp") {
      if (request.headers.authorization !== `Bearer ${secret}`) return json({ error: "unauthorized" }, 401);
      const message = JSON.parse(raw);
      methods.push({ method: message.method, version: request.headers["mcp-protocol-version"] });
      if (message.method === "notifications/initialized") { response.writeHead(202); response.end(); return; }
      if (!["initialize", "tools/list", "tools/call"].includes(message.method)) return json({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Method not found" } });
      const result = message.method === "initialize" ? { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
        : message.method === "tools/list" ? { tools: [{ name: "echo", description: "Echo a value", inputSchema: { type: "object" } }] }
        : { content: [{ type: "text", text: message.params.arguments.value }] };
      if (message.method === "tools/call") calls += 1;
      return json({ jsonrpc: "2.0", id: message.id, result });
    }
    return json({}, 404);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  origin = `http://127.0.0.1:${server.address().port}`;
  t.after(() => { server.closeAllConnections(); server.close(); });
  await fs.mkdir(path.join(fixture.root, ".hive"));
  await fs.writeFile(path.join(fixture.root, ".hive/extensions.json"), JSON.stringify({ version: 1, mcpServers: { fixture: { transport: "http", url: `${origin}/mcp`, oauth: { clientId: "fixture-client", scopes: ["read"] } } } }));
  const extensionOptions = { ...fixture.extensionOptions, allowLoopbackOAuthHttp: true, authCipher: cipher() };
  await setExtensionState(fixture.root, "mcp:fixture", "trust", extensionOptions);
  await setExtensionState(fixture.root, "mcp:fixture", "enable", extensionOptions);
  const authorize = async (url) => { const response = await fetch(url, { redirect: "manual" }); assert.equal(response.status, 302); assert.equal((await fetch(response.headers.get("location"))).status, 200); };
  return { ...fixture, extensionOptions, authorize, get calls() { return calls; }, methods, secret };
}

test("CLI marketplace commands install compatible snapshots and require separate trust", async (t) => {
  const { root, directory, extensionOptions } = await temporary(t);
  const source = path.join(directory, "market with spaces");
  await fs.mkdir(path.join(source, ".claude-plugin"), { recursive: true });
  await fs.mkdir(path.join(source, "plugins/review/skills/review"), { recursive: true });
  await fs.writeFile(path.join(source, ".claude-plugin/marketplace.json"), JSON.stringify({ name: "team", plugins: [{ name: "review", source: "./plugins/review", description: "Review fixture" }] }));
  await fs.writeFile(path.join(source, "plugins/review/skills/review/SKILL.md"), "---\nname: review\n---\nReview the changes.\n");
  const run = (args) => runCoderCli(["plugins", ...args, "--json"], { cwd: root, extensionOptions });
  assert.equal((await run(["marketplace", "add", source])).exitCode, 0);
  assert.match((await run(["marketplace", "list", "team"])).output, /review@team/);
  const installed = await run(["install", "review@team"]);
  assert.equal(installed.exitCode, 0, installed.output);
  const plugin = (await discoverExtensions(root, extensionOptions)).plugins[0];
  assert.equal(plugin.id, "plugin:review.team");
  assert.equal(plugin.enabled, false);
  assert.equal(plugin.trusted, false);
});

test("CLI OAuth prints authorization progress before awaiting consent and keeps credentials out of output", async (t) => {
  const fixture = await oauthFixture(t);
  const progress = [];
  const completion = runCoderCli(["mcp", "login", "fixture", "--json"], { cwd: fixture.root, extensionOptions: fixture.extensionOptions, stream: (line) => progress.push(line) });
  await until(() => progress.length > 0);
  const url = /http:\/\/127\.0\.0\.1:\d+\/authorize\?\S+/.exec(JSON.parse(progress[0]).text)[0];
  await fixture.authorize(url);
  const result = await completion;
  assert.equal(result.exitCode, 0, result.output);
  assert.equal((await getMcpOAuthStatus(fixture.root, "fixture", fixture.extensionOptions)).authenticated, true);
  assert.equal(JSON.stringify([result, progress]).includes(fixture.secret), false);
  const loggedOut = await runCoderCli(["mcp", "logout", "fixture", "--json"], { cwd: fixture.root, extensionOptions: fixture.extensionOptions });
  assert.equal(loggedOut.exitCode, 0);
  assert.equal((await getMcpOAuthStatus(fixture.root, "fixture", fixture.extensionOptions)).authenticated, false);
});

test("TUI OAuth and authenticated MCP calls use cancellable task handles and explicit tool approval", async (t) => {
  const fixture = await oauthFixture(t);
  let state = initialState();
  const start = async (text, allow = true) => {
    const result = await executeTuiCommand(parseTuiCommand(text), state, fixture.root, (update) => { state = update(state); }, { extensionOptions: fixture.extensionOptions, requestToolPermission: async () => allow });
    state = result.state; return result.runtime;
  };
  const login = await start("/mcp login fixture");
  assert.ok(login);
  await until(() => state.outputLines.some((line) => line.includes("/authorize?")));
  const url = /http:\/\/127\.0\.0\.1:\d+\/authorize\?\S+/.exec(state.outputLines.join("\n"))[0];
  await fixture.authorize(url);
  await login.completion;
  assert.equal(state.taskStatus, "complete");
  await (await start('/mcp call fixture echo {"value":"declined"}', false)).completion;
  assert.equal(fixture.calls, 0);
  await (await start('/mcp call fixture echo {"value":"approved"}')).completion;
  assert.equal(fixture.calls, 1);
  assert.deepEqual(fixture.methods.slice(0, 2), [{ method: "server/discover", version: "2026-07-28" }, { method: "initialize", version: "2025-11-25" }]);
  assert.match(state.outputLines.join("\n"), /approved/);
  assert.equal(state.outputLines.join("\n").includes(fixture.secret), false);
});

test("cancelling a visible OAuth login closes consent and leaves the server unauthenticated", async (t) => {
  const fixture = await oauthFixture(t);
  let state = initialState();
  const result = await executeTuiCommand(parseTuiCommand("/mcp login fixture"), state, fixture.root, (update) => { state = update(state); }, { extensionOptions: fixture.extensionOptions });
  state = result.state;
  await until(() => state.outputLines.some((line) => line.includes("/authorize?")));
  result.runtime.cancel("Fixture cancelled");
  await result.runtime.completion;
  assert.equal(state.taskStatus, "error");
  assert.equal((await getMcpOAuthStatus(fixture.root, "fixture", fixture.extensionOptions)).authenticated, false);
});
