import fs from "node:fs/promises";
import path from "node:path";

export interface ScopedInstruction {
  /** Canonical source path, relative to the canonical workspace root. */
  path: string;
  content: string;
}

export const MAX_INSTRUCTION_FILE_CHARS = 20_000;
export const MAX_INSTRUCTION_TOTAL_CHARS = 60_000;
const MAX_INSTRUCTION_BYTES = MAX_INSTRUCTION_FILE_CHARS * 4;
const TRUNCATED = "\n...[instructions truncated]";
const TOTAL_TRUNCATED = "\n...[instruction budget exhausted]";
const ROOT_INSTRUCTIONS = [
  ".github/copilot-instructions.md",
  ".claude/CLAUDE.md",
  "CLAUDE.md",
  ".codex/instructions.md",
  "HIVE.md",
];

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function canonicalKey(value: string): string {
  return process.platform === "win32" ? value.toLowerCase() : value;
}

function clipped(content: string, limit: number, truncated: boolean): string {
  if (!truncated && content.length <= limit) return content;
  const room = Math.max(0, limit - TRUNCATED.length);
  const prefix = content.slice(0, room).replace(/[\ud800-\udbff]$/, "");
  return prefix + TRUNCATED.slice(0, Math.max(0, limit - prefix.length));
}

function instructionHeader(source: string): string {
  return `--- Instructions from ${source} ---\n`;
}

export function formatWorkspaceInstructions(instructions: readonly ScopedInstruction[]): string | null {
  return instructions.length > 0
    ? instructions.map((item) => instructionHeader(item.path) + item.content).join("\n\n")
    : null;
}

async function readInstruction(root: string, directory: string, name: string): Promise<ScopedInstruction | null> {
  const source = path.join(directory, name);
  try {
    await fs.lstat(source);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new Error(`Unable to inspect instruction file ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const canonical = await fs.realpath(source);
    // Ancestor guidance is explicitly discovered; project symlinks cannot add outside policy.
    const boundary = inside(root, directory) ? root : directory;
    if (!inside(boundary, canonical)) throw new Error("symlink escapes its instruction scope");
    if (!(await fs.stat(canonical)).isFile()) throw new Error("instruction source must be a regular file");
    const handle = await fs.open(canonical, "r");
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error("instruction source must be a regular file");
      const bytes = Buffer.alloc(Math.min(stat.size, MAX_INSTRUCTION_BYTES));
      let bytesRead = 0;
      while (bytesRead < bytes.length) {
        const next = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
        if (next.bytesRead === 0) break;
        bytesRead += next.bytesRead;
      }
      const data = bytes.subarray(0, bytesRead);
      const encoding = data[0] === 0xff && data[1] === 0xfe ? "utf-16le"
        : data[0] === 0xfe && data[1] === 0xff ? "utf-16be" : "utf-8";
      const content = new TextDecoder(encoding, { fatal: true }).decode(data, { stream: stat.size > bytesRead });
      return {
        path: path.relative(root, canonical).replace(/\\/g, "/"),
        content: clipped(content, MAX_INSTRUCTION_FILE_CHARS, stat.size > bytesRead),
      };
    } finally {
      await handle.close();
    }
  } catch (error) {
    throw new Error(`Unable to read instruction file ${source}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

async function scopedDirectories(root: string, fileScope: readonly string[]): Promise<string[]> {
  const directories = new Set<string>();
  for (const scope of fileScope) {
    if (!scope.trim() || path.isAbsolute(scope) || path.win32.parse(scope).root || /[*?[\]\0]/.test(scope)) {
      throw new Error(`Instruction scope must be an exact relative path: ${scope}`);
    }
    const target = path.resolve(root, scope.replace(/\\/g, "/"));
    if (!inside(root, target)) throw new Error(`Instruction scope escapes the workspace: ${scope}`);
    let directory = path.dirname(target);
    try {
      const stat = await fs.stat(target);
      const canonical = await fs.realpath(target);
      if (!inside(root, canonical)) throw new Error(`Instruction scope symlink escapes the workspace: ${scope}`);
      if (stat.isDirectory()) directory = target;
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    while (directory !== root) {
      try {
        const canonical = await fs.realpath(directory);
        if (!inside(root, canonical)) throw new Error(`Instruction scope symlink escapes the workspace: ${scope}`);
      } catch (error) {
        if (!isMissing(error)) throw error;
      }
      directories.add(directory);
      directory = path.dirname(directory);
    }
  }
  return [...directories].sort((left, right) => {
    const depth = (value: string) => path.relative(root, value).split(path.sep).length;
    return depth(left) - depth(right) || (left < right ? -1 : left > right ? 1 : 0);
  });
}

/** Recognized instructions only, ordered from ancestors to the nearest declared file scopes. */
export async function loadScopedInstructions(workspaceRoot: string, fileScope: readonly string[] = []): Promise<ScopedInstruction[]> {
  const root = await fs.realpath(path.resolve(workspaceRoot));
  const ancestors: string[] = [];
  for (let directory = root;; directory = path.dirname(directory)) {
    ancestors.unshift(directory);
    if (path.dirname(directory) === directory) break;
  }
  const nested = await scopedDirectories(root, fileScope);
  const instructions: ScopedInstruction[] = [];
  const seen = new Set<string>();
  let used = 0;
  for (const directory of [...ancestors, ...nested]) {
    const names = directory === root ? [...ROOT_INSTRUCTIONS] : nested.includes(directory) ? ["HIVE.md"] : [];
    const override = await readInstruction(root, directory, "AGENTS.override.md");
    const agent = override ?? await readInstruction(root, directory, "AGENTS.md");
    const local: ScopedInstruction[] = [];
    for (const name of names) {
      const item = await readInstruction(root, directory, name);
      if (item) local.push(item);
    }
    if (agent) local.push(agent);
    for (const item of local) {
      const key = canonicalKey(item.path);
      if (!item.content.trim()) continue;
      if (seen.has(key)) {
        const earlier = instructions.findIndex((instruction) => canonicalKey(instruction.path) === key);
        if (earlier >= 0) instructions.splice(earlier, 1);
        used = formatWorkspaceInstructions(instructions)?.length ?? 0;
      }
      seen.add(key);
      const overhead = instructionHeader(item.path).length + (instructions.length > 0 ? 2 : 0);
      const remaining = MAX_INSTRUCTION_TOTAL_CHARS - used - overhead - TOTAL_TRUNCATED.length;
      if (remaining < TRUNCATED.length) {
        const last = instructions.at(-1);
        if (last) last.content = last.content.slice(0, MAX_INSTRUCTION_FILE_CHARS - TOTAL_TRUNCATED.length).replace(/[\ud800-\udbff]$/, "") + TOTAL_TRUNCATED;
        return instructions;
      }
      const content = clipped(item.content, Math.min(MAX_INSTRUCTION_FILE_CHARS, remaining), false);
      instructions.push({ path: item.path, content });
      used += overhead + content.length;
    }
  }
  return instructions;
}

export async function loadWorkspaceInstructions(workspaceRoot: string, fileScope: readonly string[] = []): Promise<string | null> {
  return formatWorkspaceInstructions(await loadScopedInstructions(workspaceRoot, fileScope));
}
