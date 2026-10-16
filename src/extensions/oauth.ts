import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type Server } from "node:http";
import { discoverExtensions, requireActive } from "./catalog.js";
import { cancelled, object, string, timeout } from "./io.js";
import { OAuthStore, type OAuthRecord } from "./oauth-storage.js";
import { oauthNetworkRequest, resolveOAuthAddress, validateOAuthUrl } from "../security/oauth-network.js";
import type { ExtensionOptions, McpServerDescriptor, RequestOptions } from "./types.js";

type HttpServer = Extract<McpServerDescriptor, { transport: "http" }>;
export type McpOAuthOptions = ExtensionOptions & RequestOptions;
export interface McpOAuthStatus { serverId: string; authenticated: boolean; issuer?: string; resource?: string; scopes: string[]; expiresAt?: number; expired?: boolean }
export interface McpOAuthLogin { authorizationUrl: string; redirectUri: string; issuer: string; resource: string; completion: Promise<McpOAuthStatus>; cancel(): Promise<void> }
interface Discovery { resource: string; issuer: string; authorizationEndpoint: string; tokenEndpoint: string; registrationEndpoint?: string; revocationEndpoint?: string; methods: string[]; scopes: string[] }

/** Deliberately contains no challenge, response body, authorization code, or token. */
export class McpAuthorizationRequiredError extends Error {
  readonly code = "MCP_AUTH_REQUIRED";
  constructor(readonly serverId: string, readonly insufficientScope = false) {
    super(`MCP ${serverId} ${insufficientScope ? "requires additional authorization" : "requires authorization"}; run /mcp login ${serverId}. The operation was not replayed`);
    this.name = "McpAuthorizationRequiredError";
  }
}

function endpoint(value: unknown, label: string, options: McpOAuthOptions): string {
  return validateOAuthUrl(string(value, label), options).href;
}
function canonicalResource(value: string): string {
  const url = new URL(value);
  if (url.hash || url.username || url.password) throw new Error("MCP OAuth resource URL is invalid");
  return url.pathname === "/" && !url.search ? url.origin : url.href;
}
function matchesIssuer(value: string, issuer: string): boolean { try { return new URL(value).href === issuer; } catch { return false; } }
function scopeList(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 128 || value.some((entry) => typeof entry !== "string" || !/^[\x21\x23-\x5b\x5d-\x7e]{1,256}$/u.test(entry))) throw new Error(`${label} must contain bounded OAuth scope strings`);
  return [...new Set(value as string[])];
}
function bearerParameters(header: string | null): Record<string, string> {
  if (!header || header.length > 16_384) return {};
  // Only parse the Bearer challenge, never parameters belonging to another scheme.
  const start = /(?:^|,)\s*Bearer\s+/iu.exec(header); if (!start) return {};
  const remaining = header.slice(start.index + start[0].length); const result: Record<string, string> = {};
  const pattern = /^\s*([A-Za-z][A-Za-z0-9_]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))\s*(?:,|$)/u;
  let rest = remaining;
  while (rest) { const match = pattern.exec(rest); if (!match) break; const key = match[1].toLowerCase(); if (key in result) throw new Error("OAuth Bearer challenge contains duplicate parameters"); result[key] = match[2]?.replace(/\\(.)/gu, "$1") ?? match[3]; rest = rest.slice(match[0].length); }
  return result;
}

async function request(url: string, init: RequestInit, options: McpOAuthOptions, headersOnly = false): Promise<{ status: number; headers: Headers; value?: Record<string, unknown> }> {
  if (options.signal?.aborted) throw cancelled();
  const controller = new AbortController(); const abort = () => controller.abort();
  const timer = setTimeout(abort, timeout(options.timeoutMs)); options.signal?.addEventListener("abort", abort, { once: true });
  try {
    const response = await oauthNetworkRequest(url, { ...options, method: init.method, headers: Object.fromEntries(new Headers(init.headers)), ...(init.body ? { body: String(init.body) } : {}), signal: controller.signal, headersOnly });
    if (headersOnly || response.status < 200 || response.status >= 300) return { status: response.status, headers: response.headers };
    let value: Record<string, unknown>;
    try { value = object(JSON.parse(response.bytes.toString("utf8")), "OAuth response"); } catch { throw new Error("OAuth endpoint returned invalid JSON"); }
    return { status: response.status, headers: response.headers, value };
  } catch (error) {
    if (options.signal?.aborted) throw cancelled();
    if (controller.signal.aborted) throw new Error("OAuth network request timed out");
    if (error instanceof Error && /^OAuth (?:endpoint|endpoints|hostname)/u.test(error.message)) throw error;
    throw new Error("OAuth network request failed; redirects and ambient credentials are not allowed");
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
}

async function serverFor(cwd: string, id: string, options: McpOAuthOptions): Promise<{ root: string; server: HttpServer }> {
  const catalog = await discoverExtensions(cwd, options); const exact = catalog.servers.find((entry) => entry.id === id || entry.id === `mcp:${id}`);
  const matches = exact ? [exact] : catalog.servers.filter((entry) => entry.name === id);
  if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous MCP server: ${id}` : `Unknown MCP server: ${id}`);
  const server = matches[0]; if (server.transport !== "http") throw new Error("MCP OAuth requires an HTTP server; stdio credentials use envRefs");
  if (server.bearerTokenEnv) throw new Error("MCP server uses bearerTokenEnv; remove it before selecting OAuth");
  return { root: catalog.root, server };
}

async function discover(server: HttpServer, options: McpOAuthOptions): Promise<Discovery> {
  const resource = canonicalResource(server.url); const resourceUrl = new URL(resource);
  // An unauthenticated GET only discovers the challenge; it cannot execute an MCP tool.
  const challenge = await request(server.url, { method: "GET", headers: { accept: "application/json" } }, options, true);
  const parameters = bearerParameters(challenge.headers.get("www-authenticate"));
  const candidates = parameters.resource_metadata ? [endpoint(parameters.resource_metadata, "Protected resource metadata URL", options)] : [...new Set([`${resourceUrl.origin}/.well-known/oauth-protected-resource${resourceUrl.pathname === "/" ? "" : resourceUrl.pathname}`, `${resourceUrl.origin}/.well-known/oauth-protected-resource`])];
  let metadata: Record<string, unknown> | undefined;
  for (const candidate of candidates) {
    const response = await request(endpoint(candidate, "Protected resource metadata URL", options), { headers: { accept: "application/json" } }, options);
    if (response.status === 404) continue;
    if (!response.value) throw new Error(`Protected resource discovery failed (${response.status})`);
    metadata = response.value; break;
  }
  if (!metadata) throw new Error("MCP server does not publish protected resource metadata");
  if (typeof metadata.resource !== "string" || canonicalResource(metadata.resource) !== resource) throw new Error("Protected resource metadata does not match the configured MCP resource");
  if (!Array.isArray(metadata.authorization_servers) || metadata.authorization_servers.length !== 1) throw new Error("MCP OAuth requires exactly one advertised authorization server; configure a server with an unambiguous issuer");
  const issuer = endpoint(metadata.authorization_servers[0], "OAuth issuer", options); const issuerUrl = new URL(issuer);
  if (issuerUrl.search) throw new Error("OAuth issuer must not contain a query");
  const suffix = issuerUrl.pathname === "/" ? "" : issuerUrl.pathname.replace(/\/$/u, "");
  const asCandidates = [...new Set([`${issuerUrl.origin}/.well-known/oauth-authorization-server${suffix}`, `${issuerUrl.origin}/.well-known/openid-configuration${suffix}`, ...(suffix ? [`${issuerUrl.origin}${suffix}/.well-known/openid-configuration`] : [])])];
  let authorization: Record<string, unknown> | undefined;
  for (const candidate of asCandidates) {
    const response = await request(candidate, { headers: { accept: "application/json" } }, options);
    if (response.status === 404) continue;
    if (!response.value) throw new Error(`OAuth authorization server discovery failed (${response.status})`);
    authorization = response.value; break;
  }
  if (!authorization) throw new Error("OAuth authorization server metadata is unavailable");
  if (typeof authorization.issuer !== "string" || new URL(authorization.issuer).href !== issuer) throw new Error("OAuth metadata issuer does not match the resource's advertised issuer");
  if (!Array.isArray(authorization.code_challenge_methods_supported) || !authorization.code_challenge_methods_supported.includes("S256")) throw new Error("OAuth server does not advertise mandatory S256 PKCE support");
  if (authorization.response_types_supported !== undefined && (!Array.isArray(authorization.response_types_supported) || !authorization.response_types_supported.includes("code"))) throw new Error("OAuth server does not support authorization code flow");
  const challengedScopes = parameters.scope?.split(/ +/u).filter(Boolean);
  return { resource, issuer, authorizationEndpoint: endpoint(authorization.authorization_endpoint, "OAuth authorization endpoint", options), tokenEndpoint: endpoint(authorization.token_endpoint, "OAuth token endpoint", options), ...(authorization.registration_endpoint ? { registrationEndpoint: endpoint(authorization.registration_endpoint, "OAuth registration endpoint", options) } : {}), ...(authorization.revocation_endpoint ? { revocationEndpoint: endpoint(authorization.revocation_endpoint, "OAuth revocation endpoint", options) } : {}), methods: authorization.token_endpoint_auth_methods_supported === undefined ? ["client_secret_basic"] : scopeList(authorization.token_endpoint_auth_methods_supported, "Token authentication methods"), scopes: challengedScopes ? scopeList(challengedScopes, "Challenged scopes") : server.oauth?.scopes ? scopeList(server.oauth.scopes, "Configured scopes") : scopeList(metadata.scopes_supported, "Protected resource scopes") };
}

function status(server: HttpServer, record?: OAuthRecord): McpOAuthStatus {
  return { serverId: server.id, authenticated: !!record, scopes: record?.scopes ?? [], ...(record ? { issuer: record.issuer, resource: record.resource, ...(record.expiresAt === undefined ? {} : { expiresAt: record.expiresAt, expired: record.expiresAt <= Date.now() }) } : {}) };
}
function credential(value: unknown, label: string): string { const result = string(value, label, 16_384); if (/\s/u.test(result)) throw new Error(`${label} contains invalid whitespace`); return result; }
function tokenRecord(value: Record<string, unknown>, previous: Omit<OAuthRecord, "accessToken" | "refreshToken" | "expiresAt"> & Partial<Pick<OAuthRecord, "refreshToken">>): OAuthRecord {
  if (typeof value.token_type !== "string" || value.token_type.toLowerCase() !== "bearer") throw new Error("OAuth token endpoint did not issue a Bearer token");
  if (value.expires_in !== undefined && (typeof value.expires_in !== "number" || !Number.isFinite(value.expires_in) || value.expires_in <= 0 || value.expires_in > 31_536_000)) throw new Error("OAuth token expiry is invalid");
  const scopes = value.scope === undefined ? previous.scopes : scopeList(string(value.scope, "Granted OAuth scopes").split(/ +/u), "Granted OAuth scopes");
  return { ...previous, accessToken: credential(value.access_token, "OAuth access token"), ...(value.refresh_token === undefined ? previous.refreshToken ? { refreshToken: previous.refreshToken } : {} : { refreshToken: credential(value.refresh_token, "OAuth refresh token") }), ...(typeof value.expires_in === "number" ? { expiresAt: Date.now() + value.expires_in * 1000 } : {}), scopes };
}
async function tokenRequest(record: Pick<OAuthRecord, "clientId" | "clientSecret" | "tokenEndpointAuthMethod" | "tokenEndpoint" | "resource">, params: URLSearchParams, options: McpOAuthOptions): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  params.set("resource", record.resource);
  if (record.tokenEndpointAuthMethod === "client_secret_basic") {
    if (!record.clientSecret) throw new Error("OAuth client secret is unavailable");
    const encode = (value: string) => new URLSearchParams({ v: value }).toString().slice(2);
    headers.authorization = `Basic ${Buffer.from(`${encode(record.clientId)}:${encode(record.clientSecret)}`).toString("base64")}`;
  } else { params.set("client_id", record.clientId); if (record.tokenEndpointAuthMethod === "client_secret_post") { if (!record.clientSecret) throw new Error("OAuth client secret is unavailable"); params.set("client_secret", record.clientSecret); } }
  const response = await request(endpoint(record.tokenEndpoint, "OAuth token endpoint", options), { method: "POST", headers, body: params }, options);
  if (!response.value) throw new Error(`OAuth token exchange failed (${response.status}); authorize again if the grant expired`);
  return response.value;
}

export async function getMcpOAuthStatus(cwd: string, id: string, options: McpOAuthOptions = {}): Promise<McpOAuthStatus> {
  const { root, server } = await serverFor(cwd, id, options); return status(server, await new OAuthStore(root, server, options).read());
}
export async function logoutMcpOAuth(cwd: string, id: string, options: McpOAuthOptions = {}): Promise<void> {
  const { root, server } = await serverFor(cwd, id, options); const store = new OAuthStore(root, server, options);
  await store.locked(async () => { await store.invalidate(); await store.remove(); });
}

function closeServer(server: Server): Promise<void> { return new Promise((resolve) => { server.close(() => resolve()); server.closeAllConnections(); }); }

/** Explicit login only. Never opens a browser, copies another client's auth, or runs a tool. */
export async function beginMcpOAuthLogin(cwd: string, id: string, options: McpOAuthOptions = {}): Promise<McpOAuthLogin> {
  const outerSignal = options.signal; const loginController = new AbortController();
  const forwardAbort = () => loginController.abort();
  outerSignal?.addEventListener("abort", forwardAbort, { once: true }); if (outerSignal?.aborted) forwardAbort();
  options = { ...options, signal: loginController.signal };
  let handedOff = false;
  try {
  const { root, server } = await serverFor(cwd, id, options); requireActive(server);
  if (options.signal?.aborted) throw cancelled();
  const store = new OAuthStore(root, server, options); const generation = await store.generation(); await store.available(); const discovered = await discover(server, options);
  // Check all advertised destinations before registration or displaying consent.
  // Every actual request resolves/checks again and pins its own numeric socket.
  for (const value of [discovered.authorizationEndpoint, discovered.tokenEndpoint, discovered.registrationEndpoint, discovered.revocationEndpoint]) if (value) await resolveOAuthAddress(value, options, options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(timeout(options.timeoutMs))]) : AbortSignal.timeout(timeout(options.timeoutMs)));
  const verifier = randomBytes(32).toString("base64url"); const state = randomBytes(32).toString("base64url"); const callbackPath = "/oauth/callback";
  let resolveCode!: (code: string) => void; let rejectCode!: (error: Error) => void;
  const codePromise = new Promise<string>((resolve, reject) => { resolveCode = resolve; rejectCode = reject; }); void codePromise.catch(() => undefined);
  let redirectUri = ""; let settled = false;
  const listener = createServer((req, res) => {
    res.setHeader("content-type", "text/plain; charset=utf-8"); res.setHeader("cache-control", "no-store"); res.setHeader("content-security-policy", "default-src 'none'; frame-ancestors 'none'"); res.setHeader("referrer-policy", "no-referrer");
    let target: URL;
    try { target = new URL(req.url ?? "/", redirectUri || "http://127.0.0.1"); } catch { res.writeHead(400); res.end("Invalid OAuth callback URL"); return; }
    if (req.method !== "GET" || req.headers.host !== new URL(redirectUri).host || target.origin !== new URL(redirectUri).origin || target.pathname !== callbackPath || req.headers.origin || settled) { res.writeHead(400); res.end("Invalid OAuth callback"); return; }
    const receivedState = target.searchParams.getAll("state"); const code = target.searchParams.getAll("code"); const receivedIssuer = target.searchParams.getAll("iss");
    if (receivedState.length !== 1 || Buffer.byteLength(receivedState[0]) !== Buffer.byteLength(state) || !timingSafeEqual(Buffer.from(receivedState[0]), Buffer.from(state)) || (receivedIssuer.length && (receivedIssuer.length !== 1 || !matchesIssuer(receivedIssuer[0], discovered.issuer)))) { res.writeHead(400); res.end("Invalid OAuth state or issuer"); return; }
    if (target.searchParams.has("error")) { settled = true; res.writeHead(400); res.end("Authorization was declined or failed. Return to HIVE."); rejectCode(new Error("OAuth authorization was declined or failed")); return; }
    if (code.length !== 1 || !code[0] || code[0].length > 16_384 || /[\u0000-\u0020\u007f]/u.test(code[0])) { res.writeHead(400); res.end("Invalid OAuth authorization response"); return; }
    settled = true; res.end("Authorization received. Return to HIVE."); resolveCode(code[0]);
  });
  listener.maxConnections = 8; listener.requestTimeout = 5_000; listener.headersTimeout = 5_000;
  try {
    await new Promise<void>((resolve, reject) => { listener.once("error", reject); listener.listen(server.oauth?.redirectPort ?? 0, "127.0.0.1", () => { listener.off("error", reject); resolve(); }); });
    const address = listener.address(); if (!address || typeof address === "string") throw new Error("OAuth loopback listener has no address");
    redirectUri = `http://127.0.0.1:${address.port}${callbackPath}`;
    let clientId = server.oauth?.clientId; let clientSecret = server.oauth?.clientSecretEnv ? process.env[server.oauth.clientSecretEnv] : undefined; let method: OAuthRecord["tokenEndpointAuthMethod"] = "none";
    if (server.oauth?.clientSecretEnv && !clientSecret) throw new Error(`OAuth client secret environment variable is missing: ${server.oauth.clientSecretEnv}`);
    if (clientId) {
      string(clientId, "OAuth client id", 4096);
      if (clientSecret) { method = discovered.methods.includes("client_secret_basic") ? "client_secret_basic" : discovered.methods.includes("client_secret_post") ? "client_secret_post" : (() => { throw new Error("OAuth server does not support a configured client-secret authentication method"); })(); }
      else if (!discovered.methods.includes("none")) throw new Error("OAuth server does not advertise public-client token authentication");
    } else {
      if (!discovered.registrationEndpoint) throw new Error("OAuth server requires a pre-registered clientId; automatic client registration is unavailable");
      if (!discovered.methods.includes("none")) throw new Error("OAuth server does not advertise public-client token authentication; configure a pre-registered confidential client");
      const registration = await request(discovered.registrationEndpoint, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify({ client_name: "HIVE CLI", redirect_uris: [redirectUri], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) }, options);
      if (!registration.value) throw new Error(`OAuth dynamic client registration failed (${registration.status}); configure a pre-registered clientId`);
      clientId = string(registration.value.client_id, "Registered OAuth client id", 4096);
      if (registration.value.token_endpoint_auth_method !== undefined && registration.value.token_endpoint_auth_method !== "none") throw new Error("OAuth registration did not issue a public client");
      if (registration.value.redirect_uris !== undefined && (!Array.isArray(registration.value.redirect_uris) || !registration.value.redirect_uris.includes(redirectUri))) throw new Error("OAuth registration redirect URI does not match the bound loopback listener");
      // No registration access token/client secret is needed or retained for a public client.
    }
    const authorization = new URL(discovered.authorizationEndpoint);
    for (const key of ["response_type", "client_id", "redirect_uri", "state", "code_challenge", "code_challenge_method", "resource", "scope"]) authorization.searchParams.delete(key);
    const params = { response_type: "code", client_id: clientId, redirect_uri: redirectUri, state, code_challenge: createHash("sha256").update(verifier).digest("base64url"), code_challenge_method: "S256", resource: discovered.resource };
    for (const [key, value] of Object.entries(params)) authorization.searchParams.set(key, value);
    if (discovered.scopes.length) authorization.searchParams.set("scope", discovered.scopes.join(" "));
    const abort = () => { loginController.abort(); settled = true; rejectCode(cancelled()); void closeServer(listener); };
    options.signal?.addEventListener("abort", abort, { once: true }); if (options.signal?.aborted) abort();
    const timer = setTimeout(() => { settled = true; rejectCode(new Error("OAuth authorization timed out after 120 seconds")); loginController.abort(); void closeServer(listener); }, 120_000);
    const completion = (async () => {
      try {
        const code = await codePromise; if (options.signal?.aborted) throw cancelled();
        // A config/trust change while consent is open invalidates this login.
        const current = await serverFor(root, server.id, options); requireActive(current.server);
        if (current.server.fingerprint !== server.fingerprint) throw new Error("MCP configuration changed during OAuth authorization; authorize the current configuration again");
        const base = { version: 1 as const, binding: store.binding, generation, issuer: discovered.issuer, resource: discovered.resource, clientId, ...(clientSecret ? { clientSecret } : {}), tokenEndpoint: discovered.tokenEndpoint, ...(discovered.revocationEndpoint ? { revocationEndpoint: discovered.revocationEndpoint } : {}), tokenEndpointAuthMethod: method, scopes: discovered.scopes };
        const value = await tokenRequest(base, new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: verifier }), options);
        const record = tokenRecord(value, base);
        await store.locked(async () => {
          if (options.signal?.aborted) throw cancelled();
          const latest = await serverFor(root, server.id, options); requireActive(latest.server);
          if (latest.server.fingerprint !== server.fingerprint) throw new Error("MCP configuration changed during OAuth authorization; authorize the current configuration again");
          await store.write(record, options.signal);
        }); return status(server, record);
      } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); outerSignal?.removeEventListener("abort", forwardAbort); await closeServer(listener); }
    })();
    void completion.catch(() => undefined);
    handedOff = true;
    return { authorizationUrl: authorization.href, redirectUri, issuer: discovered.issuer, resource: discovered.resource, completion, async cancel() { abort(); await completion.catch(() => undefined); } };
  } catch (error) { await closeServer(listener); throw error; }
  } finally { if (!handedOff) outerSignal?.removeEventListener("abort", forwardAbort); }
}

/** Transport credential source; tokens stay confined to this resource/config binding. */
export class McpOAuthCredentials {
  private readonly store: OAuthStore;
  constructor(root: string, private readonly server: HttpServer, private readonly options: McpOAuthOptions, private readonly secrets: string[]) { this.store = new OAuthStore(root, server, options); }
  private remember(record: OAuthRecord): void { for (const value of [record.accessToken, record.refreshToken, record.clientSecret]) if (value && !this.secrets.includes(value)) this.secrets.push(value); }
  async accessToken(options: RequestOptions = {}, rejectedToken?: string): Promise<string | undefined> {
    const merged = { ...this.options, ...options }; const record = await this.store.read(); if (!record) return undefined;
    this.remember(record);
    const needsRefresh = record.expiresAt !== undefined && record.expiresAt <= Date.now() + 30_000;
    if (!needsRefresh && (!rejectedToken || rejectedToken !== record.accessToken)) return record.accessToken;
    if (!record.refreshToken) throw new McpAuthorizationRequiredError(this.server.id);
    return this.store.locked(async () => {
      const latest = await this.store.read(); if (!latest) throw new McpAuthorizationRequiredError(this.server.id); this.remember(latest);
      if (latest.accessToken !== record.accessToken) return latest.accessToken;
      if (!latest.refreshToken) throw new McpAuthorizationRequiredError(this.server.id);
      const result = await tokenRequest(latest, new URLSearchParams({ grant_type: "refresh_token", refresh_token: latest.refreshToken }), merged);
      const { accessToken: _oldAccess, expiresAt: _oldExpiry, ...base } = latest;
      const refreshed = tokenRecord(result, base); this.remember(refreshed); await this.store.write(refreshed, merged.signal); return refreshed.accessToken;
    });
  }
}
