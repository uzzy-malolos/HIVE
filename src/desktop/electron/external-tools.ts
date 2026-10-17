import { execFile as nodeExecFile } from "node:child_process";
import { constants as fsConstants, promises as fs } from "node:fs";
import path from "node:path";
import type { DesktopOpenEditorRequest, DesktopOpenExplorerRequest } from "../types.js";

function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function rejectProtocol(value: string): void {
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(value) || value.startsWith("file:")) throw new Error("URLs and protocols are not accepted as workspace paths.");
}

export async function resolveWorkspaceTarget(repositoryRoot: string, target = ".", options: { mustExist?: boolean } = {}): Promise<string> {
  if (typeof repositoryRoot !== "string" || !path.isAbsolute(repositoryRoot)) throw new Error("Repository root must be absolute.");
  if (typeof target !== "string" || target.length === 0 || target.includes("\0")) throw new Error("Workspace target is invalid.");
  rejectProtocol(target);
  const canonicalRoot = await fs.realpath(repositoryRoot);
  const resolved = path.resolve(canonicalRoot, target);
  if (!contained(canonicalRoot, resolved)) throw new Error("Workspace target is outside the selected repository.");
  const relative = path.relative(canonicalRoot, resolved).replaceAll("\\", "/");
  if (relative === ".git" || relative.startsWith(".git/")) throw new Error("Protected Git metadata cannot be opened.");
  if (options.mustExist !== false) {
    const canonicalTarget = await fs.realpath(resolved);
    if (!contained(canonicalRoot, canonicalTarget)) throw new Error("Workspace target resolves outside the selected repository.");
    return canonicalTarget;
  }
  return resolved;
}

type ExecFileRunner = (file: string, args: readonly string[], options?: { cwd?: string; windowsHide?: boolean }) => Promise<void>;

export interface TrustedExecutableResolver { resolve(name: "code" | "cursor" | "devenv" | "wt" | "explorer" | "git" | "gh", repositoryRoot: string): Promise<string> }

export function assertTrustedExecutablePath(repositoryRoot: string, executable: string): string {
  if (!path.isAbsolute(executable) || contained(path.resolve(repositoryRoot), path.resolve(executable))) throw new Error("Refusing to launch an untrusted repository executable.");
  return executable;
}

function defaultExecFile(file: string, args: readonly string[], options?: { cwd?: string; windowsHide?: boolean }): Promise<void> {
  return new Promise((resolve, reject) => nodeExecFile(file, [...args], options ?? {}, (error) => error ? reject(error) : resolve()));
}

type TrustedExecutableName = Parameters<TrustedExecutableResolver["resolve"]>[0];

/** Command names on Linux and macOS; Windows Terminal, Explorer and Visual Studio have no equivalent here. */
const POSIX_COMMANDS: Partial<Record<TrustedExecutableName, string>> = { git: "git", gh: "gh", code: "code", cursor: "cursor" };

/**
 * Searched after PATH. Apps launched from the macOS Finder or a Linux desktop entry get a minimal
 * PATH, so Homebrew, MacPorts and snap installs would otherwise be missed.
 */
const POSIX_FALLBACK_DIRECTORIES = ["/usr/local/bin", "/opt/homebrew/bin", "/opt/local/bin", "/usr/bin", "/bin", "/snap/bin"];

export interface SystemTrustedExecutableResolverOptions {
  platform?: NodeJS.Platform;
  searchPath?: string;
  fallbackDirectories?: readonly string[];
}

export class SystemTrustedExecutableResolver implements TrustedExecutableResolver {
  readonly #platform: NodeJS.Platform;
  readonly #searchPath: string;
  readonly #fallbackDirectories: readonly string[];

  public constructor(options: SystemTrustedExecutableResolverOptions = {}) {
    this.#platform = options.platform ?? process.platform;
    this.#searchPath = options.searchPath ?? process.env.PATH ?? "";
    this.#fallbackDirectories = options.fallbackDirectories ?? POSIX_FALLBACK_DIRECTORIES;
  }

  public async resolve(name: TrustedExecutableName, repositoryRoot: string): Promise<string> {
    const root = await fs.realpath(repositoryRoot);
    return this.#platform === "win32" ? this.#resolveWindows(name, root) : this.#resolvePosix(name, root);
  }

  /**
   * Walks PATH, then the fallback directories, without a shell. Relative PATH entries are skipped
   * because they resolve against the working directory, which may be the repository, and any
   * candidate whose real path lands inside the repository is passed over.
   */
  async #resolvePosix(name: TrustedExecutableName, root: string): Promise<string> {
    const command = POSIX_COMMANDS[name];
    if (!command) throw new Error(`Trusted executable ${name} is only available on Windows.`);
    const seen = new Set<string>();
    for (const directory of [...this.#searchPath.split(path.delimiter), ...this.#fallbackDirectories]) {
      if (!directory || !path.isAbsolute(directory) || seen.has(directory)) continue;
      seen.add(directory);
      try {
        const candidate = await fs.realpath(path.join(directory, command));
        if (contained(root, candidate) || !(await fs.stat(candidate)).isFile()) continue;
        await fs.access(candidate, fsConstants.X_OK);
        return candidate;
      } catch { /* Missing or not executable here; try the next directory. */ }
    }
    throw new Error(`Trusted executable ${name} is unavailable outside the selected repository.`);
  }

  async #resolveWindows(name: TrustedExecutableName, root: string): Promise<string> {
    const systemRoot = this.#outside(root, await fs.realpath(process.env.SystemRoot || "C:\\Windows"));
    if (name === "explorer") return this.#outside(root, await fs.realpath(path.join(systemRoot, "explorer.exe")));
    const where = this.#outside(root, await fs.realpath(path.join(systemRoot, "System32", "where.exe")));
    const query = name === "code" ? "Code.exe" : name === "cursor" ? "Cursor.exe" : name === "devenv" ? "devenv.exe" : name === "wt" ? "wt.exe" : name === "git" ? "git.exe" : "gh.exe";
    const output = await new Promise<string>((resolve, reject) => nodeExecFile(where, [query], { cwd: systemRoot, windowsHide: true }, (error, stdout) => error ? reject(new Error(`Trusted executable ${name} is unavailable.`)) : resolve(String(stdout))));
    const candidates = output.split(/\r?\n/).map((entry) => entry.trim()).filter(Boolean);
    for (const candidate of candidates) {
      try { return this.#outside(root, await fs.realpath(candidate)); } catch { /* Try the next system lookup result. */ }
    }
    throw new Error(`Trusted executable ${name} is unavailable outside the selected repository.`);
  }

  #outside(repositoryRoot: string, executable: string): string {
    if (contained(repositoryRoot, executable)) throw new Error("Refusing to launch an executable from the selected repository.");
    if (!path.isAbsolute(executable)) throw new Error("Trusted executable resolution must return an absolute path.");
    return executable;
  }
}

export class DesktopExternalToolService {
  public constructor(
    private readonly editor: "vscode" | "cursor" | "visual-studio" = "vscode",
    private readonly execFile: ExecFileRunner = defaultExecFile,
    private readonly executables: TrustedExecutableResolver = new SystemTrustedExecutableResolver(),
  ) {}

  public async openEditor(input: DesktopOpenEditorRequest): Promise<void> {
    const root = await resolveWorkspaceTarget(input.repositoryRoot);
    const target = input.path ? await resolveWorkspaceTarget(root, input.path) : root;
    const location = input.line ? `${target}:${input.line}${input.column ? `:${input.column}` : ""}` : target;
    const executableName = this.editor === "cursor" ? "cursor" : this.editor === "visual-studio" ? "devenv" : "code";
    const executable = assertTrustedExecutablePath(root, await this.executables.resolve(executableName, root));
    const args = this.editor === "visual-studio" ? [target] : ["--reuse-window", "--goto", location];
    await this.execFile(executable, args, { cwd: root, windowsHide: true });
  }

  public async openTerminal(repositoryRoot: string): Promise<void> {
    const root = await resolveWorkspaceTarget(repositoryRoot);
    await this.execFile(assertTrustedExecutablePath(root, await this.executables.resolve("wt", root)), ["-d", root], { cwd: root, windowsHide: true });
  }

  public async openExplorer(input: DesktopOpenExplorerRequest): Promise<void> {
    const root = await resolveWorkspaceTarget(input.repositoryRoot);
    const target = input.path ? await resolveWorkspaceTarget(root, input.path) : root;
    const stat = await fs.stat(target);
    await this.execFile(assertTrustedExecutablePath(root, await this.executables.resolve("explorer", root)), stat.isDirectory() ? [target] : ["/select,", target], { cwd: root, windowsHide: true });
  }
}
