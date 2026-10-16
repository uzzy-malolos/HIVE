import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import { ProviderRouter } from "./provider-router.js";
import {
  QueenOrchestrator,
  createCodingSessionId,
  type QueenSessionOptions,
  type QueenToolFactory,
} from "./queen.js";
import { findRepositoryRoot } from "./repository.js";
import { CodingSessionStore } from "./session-store.js";
import { RepositoryToolService } from "./tools.js";
import { createExtensionToolExecutor } from "./extension-tools.js";
import type { RuntimeEvent, RuntimeEventType } from "./types.js";
import { WorktreeManager, branchNameForTask } from "../worktree.js";
import { rawWorkspaceFingerprint } from "./workspace-fingerprint.js";
import { discoverExtensions, loadPluginAgent, loadSkill, loadTrustedPluginOutputStyle } from "../extensions/catalog.js";
import { createCodingMcpHostFactory } from "./mcp-host.js";
import { createCodingClaudeHookHost } from "./claude-hook-host.js";
import type { ExtensionOptions } from "../extensions/types.js";

const execFileAsync = promisify(execFile);

/** Lazy capabilities also serve startup hooks before a Queen exists. */
export function createCodingExtensionOptions(options: Pick<QueenSessionOptions, "repositoryPath" | "sessionId" | "resumeId" | "continuationId" | "providerOverride" | "roleOverrides" | "requestToolPermission" | "requestMcpInput" | "extensionOptions" | "providerRegistries">, router?: Pick<ProviderRouter, "resolve" | "complete">): ExtensionOptions {
  let pendingRouter: Promise<ProviderRouter> | undefined;
  const resolveRouter = () => pendingRouter ??= (async () => {
    const projectRoot = await findRepositoryRoot(options.repositoryPath);
    const previousId = options.resumeId ?? options.continuationId;
    const saved = previousId ? await new CodingSessionStore(projectRoot).load(previousId) : undefined;
    if (previousId && !saved) throw new Error(`Coding session ${previousId} not found.`);
    return new ProviderRouter({ projectRoot, sessionId: previousId ?? options.sessionId ?? createCodingSessionId(), sessionBindings: saved?.providerBindings, projectRegistry: options.providerRegistries?.project, globalRegistry: options.providerRegistries?.global });
  })();
  const actualRouter = router ?? {
    async resolve(...args: Parameters<ProviderRouter["resolve"]>) { return (await resolveRouter()).resolve(...args); },
    async complete(...args: Parameters<ProviderRouter["complete"]>) { return (await resolveRouter()).complete(...args); },
  };
  const hostOptions = { cwd: options.repositoryPath, router: actualRouter, provider: options.roleOverrides?.builder ?? options.providerOverride, requestPermission: options.requestToolPermission };
  const extensionOptions = { ...options.extensionOptions };
  extensionOptions.mcpHost ??= createCodingMcpHostFactory({ ...hostOptions, requestInput: options.requestMcpInput });
  extensionOptions.claudeHookHost ??= createCodingClaudeHookHost({ ...hostOptions, extensionOptions });
  return extensionOptions;
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", ["-c", "core.fsmonitor=false", "-c", "diff.autoRefreshIndex=false", ...args], {
    cwd: root, encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 32 * 1024 * 1024,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  return result.stdout;
}

function samePath(first: string, second: string): boolean {
  return path.relative(path.resolve(first), path.resolve(second)) === "";
}

export async function inspectManagedWorktree(
  repositoryRoot: string,
  sessionId: string,
  recordedPath: string,
): Promise<{ fingerprint: string }> {
  const root = await fs.realpath(repositoryRoot);
  const expected = new WorktreeManager(root).getWorktreePath(sessionId);
  if (!samePath(expected, recordedPath)) throw new Error("Recorded worktree is outside this coding session's managed path.");
  const actual = await fs.realpath(expected);
  if (!samePath(expected, actual)) throw new Error("Managed worktree path resolves through an unexpected link.");
  const marker = await fs.lstat(path.join(actual, ".git"));
  if (!marker.isFile() || marker.isSymbolicLink()) throw new Error("Managed worktree has an invalid Git marker.");
  const [top, common, originalCommon, branch, registered] = await Promise.all([
    git(actual, ["rev-parse", "--show-toplevel"]),
    git(actual, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]),
    git(actual, ["branch", "--show-current"]),
    git(root, ["worktree", "list", "--porcelain", "-z"]),
  ]);
  if (!samePath(await fs.realpath(top.trim()), actual) ||
    !samePath(await fs.realpath(common.trim()), await fs.realpath(originalCommon.trim()))) {
    throw new Error("Managed worktree belongs to a different Git repository.");
  }
  const expectedBranch = branchNameForTask(sessionId);
  const registration = registered.split("\0\0").find((block) => {
    const entry = block.split("\0").find((line) => line.startsWith("worktree "));
    return entry !== undefined && samePath(entry.slice("worktree ".length), actual);
  });
  if (branch.trim() !== expectedBranch ||
    !registration?.split("\0").includes(`branch refs/heads/${expectedBranch}`)) {
    throw new Error("Managed worktree is missing or on an unexpected registered branch.");
  }
  return { fingerprint: await rawWorkspaceFingerprint(actual) };
}

export interface CreateQueenSessionResult {
  orchestrator: QueenOrchestrator;
  store: CodingSessionStore;
  providerRouter: ProviderRouter;
  repositoryRoot: string;
  sessionId: string;
}

/** Resolve a saved session's workspace without trusting a persisted arbitrary path. */
export async function getCodingWorkspace(repositoryPath: string, sessionId: string): Promise<string> {
  const repositoryRoot = await findRepositoryRoot(repositoryPath);
  const record = await new CodingSessionStore(repositoryRoot).load(sessionId);
  if (!record) throw new Error(`Coding session ${sessionId} not found.`);
  if (record.archived) throw new Error(`Coding session ${sessionId} is archived.`);
  if (!samePath(await fs.realpath(record.repository.root), await fs.realpath(repositoryRoot))) {
    throw new Error("Coding session belongs to another repository.");
  }
  if (!record.repository.worktreePath) return repositoryRoot;
  const current = await inspectManagedWorktree(repositoryRoot, sessionId, record.repository.worktreePath);
  if (!record.repository.worktreeFingerprint || record.repository.worktreeFingerprint !== current.fingerprint) {
    throw new Error("Managed worktree changed or has no saved content fingerprint; inspect it before continuing.");
  }
  return record.repository.worktreePath;
}

/** Reseal an explicitly requested local operation; old acceptance evidence cannot authorize a commit. */
export async function recordUserWorkspaceChange(repositoryPath: string, sessionId: string, expectedFingerprint: string, expectedCurrentFingerprint?: string): Promise<boolean> {
  const root = await findRepositoryRoot(repositoryPath);
  const store = new CodingSessionStore(root);
  const record = await store.load(sessionId);
  if (!record || record.archived || !record.repository.worktreePath || record.repository.worktreeFingerprint !== expectedFingerprint) {
    throw new Error("Coding workspace changed ownership while the local operation was running.");
  }
  if (!["completed", "failed", "cancelled"].includes(record.status)) throw new Error("Local workspace operations require a settled coding run.");
  const current = await inspectManagedWorktree(root, sessionId, record.repository.worktreePath);
  if (expectedCurrentFingerprint !== undefined && current.fingerprint !== expectedCurrentFingerprint) throw new Error("Workspace changed since adoption preview; inspect it again before confirming.");
  if (current.fingerprint === expectedFingerprint) return false;
  const reason = "Workspace state was explicitly updated or adopted. Previous validation and review are stale; start a new turn to revalidate.";
  record.repository.worktreeFingerprint = current.fingerprint;
  record.status = "cancelled";
  record.cancelledAt = new Date().toISOString();
  record.cancellationReason = reason;
  record.verdict = "BLOCKED";
  if (record.finalReport) record.finalReport = { ...record.finalReport, result: reason, verdict: "BLOCKED", verdictReasons: [reason],
    evidenceCurrent: false, evidenceSummary: [], validation: [], review: [], outstanding: [reason] };
  record.updatedAt = new Date().toISOString();
  await store.save(record);
  return true;
}

export async function createQueenSession(
  options: QueenSessionOptions,
): Promise<CreateQueenSessionResult> {
  if (options.resumeId && options.continuationId) {
    throw new Error("resumeId and continuationId cannot be combined.");
  }
  const selectedId = options.resumeId ?? options.continuationId;
  if (selectedId && options.sessionId && selectedId !== options.sessionId) {
    throw new Error("The coding session id must match the resumed or continued session.");
  }
  const repositoryRoot = await findRepositoryRoot(options.repositoryPath, options.signal);
  const store = new CodingSessionStore(repositoryRoot);
  const previousId = options.resumeId ?? options.continuationId;
  const resumed = previousId ? await store.load(previousId) : null;
  if (previousId && !resumed) throw new Error(`Coding session ${previousId} not found.`);
  if (resumed && !samePath(await fs.realpath(resumed.repository.root), await fs.realpath(repositoryRoot))) {
    throw new Error("Coding session belongs to another repository.");
  }
  if (resumed?.archived) {
    throw new Error(`Coding session ${resumed.id} is archived. Run 'hive sessions unarchive ${resumed.id}' to restore it.`);
  }
  const sessionId = previousId ?? options.sessionId ?? createCodingSessionId();
  const selectedPluginAgentId = options.pluginAgentId === null ? undefined : options.pluginAgentId ?? resumed?.pluginAgentId;
  const pluginAgent = selectedPluginAgentId ? await loadPluginAgent(repositoryRoot, selectedPluginAgentId, options.extensionOptions) : undefined;
  const pluginAgentId = pluginAgent?.id;
  const selectedStyleId = options.outputStyleId === null ? undefined : options.outputStyleId ?? resumed?.outputStyleId;
  const outputStyleId = selectedStyleId ? (await loadTrustedPluginOutputStyle(repositoryRoot, selectedStyleId, options.extensionOptions)).id : undefined;
  if (options.resumeId && options.outputStyleId !== undefined && outputStyleId !== resumed?.outputStyleId) throw new Error("Change output style on a new turn, not while resuming an existing turn");
  if (options.resumeId && options.pluginAgentId !== undefined && pluginAgentId !== resumed?.pluginAgentId) throw new Error("Change the selected plugin agent on a new turn, not while resuming an existing turn");
  const enabledLspServers = options.enabledLspServers ?? (pluginAgent ? (await discoverExtensions(repositoryRoot, options.extensionOptions)).lspServers.filter((server) => server.pluginId === pluginAgent.pluginId && server.trusted && server.enabled).map((server) => server.id) : []);
  const providerRouter = new ProviderRouter({
    projectRoot: repositoryRoot,
    sessionId,
    sessionBindings: resumed?.providerBindings,
    projectRegistry: options.providerRegistries?.project,
    globalRegistry: options.providerRegistries?.global,
  });
  const extensionOptions = createCodingExtensionOptions({ ...options, repositoryPath: repositoryRoot, sessionId }, providerRouter);
  const tools: QueenToolFactory = {
    create(factoryOptions) {
      const emit = factoryOptions.emit as unknown as (
        type: RuntimeEventType,
        payload: RuntimeEvent["payload"],
      ) => RuntimeEvent;
      const base = new RepositoryToolService({
        repositoryRoot: factoryOptions.repositoryRoot,
        sessionId: factoryOptions.sessionId,
        approvalPolicy: factoryOptions.approvalPolicy,
        onEvent: (event) => {
          emit(event.type, event.payload);
        },
      });
      return createExtensionToolExecutor({
        base,
        extensionRoot: repositoryRoot,
        repositoryRoot: factoryOptions.repositoryRoot,
        mode: options.mode,
        enabledMcpServers: options.enabledMcpServers,
        enabledLspServers,
        enabledSkillIds: [...new Set([...(options.enabledSkillIds ?? []), ...(pluginAgent?.preloadedSkillIds ?? [])])],
        extensionOptions,
        requestToolPermission: options.requestToolPermission,
        signal: factoryOptions.signal,
        onHookStop: (reason) => orchestrator.cancel(reason),
        onNotification: options.onAssistantText,
      });
    },
  };
  const worktrees = {
    async create(root: string, id: string, baseCommit: string): Promise<string> {
      return new WorktreeManager(root).createWorktreeFrom(id, baseCommit);
    },
    inspect: inspectManagedWorktree,
  };
  const orchestrator = new QueenOrchestrator(
    { ...options, extensionOptions, pluginAgentId: pluginAgentId ?? null, outputStyleId: outputStyleId ?? null, repositoryPath: repositoryRoot, sessionId },
    { store, provider: options.invokedSkillSources?.length ? {
      bindingForRole: (...args) => providerRouter.bindingForRole(...args),
      async complete(request) {
        for (const source of options.invokedSkillSources ?? []) if ((await loadSkill(repositoryRoot, source.id, extensionOptions)).text !== source.text) throw new Error("Invoked skill changed during execution; inspect and trust it again");
        return providerRouter.complete(request);
      },
      async streamComplete(request, onChunk) {
        for (const source of options.invokedSkillSources ?? []) if ((await loadSkill(repositoryRoot, source.id, extensionOptions)).text !== source.text) throw new Error("Invoked skill changed during execution; inspect and trust it again");
        return providerRouter.streamComplete(request, onChunk);
      },
    } : providerRouter, tools, worktrees },
  );
  return { orchestrator, store, providerRouter, repositoryRoot, sessionId };
}

export async function runQueenSession(
  options: QueenSessionOptions,
): Promise<Awaited<ReturnType<QueenOrchestrator["run"]>>> {
  const { orchestrator } = await createQueenSession(options);
  return orchestrator.run();
}
