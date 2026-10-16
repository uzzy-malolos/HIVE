import { homedir } from "node:os";
import path from "node:path";
import { findRepositoryRoot } from "../coding/repository.js";
import { containsKnownSecret, redactKnownSecrets } from "../security/secrets.js";
import { sanitizeTerminalText } from "../security/terminal-text.js";
import { listProviderModels } from "./models.js";
import { ProviderRegistry } from "./registry.js";
import { buildProviderConfig, providerLaunchCommand, PROVIDER_SETUP_PRESETS } from "./setup.js";
import type { ProviderConfig } from "./types.js";
import { createCodexAppServer, type CodexAppServerOptions } from "./codex-app-server.js";
import { ChatGptSubscriptionAdapter } from "./adapters/chatgpt-subscription.js";

export interface ProviderCommandOptions {
  signal?: AbortSignal;
  /** Isolated global catalog for embedding and tests; never read from project config. */
  globalRoot?: string;
  /** Trusted embedding capability; never accepted from project provider JSON. */
  chatgptOptions?: CodexAppServerOptions;
  onProgress?: (text: string) => void;
}

export interface ProviderCommandResult {
  exitCode: number;
  lines: string[];
  data: unknown;
  provider?: ProviderConfig;
  models?: string[];
}

/** Provider setup and Queen routing must agree even when launched in a subdirectory. */
export async function providerConfigRoot(cwd: string, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  return findRepositoryRoot(cwd, signal).catch(() => {
    signal?.throwIfAborted();
    return path.resolve(cwd);
  });
}

export async function providerCatalog(cwd: string, options: ProviderCommandOptions = {}) {
  const root = await providerConfigRoot(cwd, options.signal);
  const project = new ProviderRegistry(root);
  const global = new ProviderRegistry(options.globalRoot ?? homedir());
  const [projectRows, globalRows, projectRoles, globalRoles] = await Promise.all([
    project.list(), global.list(), project.getRoles(), global.getRoles(),
  ]);
  options.signal?.throwIfAborted();
  const rows = [
    ...projectRows.map((provider) => ({ provider, scope: "project" as const, registry: project })),
    ...globalRows.filter((provider) => !projectRows.some((row) => row.id === provider.id))
      .map((provider) => ({ provider, scope: "global" as const, registry: global })),
  ];
  return { root, project, rows, roles: { ...globalRoles, ...projectRoles } };
}

export function providerPublicText(value: string, provider?: ProviderConfig): string {
  for (const reference of [provider?.apiKeyEnv, provider?.tokenEnv]) {
    const secret = reference ? process.env[reference] : undefined;
    if (secret) value = value.replaceAll(secret, "[REDACTED]").replaceAll(encodeURIComponent(secret), "[REDACTED]");
  }
  return sanitizeTerminalText(redactKnownSecrets(value));
}

/** Old manually edited registries may contain extra fields; none become public output. */
function publicProvider(provider: ProviderConfig, scope: "project" | "global") {
  const clean = (value: string) => providerPublicText(value, provider);
  const envReference = (value: string | undefined) => value === undefined ? undefined
    : /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(value) && !containsKnownSecret(value) ? value : "[invalid environment reference]";
  let baseUrl: string | undefined;
  if (provider.baseUrl) {
    try {
      const url = new URL(provider.baseUrl);
      url.username = ""; url.password = ""; url.search = ""; url.hash = "";
      baseUrl = clean(url.href.replace(/\/$/u, ""));
    } catch { baseUrl = "[invalid endpoint]"; }
  }
  return { id: clean(provider.id), name: clean(provider.name), kind: clean(provider.kind), authType: clean(provider.authType),
    approved: provider.approved === true, scope,
    ...(baseUrl ? { baseUrl } : {}),
    ...(provider.apiKeyEnv === undefined ? {} : { apiKeyEnv: envReference(provider.apiKeyEnv) }),
    ...(provider.tokenEnv === undefined ? {} : { tokenEnv: envReference(provider.tokenEnv) }),
    ...(provider.defaultModel === undefined ? {} : { defaultModel: clean(provider.defaultModel) }),
    ...(provider.model === undefined ? {} : { model: clean(provider.model) }),
  };
}

/** Argument quoting only; there is no shell evaluation or variable expansion. */
export function providerCommandArguments(input: string): string[] {
  if (input.length > 8_192 || /[\x00-\x1f\x7f]/u.test(input)) throw new Error("Invalid provider command arguments.");
  const result: string[] = [];
  let token = "";
  let quote = "";
  let started = false;
  for (const character of input) {
    if (quote) {
      if (character === quote) quote = "";
      else token += character;
    } else if (character === '"' || character === "'") { quote = character; started = true; }
    else if (/\s/u.test(character)) {
      if (started) { result.push(token); token = ""; started = false; }
    } else { token += character; started = true; }
  }
  if (quote) throw new Error("Close the quoted provider argument before submitting.");
  if (started) result.push(token);
  return result;
}

const HELP = [
  "providers setup: choose BYOK (your API key) or local models in the CLI wizard.",
  "providers presets: show BYOK and local setup choices.",
  "providers add --id ID --preset openai|anthropic|google|openrouter|opencode|kilo|cline|custom|hive-cloud|ollama|local|hermes --model MODEL [--base-url URL] [--api-key-env NAME]",
  "providers models ID: list models from that endpoint; no generation or model downloads.",
  "providers test ID | approve ID | list",
  "providers login ID [--device] | auth-status ID | logout ID: ChatGPT subscription via installed Codex.",
  "API keys stay in environment variables. Enter the variable name, never a key value.",
  "Local Ollama and OpenAI-compatible servers need no API key. Start/load a model in your local runtime first.",
  "After approval, select /model ID/MODEL in the terminal or launch hive --model ID/MODEL. Existing defaults stay unchanged.",
];

/** Shared CLI/slash provider controls. Only explicit test/models verbs contact endpoints. */
export async function providerCommand(cwd: string, args: readonly string[], options: ProviderCommandOptions = {}): Promise<ProviderCommandResult> {
  const result = await executeProviderCommand(cwd, args, options);
  return { ...result, lines: result.lines.map((line) => providerPublicText(line, result.provider)) };
}

async function executeProviderCommand(cwd: string, args: readonly string[], options: ProviderCommandOptions): Promise<ProviderCommandResult> {
  options.signal?.throwIfAborted();
  const action = args[0] ?? "list";
  if (action === "help" || action === "presets") {
    if (args.length > 1) throw new Error(`providers ${action} accepts no arguments.`);
    return { exitCode: 0, lines: action === "help" ? HELP : PROVIDER_SETUP_PRESETS.map((preset) =>
      `${preset.mode === "local" ? "Local" : preset.mode === "subscription" ? "Subscription" : "BYOK"}: ${preset.id} - ${preset.label}${preset.apiKeyEnv ? ` (environment: ${preset.apiKeyEnv})` : " (no API key required)"}`), data: action === "help" ? HELP : PROVIDER_SETUP_PRESETS };
  }
  const catalog = await providerCatalog(cwd, options);
  if (action === "list") {
    if (args.length > 1) throw new Error("providers list accepts no arguments.");
    const data = catalog.rows.map(({ provider, scope }) => publicProvider(provider, scope));
    const lines = data.length ? data.map((provider) =>
      `${provider.approved ? "[+]" : "[ ]"} ${provider.id} (${provider.kind}, ${provider.scope}) ${provider.defaultModel ?? provider.model ?? "model not selected"}${provider.baseUrl ? ` - ${provider.baseUrl}` : ""} - ${provider.kind === "chatgpt-subscription" ? "ChatGPT sign-in via Codex" : provider.authType === "none" ? "no API key" : `key reference: ${provider.apiKeyEnv ?? provider.tokenEnv ?? "missing"}`}`)
      : ["No providers configured. Choose BYOK or local models with providers setup."];
    return { exitCode: 0, lines, data };
  }
  if (action === "add") {
    const flags: Record<string, string> = {};
    for (let index = 1; index < args.length; index += 2) {
      const flag = args[index];
      const value = args[index + 1];
      if (!["--id", "--preset", "--kind", "--base-url", "--api-key-env", "--model"].includes(flag) || flags[flag] !== undefined || !value || value.startsWith("--")) {
        throw new Error("Usage: providers add --id ID --preset PRESET --model MODEL [--base-url URL] [--api-key-env NAME]");
      }
      flags[flag] = value;
    }
    const config = buildProviderConfig({ id: flags["--id"] ?? "", preset: flags["--preset"], kind: flags["--kind"],
      baseUrl: flags["--base-url"], model: flags["--model"], apiKeyEnv: flags["--api-key-env"] });
    options.signal?.throwIfAborted();
    const provider = await catalog.project.add(config);
    const model = provider.defaultModel;
    return { exitCode: 0, provider, data: { success: true, id: provider.id, approved: false, configRoot: catalog.root },
      lines: [`Provider ${provider.id} saved in ${catalog.root}; not approved yet.`,
        `Test: providers test ${provider.id}`, `Approve after inspecting its endpoint: providers approve ${provider.id}`,
        ...(model ? [`Use: /model ${provider.id}/${model} or ${providerLaunchCommand(provider.id, model)}`] : ["Choose the actual model with /model ID/MODEL after approval."])] };
  }
  const id = args[1];
  if (id && ["login", "auth-status", "logout"].includes(action)) {
    if (args.length > (action === "login" ? 3 : 2) || args[2] !== undefined && args[2] !== "--device") throw new Error("Use providers login ID [--device], auth-status ID, or logout ID.");
    const provider = catalog.rows.find((entry) => entry.provider.id === id)?.provider;
    if (provider?.kind !== "chatgpt-subscription") throw new Error("Select a configured ChatGPT subscription provider; add one with providers add --id chatgpt --preset chatgpt.");
    if (action === "login" && !options.onProgress) throw new Error("Subscription sign-in requires a progress callback to show its browser URL or device code.");
    const client = await createCodexAppServer({ ...options.chatgptOptions, signal: options.signal });
    try {
      if (action === "auth-status") { const data = await client.accountStatus(options.signal); return { exitCode: 0, provider, data, lines: [JSON.stringify(data)] }; }
      if (action === "logout") { await client.logout(options.signal); return { exitCode: 0, provider, data: { signedOut: true }, lines: ["Signed out of HIVE's isolated Codex account. Other Codex clients were not changed."] }; }
      const login = await client.startLogin({ method: args[2] === "--device" ? "device" : "browser" }, options.signal);
      try {
        options.onProgress?.(sanitizeTerminalText(login.type === "device" ? `Open ${login.verificationUrl} and enter code ${login.userCode}. This authorizes HIVE's isolated Codex account.` : `Open this URL to sign in with ChatGPT through Codex:\n${login.authUrl}`));
        const result = await client.waitForLogin(login.loginId, { signal: options.signal, timeoutMs: 180_000 });
        if (!result.success) throw new Error(result.error ?? "ChatGPT sign-in did not complete.");
        const data = await client.accountStatus(options.signal);
        return { exitCode: 0, provider, data, lines: ["ChatGPT sign-in completed. Inspect models and approve the provider before using it.", `Next: providers models ${id}; providers approve ${id}`] };
      } finally { await client.cancelLogin(login.loginId).catch(() => undefined); }
    } finally { await client.close(); }
  }
  if (!id || args.length !== 2 || !["test", "approve", "models"].includes(action)) throw new Error("Use providers help for supported commands.");
  const entry = catalog.rows.find((row) => row.provider.id === id);
  if (!entry) throw new Error("Provider is not configured. Use providers setup or providers add first.");
  const provider = entry.provider;
  if (action === "models") {
    const models = await listProviderModels(provider, { signal: options.signal, chatgptOptions: options.chatgptOptions });
    return { exitCode: 0, provider, models, data: { providerId: providerPublicText(provider.id, provider), models },
      lines: models.length ? models.map((model) => `${provider.id}/${model}`) : ["The endpoint returned no models. Start/load a model in your local runtime, then retry."] };
  }
  if (action === "approve") {
    options.signal?.throwIfAborted();
    await entry.registry.approve(id);
    return { exitCode: 0, provider: { ...provider, approved: true }, data: { success: true, id: providerPublicText(id, provider), scope: entry.scope },
      lines: [`Provider ${id} approved (${entry.scope}). Select it with /model ${id}/${provider.defaultModel ?? provider.model ?? "MODEL"}. Existing role assignments stay unchanged.`] };
  }
  try {
    const health = provider.kind === "chatgpt-subscription" ? await new ChatGptSubscriptionAdapter(options.chatgptOptions).healthCheck(provider, undefined, options.signal) : await entry.registry.test(id, options.signal);
    const message = providerPublicText(health.message, provider);
    return { exitCode: health.ok ? 0 : 1, provider, data: { ok: health.ok, providerId: providerPublicText(provider.id, provider), message, ...(health.redactedError ? { redactedError: providerPublicText(health.redactedError, provider) } : {}) },
      lines: [`[${health.ok ? "PASS" : "FAIL"}] ${message}`, "Health is a prerequisite; providers verify checks actual generation separately."] };
  } catch (error) {
    options.signal?.throwIfAborted();
    throw new Error(providerPublicText(error instanceof Error ? error.message : String(error), provider));
  }
}
