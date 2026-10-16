import { isIP } from "node:net";
import { containsKnownSecret } from "../security/secrets.js";
import type { ProviderConfig } from "./types.js";
import { createCodexAppServer, type CodexAppServerOptions } from "./codex-app-server.js";

// Public OpenRouter metadata is about 0.8 MiB for 465 models; allow bounded catalog growth.
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_MODELS = 4096;
const MODELS_PER_PAGE = 512;
const MAX_PAGES = 16;
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\uD800-\uDFFF]/u;

class ModelDiscoveryError extends Error {}

function fail(message: string): never { throw new ModelDiscoveryError(message); }

export function providerModelsEndpoint(config: ProviderConfig): URL {
  let defaultBase: string | undefined;
  switch (config.kind) {
    case "openai": defaultBase = "https://api.openai.com/v1"; break;
    case "openrouter": defaultBase = "https://openrouter.ai/api/v1"; break;
    case "anthropic": defaultBase = "https://api.anthropic.com/v1"; break;
    case "google": defaultBase = "https://generativelanguage.googleapis.com/v1beta"; break;
    case "ollama": defaultBase = "http://127.0.0.1:11434"; break;
    case "openai-compatible": case "local": case "custom": break;
    case "oauth": return fail("Model discovery is not supported for OAuth provider adapters.");
    case "chatgpt-subscription": return fail("ChatGPT subscription model discovery uses the installed Codex account service.");
    default: { const exhaustive: never = config.kind; return exhaustive; }
  }
  const base = config.baseUrl ?? defaultBase;
  if (!base) return fail("Model discovery requires an explicit provider base URL.");
  if (typeof base !== "string" || base.length > 2048 || base.trim() !== base || UNSAFE_TEXT.test(base)
    || base.includes("?") || base.includes("#") || base.includes("\\")) {
    return fail("Provider base URL must not contain credentials, query, fragment, or control characters.");
  }
  let url: URL;
  try { url = new URL(base); } catch { return fail("Provider base URL is invalid."); }
  if (url.username || url.password) return fail("Provider base URL must not contain credentials.");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || (isIP(host) === 4 && host.startsWith("127."));
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    return fail("Provider base URL requires HTTPS or loopback HTTP (localhost, 127/8, or ::1).");
  }
  if ((config.kind === "anthropic" || config.kind === "google") && defaultBase) {
    const canonical = new URL(defaultBase);
    const normalized = url.href.replace(/\/+$/, "");
    if (normalized !== canonical.origin && normalized !== defaultBase) {
      return fail("This provider adapter does not support a custom base URL.");
    }
    url = canonical;
  }
  // OpenCode publishes a shared catalog outside its protocol-specific inference base.
  url.pathname = config.kind === "openai-compatible" && url.origin === "https://opencode.ai" && url.pathname.replace(/\/+$/, "") === "/inference/openai/v1"
    ? "/inference/v1/models"
    : `${url.pathname.replace(/\/+$/, "")}/${config.kind === "ollama" ? "api/tags" : "models"}`;
  if (config.kind === "anthropic") url.searchParams.set("limit", String(MODELS_PER_PAGE));
  if (config.kind === "google") url.searchParams.set("pageSize", String(MODELS_PER_PAGE));
  return url;
}

function authentication(config: ProviderConfig): { headers: Record<string, string>; secret?: string } {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (config.authType === "none") return { headers };
  if (config.authType === "oauth") return fail("Model discovery requires an explicit API-key or bearer environment reference.");
  const nativeApiKey = config.kind === "anthropic" || config.kind === "google";
  if (nativeApiKey && !config.apiKeyEnv) return fail("Native provider model discovery requires apiKeyEnv; tokenEnv is not supported by this adapter.");
  const env = nativeApiKey ? config.apiKeyEnv
    : config.authType === "bearer" ? config.tokenEnv ?? config.apiKeyEnv : config.apiKeyEnv ?? config.tokenEnv;
  if (!env || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(env)) {
    return fail("Model discovery requires an explicit credential environment reference.");
  }
  const secret = process.env[env];
  if (!secret) return fail("The configured credential environment variable is missing or empty.");
  if (secret.length > 16_384 || UNSAFE_TEXT.test(secret) || secret.trim() !== secret) {
    return fail("The configured credential is not a valid HTTP header value.");
  }
  if (config.kind === "anthropic") {
    headers["x-api-key"] = secret;
    headers["anthropic-version"] = "2023-06-01";
  } else if (config.kind === "google") headers["x-goog-api-key"] = secret;
  else headers.Authorization = `Bearer ${secret}`;
  return { headers, secret };
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function modelId(value: unknown, secret?: string): string {
  if (typeof value !== "string" || !value || value.trim() !== value || Buffer.byteLength(value, "utf8") > 256
    || UNSAFE_TEXT.test(value) || containsKnownSecret(value) || (secret && value.includes(secret))) {
    return fail("Provider returned an invalid or sensitive model identifier.");
  }
  return value;
}

function parsePage(value: unknown, kind: ProviderConfig["kind"], secret?: string): { models: string[]; cursor?: string } {
  if (!record(value)) return fail("Provider returned an invalid model-list response.");
  const list = kind === "ollama" || kind === "google" ? value.models : value.data;
  // Google omits repeated fields when an empty response is encoded as JSON.
  const items = list === undefined && kind === "google" ? [] : list;
  if (!Array.isArray(items) || items.length > MAX_MODELS) return fail("Provider returned an invalid or oversized model list.");
  const models: string[] = [];
  for (const item of items) {
    if (!record(item)) return fail("Provider returned an invalid model-list entry.");
    if (kind === "google") {
      const name = modelId(item.name, secret);
      if (!name.startsWith("models/") || name.length === "models/".length) return fail("Provider returned an invalid Google model name.");
      const methods = item.supportedGenerationMethods;
      if (!Array.isArray(methods) || !methods.every((method: unknown) => typeof method === "string")) {
        return fail("Provider returned invalid Google model capabilities.");
      }
      if (methods.includes("generateContent")) models.push(modelId(name.slice("models/".length), secret));
    } else models.push(modelId(kind === "ollama" ? item.name ?? item.model : item.id, secret));
  }
  let cursor: string | undefined;
  if (kind === "anthropic") {
    if (typeof value.has_more !== "boolean") return fail("Provider returned invalid model pagination.");
    if (value.has_more) cursor = modelId(value.last_id, secret);
  } else if (kind === "google" && value.nextPageToken !== undefined && value.nextPageToken !== "") {
    if (typeof value.nextPageToken !== "string" || Buffer.byteLength(value.nextPageToken, "utf8") > 2048
      || UNSAFE_TEXT.test(value.nextPageToken)) return fail("Provider returned invalid model pagination.");
    cursor = value.nextPageToken;
  }
  return { models, ...(cursor ? { cursor } : {}) };
}

async function readJson(response: Response, budget: { bytes: number }): Promise<unknown> {
  const advertised = response.headers.get("content-length");
  if (advertised !== null && (!/^\d+$/.test(advertised) || Number(advertised) > MAX_RESPONSE_BYTES - budget.bytes)) {
    void response.body?.cancel().catch(() => {});
    return fail("Provider model-list response exceeds the 8 MiB limit.");
  }
  if (!response.body) return fail("Provider returned an empty model-list response.");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      budget.bytes += chunk.value.byteLength;
      if (budget.bytes > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {});
        return fail("Provider model-list response exceeds the 8 MiB limit.");
      }
      chunks.push(chunk.value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { return fail("Provider returned invalid JSON for its model list."); }
}

/** Lists actual available models without generating, approving, or changing provider configuration. */
export async function listProviderModels(
  config: ProviderConfig,
  options: { signal?: AbortSignal; timeoutMs?: number; chatgptOptions?: CodexAppServerOptions } = {},
): Promise<string[]> {
  if (config.kind === "chatgpt-subscription") {
    if (config.authType !== "oauth" || config.baseUrl || config.apiKeyEnv || config.tokenEnv) return fail("ChatGPT subscription uses Codex sign-in without API keys or custom endpoints.");
    const client = await createCodexAppServer({ ...options.chatgptOptions, signal: options.signal });
    try { return [...new Set((await client.listModels(options.signal)).map((model) => model.model))]; }
    finally { await client.close(); }
  }
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) {
    return fail("Model discovery timeout must be an integer from 100 to 120000 milliseconds.");
  }
  const url = providerModelsEndpoint(config);
  const { headers, secret } = authentication(config);
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  timer.unref();
  const signal = options.signal ? AbortSignal.any([controller.signal, options.signal]) : controller.signal;
  const budget = { bytes: 0 };
  const models = new Set<string>();
  const cursors = new Set<string>();
  try {
    signal.throwIfAborted();
    for (let page = 0; page < MAX_PAGES; page += 1) {
      const response = await fetch(url, { method: "GET", headers, signal, redirect: "error" });
      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        return fail(`Provider model discovery failed with HTTP ${response.status}.`);
      }
      const parsed = parsePage(await readJson(response, budget), config.kind, secret);
      for (const id of parsed.models) models.add(id);
      if (models.size > MAX_MODELS) return fail("Provider model list exceeds the 4096-model limit.");
      if (!parsed.cursor) return [...models].sort();
      if (cursors.has(parsed.cursor)) return fail("Provider returned a repeated model pagination cursor.");
      cursors.add(parsed.cursor);
      url.searchParams.set(config.kind === "google" ? "pageToken" : "after_id", parsed.cursor);
    }
    return fail("Provider model listing exceeded the 16-page limit.");
  } catch (error: unknown) {
    if (options.signal?.aborted) {
      const cancelled = new Error("Provider model discovery was cancelled.");
      cancelled.name = "AbortError";
      throw cancelled;
    }
    if (timedOut) return fail("Provider model discovery timed out.");
    if (error instanceof ModelDiscoveryError) throw error;
    return fail("Provider model discovery could not complete the HTTP request.");
  } finally { clearTimeout(timer); controller.abort(); }
}
