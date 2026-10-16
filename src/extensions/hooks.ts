import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import path from "node:path";
import { discoverExtensions } from "./catalog.js";
import { cancelled, MAX_SKILL_BYTES, processEnvironment, protectedText, stopProcess } from "./io.js";
import { claudeHookInput, claudeHookOutcome, claudeHookProcess, matchesClaudeHook } from "./claude-hooks.js";
import { claudeHookSecrets, executeAdvancedClaudeHook } from "./claude-hook-handlers.js";
import type { ExtensionOptions, HookDescriptor, HookEvent, HookResult, RequestOptions } from "./types.js";

class UnsafeHookOutput extends Error {}
class ChangedHookTrust extends Error {}

/** Terminate only this invocation's live process tree; never reuse a completed PID. */
async function stopHookProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  const pid = child.pid;
  if (pid && child.exitCode === null && child.signalCode === null) {
    if (process.platform === "win32") {
      const taskkill = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"), ["/PID", String(pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = () => { if (settled) return; settled = true; clearTimeout(timer); resolve(); };
        const timer = setTimeout(() => { taskkill.kill(); finish(); }, 2000);
        taskkill.once("error", finish); taskkill.once("close", finish);
      });
    } else {
      try { process.kill(-pid, "SIGKILL"); }
      catch (error) { if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error; }
    }
  }
  await stopProcess(child);
}

async function executeHook(hook: HookDescriptor, input: string, cwd: string, options: RequestOptions): Promise<HookResult> {
  if (options.signal?.aborted) throw cancelled();
  if (!hook.process) throw new Error("Command hook requires an executable process");
  const processSpec = hook.process;
  const spec = hook.claude ? await claudeHookProcess(processSpec, hook.claude, cwd) : processSpec;
  if (options.signal?.aborted) throw cancelled();
  const child = spawn(spec.command, spec.args, { cwd: spec.cwd, env: processEnvironment(spec), shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
  const secrets = claudeHookSecrets(hook);
  const stdout: Buffer[] = []; const stderr: Buffer[] = []; let bytes = 0;
  try {
    return await new Promise<HookResult>((resolve, reject) => {
      let settled = false;
      const cleanup = () => { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); };
      const fail = (error: Error) => { if (settled) return; settled = true; cleanup(); reject(error); };
      const abort = () => fail(cancelled());
      const timeoutMs = Math.min(processSpec.timeoutMs, options.timeoutMs ?? processSpec.timeoutMs);
      const timer = setTimeout(() => fail(new Error(`Hook timed out after ${timeoutMs}ms`)), timeoutMs);
      options.signal?.addEventListener("abort", abort, { once: true });
      const receive = (chunks: Buffer[]) => (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_SKILL_BYTES) { fail(new Error("Hook output exceeded 65536 bytes")); return; }
        chunks.push(chunk);
      };
      child.stdout.on("data", receive(stdout)); child.stderr.on("data", receive(stderr));
      child.on("error", fail);
      child.stdin.on("error", (error: NodeJS.ErrnoException) => { if (error.code !== "EPIPE") fail(error); });
      child.on("close", (code) => {
        if (settled) return;
        try {
          const out = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stdout));
          const err = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(stderr));
          const outcome = hook.claude ? claudeHookOutcome(hook.claude, out, err, code) : undefined;
          settled = true; cleanup();
          resolve({ id: hook.id, ok: code === 0, exitCode: code, output: protectedText([out, err].filter(Boolean).join("\n"), secrets) || (code === 0 ? "Hook completed" : `Hook exited with ${code}`),
            ...(outcome ? { ...outcome, ...(outcome.additionalContext ? { additionalContext: protectedText(outcome.additionalContext, secrets).slice(0, 10_000) } : {}), ...(outcome.continuation ? { continuation: protectedText(outcome.continuation, secrets).slice(0, 10_000) } : {}), ...(outcome.diagnostics ? { diagnostics: outcome.diagnostics.map((entry) => protectedText(entry, secrets).slice(0, 10_000)) } : {}) } : {}),
          });
        } catch (error) { fail(new UnsafeHookOutput(error instanceof Error ? error.message : "Invalid hook output")); }
      });
      child.stdin.end(input);
    });
  } finally { await stopHookProcess(child); }
}

/** The caller chooses when lifecycle hooks are appropriate. Discovery never runs them. */
export async function runHooks(cwd: string, event: HookEvent, input: unknown, options: ExtensionOptions & RequestOptions = {}): Promise<HookResult[]> {
  const serialized = JSON.stringify({ event, input });
  if (Buffer.byteLength(serialized) > MAX_SKILL_BYTES) throw new Error("Hook input exceeded 65536 bytes");
  const catalog = await discoverExtensions(cwd, options);
  const results: HookResult[] = [];
  const hasAgentHook = catalog.hooks.some((entry) => entry.event === event && entry.enabled && entry.trusted && entry.claude?.handler?.type === "agent");
  const deadline = AbortSignal.timeout(options.timeoutMs ?? (hasAgentHook ? 120_000 : 30_000));
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  for (const hook of catalog.hooks.filter((entry) => entry.event === event && entry.enabled && entry.trusted)) {
    const secretSnapshot = claudeHookSecrets(hook);
    if (event === "after_tool" && hook.claude && input !== null && typeof input === "object" && "result" in input && input.result !== null && typeof input.result === "object" && "ok" in input.result && input.result.ok === false) continue;
    if (options.signal?.aborted) throw cancelled();
    try {
      const value = hook.claude ? claudeHookInput(hook.claude, input, catalog.root) : undefined;
      if (value && hook.claude && !matchesClaudeHook(hook.claude, value)) continue;
      const hookInput = value ? JSON.stringify(value) : serialized;
      if (Buffer.byteLength(hookInput) > MAX_SKILL_BYTES) throw new Error("Hook input exceeded 65536 bytes");
      const fresh = (await discoverExtensions(cwd, options)).hooks.find((entry) => entry.id === hook.id);
      if (fresh?.blockedReason) throw new ChangedHookTrust(fresh.blockedReason);
      if (!fresh?.trusted || !fresh.enabled || fresh.fingerprint !== hook.fingerprint) throw new ChangedHookTrust("Hook trust or configuration changed before execution; inspect and trust it again");
      if (deadline.aborted) throw new Error("Hook event exceeded its total deadline");
      const runtimeCwd = value && typeof value.cwd === "string" ? value.cwd : catalog.root;
      if (value && hook.claude?.handler) {
        const invocation = new AbortController();
        const invocationSignal = AbortSignal.any([signal, invocation.signal, AbortSignal.timeout(hook.timeoutMs ?? 30_000)]);
        let abort: (() => void) | undefined;
        try {
          const aborted = new Promise<never>((_resolve, reject) => { abort = () => reject(new Error("Claude hook was cancelled or exceeded its deadline")); invocationSignal.addEventListener("abort", abort, { once: true }); if (invocationSignal.aborted) abort(); });
          results.push(await Promise.race([executeAdvancedClaudeHook(hook, value, runtimeCwd, invocationSignal, options.claudeHookHost, secretSnapshot), aborted]));
        } finally { if (abort) invocationSignal.removeEventListener("abort", abort); invocation.abort(); }
      } else results.push(await executeHook(hook, hookInput, runtimeCwd, { ...options, signal }));
    }
    catch (error) {
      if (options.signal?.aborted) throw cancelled();
      const modelHook = hook.claude?.handler?.type === "prompt" || hook.claude?.handler?.type === "agent";
      const gated = event === "before_tool" || event === "prompt_submit" || event === "permission_request";
      results.push({ id: hook.id, ok: false, exitCode: null, output: protectedText(deadline.aborted ? "Hook event exceeded its total deadline" : error instanceof Error ? error.message : "Hook failed", secretSnapshot), ...(hook.claude ? { blocked: gated && (modelHook || error instanceof UnsafeHookOutput || error instanceof ChangedHookTrust || hook.claude.onFailure === "block") } : {}) });
    }
    if (deadline.aborted || results.at(-1)?.stop === true) break;
  }
  return results;
}
