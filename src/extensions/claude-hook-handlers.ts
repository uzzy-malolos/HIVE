import { oauthNetworkRequest } from "../security/oauth-network.js";
import { cancelled, explicitSecrets, MAX_SKILL_BYTES, object, keys, protectedText } from "./io.js";
import { claudeHookOutcome, type ClaudeHookConfiguration, type ClaudeHookEvaluation, type ClaudeHookHost } from "./claude-hooks.js";
import type { HookDescriptor, HookResult } from "./types.js";

function referencedEnvironment(configuration: ClaudeHookConfiguration): string[] {
  const handler = configuration.handler;
  return handler?.type === "http" ? handler.allowedEnvVars : [];
}

export function claudeHookSecrets(hook: HookDescriptor): string[] {
  const refs = [...Object.values(hook.process?.envRefs ?? {}), ...(hook.claude ? referencedEnvironment(hook.claude) : [])];
  return [...new Set(explicitSecrets(refs).flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1), encodeURIComponent(secret)]))].sort((left, right) => right.length - left.length);
}

function result(hook: HookDescriptor, output: string, outcome: ReturnType<typeof claudeHookOutcome>, secrets: string[]): HookResult {
  return { id: hook.id, ok: true, exitCode: 0, output: protectedText(output, secrets) || "Hook completed", ...outcome,
    ...(outcome.additionalContext ? { additionalContext: protectedText(outcome.additionalContext, secrets).slice(0, 10_000) } : {}),
    ...(outcome.continuation ? { continuation: protectedText(outcome.continuation, secrets).slice(0, 10_000) } : {}),
    ...(outcome.diagnostics ? { diagnostics: outcome.diagnostics.map((entry) => protectedText(entry, secrets).slice(0, 10_000)) } : {}),
  };
}

export function claudeHookPrompt(prompt: string, input: Record<string, unknown>): string {
  const json = JSON.stringify(input); let substituted = false;
  const expanded = prompt.replace(/\\\$|\$ARGUMENTS\b/gu, (match) => {
    if (match === "\\$") return "$";
    substituted = true; return json;
  });
  const output = substituted ? expanded : `${expanded}\n\nHook input JSON:\n${json}`;
  if (Buffer.byteLength(output) > MAX_SKILL_BYTES + 32_768) throw new Error("Claude model hook prompt exceeded its input limit");
  return output;
}

/** The generated decision is untrusted even when supplied by an embedding host. */
export function parseClaudeHookEvaluation(raw: unknown, type: "prompt" | "agent"): ClaudeHookEvaluation {
  const value = object(raw, "Claude model hook decision"); keys(value, type === "prompt" ? ["ok", "reason", "impossible"] : ["ok", "reason"], "Claude model hook decision");
  if (typeof value.ok !== "boolean") throw new Error("Claude model hook decision requires a boolean ok");
  if (value.reason !== undefined && (typeof value.reason !== "string" || value.reason.length > 10_000 || value.reason.includes("\0")) || !value.ok && (typeof value.reason !== "string" || !value.reason.trim())) throw new Error("Claude model hook denial requires a bounded reason");
  if (value.impossible !== undefined && (typeof value.impossible !== "boolean" || value.ok && value.impossible)) throw new Error("Claude model hook impossible must be a boolean on a denial");
  return { ok: value.ok, ...(typeof value.reason === "string" ? { reason: value.reason } : {}), ...(typeof value.impossible === "boolean" ? { impossible: value.impossible } : {}) };
}

function modelOutcome(configuration: ClaudeHookConfiguration, evaluation: ClaudeHookEvaluation): ReturnType<typeof claudeHookOutcome> {
  if (evaluation.ok) return { blocked: false };
  const reason = evaluation.reason ?? "Claude model hook denied this action";
  const handler = configuration.handler;
  if (configuration.event === "Stop" || configuration.event === "SubagentStop") return handler?.type === "prompt" && evaluation.impossible === true ? { blocked: false, diagnostics: [reason] } : { blocked: false, continuation: reason };
  if (configuration.event === "PermissionRequest") return { blocked: false };
  const blocks = configuration.event === "PreToolUse" || configuration.event === "UserPromptSubmit";
  const continues = handler?.type === "agent" || handler?.type === "prompt" && handler.continueOnBlock === true || configuration.event === "PostToolUseFailure";
  return { blocked: blocks, ...(!continues ? { stop: true } : {}), diagnostics: [reason], ...(continues && !blocks ? { additionalContext: reason } : {}) };
}

export function claudeMcpHookInput(template: Record<string, unknown>, input: Record<string, unknown>): Record<string, unknown> {
  let nodes = 0;
  const lookup = (key: string): unknown => {
    if (!/^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u.test(key)) throw new Error("Claude MCP hook substitutions require bounded object paths");
    let value: unknown = input;
    for (const segment of key.split(".")) {
      if (segment === "__proto__" || segment === "constructor" || segment === "prototype" || value === null || typeof value !== "object" || !Object.hasOwn(value, segment)) throw new Error("Claude MCP hook substitution path is missing");
      value = Reflect.get(value, segment);
    }
    return value;
  };
  const visit = (value: unknown, depth: number): unknown => {
    if (++nodes > 4096 || depth > 16) throw new Error("Claude MCP hook input exceeds its structural limit");
    if (typeof value === "string") {
      const whole = /^\$\{([^}]+)\}$/u.exec(value);
      if (whole) return lookup(whole[1]);
      return value.replace(/\$\{([^}]+)\}/gu, (_match, key: string) => {
        const item = lookup(key);
        if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean" && item !== null) throw new Error("Embedded Claude MCP hook substitutions require scalar values");
        return String(item ?? "");
      });
    }
    if (Array.isArray(value)) return value.map((entry) => visit(entry, depth + 1));
    if (value !== null && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) => {
      if (key === "__proto__" || key === "constructor" || key === "prototype") throw new Error("Claude MCP hook input contains a forbidden object key");
      return [key, visit(entry, depth + 1)];
    }));
    return value;
  };
  const expanded = object(visit(template, 0), "Claude MCP hook input");
  if (Buffer.byteLength(JSON.stringify(expanded)) > MAX_SKILL_BYTES) throw new Error("Claude MCP hook input exceeded 65536 bytes");
  return expanded;
}

/** Runs after fresh trust validation. Network redirects, ambient cookies and retries are never used. */
export async function executeAdvancedClaudeHook(hook: HookDescriptor, input: Record<string, unknown>, cwd: string, signal: AbortSignal, host?: ClaudeHookHost, secretSnapshot: string[] = []): Promise<HookResult> {
  if (signal.aborted) throw cancelled();
  const configuration = hook.claude; const handler = configuration?.handler;
  if (!configuration || !handler) throw new Error("Advanced Claude hook configuration is missing");
  // Retain the values actually used for this invocation if environment credentials rotate.
  for (const secret of claudeHookSecrets(hook)) if (!secretSnapshot.includes(secret)) secretSnapshot.push(secret);
  if (handler.type === "http") {
    const headers: Record<string, string> = {};
    for (const [key, template] of Object.entries(handler.headers)) {
      const value = template.replace(/\$(?:\{([A-Za-z_][A-Za-z0-9_]*)\}|([A-Za-z_][A-Za-z0-9_]*))/gu, (_match, braced: string | undefined, plain: string | undefined) => {
        const name = braced ?? plain ?? "";
        return handler.allowedEnvVars.includes(name) ? process.env[name] ?? "" : "";
      });
      if (/[\r\n\0]/u.test(value) || Buffer.byteLength(value) > 16_384) throw new Error("Claude HTTP hook resolved an invalid header value");
      headers[key] = value;
    }
    const response = await oauthNetworkRequest(handler.url, { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(input), signal, maxResponseBytes: MAX_SKILL_BYTES, allowLoopbackOAuthHttp: true });
    if (response.status < 200 || response.status >= 300) throw new Error(`Claude HTTP hook returned status ${response.status}`);
    const output = new TextDecoder("utf-8", { fatal: true }).decode(response.bytes).trim();
    if (output && (!output.startsWith("{") || !output.endsWith("}"))) throw new Error("Claude HTTP hook requires an empty or JSON object response");
    return result(hook, output, claudeHookOutcome(configuration, output, "", 0), secretSnapshot);
  }
  if (handler.type === "mcp_tool") {
    if (!host?.callMcpTool) throw new Error("Claude MCP tool hook requires a trusted host with fresh per-tool approval");
    const response = await host.callMcpTool({ hookId: hook.id, server: handler.server, tool: handler.tool, input: claudeMcpHookInput(handler.input, input), signal });
    if (signal.aborted) throw cancelled();
    if (response.isError) throw new Error("Claude MCP hook tool reported an error");
    const output = response.content.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("\n");
    if (Buffer.byteLength(output) > MAX_SKILL_BYTES) throw new Error("Claude MCP hook result exceeded 65536 bytes");
    return result(hook, output, claudeHookOutcome(configuration, output, "", 0), secretSnapshot);
  }
  if (!host) throw new Error("Claude model hook requires a trusted host with selected provider and approval");
  const evaluation = parseClaudeHookEvaluation(await host.evaluate({ hookId: hook.id, event: configuration.event, type: handler.type, prompt: claudeHookPrompt(handler.prompt, input), input, ...(handler.model ? { model: handler.model } : {}), cwd, maxTurns: handler.type === "agent" ? 50 : 1, signal }), handler.type);
  if (signal.aborted) throw cancelled();
  return result(hook, JSON.stringify(evaluation), modelOutcome(configuration, evaluation), secretSnapshot);
}
