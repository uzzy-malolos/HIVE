import * as readline from "node:readline/promises";
import { ProviderRegistry } from "../providers/registry.js";
import { buildProviderConfig, providerLaunchCommand, PROVIDER_SETUP_PRESETS } from "../providers/setup.js";
import type { ProviderRoles } from "../providers/types.js";
import { redactKnownSecrets } from "../security/secrets.js";
import { sanitizeTerminalText } from "../security/terminal-text.js";
import { getHiveProvidersHeader } from "./branding.js";
import { getRenderMode } from "./terminal.js";

export interface ProviderSetupWizardOptions {
  question?: (prompt: string, signal?: AbortSignal) => Promise<string>;
  write?: (message: string) => void;
  signal?: AbortSignal;
  healthTimeoutMs?: number;
}

const defaultCodingRoles = ["queen", "planner", "scout", "builder", "validator", "reviewer", "fixer", "synthesis"] satisfies readonly (keyof ProviderRoles)[];

export async function runProviderSetupWizard(registry: ProviderRegistry, options: ProviderSetupWizardOptions = {}): Promise<void> {
  const timeoutMs = options.healthTimeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60_000) throw new Error("Provider setup health timeout must be 100 to 60000 milliseconds.");
  options.signal?.throwIfAborted();
  const cancellation = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, cancellation.signal]) : cancellation.signal;
  const rl = options.question ? undefined : readline.createInterface({ input: process.stdin, output: process.stdout });
  rl?.on("SIGINT", () => cancellation.abort(new Error("Provider setup cancelled.")));
  const write = options.write ?? ((message: string) => { process.stdout.write(`${message}\n`); });
  const ask = async (prompt: string): Promise<string> => {
    signal.throwIfAborted();
    let answer: string;
    if (options.question) answer = await options.question(prompt, signal);
    else if (rl) answer = await rl.question(prompt, { signal });
    else throw new Error("Provider setup input is unavailable.");
    signal.throwIfAborted();
    return answer.trim();
  };
  try {
    if (getRenderMode() !== "suppressed") write(getHiveProvidersHeader());
    write("Configure your own provider. API keys stay in your environment; HIVE saves only their variable names.");
    write("  [1] Bring your own API key (BYOK)\n  [2] Local model server (no API key required)\n  [3] ChatGPT subscription (sign in through installed Codex)");
    const modeChoice = await ask("Provider mode [1-3]: ");
    if (!["1", "2", "3"].includes(modeChoice)) throw new Error("Choose 1 for BYOK, 2 for a local server, or 3 for ChatGPT sign-in.");
    if (modeChoice === "3") {
      const id = await ask("Provider ID [chatgpt]: ") || "chatgpt";
      await registry.add(buildProviderConfig({ id, preset: "chatgpt" }));
      write(`Saved ${id} without credentials or changed defaults. Continue: hive providers login ${id} --device`);
      write(`Then inspect models and approve: hive providers models ${id}; hive providers approve ${id}`);
      return;
    }
    const presets = PROVIDER_SETUP_PRESETS.filter((entry) => entry.mode === (modeChoice === "1" ? "byok" : "local"));
    write(presets.map((entry, index) => `  [${index + 1}] ${entry.label}`).join("\n"));
    const presetChoice = await ask(`Provider [1-${presets.length}]: `);
    const preset = presets.find((entry, index) => String(index + 1) === presetChoice || entry.id === presetChoice);
    if (!preset) throw new Error("Choose a listed provider preset.");
    const id = await ask(`Provider ID (for example ${preset.id}): `);
    const defaultBaseUrl = preset.baseUrl ?? (preset.id === "hive-cloud" ? process.env.HIVE_CLOUD_BASE_URL : undefined);
    const defaultBaseLabel = preset.baseUrl ?? (defaultBaseUrl ? "HIVE_CLOUD_BASE_URL" : undefined);
    const baseUrl = await ask(`Base URL${defaultBaseLabel ? ` [${defaultBaseLabel}]` : " (HTTPS API endpoint)"}: `) || defaultBaseUrl;
    const model = await ask("Exact model ID (required; no model is downloaded or substituted): ");
    const apiKeyEnv = preset.mode === "byok"
      ? await ask(`API key environment-variable name${preset.apiKeyEnv ? ` [${preset.apiKeyEnv}]` : " (not the key value)"}: `) || preset.apiKeyEnv
      : preset.kind === "ollama" ? undefined : await ask("API key environment-variable name (optional; leave blank for no authentication): ") || undefined;
    const config = buildProviderConfig({ id, preset: preset.id, baseUrl, model, apiKeyEnv });
    signal.throwIfAborted();
    await registry.add(config);
    write(`Saved provider ${config.id} without a credential value. Testing its health prerequisite...`);
    const deadline = AbortSignal.timeout(timeoutMs);
    const healthSignal = AbortSignal.any([signal, deadline]);
    let healthy = false;
    const safeMessage = (value: string): string => {
      const secret = config.apiKeyEnv ? process.env[config.apiKeyEnv] : undefined;
      return sanitizeTerminalText(redactKnownSecrets(secret ? value.replaceAll(secret, "[REDACTED]") : value)).slice(0, 2000);
    };
    try {
      const result = await registry.test(config.id, healthSignal);
      healthSignal.throwIfAborted();
      healthy = result.ok;
      write(`${healthy ? "[PASS]" : "[FAIL]"} ${safeMessage(result.message)}`);
    } catch (error) {
      signal.throwIfAborted();
      write(`[FAIL] ${deadline.aborted ? "Provider health check timed out." : safeMessage(error instanceof Error ? error.message : "Provider health check failed.")}`);
    }
    signal.throwIfAborted();
    if (!healthy) {
      write(`Provider ${config.id} remains unapproved. Configure your environment or start the local server, then run: hive providers test ${config.id}`);
      return;
    }
    await registry.approve(config.id);
    write(`Provider ${config.id} is approved. Use it explicitly: ${providerLaunchCommand(config.id, model)}`);
    write(`To test actual generation, streaming, and a disposable file edit: hive providers verify ${config.id} --coding`);
    const defaults = await ask(`Use ${config.id}/${model} for all default coding roles? This replaces their existing assignments. [y/N]: `);
    if (/^(?:y|yes)$/iu.test(defaults)) {
      signal.throwIfAborted();
      for (const role of defaultCodingRoles) await registry.setRole(role, config.id, model);
      write("Updated default coding roles to the provider and model you selected.");
    } else write("Existing default role assignments were preserved.");
  } finally { rl?.close(); }
}
