import path from "node:path";
import { StructuredAgentLoop, BUILTIN_AGENT_TOOL_NAMES, type AgentLoopOptions, type AgentLoopResult, type AgentToolExecutor } from "../coding/agent-loop.js";
import type { ExtensionState } from "./types.js";
import { identifier, MAX_SKILL_BYTES, cancelled } from "./io.js";

export interface ParsedPluginAgent {
  name: string;
  path: string;
  description: string;
  instructions: string;
  tools?: string[];
  disallowedTools?: string[];
  /** Declaration only. Invocation always preserves the caller's selected provider/model. */
  model?: string;
  maxTurns?: number;
  /** Trusted skill contents are resolved by the runtime when this agent is selected. */
  skills?: string[];
  metadata: Record<string, string | string[] | boolean | number>;
  warnings: string[];
}
export interface PluginAgentDescriptor extends ExtensionState, ParsedPluginAgent {}

function scalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"')) {
    try { const parsed: unknown = JSON.parse(trimmed); if (typeof parsed === "string") return parsed; } catch { /* Fail below. */ }
    throw new Error("Agent frontmatter contains an invalid quoted string");
  }
  if (trimmed.startsWith("'")) {
    if (!trimmed.endsWith("'") || trimmed.length < 2) throw new Error("Agent frontmatter contains an invalid quoted string");
    return trimmed.slice(1, -1).replaceAll("''", "'");
  }
  if (/^[&*!{]/u.test(trimmed) || /\s+[&*][A-Za-z]/u.test(trimmed)) throw new Error("Agent frontmatter YAML aliases, tags and objects are unsupported");
  return trimmed.replace(/\s+#.*$/u, "").trim();
}

/** A bounded YAML scalar/list/block subset; never evaluates YAML tags or aliases. */
function frontmatter(text: string): { header: Map<string, string | string[]>; body: string } {
  if (!/^---\r?\n/u.test(text)) throw new Error("Agent Markdown requires YAML frontmatter");
  const opening = text.indexOf("\n") + 1;
  const end = /^---[ \t]*(?:\r?\n|$)/mu.exec(text.slice(opening));
  if (!end) throw new Error("Agent Markdown has unterminated frontmatter");
  const lines = text.slice(opening, opening + end.index).split(/\r?\n/u);
  if (lines.length > 256) throw new Error("Agent frontmatter exceeds 256 lines");
  const header = new Map<string, string | string[]>();
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim() || /^\s*#/u.test(line)) continue;
    const match = /^([A-Za-z][A-Za-z0-9_-]*):[ \t]*(.*)$/u.exec(line);
    if (!match || header.has(match[1])) throw new Error("Agent frontmatter requires unique top-level scalar or list fields");
    const [, key, raw] = match;
    if (key === "hooks" || key === "mcpServers") {
      // Claude deliberately ignores these fields for plugin agents. Preserve the
      // bounded source without evaluating YAML or granting its capabilities.
      const ignored = [raw];
      while (index + 1 < lines.length && (/^\s/u.test(lines[index + 1]) || !lines[index + 1].trim())) ignored.push(lines[++index]);
      header.set(key, ignored.join("\n").trim());
    } else if (["|", ">", "|-", ">-", "|+", ">+"].includes(raw.trim())) {
      const block: string[] = [];
      while (index + 1 < lines.length && (/^\s/u.test(lines[index + 1]) || !lines[index + 1].trim())) block.push(lines[++index]);
      const indentation = Math.min(...block.filter((part) => part.trim()).map((part) => /^ */u.exec(part)?.[0].length ?? 0));
      const content = block.map((part) => part.slice(Number.isFinite(indentation) ? indentation : 0));
      header.set(key, raw.startsWith(">") ? content.join(" ").trim() : content.join("\n").trim());
    } else if (!raw.trim()) {
      const entries: string[] = [];
      while (index + 1 < lines.length && /^\s+-[ \t]+/u.test(lines[index + 1])) entries.push(scalar(lines[++index].replace(/^\s+-[ \t]+/u, "")));
      header.set(key, entries);
    } else if (raw.trim().startsWith("[")) {
      const source = raw.trim();
      if (!source.endsWith("]")) throw new Error("Agent frontmatter list must close on the same line");
      header.set(key, source.slice(1, -1).split(",").filter((entry) => entry.trim()).map(scalar));
    } else header.set(key, scalar(raw));
    if (header.size > 32) throw new Error("Agent frontmatter exceeds 32 fields");
  }
  return { header, body: text.slice(opening + end.index + end[0].length).trim() };
}

const toolAliases: Readonly<Record<string, readonly string[]>> = {
  Read: ["read_file"], Glob: ["list_directory"], Grep: ["search_text", "search_symbols"],
  Write: ["create_file", "write_file"], Edit: ["edit_file", "apply_patch"],
  Bash: ["run_command", "run_test", "read_command_output"], Skill: ["read_skill_reference"],
  LSP: ["lsp__*"],
};

function toolsField(value: string | string[] | undefined, field: string): string[] | undefined {
  if (value === undefined) return undefined;
  const entries = typeof value === "string" ? value.split(",").map((entry) => entry.trim()) : value;
  if (entries.length > 128 || entries.some((entry) => !entry || entry.length > 256)) throw new Error(`Agent ${field} must contain at most 128 bounded tool names`);
  for (const entry of entries) {
    const base = entry.replace(/\(.*\)$/u, "");
    if (base !== entry && field === "tools") throw new Error("Agent allowed tool specifiers require unsupported argument policies; use whole tool names and HIVE permissions");
    if (!Object.hasOwn(toolAliases, base) && !/^(?:mcp__|mcp_context__|lsp__)[A-Za-z0-9_.*-]+$/u.test(base) && !(BUILTIN_AGENT_TOOL_NAMES as readonly string[]).includes(base) && base !== "read_skill_reference") throw new Error(`Unsupported agent tool: ${entry}`);
  }
  return [...new Set(entries)];
}

export function parsePluginAgent(text: string, file: string, relativePluginPath = file): ParsedPluginAgent {
  if (Buffer.byteLength(text) > MAX_SKILL_BYTES || text.includes("\0")) throw new Error(`Agent Markdown exceeds ${MAX_SKILL_BYTES} bytes or contains NUL`);
  const { header, body } = frontmatter(text);
  const allowed = new Set(["name", "description", "tools", "disallowedTools", "model", "maxTurns", "effort", "color", "skills", "memory", "background", "isolation", "permissionMode", "omitClaudeMd", "autoCompactWindow", "hooks", "mcpServers", "initialPrompt"]);
  for (const key of header.keys()) if (!allowed.has(key)) throw new Error(`Unsupported agent frontmatter field: ${key}`);
  const declaredName = identifier(header.get("name") ?? path.basename(file, ".md"), "agent name");
  const normalizedPath = relativePluginPath.replaceAll("\\", "/").replace(/^\.\//u, "");
  const directories = normalizedPath.startsWith("agents/") ? normalizedPath.split("/").slice(1, -1) : [];
  const name = [...directories.map((directory) => identifier(directory, "agent namespace")), declaredName].join(".");
  identifier(name, "namespaced agent name");
  const description = header.get("description");
  if (typeof description !== "string" || !description.trim() || description.length > 4096 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(description)) throw new Error("Agent description must be nonempty text up to 4096 characters");
  if (!body) throw new Error("Agent instructions must be nonempty");
  const model = header.get("model");
  if (model !== undefined && (typeof model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,255}$/u.test(model))) throw new Error("Agent model must be a bounded model identifier");
  const turns = header.get("maxTurns");
  const maxTurns = turns === undefined ? undefined : typeof turns === "string" && /^\d+$/u.test(turns) ? Number(turns) : NaN;
  if (maxTurns !== undefined && (!Number.isInteger(maxTurns) || maxTurns < 1 || maxTurns > 128)) throw new Error("Agent maxTurns must be an integer from 1 to 128");
  const rawSkills = header.get("skills");
  const skills = rawSkills === undefined ? undefined : [...new Set(typeof rawSkills === "string" ? rawSkills.split(",").map((entry) => entry.trim()) : rawSkills)];
  if (skills !== undefined && (skills.length > 32 || skills.some((entry) => !/^(?:skill:)?[A-Za-z0-9][A-Za-z0-9_.-]{0,127}(?::[A-Za-z0-9][A-Za-z0-9_.-]{0,127})?$/u.test(entry)))) throw new Error("Agent skills must contain at most 32 distinct skill names or plugin:skill references");
  const metadata: ParsedPluginAgent["metadata"] = {};
  const warnings: string[] = [];
  for (const [key, value] of header) {
    if (["name", "description", "tools", "disallowedTools", "model", "maxTurns", "skills"].includes(key)) continue;
    metadata[key] = value;
    warnings.push(["hooks", "mcpServers", "permissionMode"].includes(key)
      ? `Agent ${String(name)}: ${key} is ignored for plugin agents, as in Claude Code; it cannot start processes, expose private servers or override HIVE permissions.`
      : `Agent ${String(name)}: ${key} is retained as metadata; HIVE's selected runtime, permissions, workspace and lifecycle apply.`);
  }
  if (model !== undefined && model !== "inherit") warnings.push(`Agent ${String(name)}: declared model ${model} is metadata; the explicitly selected HIVE provider/model is preserved.`);
  return { name: String(name), path: file, description, instructions: body, tools: toolsField(header.get("tools"), "tools"), disallowedTools: toolsField(header.get("disallowedTools"), "disallowedTools"), ...(model === undefined ? {} : { model }), ...(maxTurns === undefined ? {} : { maxTurns }), ...(skills === undefined ? {} : { skills }), metadata, warnings };
}

function matchesTool(pattern: string, name: string): boolean {
  const base = pattern.replace(/\(.*\)$/u, "");
  if (name.length > 1024) return false;
  return (toolAliases[base] ?? [base]).some((entry) => {
    // Bounded glob matching avoids exponential regex backtracking on repeated '*a'.
    let patternIndex = 0, nameIndex = 0, starIndex = -1, matchedAfterStar = 0;
    while (nameIndex < name.length) {
      if (entry[patternIndex] === "*") { starIndex = patternIndex++; matchedAfterStar = nameIndex; }
      else if (entry[patternIndex] === name[nameIndex]) { patternIndex += 1; nameIndex += 1; }
      else if (starIndex >= 0) { patternIndex = starIndex + 1; nameIndex = ++matchedAfterStar; }
      else return false;
    }
    while (entry[patternIndex] === "*") patternIndex += 1;
    return patternIndex === entry.length;
  });
}

/** Restricts both advertisement and execution; never substitutes repository tool policy. */
export function restrictPluginAgentTools(agent: Pick<ParsedPluginAgent, "tools" | "disallowedTools">, base: AgentToolExecutor, revalidate?: () => Promise<void>): AgentToolExecutor {
  const permitted = (name: string) => (agent.tools === undefined || agent.tools.some((pattern) => matchesTool(pattern, name))) && !(agent.disallowedTools ?? []).some((pattern) => matchesTool(pattern, name));
  return {
    get builtinToolNames() { return (base.builtinToolNames ?? BUILTIN_AGENT_TOOL_NAMES).filter(permitted); },
    get toolDefinitions() { return base.toolDefinitions?.filter((tool) => permitted(tool.name)); },
    async refreshToolDefinitions(signal) { if (signal.aborted) throw cancelled(); await revalidate?.(); await base.refreshToolDefinitions?.(signal); },
    ...(base.drainNotifications ? { drainNotifications: () => base.drainNotifications!() } : {}),
    async execute(name, args, task, signal, context) {
      if (signal.aborted) throw cancelled();
      await revalidate?.();
      if (!permitted(name)) return { ok: false, output: `Tool ${name} is denied by the selected agent's tool restrictions.` };
      return base.execute(name, args, task, signal, context);
    },
    ...(base.close ? { close: () => base.close!() } : {}),
  };
}

export interface PluginAgentRunOptions extends AgentLoopOptions {
  agent: PluginAgentDescriptor;
  /** Reload and compare the trusted descriptor before every provider/tool invocation. */
  revalidate: () => Promise<void>;
}

/** Runs a genuine agent loop with the caller's provider, file jail and approval policy. */
export async function runPluginAgent(options: PluginAgentRunOptions): Promise<AgentLoopResult> {
  if (!options.agent.trusted || !options.agent.enabled) throw new Error("The selected plugin agent must be trusted and enabled");
  const check = async () => { if (options.signal.aborted) throw cancelled(); await options.revalidate(); if (options.signal.aborted) throw cancelled(); };
  await check();
  const client = options.completionClient;
  const instructions = `\n\nExplicitly selected plugin agent ${JSON.stringify(options.agent.id)}. Use these specialist instructions within HIVE's tool, permission and workspace policies:\n${options.agent.instructions}`;
  const completionClient: PluginAgentRunOptions["completionClient"] = {
    async complete(request) { await check(); return client.complete({ ...request, systemPrompt: request.systemPrompt + instructions }); },
    ...(client.streamComplete ? { async streamComplete(request, onChunk) { await check(); return client.streamComplete!({ ...request, systemPrompt: request.systemPrompt + instructions }, onChunk); } } : {}),
  };
  return new StructuredAgentLoop().run({ ...options, completionClient, tools: restrictPluginAgentTools(options.agent, options.tools, check), maxTurns: Math.min(options.maxTurns ?? 16, options.agent.maxTurns ?? 128) });
}
