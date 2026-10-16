import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

export const CHECKPOINT_FILE_LIMIT = 2 * 1024 * 1024;
export const CHECKPOINT_BATCH_LIMIT = 8 * 1024 * 1024;
const OUTPUT_LIMIT = 64 * 1024;
const TIMEOUT_MS = 15_000;

function normalizePatchPath(value: string): string {
  if (!value || /[\x00-\x1f<>:"|?*\\]/.test(value) || path.posix.isAbsolute(value) || path.win32.isAbsolute(value)) {
    throw new Error("Patch paths must be exact repository-relative file paths.");
  }
  const parts = value.split("/");
  if (parts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part) || /^\.git$/i.test(part))) {
    throw new Error("Patch contains an unsafe file path.");
  }
  return value;
}

function decodeGitPath(value: string): string {
  if (!value.startsWith('"')) return value;
  if (!value.endsWith('"')) throw new Error("Patch contains an unsupported quoted path.");
  const chunks: Buffer[] = [];
  const quoted = value.slice(1, -1);
  const escapes: Readonly<Record<string, string>> = { a: "\x07", b: "\b", t: "\t", n: "\n", v: "\v", f: "\f", r: "\r", '"': '"', "\\": "\\" };
  let literal = "";
  for (let index = 0; index < quoted.length; index += 1) {
    if (quoted[index] !== "\\") { literal += quoted[index]; continue; }
    chunks.push(Buffer.from(literal));
    literal = "";
    const octal = quoted.slice(index + 1).match(/^[0-7]{1,3}/)?.[0];
    if (octal) {
      const byte = Number.parseInt(octal, 8);
      if (byte > 255) throw new Error("Patch contains an invalid quoted path byte.");
      chunks.push(Buffer.from([byte]));
      index += octal.length;
    } else {
      const escaped = escapes[quoted[++index]];
      if (escaped === undefined) throw new Error("Patch contains an unsupported quoted path escape.");
      chunks.push(Buffer.from(escaped));
    }
  }
  chunks.push(Buffer.from(literal));
  const bytes = Buffer.concat(chunks);
  const decoded = bytes.toString("utf8");
  if (!Buffer.from(decoded).equals(bytes)) throw new Error("Patch contains an invalid UTF-8 path.");
  return decoded;
}

function headerPath(value: string): string | undefined {
  const decoded = decodeGitPath(value.split("\t", 1)[0]);
  if (decoded === "/dev/null") return undefined;
  return normalizePatchPath(decoded.replace(/^[ab]\//, ""));
}

/** Header-looking added or removed text inside a hunk is file content. */
export function extractPatchPaths(patchText: string): string[] {
  const paths = new Set<string>();
  let hunk: { before: number; after: number } | undefined;
  for (const line of patchText.split(/\r?\n/)) {
    if (line === "\\ No newline at end of file") continue;
    if (hunk && (hunk.before > 0 || hunk.after > 0)) {
      if (line[0] === " ") { hunk.before -= 1; hunk.after -= 1; }
      else if (line[0] === "-") hunk.before -= 1;
      else if (line[0] === "+") hunk.after -= 1;
      else throw new Error("Patch contains an incomplete or malformed hunk.");
      if (hunk.before < 0 || hunk.after < 0) throw new Error("Patch hunk line counts do not match its content.");
      continue;
    }
    hunk = undefined;
    if (line.startsWith("@@ ")) {
      const match = line.match(/^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@(?:.*)?$/);
      if (!match) throw new Error("Patch contains an unsupported hunk header.");
      const before = Number(match[1] ?? 1);
      const after = Number(match[2] ?? 1);
      if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after)) throw new Error("Patch hunk line counts are invalid.");
      hunk = { before, after };
    } else if (line.startsWith("diff --git ")) {
      const header = line.slice("diff --git ".length);
      const quoted = header.match(/^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/);
      let pair: string[] | undefined = quoted ? [quoted[1], quoted[2]] : undefined;
      if (!pair && header.startsWith("a/")) {
        // Git leaves spaces unquoted. Repeated ` b/` text is ambiguous unless
        // both sides identify the same path, as ordinary edits/adds/deletes do.
        const candidates = [...header.matchAll(/ b\//g)].map((match) => [header.slice(0, match.index), header.slice(match.index + 1)]);
        const identical = candidates.filter(([before, after]) => before.slice(2) === after.slice(2));
        pair = identical.length === 1 ? identical[0] : candidates.length === 1 ? candidates[0] : undefined;
      }
      if (!pair) throw new Error("Patch contains an unsupported or ambiguous diff header.");
      for (const raw of pair) {
        const file = headerPath(raw);
        if (file) paths.add(file);
      }
    } else if (line.startsWith("--- ") || line.startsWith("+++ ")) {
      const file = headerPath(line.slice(4));
      if (file) paths.add(file);
    } else if (/^(?:GIT binary patch|Binary files .* differ)$/.test(line) || /^(?:new|old)(?: file)? mode (?:120000|160000)$/.test(line)) {
      throw new Error("Binary, symbolic-link, and submodule patches are not supported.");
    }
  }
  if (hunk && (hunk.before > 0 || hunk.after > 0)) throw new Error("Patch contains an incomplete hunk.");
  if (paths.size === 0) throw new Error("Patch does not contain any repository file paths.");
  return [...paths];
}

function projectionEnvironment(stagingDirectory: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (/^GIT_/i.test(key) || /(?:API_KEY|TOKEN|SECRET|PASSWORD|PRIVATE_KEY|AUTHORIZATION)/i.test(key)) continue;
    environment[key] = value;
  }
  // Git ignores a ceiling equal to cwd; the strict parent prevents repository discovery above the private stage.
  return { ...environment, GIT_CEILING_DIRECTORIES: path.dirname(stagingDirectory), GIT_DISCOVERY_ACROSS_FILESYSTEM: "0",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_COUNT: "0", GIT_TERMINAL_PROMPT: "0", GIT_ATTR_NOSYSTEM: "1" };
}

async function applyInStage(stagingDirectory: string, patchText: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn("git", ["-c", "core.autocrlf=false", "-c", "core.safecrlf=false", "apply", "--recount", "--whitespace=nowarn", "-"], {
      cwd: stagingDirectory, env: projectionEnvironment(stagingDirectory), stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    let outputBytes = 0;
    let failure: string | undefined;
    const timer = setTimeout(() => { failure = "Patch projection timed out after 15 seconds."; child.kill("SIGKILL"); }, TIMEOUT_MS);
    const countOutput = (chunk: Buffer): void => {
      outputBytes += chunk.length;
      if (outputBytes > OUTPUT_LIMIT && !failure) { failure = "Patch projection exceeded its bounded output limit."; child.kill("SIGKILL"); }
    };
    child.stdout.on("data", countOutput);
    child.stderr.on("data", countOutput);
    child.stdin.on("error", () => { failure ??= "Patch projection could not send patch input to Git."; });
    child.once("error", () => { clearTimeout(timer); reject(new Error("Patch projection could not start Git.")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (failure || code !== 0) reject(new Error(failure ?? `Patch projection failed (Git exit ${String(code)}).`));
      else resolve();
    });
    child.stdin.end(patchText);
  });
}

/** The caller owns a new, empty, symlink-guarded private staging directory and its cleanup. */
export async function projectPatch(
  originals: ReadonlyMap<string, Buffer | null>,
  patchText: string,
  stagingDirectory: string,
): Promise<ReadonlyMap<string, Buffer | null>> {
  if (originals.size === 0 || originals.size > 128) throw new Error("Patch projection requires between 1 and 128 exact paths.");
  const keys = new Map<string, string>();
  let totalBytes = 0;
  const keyFor = (file: string): string => process.platform === "win32" ? file.toLowerCase() : file;
  for (const [file, bytes] of originals) {
    normalizePatchPath(file);
    const key = keyFor(file);
    if (keys.has(key)) throw new Error("Patch projection paths must be unique.");
    keys.set(key, file);
    if (bytes !== null && (!Buffer.isBuffer(bytes) || bytes.length > CHECKPOINT_FILE_LIMIT)) throw new Error("Patch inputs exceed the 2 MiB checkpoint file limit.");
    totalBytes += bytes?.length ?? 0;
  }
  if (totalBytes > CHECKPOINT_BATCH_LIMIT) throw new Error("Patch inputs exceed the 8 MiB checkpoint snapshot limit.");
  if (extractPatchPaths(patchText).some((file) => !keys.has(keyFor(file)))) throw new Error("Patch projection contains a file outside its declared paths.");
  if ((await fs.readdir(stagingDirectory)).length !== 0) throw new Error("Patch projection staging directory must be empty.");
  for (const [file, bytes] of originals) {
    if (bytes === null) continue;
    const absolute = path.join(stagingDirectory, ...file.split("/"));
    await fs.mkdir(path.dirname(absolute), { recursive: true, mode: 0o700 });
    await fs.writeFile(absolute, bytes, { flag: "wx", mode: 0o600 });
  }
  await applyInStage(stagingDirectory, patchText);
  const found = new Map<string, Buffer>();
  const pending = [""];
  while (pending.length > 0) {
    const directory = pending.pop();
    if (directory === undefined) break;
    for (const entry of await fs.readdir(path.join(stagingDirectory, directory), { withFileTypes: true })) {
      const relative = [directory, entry.name].filter(Boolean).join("/");
      if (entry.isDirectory()) { pending.push(relative); continue; }
      if (!entry.isFile() || !keys.has(keyFor(relative))) throw new Error("Patch projection produced an undeclared or unsupported file.");
      const handle = await fs.open(path.join(stagingDirectory, relative), "r");
      try {
        const stat = await handle.stat();
        if (!stat.isFile() || stat.nlink !== 1 || stat.size > CHECKPOINT_FILE_LIMIT) throw new Error("Patch output exceeds the 2 MiB checkpoint file limit or is not a regular file.");
        totalBytes += stat.size;
        if (totalBytes > CHECKPOINT_BATCH_LIMIT) throw new Error("Patch before/after outputs exceed the 8 MiB checkpoint snapshot limit.");
        const bytes = Buffer.alloc(stat.size + 1);
        let length = 0;
        while (length < bytes.length) {
          const { bytesRead } = await handle.read(bytes, length, bytes.length - length, length);
          if (!bytesRead) break;
          length += bytesRead;
        }
        if (length !== stat.size) throw new Error("Patch output changed during its bounded read.");
        found.set(keyFor(relative), bytes.subarray(0, length));
      } finally { await handle.close(); }
    }
  }
  return new Map([...originals.keys()].map((file) => [file, found.get(keyFor(file)) ?? null]));
}
