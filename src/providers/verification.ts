import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { StructuredAgentLoop } from "../coding/agent-loop.js";
import { RepositoryToolService } from "../coding/tools.js";
import { redactKnownSecrets } from "../security/secrets.js";
import { sanitizeTerminalText } from "../security/terminal-text.js";
import { outputTokenLimit } from "./limits.js";
import type { ProviderRegistry } from "./registry.js";
import type { ProviderCompletionInput, ProviderCompletionResult, ProviderConfig } from "./types.js";

type CheckName = "health" | "buffered" | "streaming" | "coding";
export interface ProviderVerificationCheck {
  name: CheckName;
  status: "passed" | "failed" | "skipped";
  durationMs: number;
  detail: string;
  usage?: ProviderCompletionResult["usage"];
}
export interface ProviderVerificationReport {
  schemaVersion: 1;
  providerId: string;
  model: string;
  endpoint: string;
  startedAt: string;
  completedAt: string;
  status: "passed" | "failed" | "cancelled";
  maxOutputTokensPerRequest: number;
  checks: ProviderVerificationCheck[];
}
export interface ProviderVerificationOptions {
  model?: string;
  coding?: boolean;
  signal?: AbortSignal;
  timeoutMs?: number;
  maxOutputTokens?: number;
  onProgress?: (check: ProviderVerificationCheck) => void;
}

function failureText(error: unknown, config: ProviderConfig): string {
  let text = error instanceof Error ? error.message : String(error);
  const references = [config.apiKeyEnv, config.tokenEnv, "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "GEMINI_API_KEY", "GOOGLE_API_KEY"];
  for (const name of references) {
    const secret = name ? process.env[name] : undefined;
    if (secret) text = text.replaceAll(secret, "[REDACTED]");
  }
  return sanitizeTerminalText(redactKnownSecrets(text)).slice(0, 2000);
}

function endpoint(config: ProviderConfig): string {
  if (config.kind === "anthropic") return "https://api.anthropic.com";
  if (config.kind === "google") return "https://generativelanguage.googleapis.com";
  if (config.baseUrl) return new URL(config.baseUrl).origin;
  switch (config.kind) {
    case "openai": return "https://api.openai.com";
    case "openrouter": return "https://openrouter.ai";
    case "ollama": return "http://localhost:11434";
    default: return "not configured";
  }
}

/** Real requests to one explicit provider; no fallback or configuration writes. */
export async function verifyProvider(
  registry: Pick<ProviderRegistry, "getAdapter">,
  providerId: string,
  options: ProviderVerificationOptions = {},
): Promise<ProviderVerificationReport> {
  const { adapter, config } = await registry.getAdapter(providerId);
  if (config.id !== providerId || !config.approved) throw new Error("Select an existing approved provider before verification.");
  if (config.baseUrl && (config.kind === "anthropic" || config.kind === "google")) {
    const supported = config.kind === "anthropic" ? ["https://api.anthropic.com", "https://api.anthropic.com/v1"]
      : ["https://generativelanguage.googleapis.com", "https://generativelanguage.googleapis.com/v1beta"];
    if (!supported.includes(config.baseUrl.replace(/\/+$/u, ""))) throw new Error(`The ${config.kind} adapter does not support this baseUrl override. Verification refused before sending credentials or generation requests.`);
  }
  const model = options.model?.trim() || config.defaultModel?.trim() || config.model?.trim();
  if (config.kind === "chatgpt-subscription") throw new Error("This strict verification probe requires an output-token cap that Codex app-server does not expose. Use an explicit subscription session instead; no capped request was sent.");
  if (!model || model.length > 256 || /[\x00-\x1f]/.test(model)) throw new Error("Verification requires a configured model or --model <id>.");
  const maxOutputTokens = outputTokenLimit(options.maxOutputTokens ?? 512) ?? 512;
  const timeoutMs = options.timeoutMs ?? 60_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120_000) throw new Error("Verification timeout must be 100 to 120000 milliseconds per check.");
  const startedAt = new Date().toISOString();
  const checks: ProviderVerificationCheck[] = [];
  const marker = `HIVE_VERIFY_${randomUUID().slice(0, 8)}`;
  const request = (signal: AbortSignal): ProviderCompletionInput => ({ model, prompt: `Reply with exactly ${marker} and nothing else.`, maxOutputTokens, signal });
  const run = async (name: CheckName, operation: (signal: AbortSignal) => Promise<Pick<ProviderVerificationCheck, "detail" | "usage">>): Promise<boolean> => {
    const start = Date.now();
    const deadline = AbortSignal.timeout(timeoutMs);
    const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
    let check: ProviderVerificationCheck;
    try {
      signal.throwIfAborted();
      const result = await operation(signal);
      signal.throwIfAborted();
      check = { name, status: "passed", durationMs: Date.now() - start, ...result };
    } catch (error) {
      check = { name, status: "failed", durationMs: Date.now() - start, detail: deadline.aborted ? "Verification check timed out." : failureText(error, config) };
    }
    checks.push(check);
    options.onProgress?.(check);
    return check.status === "passed";
  };
  const healthy = await run("health", async (signal) => {
    const health = await adapter.healthCheck(config, undefined, signal);
    if (!health.ok) throw new Error(health.redactedError || health.message);
    return { detail: "Provider health prerequisite passed; generation is checked separately." };
  });
  if (healthy && !options.signal?.aborted) {
    await run("buffered", async (signal) => {
      const result = await adapter.complete(config, request(signal));
      if (result.output?.trim() !== marker) throw new Error("Provider did not return the requested verification marker.");
      return { detail: "Buffered generation returned the exact requested marker.", usage: result.usage };
    });
    if (!options.signal?.aborted) {
      if (adapter.streamComplete) {
        await run("streaming", async (signal) => {
          let accumulated = "";
          let chunks = 0;
          const result = await adapter.streamComplete?.(config, request(signal), (chunk) => { accumulated += chunk; chunks += 1; });
          if (!result || !chunks || accumulated !== result.output || result.output.trim() !== marker) throw new Error("Streaming output did not match the requested marker and final response.");
          return { detail: `Streaming generation delivered ${chunks} actual chunk(s).`, usage: result.usage };
        });
      } else checks.push({ name: "streaming", status: "skipped", durationMs: 0, detail: "This adapter does not implement streaming; streaming remains unverified." });
    }
    if (options.coding && !options.signal?.aborted) {
      await run("coding", async (signal) => {
        const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hive-provider-verify-"));
        const expected = `${marker}\n`;
        try {
          const task = { id: "verify-builder", sessionId: `verify-${randomUUID()}`, role: "builder" as const,
            title: "Verify a file-edit tool", objective: `Use create_file or write_file to put exactly ${JSON.stringify(expected)} into probe.txt, then finish.`,
            status: "working" as const, providerId, model, dependencies: [], fileScope: ["probe.txt"], expectedOutput: "probe.txt contains the exact marker",
            completionCriteria: ["A file-write tool succeeded"], validationCommands: [], depth: 0, attempt: 1, maxAttempts: 1, createdAt: new Date().toISOString() };
          const tools = new RepositoryToolService({ repositoryRoot: temporary, sessionId: task.sessionId, approvalPolicy: "changes" });
          let wrote = false;
          const loop = await new StructuredAgentLoop().run({ task, cwd: temporary, sharedContext: "Only probe.txt in this disposable workspace may be read or edited. Command execution is unavailable.",
            signal, maxTurns: 3, maxToolCalls: 2, maxInvalidResponses: 1,
            completionClient: { async complete(input) {
              const result = await adapter.complete(config, { ...input, model, maxOutputTokens, signal });
              return { output: result.output, ...(result.usage ? { usage: { input: result.usage.promptTokens, output: result.usage.completionTokens, total: result.usage.totalTokens } } : {}) };
            } },
            tools: { builtinToolNames: ["read_file", "create_file", "write_file"], async execute(name, args, executionTask, executionSignal, context) {
              if (!["read_file", "create_file", "write_file"].includes(name) || args.path !== "probe.txt" ||
                (name !== "read_file" && args.content !== expected)) return { ok: false, output: "Only the exact requested probe file operation is allowed." };
              const result = await tools.execute(name, args, executionTask, executionSignal, context);
              if (result.ok && name !== "read_file") wrote = true;
              return result;
            } },
          });
          if (!wrote || await fs.readFile(path.join(temporary, "probe.txt"), "utf8") !== expected) throw new Error("The provider did not complete the actual file-write tool workflow.");
          return { detail: `Actual file-write tool verified in ${loop.turns} model turns; no project files were sent or modified.` };
        } finally {
          if (await fs.realpath(temporary) !== path.resolve(temporary) || !path.basename(temporary).startsWith("hive-provider-verify-")) throw new Error("Verification cleanup path changed; temporary data was preserved.");
          await fs.rm(temporary, { recursive: true, force: true });
        }
      });
    }
  } else {
    for (const name of ["buffered", "streaming", ...(options.coding ? ["coding" as const] : [])] as const) checks.push({ name, status: "skipped", durationMs: 0, detail: "The provider health prerequisite failed; no generation was attempted." });
  }
  return { schemaVersion: 1, providerId, model, endpoint: endpoint(config), startedAt, completedAt: new Date().toISOString(),
    status: options.signal?.aborted ? "cancelled" : checks.every((check) => check.status === "passed") ? "passed" : "failed",
    maxOutputTokensPerRequest: maxOutputTokens, checks };
}
