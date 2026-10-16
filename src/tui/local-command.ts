import { randomUUID } from "node:crypto";
import { CodingSessionStore } from "../coding/session-store.js";
import { findRepositoryRoot } from "../coding/repository.js";
import { getCodingWorkspace, recordUserWorkspaceChange } from "../coding/runtime.js";
import { RepositoryToolService } from "../coding/tools.js";
import type { RuntimeEvent, ToolPermissionRequest } from "../coding/types.js";
import { RuntimeEventBus } from "../coding/events.js";
import { runHooks } from "../extensions/index.js";
import { CheckpointStore } from "../coding/checkpoints.js";
import { withCodingSessionLease } from "../coding/session-lease.js";

export interface LocalCommandOptions {
  cwd: string;
  command: string;
  codingSessionId?: string;
  signal: AbortSignal;
  requestPermission: (request: ToolPermissionRequest, signal: AbortSignal) => Promise<boolean>;
  onEvent: (event: RuntimeEvent) => void;
}

/** A user-entered command uses the same jail and publication restrictions as agent commands. */
export async function runLocalCommand(options: LocalCommandOptions): Promise<{ exitCode: number | null; output: string; changedWorkspace: boolean }> {
  return options.codingSessionId
    ? withCodingSessionLease(options.cwd, options.codingSessionId, () => runOwnedLocalCommand(options), options.signal)
    : runOwnedLocalCommand(options);
}

async function runOwnedLocalCommand(options: LocalCommandOptions): Promise<{ exitCode: number | null; output: string; changedWorkspace: boolean }> {
  const { command, signal } = options;
  if (signal.aborted) throw new DOMException("Command cancelled.", "AbortError");
  const approved = await options.requestPermission({ tool: "run_command", description: `Run ${command}`, input: { command }, external: false }, signal);
  if (!approved || signal.aborted) throw new Error("Command declined before execution.");
  const workspace = options.codingSessionId ? await getCodingWorkspace(options.cwd, options.codingSessionId) : options.cwd;
  const root = options.codingSessionId ? await findRepositoryRoot(options.cwd) : options.cwd;
  const record = options.codingSessionId ? await new CodingSessionStore(root).load(options.codingSessionId) : null;
  if (options.codingSessionId && (!record || !["completed", "failed", "cancelled"].includes(record.status))) {
    throw new Error("Local commands require a settled coding run. Interrupt or finish the active run first.");
  }
  const before = await runHooks(root, "before_tool", { tool: "run_command", input: { command }, workspace }, { signal });
  const blocked = before.find((hook) => !hook.ok);
  if (blocked) throw new Error(`Hook ${blocked.id} blocked the command: ${blocked.output}`);
  const events = new RuntimeEventBus();
  events.subscribe(options.onEvent);
  const tools = new RepositoryToolService({ repositoryRoot: workspace, sessionId: `shell-${randomUUID()}`, approvalPolicy: "changes", onEvent: (input) => { events.emit(input); } });
  const result = await tools.runCommand(command, { signal });
  const changedWorkspace = record?.repository.worktreeFingerprint
    ? await recordUserWorkspaceChange(root, record.id, record.repository.worktreeFingerprint)
    : false;
  const after = signal.aborted ? [] : await runHooks(root, "after_tool", { tool: "run_command", input: { command }, result: { exitCode: result.exitCode, output: result.output.slice(0, 8_000) } }, { signal });
  const failed = after.find((hook) => !hook.ok);
  if (failed) throw new Error(`Command finished, but hook ${failed.id} failed: ${failed.output}`);
  return { exitCode: result.exitCode, output: result.output, changedWorkspace };
}

export async function rewindLocalFiles(options: Omit<LocalCommandOptions, "command" | "onEvent"> & { checkpointId: string }): Promise<string[]> {
  if (!options.codingSessionId) throw new Error("No coding workspace is attached to this conversation.");
  return withCodingSessionLease(options.cwd, options.codingSessionId, () => rewindOwnedLocalFiles(options), options.signal);
}

async function rewindOwnedLocalFiles(options: Omit<LocalCommandOptions, "command" | "onEvent"> & { checkpointId: string }): Promise<string[]> {
  if (!options.codingSessionId) throw new Error("No coding workspace is attached to this conversation.");
  const workspace = await getCodingWorkspace(options.cwd, options.codingSessionId);
  const root = await findRepositoryRoot(options.cwd);
  const record = await new CodingSessionStore(root).load(options.codingSessionId);
  if (!record?.repository.worktreeFingerprint) throw new Error("Only a settled managed coding workspace can restore checkpoints.");
  if (!["completed", "failed", "cancelled"].includes(record.status)) throw new Error("File restore requires a settled coding run. Interrupt or finish the active run first.");
  const checkpoints = new CheckpointStore(workspace, options.codingSessionId);
  const preview = await checkpoints.preview(options.checkpointId);
  if (!preview.restorable || !preview.confirmationToken) throw new Error(`Checkpoint cannot be restored: ${preview.conflicts.join("; ")}`);
  const approved = await options.requestPermission({ tool: "rewind_files", description: `Restore checkpoint ${preview.id}`,
    input: { checkpoint: preview.id, paths: preview.paths }, external: false, alwaysAsk: true }, options.signal);
  if (!approved || options.signal.aborted) throw new Error("File restore declined before any changes.");
  const restored = await checkpoints.restore(preview.id, preview.confirmationToken);
  try { await recordUserWorkspaceChange(root, record.id, record.repository.worktreeFingerprint); }
  catch { throw new Error("Files were restored, but HIVE could not invalidate the saved run evidence. Re-review the workspace before continuing."); }
  return restored.restoredPaths;
}
