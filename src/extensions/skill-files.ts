import { constants, promises as fs } from "node:fs";
import path from "node:path";
import { redactKnownSecrets } from "../security/secrets.js";
import { discoverExtensions, loadSkill, requireActive } from "./catalog.js";
import { inside, MAX_SKILL_BYTES, missing } from "./io.js";
import type { ExtensionOptions } from "./types.js";
export interface SkillReferenceOptions extends ExtensionOptions { scope?: "skill" | "plugin" }

const PRIVATE_SEGMENT = /^(?:\.git|\.hive|\.hivemind|node_modules|\.ssh|\.aws|\.azure|\.gnupg|\.env(?:\..*)?|credentials?(?:[._-].*)?|secrets?(?:[._-].*)?|tokens?(?:[._-].*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?)$/iu;

function assertReferencePath(relativePath: string): void {
  if (typeof relativePath !== "string" || !relativePath.trim() || relativePath.length > 4096 ||
      path.isAbsolute(relativePath) || /^[a-z]:/iu.test(relativePath) || /[\u0000-\u001f\u007f:*?<>|]/u.test(relativePath)) {
    throw new Error("Skill reference requires a relative Markdown or text file path.");
  }
  const segments = relativePath.split(/[\\/]/u);
  if (segments.some((segment) => !segment || segment === "." || segment === ".." || /[. ]$/u.test(segment))) {
    throw new Error("Skill reference path cannot contain traversal or ambiguous path segments.");
  }
  if (segments.some((segment) => PRIVATE_SEGMENT.test(segment))) throw new Error("Skill references cannot read private or internal paths.");
  if (![".md", ".txt"].includes(path.extname(relativePath).toLowerCase())) {
    throw new Error("Skill references must be Markdown (.md) or text (.txt) instruction files.");
  }
}

function stamp(stat: Awaited<ReturnType<typeof fs.lstat>>): string {
  return [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs, stat.mode, stat.nlink].join(":");
}

/** Selected skills can progressively read instructions beside SKILL.md, even from a managed worktree. */
export async function readSkillReference(
  cwd: string,
  skillId: string,
  relativePath: string,
  options: SkillReferenceOptions = {},
): Promise<{ id: string; path: string; content: string }> {
  if (options.scope !== undefined && options.scope !== "skill" && options.scope !== "plugin") throw new Error("Skill reference scope must be skill or plugin.");
  if (options.scope !== "plugin") assertReferencePath(relativePath);
  const skill = await loadSkill(cwd, skillId, options);
  let directory = await fs.realpath(path.dirname(skill.path));
  let pluginIdentity: { id: string; fingerprint: string } | undefined;
  if (options.scope === "plugin") {
    const catalog = await discoverExtensions(cwd, options);
    const selected = catalog.skills.find((entry) => entry.id === skill.id && entry.path === skill.path);
    const plugin = catalog.plugins.find((entry) => entry.id === selected?.pluginId);
    if (!plugin) throw new Error("Plugin reference scope requires a selected skill belonging to a trusted plugin.");
    requireActive(plugin);
    directory = await fs.realpath(plugin.path);
    if (!inside(directory, skill.path)) throw new Error("Selected skill is outside its plugin directory.");
    pluginIdentity = { id: plugin.id, fingerprint: plugin.fingerprint };
    if (typeof relativePath !== "string") throw new Error("Skill reference requires a file path.");
    if (path.isAbsolute(relativePath)) {
      if (!inside(directory, path.resolve(relativePath))) throw new Error("Skill reference must stay inside the selected plugin directory.");
      relativePath = path.relative(directory, relativePath);
    }
    assertReferencePath(relativePath);
  }
  const candidate = path.resolve(directory, ...relativePath.split(/[\\/]/u));
  if (!inside(directory, candidate) || candidate === directory) throw new Error("Skill reference must stay inside the selected skill directory.");
  let real: string;
  try { real = await fs.realpath(candidate); }
  catch (error) { if (missing(error)) throw new Error(`Skill reference does not exist: ${relativePath}`); throw error; }
  if (!inside(directory, real) || real === directory) throw new Error("Skill reference must stay inside the selected skill directory.");
  assertReferencePath(path.relative(directory, real));
  const before = await fs.lstat(real);
  if (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1) throw new Error("Skill reference must be a regular single-link file.");
  if (before.size > MAX_SKILL_BYTES) throw new Error(`Skill reference exceeds the ${MAX_SKILL_BYTES} byte limit.`);
  const handle = await fs.open(real, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    if (stamp(before) !== stamp(await handle.stat())) throw new Error("Skill reference changed while opening; retry the read.");
    const bytes = Buffer.alloc(MAX_SKILL_BYTES + 1);
    let size = 0;
    while (size < bytes.length) {
      const { bytesRead } = await handle.read(bytes, size, bytes.length - size, size);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > MAX_SKILL_BYTES) throw new Error(`Skill reference exceeds the ${MAX_SKILL_BYTES} byte limit.`);
    const after = await fs.lstat(real);
    if (stamp(before) !== stamp(after) || stamp(before) !== stamp(await handle.stat()) || await fs.realpath(candidate) !== real) {
      throw new Error("Skill reference changed while reading; retry the read.");
    }
    let content: string;
    try { content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, size)); }
    catch { throw new Error("Skill reference must contain valid UTF-8 text."); }
    // Recheck trust after I/O so editing SKILL.md cannot keep an in-flight reference authorized.
    const current = await loadSkill(cwd, skill.id, options);
    if (current.path !== skill.path || current.text !== skill.text) throw new Error("Skill changed while reading; inspect and trust it again.");
    if (pluginIdentity) {
      const plugin = (await discoverExtensions(cwd, options)).plugins.find((entry) => entry.id === pluginIdentity.id);
      if (!plugin?.enabled || !plugin.trusted || plugin.fingerprint !== pluginIdentity.fingerprint) throw new Error("Plugin changed while reading; inspect and trust it again.");
    }
    return { id: skill.id, path: real, content: redactKnownSecrets(content) };
  } finally { await handle.close(); }
}
