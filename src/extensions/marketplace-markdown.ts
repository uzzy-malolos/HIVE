import { bundlePath } from "./marketplace-io.js";
import { string } from "./io.js";

/** Claude directory paths permit a trailing slash, while copied file names do not. */
export function componentPaths(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  const entries = Array.isArray(value) ? value : [value];
  if (entries.length > 128) throw new Error(`${label} has too many paths`);
  return entries.map((entry) => {
    const raw = string(entry, label);
    return bundlePath(raw.length > 1 && raw.endsWith("/") ? raw.slice(0, -1) : raw);
  });
}

export function markdownContent(content: string, label: string, warnings: Set<string>): { body: string; description?: string; disableModelInvocation?: boolean; userInvocable?: boolean; argumentHint?: string } {
  if (!/^---\r?\n/u.test(content)) return { body: content };
  const opening = content.indexOf("\n") + 1;
  const remainder = content.slice(opening);
  const closing = /^---[ \t]*(?:\r?\n|$)/mu.exec(remainder);
  if (!closing) throw new Error(`Unterminated Markdown frontmatter: ${label}`);
  const header = remainder.slice(0, closing.index);
  // Claude execution and routing metadata cannot grant permissions or change the
  // selected provider when these files are explicitly selected as HIVE skills.
  for (const key of ["allowed-tools", "model", "context", "agent", "hooks"])
    if (new RegExp(`^${key}:`, "mu").test(header)) warnings.add(`${label}: ${key} is instruction metadata only; HIVE provider, permissions and explicit skill selection apply.`);
  const description = /^description:[ \t]*(.*?)[ \t]*\r?$/mu.exec(header)?.[1];
  const plain = description && !["|", ">", "|-", ">-"].includes(description) ? description.replace(/^(["'])([\s\S]*)\1$/u, "$2") : undefined;
  const booleanField = (key: string): boolean | undefined => {
    const values = [...header.matchAll(new RegExp(`^${key}:[ \\t]*(.*?)[ \\t]*\\r?$`, "gmu"))];
    if (!values.length) return undefined;
    if (values.length !== 1 || !/^(?:true|false)(?:[ \t]+#.*)?$/u.test(values[0][1])) throw new Error(`${label}: ${key} must be a unique boolean`);
    return values[0][1].replace(/[ \t]+#.*$/u, "") === "true";
  };
  const disableModelInvocation = booleanField("disable-model-invocation");
  const userInvocable = booleanField("user-invocable");
  const scalar = (value: string): string => {
    const raw = value.trim();
    if (raw.startsWith('"')) {
      try { const parsed: unknown = JSON.parse(raw); if (typeof parsed === "string") return parsed; } catch { /* Reject below. */ }
      throw new Error(`${label}: invalid quoted argument metadata`);
    }
    if (raw.startsWith("'")) { if (raw.length > 1 && raw.endsWith("'")) return raw.slice(1, -1).replaceAll("''", "'"); throw new Error(`${label}: invalid quoted argument metadata`); }
    if (/^[&*!{\[]/u.test(raw)) throw new Error(`${label}: complex argument metadata is unsupported`);
    return raw.replace(/[ \t]+#.*$/u, "").trim();
  };
  const argumentHints = [...header.matchAll(/^argument-hint:[ \t]*(.*?)[ \t]*\r?$/gmu)];
  if (argumentHints.length > 1) throw new Error(`${label}: argument-hint must be unique`);
  const argumentHint = argumentHints.length ? scalar(argumentHints[0][1]) : undefined;
  if (argumentHint !== undefined && (argumentHint.length > 1024 || /[\u0000-\u001f\u007f]/u.test(argumentHint))) throw new Error(`${label}: argument-hint must be bounded text`);
  if (/^[ \t]*(?:arguments|"arguments"|'arguments')[ \t]*:/mu.test(header)) throw new Error(`${label}: named skill arguments are unsupported; rewrite using positional placeholders before import`);
  return { body: remainder.slice(closing.index + closing[0].length), ...(plain ? { description: plain } : {}), ...(disableModelInvocation === undefined ? {} : { disableModelInvocation }), ...(userInvocable === undefined ? {} : { userInvocable }), ...(argumentHint === undefined ? {} : { argumentHint }) };
}

/** Body interpolation is deterministic and becomes part of the installed tree hash. */
export function pluginMarkdown(content: string, destination: string, label: string): string {
  if (/\$\{(?:CLAUDE_PLUGIN_DATA|CLAUDE_PROJECT_DIR|user_config\.)/u.test(content)) throw new Error(`${label} uses unsupported Claude data, project or user configuration interpolation`);
  return content.replaceAll("${CLAUDE_PLUGIN_ROOT}", destination.replaceAll("\\", "/"));
}
