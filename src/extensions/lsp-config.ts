import { containsKnownSecret } from "../security/secrets.js";
import { keys, object, parseProcess, string, timeout, MAX_CONFIG_BYTES } from "./io.js";
import type { ExtensionState, ProcessSpec } from "./types.js";

export interface ParsedLspServer {
  name: string;
  process: ProcessSpec;
  extensionToLanguage: Record<string, string>;
  initializationOptions?: Record<string, unknown>;
  settings?: Record<string, unknown>;
  workspaceFolder?: string;
  startupTimeoutMs: number;
  shutdownTimeoutMs: number;
  requestTimeoutMs: number;
  diagnostics: boolean;
}
export interface LspServerDescriptor extends ExtensionState, ParsedLspServer {}

function jsonOptions(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  const input = object(value, label);
  if (Buffer.byteLength(JSON.stringify(input)) > MAX_CONFIG_BYTES || containsKnownSecret(JSON.stringify(input))) throw new Error(`${label} must be bounded non-secret JSON`);
  return structuredClone(input);
}

/** Parses native HIVE config. Claude aliases are normalized by the marketplace converter. */
export async function parseLspServer(root: string, name: string, raw: unknown): Promise<ParsedLspServer> {
  const value = object(raw, `LSP server ${name}`);
  keys(value, ["command", "args", "cwd", "env", "envRefs", "timeoutMs", "enabled", "extensionToLanguage", "initializationOptions", "settings", "workspaceFolder", "startupTimeoutMs", "shutdownTimeoutMs", "requestTimeoutMs", "diagnostics"], "LSP server");
  const extensions = Object.entries(object(value.extensionToLanguage, "LSP extensionToLanguage"));
  if (!extensions.length || extensions.length > 128) throw new Error("LSP extensionToLanguage must contain 1 through 128 entries");
  const extensionToLanguage: Record<string, string> = {};
  for (const [extension, language] of extensions) {
    if (!/^\.[A-Za-z0-9_.+-]{1,63}$/u.test(extension) || Object.keys(extensionToLanguage).some((key) => key.toLowerCase() === extension.toLowerCase())) throw new Error("LSP extensions must be unique dotted file extensions");
    extensionToLanguage[extension] = string(language, "LSP language ID", 128);
  }
  const { envRefs: _refs, ...literalConfiguration } = value;
  if (containsKnownSecret(JSON.stringify(literalConfiguration))) throw new Error("LSP credentials must use envRefs");
  if (Array.isArray(value.args) && value.args.some((arg) => typeof arg === "string" && /^--?(?:api[-_]?key|token|password|secret|authorization)(?:=|$)/iu.test(arg))) throw new Error("LSP credentials cannot be command-line arguments; use envRefs");
  if (value.diagnostics !== undefined && typeof value.diagnostics !== "boolean") throw new Error("LSP diagnostics must be a boolean");
  const initializationOptions = jsonOptions(value.initializationOptions, "LSP initializationOptions");
  const settings = jsonOptions(value.settings, "LSP settings");
  const workspaceFolder = value.workspaceFolder === undefined ? undefined : string(value.workspaceFolder, "LSP workspaceFolder");
  return { name, process: await parseProcess(root, value), extensionToLanguage,
    ...(initializationOptions === undefined ? {} : { initializationOptions }), ...(settings === undefined ? {} : { settings }), ...(workspaceFolder === undefined ? {} : { workspaceFolder }),
    startupTimeoutMs: value.startupTimeoutMs === undefined ? 30_000 : timeout(value.startupTimeoutMs),
    shutdownTimeoutMs: value.shutdownTimeoutMs === undefined ? 2_000 : timeout(value.shutdownTimeoutMs),
    requestTimeoutMs: value.requestTimeoutMs === undefined ? 30_000 : timeout(value.requestTimeoutMs), diagnostics: value.diagnostics !== false };
}
