import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { containsKnownSecret, redactKnownSecrets } from "../security/secrets.js";
import { sanitizeTerminalText } from "../security/terminal-text.js";
import type { ProcessSpec } from "./types.js";

export const MAX_CONFIG_BYTES = 128 * 1024;
export const MAX_SKILL_BYTES = 64 * 1024;
export const MAX_MESSAGE_BYTES = 1024 * 1024;
export const MAX_TIMEOUT_MS = 120_000;

export function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

export function keys(value: Record<string, unknown>, allowed: string[], label: string): void {
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`${label}: unsupported field ${key}`);
}

export function string(value: unknown, label: string, max = 4096): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error(`${label} must be a nonempty string without control characters (maximum ${max})`);
  }
  return value;
}

export function identifier(value: unknown, label = "id"): string {
  const result = string(value, label, 128);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(result)) throw new Error(`${label} must use letters, numbers, dot, dash or underscore`);
  return result;
}

export function enabled(value: unknown, fallback = false): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new Error("enabled must be a boolean");
  return value;
}

export function timeout(value: unknown): number {
  if (value === undefined) return 30_000;
  if (typeof value !== "number" || !Number.isInteger(value) || value < 100 || value > MAX_TIMEOUT_MS) {
    throw new Error(`timeoutMs must be an integer from 100 to ${MAX_TIMEOUT_MS}`);
  }
  return value;
}

export async function boundedRead(file: string, maxBytes: number): Promise<string> {
  const handle = await fs.open(file, "r");
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes or is not a regular file: ${file}`);
    const buffer = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > maxBytes) throw new Error(`File exceeds ${maxBytes} bytes: ${file}`);
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
  } finally { await handle.close(); }
}

export function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

export async function containedPath(root: string, candidate: string): Promise<string> {
  const resolved = await fs.realpath(path.resolve(root, candidate));
  if (!inside(root, resolved)) throw new Error(`Extension path must remain inside workspace: ${candidate}`);
  return resolved;
}

export function validateEnvironmentLiteral(key: string, value: unknown): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || key.toLowerCase() === "__proto__") throw new Error("Invalid environment variable name");
  if (/(?:^|_)(?:KEY|APIKEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?|AUTH(?:ORIZATION)?|PRIVATE)(?:_|$)/iu.test(key)) throw new Error("Credential environment values must use envRefs, not literals");
  if (typeof value !== "string" || value.length > 16_384 || value.includes("\0") || containsKnownSecret(value)) throw new Error("Environment values must be bounded non-secret strings without NUL characters");
  // URL connection strings must not smuggle credentials into otherwise public settings.
  for (const match of value.matchAll(/(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s"'<>]+/gu)) {
    let url: URL;
    try { url = new URL(match[0]); } catch { throw new Error("Environment values contain an invalid URL; use envRefs for connection strings"); }
    if (url.username || url.password || [...url.searchParams.keys()].some((name) => /(?:key|token|secret|password|credential|authorization)/iu.test(name))) throw new Error("Credential-bearing URL environment values must use envRefs");
  }
  return value;
}

export async function parseProcess(root: string, value: Record<string, unknown>): Promise<ProcessSpec> {
  const command = string(value.command, "command");
  const argsValue = value.args ?? [];
  if (!Array.isArray(argsValue) || argsValue.length > 64) throw new Error("args must be an array with at most 64 entries");
  const args = argsValue.map((arg) => typeof arg === "string" && !arg.includes("\0") && arg.length <= 16_384 ? arg : (() => { throw new Error("Invalid process argument"); })());
  const envRefs: Record<string, string> = {};
  if (value.envRefs !== undefined) for (const [key, ref] of Object.entries(object(value.envRefs, "envRefs"))) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(key) || key.toLowerCase() === "__proto__") throw new Error("Invalid environment variable name");
    const name = string(ref, "environment reference", 128);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) throw new Error("envRefs values must name environment variables, never contain secret values");
    envRefs[key] = name;
  }
  const env: Record<string, string> = {};
  if (value.env !== undefined) for (const [key, literal] of Object.entries(object(value.env, "env"))) {
    const validated = validateEnvironmentLiteral(key, literal);
    if (Object.keys(envRefs).some((name) => name.toLowerCase() === key.toLowerCase()) || Object.keys(env).some((name) => name.toLowerCase() === key.toLowerCase())) throw new Error("Environment names must be unique across env and envRefs");
    env[key] = validated;
  }
  if (Object.keys(envRefs).length + Object.keys(env).length > 32) throw new Error("At most 32 explicit environment entries may be configured");
  if (new Set(Object.keys(envRefs).map((key) => key.toLowerCase())).size !== Object.keys(envRefs).length) throw new Error("Environment reference names must be unique ignoring case");
  const cwd = await containedPath(root, value.cwd === undefined ? "." : string(value.cwd, "cwd"));
  if (!(await fs.stat(cwd)).isDirectory()) throw new Error("Process cwd must be a directory");
  return { command, args, cwd, envRefs, ...(Object.keys(env).length ? { env } : {}), timeoutMs: timeout(value.timeoutMs) };
}

export function processEnvironment(spec: ProcessSpec): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "COMSPEC", "HOME", "USERPROFILE", "TEMP", "TMP", "LANG", "LC_ALL"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  const assign = (key: string, value: string): void => {
    // Keep explicit overrides deterministic on case-insensitive Windows environments.
    for (const existing of Object.keys(env)) if (existing.toLowerCase() === key.toLowerCase()) delete env[existing];
    env[key] = value;
  };
  for (const [key, value] of Object.entries(spec.env ?? {})) assign(key, value);
  for (const [key, ref] of Object.entries(spec.envRefs)) {
    const value = process.env[ref];
    if (value === undefined) throw new Error(`Required environment variable is not set: ${ref}`);
    assign(key, value);
  }
  return env;
}

export function startProcess(spec: ProcessSpec): ChildProcessWithoutNullStreams {
  return spawn(spec.command, spec.args, { cwd: spec.cwd, env: processEnvironment(spec), shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
}

function waitExit(child: ChildProcessWithoutNullStreams, milliseconds: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); child.off("exit", done); resolve(true); };
    const timer = setTimeout(() => { child.off("exit", done); resolve(false); }, milliseconds);
    child.once("exit", done);
  });
}

export async function stopProcess(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.stdin.end();
  if (await waitExit(child, 100)) return;
  child.kill("SIGTERM");
  if (await waitExit(child, 250)) return;
  child.kill("SIGKILL");
  if (!await waitExit(child, 1000)) throw new Error("Extension process did not terminate");
}

export function publicText(value: string): string {
  return sanitizeTerminalText(redactKnownSecrets(value));
}

export function explicitSecrets(refs: string[]): string[] {
  return [...new Set(refs.map((ref) => process.env[ref]).filter((secret): secret is string => !!secret))].sort((left, right) => right.length - left.length);
}

export function protectedText(value: string, secrets: string[]): string {
  for (const secret of secrets) value = value.replaceAll(secret, "[REDACTED]");
  return publicText(value);
}

export function protectedFailure(error: unknown, secrets: string[]): Error {
  if (error instanceof Error && error.name === "AbortError") return cancelled();
  return new Error(protectedText(error instanceof Error ? error.message : "Extension request failed", secrets).slice(0, 4096));
}

export function cancelled(): Error { return new DOMException("Extension request cancelled", "AbortError"); }

export function missing(error: unknown): boolean { return error instanceof Error && "code" in error && error.code === "ENOENT"; }
