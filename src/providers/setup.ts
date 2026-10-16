import type { ProviderConfig, ProviderKind } from "./types.js";
import { containsKnownSecret } from "../security/secrets.js";

export interface ProviderSetupPreset {
  readonly id: string;
  readonly label: string;
  readonly mode: "byok" | "local" | "subscription";
  readonly kind: ProviderKind;
  readonly baseUrl?: string;
  readonly apiKeyEnv?: string;
}

export const PROVIDER_SETUP_PRESETS: readonly ProviderSetupPreset[] = [
  { id: "openai", label: "OpenAI", mode: "byok", kind: "openai", baseUrl: "https://api.openai.com/v1", apiKeyEnv: "OPENAI_API_KEY" },
  { id: "anthropic", label: "Anthropic", mode: "byok", kind: "anthropic", baseUrl: "https://api.anthropic.com/v1", apiKeyEnv: "ANTHROPIC_API_KEY" },
  { id: "google", label: "Google Gemini", mode: "byok", kind: "google", baseUrl: "https://generativelanguage.googleapis.com/v1beta", apiKeyEnv: "GEMINI_API_KEY" },
  { id: "openrouter", label: "OpenRouter", mode: "byok", kind: "openrouter", baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" },
  { id: "custom", label: "Custom OpenAI-compatible API", mode: "byok", kind: "openai-compatible", apiKeyEnv: "CUSTOM_API_KEY" },
  { id: "hive-cloud", label: "HIVE Cloud (your configured endpoint)", mode: "byok", kind: "openai-compatible", apiKeyEnv: "HIVE_API_KEY" },
  { id: "opencode", label: "OpenCode Console (Chat Completions models)", mode: "byok", kind: "openai-compatible", baseUrl: "https://opencode.ai/inference/openai/v1", apiKeyEnv: "OPENCODE_API_KEY" },
  { id: "kilo", label: "Kilo AI Gateway", mode: "byok", kind: "openai-compatible", baseUrl: "https://ai-gateway.kilo.ai/api/v1", apiKeyEnv: "KILO_API_KEY" },
  { id: "cline", label: "Cline API", mode: "byok", kind: "openai-compatible", baseUrl: "https://api.cline.bot/api/v1", apiKeyEnv: "CLINE_API_KEY" },
  { id: "ollama", label: "Ollama", mode: "local", kind: "ollama", baseUrl: "http://127.0.0.1:11434" },
  { id: "local", label: "LM Studio / llama.cpp / vLLM (OpenAI-compatible)", mode: "local", kind: "local", baseUrl: "http://127.0.0.1:1234/v1" },
  { id: "hermes", label: "Hermes / Nous subscription proxy (already running locally)", mode: "local", kind: "local", baseUrl: "http://127.0.0.1:8645/v1" },
  { id: "chatgpt", label: "ChatGPT subscription via installed Codex", mode: "subscription", kind: "chatgpt-subscription" },
];

export interface ProviderSetupInput {
  id: string;
  preset?: string;
  kind?: string;
  baseUrl?: string;
  model?: string;
  apiKeyEnv?: string;
  name?: string;
}

/** Copyable command text uses the host shell's quoting rules for unusual model IDs. */
export function providerLaunchCommand(id: string, model: string): string {
  const reference = `${id}/${model}`;
  const quoted = /^[A-Za-z0-9._:/@+-]+$/u.test(reference) ? reference
    : process.platform === "win32" ? `'${reference.replaceAll("'", "''")}'`
      : `'${reference.replaceAll("'", "'\\''")}'`;
  return `hive --model ${quoted}`;
}

function text(value: string, field: string, maximum: number): string {
  if (typeof value !== "string" || /[\x00-\x1f\x7f-\x9f]/u.test(value)) throw new Error(`${field} must be text without control characters.`);
  if (containsKnownSecret(value)) throw new Error(`${field} must not contain a credential value.`);
  const result = value.trim();
  if (!result || result.length > maximum) throw new Error(`${field} is required and must be at most ${maximum} characters.`);
  return result;
}

function providerKind(value: string | undefined): ProviderKind {
  switch (value) {
    case "openai": case "openai-compatible": case "openrouter": case "anthropic":
    case "google": case "ollama": case "local": case "custom": case "chatgpt-subscription": return value;
    default: throw new Error("Choose a supported provider preset or kind: openai, openai-compatible, openrouter, anthropic, google, ollama, local, custom.");
  }
}

function isLoopbackHostname(hostname: string): boolean {
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/u.test(hostname) || hostname === "[::1]" || hostname === "localhost";
}

function endpoint(value: string): string {
  const input = text(value, "Base URL", 2048);
  if (input.includes("\\")) throw new Error("Base URL must not contain backslashes.");
  let parsed: URL;
  try { parsed = new URL(input); } catch { throw new Error("Base URL must be an absolute HTTPS URL or a loopback HTTP URL."); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("Base URL must not include credentials, query parameters, or fragments.");
  const loopback = isLoopbackHostname(parsed.hostname);
  if (parsed.protocol !== "https:" && !(parsed.protocol === "http:" && loopback)) throw new Error("Use HTTPS for remote providers, or a loopback HTTP address such as http://127.0.0.1:1234/v1.");
  return parsed.href.replace(/\/+$/u, "");
}

/** Persist only public configuration and environment-variable references, never key values. */
export function buildProviderConfig(input: ProviderSetupInput): Omit<ProviderConfig, "createdAt" | "updatedAt" | "approved"> {
  const id = text(input.id, "Provider ID", 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/u.test(id)) throw new Error("Provider ID must use letters, digits, dots, underscores, or hyphens, starting with a letter or digit.");
  const subscription = input.preset === "chatgpt" || input.kind === "chatgpt-subscription";
  const model = input.model === undefined && (subscription || input.preset === undefined && input.kind !== undefined) ? undefined : text(input.model ?? "", "Model ID", 256);
  if (model && /\s/u.test(model)) throw new Error("Model ID must not contain whitespace. Use the exact model ID served by your provider.");
  const preset = input.preset === undefined ? undefined : PROVIDER_SETUP_PRESETS.find((entry) => entry.id === input.preset);
  if (input.preset !== undefined && !preset) throw new Error("Unknown provider preset. Run hive providers presets to see supported choices.");
  const kind = providerKind(input.kind ?? preset?.kind);
  if (preset && kind !== preset.kind) throw new Error("Provider kind conflicts with the selected preset.");
  if (subscription) {
    if (input.apiKeyEnv !== undefined || input.baseUrl !== undefined) throw new Error("ChatGPT subscription sign-in uses the installed Codex account service; API keys and endpoint overrides are unsupported.");
    return { id, name: input.name === undefined ? "ChatGPT subscription" : text(input.name, "Provider name", 128), kind: "chatgpt-subscription", authType: "oauth", ...(model ? { defaultModel: model } : {}) };
  }
  const defaultPreset = PROVIDER_SETUP_PRESETS.find((entry) => entry.kind === kind);
  const baseUrlInput = input.baseUrl ?? preset?.baseUrl ?? defaultPreset?.baseUrl;
  if (!baseUrlInput) throw new Error("Base URL is required for this provider.");
  const baseUrl = endpoint(baseUrlInput);
  if (kind === "anthropic" || kind === "google") {
    const supported = kind === "anthropic" ? ["https://api.anthropic.com", "https://api.anthropic.com/v1"] : ["https://generativelanguage.googleapis.com", "https://generativelanguage.googleapis.com/v1beta"];
    if (!supported.includes(baseUrl)) throw new Error(`The ${kind} adapter uses its fixed official endpoint; choose custom for an OpenAI-compatible proxy.`);
  }
  const local = preset?.mode === "local" || (!preset && (kind === "local" || kind === "ollama" || ((kind === "openai-compatible" || kind === "custom") && isLoopbackHostname(new URL(baseUrl).hostname))));
  const envInput = input.apiKeyEnv ?? (local ? undefined : preset?.apiKeyEnv ?? defaultPreset?.apiKeyEnv);
  const apiKeyEnv = envInput === undefined || envInput === "" ? undefined : text(envInput, "API key environment-variable name", 128);
  if (apiKeyEnv && (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(apiKeyEnv) || containsKnownSecret(apiKeyEnv))) throw new Error("Pass an environment-variable name such as OPENAI_API_KEY, never a key value.");
  if (!local && !apiKeyEnv) throw new Error("BYOK providers require an API key environment-variable name. Set its value in your own secure environment.");
  if (kind === "ollama" && apiKeyEnv) throw new Error("The Ollama adapter does not send API keys. Use a custom OpenAI-compatible provider if your server requires authentication.");
  const name = input.name === undefined ? id : text(input.name, "Provider name", 128);
  return { id, name, kind, baseUrl, authType: apiKeyEnv ? (kind === "anthropic" || kind === "google" ? "api-key" : "bearer") : "none", ...(apiKeyEnv ? { apiKeyEnv } : {}), ...(model ? { defaultModel: model } : {}) };
}
