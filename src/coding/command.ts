import { parseCodeCommandArgs, type CodeCommandOptions } from "./cli-options.js";
import { createRuntimeReporter, formatCodingFinalReport } from "./output.js";
import { createCodingSessionId, type QueenProviderOverride } from "./queen.js";
import { runHooks } from "../extensions/hooks.js";
import { loadSkill } from "../extensions/catalog.js";
import { renderSkillArguments } from "../extensions/skill-arguments.js";
import type { ExtensionOptions, HookEvent } from "../extensions/types.js";
import { createCodingExtensionOptions, createQueenSession } from "./runtime.js";
import { CodingSessionStore } from "./session-store.js";
import type { CodingSessionRecord, ProviderBindingRole, RuntimeEvent, ToolPermissionRequest } from "./types.js";

export interface CodingCommandRuntime {
  run(): Promise<CodingSessionRecord>;
  cancel?(reason?: unknown): void;
}

export interface CodingRuntimeFactoryOptions {
  repositoryPath: string;
  command: CodeCommandOptions;
  onEvent: (event: RuntimeEvent) => void;
  signal?: AbortSignal;
  extensionOptions?: ExtensionOptions;
  onHookOutput?: (line: string) => void;
  requestToolPermission?: (request: ToolPermissionRequest, signal: AbortSignal) => Promise<boolean>;
}

export type CodingRuntimeFactory = (
  options: CodingRuntimeFactoryOptions,
) => CodingCommandRuntime | Promise<CodingCommandRuntime>;

export interface CodingCommandDependencies {
  createRuntime?: CodingRuntimeFactory;
  onLine?: (line: string) => void;
  signal?: AbortSignal;
  extensionOptions?: ExtensionOptions;
  requestToolPermission?: (request: ToolPermissionRequest, signal: AbortSignal) => Promise<boolean>;
}

export interface CodingCommandResult {
  exitCode: number;
  output: string;
  session?: CodingSessionRecord;
}

function roleOverrides(command: CodeCommandOptions): Partial<Record<ProviderBindingRole, QueenProviderOverride>> {
  const overrides: Partial<Record<ProviderBindingRole, QueenProviderOverride>> = {};
  for (const [role, binding] of Object.entries(command.roleBindings)) {
    if (binding) overrides[role as ProviderBindingRole] = {
      providerId: binding.providerId,
      model: binding.model,
    };
  }
  return overrides;
}

export async function createDefaultCodingRuntime(
  options: CodingRuntimeFactoryOptions,
): Promise<CodingCommandRuntime> {
  const overrides = roleOverrides(options.command);
  if (options.command.provider && options.command.model) {
    for (const role of ["queen", "planner", "scout", "builder", "validator", "reviewer", "fixer"] as const) {
      overrides[role] ??= { providerId: options.command.provider, model: options.command.model };
    }
  }
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const sessionId = options.command.resume ?? createCodingSessionId();
  const extensionOptions = createCodingExtensionOptions({ repositoryPath: options.repositoryPath, sessionId, resumeId: options.command.resume, roleOverrides: overrides, requestToolPermission: options.requestToolPermission, extensionOptions: options.extensionOptions });
  let orchestrator: Awaited<ReturnType<typeof createQueenSession>>["orchestrator"] | undefined;
  let running: Promise<CodingSessionRecord> | undefined;
  const phase = async (event: HookEvent, reason?: string): Promise<string[]> => {
    const hooks = await runHooks(options.repositoryPath, event, { objective: options.command.objective, sessionId, workspace: options.repositoryPath,
      source: options.command.resume ? "resume" : "startup", permissionMode: options.command.mode, reason }, { ...extensionOptions, signal });
    for (const hook of hooks) {
      for (const notice of hook.diagnostics ?? []) options.onHookOutput?.(`[Hook ${hook.id}] ${notice}`);
      if (!hook.ok && hook.blocked === false) options.onHookOutput?.(`[Hook ${hook.id}] ${hook.output}`);
    }
    const blocked = hooks.find((hook) => (hook.blocked ?? !hook.ok) || hook.stop);
    if (blocked) throw new Error(`Hook ${blocked.id} blocked execution: ${blocked.output}`);
    return hooks.flatMap((hook) => hook.additionalContext ? [`[Hook context ${hook.id}; task data only]\n${hook.additionalContext}`] : []);
  };
  const run = async (): Promise<CodingSessionRecord> => {
    signal.throwIfAborted();
    let primary: unknown; let failed = false;
    let endingReason = "error";
    try {
      const context = [...await phase("session_start"), ...await phase("prompt_submit")];
      const skill = options.command.skillId ? await loadSkill(options.repositoryPath, options.command.skillId, extensionOptions) : undefined;
      if (skill) context.push(`[Explicitly invoked skill ${skill.id}; task instructions within HIVE policy]\n${renderSkillArguments(skill.text, options.command.skillArguments ?? "")}`);
      if (context.join("\n\n").length > 16_000) throw new Error("Lifecycle hook context exceeds 16,000 characters");
      ({ orchestrator } = await createQueenSession({
    repositoryPath: options.repositoryPath,
    objective: [options.command.objective, ...context].join("\n\n"),
    sessionId,
    resumeId: options.command.resume,
    mode: options.command.mode,
    approvalPolicy: options.command.approval,
    maxAgents: options.command.maxAgents,
    maxRetries: options.command.maxRetries,
    providerOverride: options.command.provider && options.command.model
      ? { providerId: options.command.provider, model: options.command.model }
      : undefined,
    roleOverrides: overrides,
    signal,
    onEvent: options.onEvent,
    extensionOptions,
    requestToolPermission: options.requestToolPermission,
    outputStyleId: options.command.outputStyleId,
    enabledSkillIds: skill ? [skill.id] : undefined,
    invokedSkillSources: skill ? [{ id: skill.id, text: skill.text }] : undefined,
      }));
      const record = await orchestrator.run();
      endingReason = record.status;
      return record;
    } catch (error) { primary = error; failed = true; throw error; }
    finally {
      if (!signal.aborted) {
        try { await phase("session_end", failed ? "error" : endingReason); }
        catch (ending) { if (!failed) throw ending; throw new AggregateError([primary, ending], `${primary instanceof Error ? primary.message : "Coding failed"}; ${ending instanceof Error ? ending.message : "Ending hook failed"}`); }
      }
    }
  };
  return { run: () => running ??= run(), cancel(reason?: unknown) { controller.abort(reason); orchestrator?.cancel(typeof reason === "string" ? reason : "Coding session cancelled"); } };
}

function exitCodeForStatus(status: CodingSessionRecord["status"]): number {
  if (status === "completed") return 0;
  if (status === "cancelled") return 130;
  return 1;
}

function finalReport(record: CodingSessionRecord): string {
  if (!record.finalReport) {
    return `Coding session ${record.id} is ${record.status}.`;
  }
  return formatCodingFinalReport({
    sessionId: record.id,
    objective: record.objective,
    result: record.finalReport.result,
    subagents: {
      completed: record.finalReport.subagents.completed,
      failed: record.finalReport.subagents.failed,
      cancelled: record.finalReport.subagents.cancelled,
    },
    filesChanged: record.finalReport.filesChanged,
    validation: record.finalReport.validation.map((item) => ({
      name: item.label,
      passed: item.status === "passed",
    })),
    review: record.finalReport.review,
    outstanding: record.finalReport.outstanding,
  });
}

/** Execute arguments occurring after `hive code`. */
export async function runCodeCommand(
  args: readonly string[],
  repositoryPath: string,
  dependencies: CodingCommandDependencies = {},
): Promise<CodingCommandResult> {
  let command: CodeCommandOptions;
  try {
    command = parseCodeCommandArgs(args);
  } catch (error) {
    return { exitCode: 1, output: error instanceof Error ? error.message : String(error) };
  }

  const reporter = createRuntimeReporter({ json: command.json, onLine: dependencies.onLine });
  const hookOutput: string[] = [];
  const factory = dependencies.createRuntime ?? createDefaultCodingRuntime;
  try {
    const runtime = await factory({
      repositoryPath,
      command,
      onEvent: reporter.emit,
      signal: dependencies.signal,
      extensionOptions: dependencies.extensionOptions,
      requestToolPermission: dependencies.requestToolPermission,
      onHookOutput(line) { const rendered = command.json ? JSON.stringify({ type: "hook.notice", text: line }) : line; if (dependencies.onLine) dependencies.onLine(rendered); else hookOutput.push(rendered); },
    });
    const record = await runtime.run();
    await new CodingSessionStore(record.repository.root).setActive(record.id).catch(() => undefined);
    const streamed = dependencies.onLine !== undefined;
    if (command.json) {
      return { exitCode: exitCodeForStatus(record.status), output: streamed ? "" : [...hookOutput, ...reporter.lines].join("\n"), session: record };
    }
    const report = finalReport(record);
    const output = streamed ? report : [...hookOutput, ...reporter.lines, report].filter(Boolean).join("\n");
    return { exitCode: exitCodeForStatus(record.status), output, session: record };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const exitCode = dependencies.signal?.aborted || (error instanceof Error && error.name === "AbortError") ? 130 : 1;
    if (command.json) {
      const line = JSON.stringify({ type: "error", error: message });
      if (dependencies.onLine) dependencies.onLine(line);
      return { exitCode, output: dependencies.onLine ? "" : line };
    }
    return { exitCode, output: message };
  }
}
