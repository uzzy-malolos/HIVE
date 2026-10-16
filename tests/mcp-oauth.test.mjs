import assert from "node:assert/strict";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { EventEmitter } from "node:events";
import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PassThrough } from "node:stream";
import { promisify } from "node:util";
import { connectMcp, discoverExtensions, setExtensionState } from "../dist/extensions/index.js";
import { beginMcpOAuthLogin, getMcpOAuthStatus, logoutMcpOAuth } from "../dist/extensions/oauth.js";
import { WindowsOAuthCipher } from "../dist/extensions/oauth-storage.js";
import { oauthNetworkRequest, publicOAuthAddress, resolveOAuthAddress, validateOAuthUrl } from "../dist/security/oauth-network.js";

function testCipher() {
  const key = randomBytes(32);
  return { kind: "test-aes-gcm", async encrypt(bytes) { const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, nonce); return Buffer.concat([nonce, cipher.update(bytes), cipher.final(), cipher.getAuthTag()]); }, async decrypt(bytes) { const value = Buffer.from(bytes); const decipher = createDecipheriv("aes-256-gcm", key, value.subarray(0, 12)); decipher.setAuthTag(value.subarray(-16)); return Buffer.concat([decipher.update(value.subarray(12, -16)), decipher.final()]); } };
}

async function fixture(run, behavior = {}) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hive-mcp-oauth-")); const root = path.join(temporary, "repo");
  await fs.mkdir(path.join(root, ".hive"), { recursive: true });
  const options = { trustStateDir: path.join(temporary, "trust"), authStateDir: path.join(temporary, "auth"), authCipher: testCipher(), allowLoopbackOAuthHttp: true };
  const seen = { requests: [], tokenRequests: [], registrations: [], toolCalls: 0, refreshes: 0, authorization: undefined, tokens: ["opaque-access-value-one", "opaque-access-value-two", "opaque-access-value-three"] };
  let tokenStartedResolve; const tokenStarted = new Promise((resolve) => { tokenStartedResolve = resolve; });
  let releaseToken; const tokenReleased = new Promise((resolve) => { releaseToken = resolve; });
  let origin;
  const json = (res, status, value, headers = {}) => { res.writeHead(status, { "content-type": "application/json", ...headers }); res.end(JSON.stringify(value)); };
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, origin); let body = ""; for await (const chunk of req) body += chunk;
      seen.requests.push({ method: req.method, path: url.pathname, authorization: req.headers.authorization });
      if (url.pathname === "/resource-metadata" || url.pathname === "/.well-known/oauth-protected-resource/mcp") return json(res, 200, { resource: behavior.wrongResource ? `${origin}/other` : `${origin}/mcp`, authorization_servers: [`${origin}/tenant`], scopes_supported: ["fallback"] });
      if (url.pathname === "/.well-known/oauth-authorization-server/tenant") {
        if (behavior.oidcFallback) return json(res, 404, {});
        return json(res, 200, { issuer: behavior.wrongIssuer ? `${origin}/other` : `${origin}/tenant`, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, ...(behavior.noRegistration ? {} : { registration_endpoint: `${origin}/register` }), code_challenge_methods_supported: behavior.noPkce ? [] : ["S256"], token_endpoint_auth_methods_supported: ["none", "client_secret_basic"], response_types_supported: ["code"] });
      }
      if (url.pathname === "/.well-known/openid-configuration/tenant") return json(res, 404, {});
      if (url.pathname === "/tenant/.well-known/openid-configuration") return json(res, 200, { issuer: `${origin}/tenant`, authorization_endpoint: `${origin}/authorize`, token_endpoint: `${origin}/token`, registration_endpoint: `${origin}/register`, code_challenge_methods_supported: ["S256"], token_endpoint_auth_methods_supported: ["none"] });
      if (url.pathname === "/register") { const registration = JSON.parse(body); seen.registrations.push(registration); return json(res, 201, { client_id: "hive-fixture-client", redirect_uris: registration.redirect_uris, token_endpoint_auth_method: "none" }); }
      if (url.pathname === "/authorize") { seen.authorization = url; const redirect = new URL(url.searchParams.get("redirect_uri")); redirect.searchParams.set("code", "fixture-authorization-code"); redirect.searchParams.set("state", url.searchParams.get("state")); redirect.searchParams.set("iss", `${origin}/tenant`); res.writeHead(302, { location: redirect.href }); res.end(); return; }
      if (url.pathname === "/token") {
        const params = new URLSearchParams(body); seen.tokenRequests.push(params);
        assert.equal(params.get("resource"), `${origin}/mcp`);
        if (params.get("grant_type") === "authorization_code") {
          assert.equal(params.get("code"), "fixture-authorization-code");
          assert.equal(createHash("sha256").update(params.get("code_verifier")).digest("base64url"), seen.authorization.searchParams.get("code_challenge"));
          assert.equal(params.get("redirect_uri"), seen.authorization.searchParams.get("redirect_uri"));
          if (behavior.holdToken) { tokenStartedResolve(); await tokenReleased; }
          return json(res, 200, { access_token: seen.tokens[0], refresh_token: "opaque-refresh-value-one", token_type: "Bearer", expires_in: behavior.initialExpires ?? 3600, scope: "tools:read" });
        }
        seen.refreshes += 1;
        if (behavior.refreshFails) return json(res, 400, { error: "invalid_grant", error_description: "opaque-refresh-value-one" });
        return json(res, 200, { access_token: seen.tokens[Math.min(seen.refreshes, 2)], refresh_token: `opaque-refresh-value-${seen.refreshes + 1}`, token_type: "bearer", expires_in: 3600 });
      }
      if (url.pathname === "/mcp") {
        if (req.method === "GET") return json(res, 401, {}, behavior.noChallenge ? {} : { "www-authenticate": `Bearer resource_metadata="${origin}/resource-metadata", scope="tools:read"` });
        if (!seen.tokens.some((value) => req.headers.authorization === `Bearer ${value}`)) return json(res, 401, {}, { "www-authenticate": `Bearer resource_metadata="${origin}/resource-metadata"` });
        if (req.method === "DELETE") { res.writeHead(204); res.end(); return; }
        const message = JSON.parse(body);
        if (message.method === "tools/call") { seen.toolCalls += 1; if (behavior.rejectTool) return json(res, 401, {}); return json(res, 200, { jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: behavior.echoToken ? seen.tokens[0] : "verified fixture tool" }] } }); }
        if (message.method === "tools/list") {
          if (behavior.rejectFirstToken && req.headers.authorization === `Bearer ${seen.tokens[0]}`) return json(res, 401, {});
          return json(res, 200, { jsonrpc: "2.0", id: message.id, result: { tools: [{ name: "fixture", inputSchema: { type: "object" } }] } });
        }
        if (message.method === "initialize") return json(res, 200, { jsonrpc: "2.0", id: message.id, result: { protocolVersion: "2025-11-25", capabilities: { tools: {} }, serverInfo: { name: "oauth-fixture", version: "1" } } });
        res.writeHead(202); res.end(); return;
      }
      return json(res, 404, {});
    } catch { json(res, 500, { error: "fixture assertion failed" }); }
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); origin = `http://127.0.0.1:${server.address().port}`;
  const configPath = path.join(root, ".hive", "extensions.json");
  const configure = async (extra = {}) => fs.writeFile(configPath, JSON.stringify({ version: 1, mcpServers: { fixture: { transport: "http", url: `${origin}/mcp`, ...extra } } }));
  const activate = async () => { await setExtensionState(root, "mcp:fixture", "trust", options); await setExtensionState(root, "mcp:fixture", "enable", options); };
  await configure(); await activate();
  const authorize = async (login) => { const response = await fetch(login.authorizationUrl, { redirect: "manual" }); assert.equal(response.status, 302); const result = await fetch(response.headers.get("location")); assert.equal(result.status, 200); return login.completion; };
  try { await run({ root, options, origin, temporary, seen, configure, activate, authorize, tokenStarted, releaseToken }); }
  finally { releaseToken(); await new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }); await fs.rm(temporary, { recursive: true, force: true }); }
}

test("OAuth does real metadata discovery, registration, S256 code exchange, encrypted persistence and authenticated MCP requests", async () => fixture(async ({ root, options, seen, authorize }) => {
  assert.equal((await getMcpOAuthStatus(root, "fixture", options)).authenticated, false);
  const login = await beginMcpOAuthLogin(root, "fixture", options);
  const url = new URL(login.authorizationUrl); assert.equal(url.searchParams.get("code_challenge_method"), "S256"); assert.equal(url.searchParams.get("scope"), "tools:read"); assert.equal(seen.tokenRequests.length, 0);
  assert.equal((await authorize(login)).authenticated, true);
  assert.equal(seen.registrations[0].redirect_uris[0], login.redirectUri);
  const [file] = (await fs.readdir(options.authStateDir)).filter((name) => name.endsWith(".json")); const encrypted = await fs.readFile(path.join(options.authStateDir, file), "utf8");
  assert.ok(!encrypted.includes(seen.tokens[0])); assert.ok(!encrypted.includes("opaque-refresh"));
  const connection = await connectMcp(root, "fixture", options);
  try { assert.equal((await connection.listTools())[0].name, "fixture"); assert.equal((await connection.callTool("fixture", {})).content[0].text, "verified fixture tool"); } finally { await connection.close(); }
  assert.ok(seen.requests.filter((entry) => entry.path === "/mcp" && entry.method !== "GET").every((entry) => entry.authorization === `Bearer ${seen.tokens[0]}`));
  await logoutMcpOAuth(root, "fixture", options); assert.equal((await getMcpOAuthStatus(root, "fixture", options)).authenticated, false);
}));

test("OAuth rejects wrong state, duplicate state, malformed issuer and hostile Host before accepting the genuine callback", async () => fixture(async ({ root, options, authorize }) => {
  const login = await beginMcpOAuthLogin(root, "fixture", options); const url = new URL(login.redirectUri); const auth = new URL(login.authorizationUrl); url.searchParams.set("code", "fixture-authorization-code");
  url.searchParams.set("state", "wrong"); assert.equal((await fetch(url)).status, 400);
  url.searchParams.set("state", auth.searchParams.get("state")); url.searchParams.append("state", "duplicate"); assert.equal((await fetch(url)).status, 400);
  url.searchParams.delete("state"); url.searchParams.set("state", auth.searchParams.get("state")); url.searchParams.set("iss", "::::"); assert.equal((await fetch(url)).status, 400);
  url.searchParams.delete("iss");
  const hostileStatus = await new Promise((resolve, reject) => { const request = http.get(url, { headers: { host: "evil.example" } }, (response) => { response.resume(); response.once("end", () => resolve(response.statusCode)); }); request.once("error", reject); });
  assert.equal(hostileStatus, 400);
  assert.equal((await authorize(login)).authenticated, true);
}));

test("OAuth refuses wrong resource, issuer and missing PKCE before consent", async () => {
  for (const [behavior, expected] of [[{ wrongResource: true }, /resource metadata does not match/], [{ wrongIssuer: true }, /issuer does not match/], [{ noPkce: true }, /S256 PKCE/]]) await fixture(async ({ root, options, seen }) => { await assert.rejects(beginMcpOAuthLogin(root, "fixture", options), expected); assert.equal(seen.registrations.length, 0); }, behavior);
});

test("OAuth supports protected-resource well-known and path-appended OIDC discovery fallbacks", async () => fixture(async ({ root, options, seen, authorize }) => {
  await authorize(await beginMcpOAuthLogin(root, "fixture", options));
  assert.ok(seen.requests.some((entry) => entry.path === "/.well-known/oauth-protected-resource/mcp"));
  assert.ok(seen.requests.some((entry) => entry.path === "/tenant/.well-known/openid-configuration"));
}, { noChallenge: true, oidcFallback: true }));

test("OAuth refreshes expiring tokens before sending an MCP request and rotates encrypted refresh tokens", async () => fixture(async ({ root, options, seen, authorize }) => {
  await authorize(await beginMcpOAuthLogin(root, "fixture", options)); const connection = await connectMcp(root, "fixture", options);
  try { await connection.listTools(); assert.equal(seen.refreshes, 1); assert.equal(seen.tokenRequests[1].get("refresh_token"), "opaque-refresh-value-one"); } finally { await connection.close(); }
}, { initialExpires: 1 }));

test("OAuth refreshes and retries a read-only list once, never replays a tool side effect", async () => {
  await fixture(async ({ root, options, seen, authorize }) => { await authorize(await beginMcpOAuthLogin(root, "fixture", options)); const connection = await connectMcp(root, "fixture", options); try { await connection.listTools(); assert.equal(seen.refreshes, 1); } finally { await connection.close(); } }, { rejectFirstToken: true });
  await fixture(async ({ root, options, seen, authorize }) => { await authorize(await beginMcpOAuthLogin(root, "fixture", options)); const connection = await connectMcp(root, "fixture", options); try { await assert.rejects(connection.callTool("fixture", {}), (error) => error.code === "MCP_AUTH_REQUIRED"); assert.equal(seen.toolCalls, 1); assert.equal(seen.refreshes, 0); } finally { await connection.close(); } }, { rejectTool: true });
});

test("OAuth secrets echoed by an MCP server are removed from tool results", async () => fixture(async ({ root, options, authorize }) => {
  await authorize(await beginMcpOAuthLogin(root, "fixture", options)); const connection = await connectMcp(root, "fixture", options);
  try { assert.equal((await connection.callTool("fixture", {})).content[0].text, "[REDACTED]"); } finally { await connection.close(); }
}, { echoToken: true }));

test("OAuth cancellation closes its loopback listener and stores no grant", async () => fixture(async ({ root, options }) => {
  const controller = new AbortController(); const login = await beginMcpOAuthLogin(root, "fixture", { ...options, signal: controller.signal }); controller.abort();
  await assert.rejects(login.completion, { name: "AbortError" }); await assert.rejects(fetch(login.redirectUri));
  assert.equal((await getMcpOAuthStatus(root, "fixture", options)).authenticated, false);
}));

test("OAuth refuses authorization when OS encryption is unavailable or HTTPS requirements are violated", async () => fixture(async ({ root, options, seen }) => {
  await assert.rejects(beginMcpOAuthLogin(root, "fixture", { ...options, authCipher: { kind: "unavailable", async encrypt() { throw new Error("OS encryption unavailable"); }, async decrypt() { throw new Error("unavailable"); } } }), /OS encryption unavailable/);
  assert.equal(seen.requests.length, 0);
  await assert.rejects(beginMcpOAuthLogin(root, "fixture", { ...options, allowLoopbackOAuthHttp: false }), /HTTPS/);
}));

test("OAuth requires current extension trust and configuration binding; old tokens are not reused after edits", async () => fixture(async ({ root, options, authorize, configure, activate }) => {
  const login = await beginMcpOAuthLogin(root, "fixture", options); await configure({ timeoutMs: 5000 });
  await assert.rejects(authorize(login), /untrusted|configuration changed/);
  await activate(); await authorize(await beginMcpOAuthLogin(root, "fixture", options)); await configure({ timeoutMs: 6000 }); await activate();
  assert.equal((await getMcpOAuthStatus(root, "fixture", options)).authenticated, false);
  await assert.rejects(connectMcp(root, "fixture", options), /requires authorization/);
}));

test("OAuth can use a pre-registered public client and reports unsupported registration clearly", async () => {
  await fixture(async ({ root, options, configure, activate, authorize, seen }) => { await configure({ oauth: { clientId: "already-registered-client" } }); await activate(); await authorize(await beginMcpOAuthLogin(root, "fixture", options)); assert.equal(seen.authorization.searchParams.get("client_id"), "already-registered-client"); assert.equal(seen.registrations.length, 0); }, { noRegistration: true });
  await fixture(async ({ root, options }) => { await assert.rejects(beginMcpOAuthLogin(root, "fixture", options), /pre-registered clientId/); }, { noRegistration: true });
});

test("Windows OAuth cipher round-trips through actual current-user DPAPI", { skip: process.platform !== "win32" }, async () => {
  const cipher = new WindowsOAuthCipher(); const plaintext = Buffer.from("HIVE local DPAPI verification, no credentials"); const encrypted = await cipher.encrypt(plaintext);
  assert.ok(!Buffer.from(encrypted).includes(plaintext)); assert.deepEqual(Buffer.from(await cipher.decrypt(encrypted)), plaintext);
});

test("OAuth cancellation after receiving a callback aborts a held token response without publishing a grant", async () => fixture(async ({ root, options, authorize, tokenStarted, releaseToken }) => {
  const login = await beginMcpOAuthLogin(root, "fixture", options); const finished = authorize(login); void finished.catch(() => undefined);
  await tokenStarted; await login.cancel(); releaseToken();
  await assert.rejects(finished, { name: "AbortError" }); assert.equal((await getMcpOAuthStatus(root, "fixture", options)).authenticated, false);
}, { holdToken: true }));

test("OAuth logout from another process invalidates a pending login even if the token response arrives later", async () => fixture(async ({ root, options, authorize, tokenStarted, releaseToken }) => {
  const login = await beginMcpOAuthLogin(root, "fixture", options); const finished = authorize(login); void finished.catch(() => undefined); await tokenStarted;
  const script = `import {logoutMcpOAuth} from './dist/extensions/oauth.js'; await logoutMcpOAuth(process.argv[1], 'fixture', JSON.parse(process.argv[2]));`;
  await promisify(execFile)(process.execPath, ["--input-type=module", "-e", script, root, JSON.stringify({ trustStateDir: options.trustStateDir, authStateDir: options.authStateDir })], { cwd: path.resolve("."), windowsHide: true });
  releaseToken(); await assert.rejects(finished, /invalidated by logout/); assert.equal((await getMcpOAuthStatus(root, "fixture", options)).authenticated, false);
  assert.ok((await fs.readdir(options.authStateDir)).some((name) => name.endsWith(".generation")));
}, { holdToken: true }));

test("OAuth public network policy rejects private, mapped, reserved, documentation and mixed DNS addresses", async () => {
  for (const address of ["0.0.0.0", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.169.254", "172.16.0.1", "192.0.0.1", "192.0.2.1", "192.168.1.1", "198.18.0.1", "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1", "::", "::1", "::ffff:127.0.0.1", "64:ff9b::a00:1", "2001:db8::1", "2002:0a00:0001::1", "3fff::1", "fc00::1", "fe80::1", "ff02::1"]) assert.equal(publicOAuthAddress(address), false, address);
  for (const address of ["1.1.1.1", "8.8.8.8", "93.184.216.34", "2001:4860:4860::8888", "2606:4700:4700::1111"]) assert.equal(publicOAuthAddress(address), true, address);
  for (const value of ["https://127.1/metadata", "https://0x7f000001/metadata", "https://[::ffff:127.0.0.1]/metadata", "https://169.254.169.254/metadata"]) assert.throws(() => validateOAuthUrl(value, {}), /private, loopback or reserved/);
  await assert.rejects(resolveOAuthAddress("https://attacker.example/metadata", {}, undefined, async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.1", family: 4 }]), /private, loopback or reserved/);
  assert.equal((await resolveOAuthAddress("https://private.example/metadata", { allowPrivateOAuthHosts: true }, undefined, async () => [{ address: "10.0.0.1", family: 4 }])).address, "10.0.0.1");
});

test("OAuth socket uses the one validated IP, retains TLS authority and cannot re-resolve after validation", async (t) => {
  let resolutions = 0; let captured;
  t.mock.method(https, "request", (url, options, callback) => {
    captured = { url: String(url), options }; const request = new EventEmitter(); request.end = () => { const response = new PassThrough(); response.statusCode = 200; response.headers = { "content-type": "application/json" }; callback(response); response.end('{"ok":true}'); }; return request;
  });
  const result = await oauthNetworkRequest("https://oauth.example:8443/token", { method: "POST", headers: { authorization: "Basic fixture-value" }, body: "grant_type=authorization_code" }, async () => { resolutions += 1; return [{ address: resolutions === 1 ? "93.184.216.34" : "127.0.0.1", family: 4 }]; });
  assert.equal(resolutions, 1); assert.equal(captured.options.hostname, "93.184.216.34"); assert.equal(captured.options.headers.host, "oauth.example:8443"); assert.equal(captured.options.servername, "oauth.example"); assert.equal(captured.options.agent, false); assert.equal(captured.options.rejectUnauthorized, undefined); assert.equal(result.bytes.toString(), '{"ok":true}');
});
