/**
 * interaction.ts
 * Pure session contract for the HIVE cockpit.
 * Maps HIVE modes onto ask / workspace-write / read-only behavior.
 * Publish actions stay behind the existing --confirmed gate.
 */

import type { HiveMode } from "../config.js";
import { redactKnownSecrets } from "../security/secrets.js";

export const HIVE_SESSION_MODES = [
  "guarded",
  "standard",
  "autonomous",
  "plan",
  "review",
] as const satisfies readonly HiveMode[];

export type SessionActionKind = "read" | "edit" | "command" | "push" | "pull_request";

export type ActivityKind = "read" | "edit" | "command";

export interface SessionAction {
  kind: SessionActionKind;
  /** Display target. Callers may pass a raw path or command; decisions store a safe label. */
  target: string;
  inWorkspace: boolean;
  confirmed: boolean;
}

export interface PermissionDecision {
  kind: SessionActionKind;
  target: string;
  outcome: "allow" | "deny" | "ask";
  /** When false, agreeing still must not apply the action. */
  canApply: boolean;
  reason: string;
}

export interface PermissionContext {
  editsApproved?: boolean;
}

export interface ActivityView {
  kind: ActivityKind;
  target: string;
}

export type TurnChunk =
  | { kind: "text"; text: string }
  | { kind: "activity"; activity: ActivityView }
  | { kind: "permission"; action: SessionAction };

export interface PlayTurnOptions {
  mode: HiveMode;
  chunks: readonly TurnChunk[];
  onLine: (line: string) => void;
  /** Answer an ask decision. Omit to decline. */
  answer?: (decision: PermissionDecision) => Promise<boolean> | boolean;
  signal?: AbortSignal;
}

export interface PlayTurnResult {
  lines: string[];
  decisions: PermissionDecision[];
  applied: SessionAction[];
  interrupted: boolean;
}

export interface SessionPosture {
  mode: "auto" | "plan" | "review";
  approvalPolicy: "safe" | "changes";
}

export interface InterruptInput {
  key: "ctrl-c" | "escape";
  turnLive: boolean;
  exitArmed: boolean;
  permissionPending: boolean;
}

export type InterruptResult =
  | { action: "decline-permission"; turnLive: boolean; exitArmed: boolean }
  | { action: "cancel-turn"; turnLive: false; exitArmed: true }
  | { action: "arm-exit"; turnLive: false; exitArmed: true }
  | { action: "exit"; turnLive: false; exitArmed: true }
  | { action: "ignore"; turnLive: boolean; exitArmed: boolean };

export interface RuntimeActivityEvent {
  type: string;
  payload?: unknown;
}

const MODE_CYCLE: readonly HiveMode[] = HIVE_SESSION_MODES;

const READ_TOOLS = new Set([
  "read_file",
  "read",
  "list_directory",
  "list_files",
  "search_text",
  "search_files",
  "search_symbols",
  "grep",
  "glob",
  "inspect_diff",
  "read_command_output",
]);

const EDIT_TOOLS = new Set([
  "create_file",
  "write_file",
  "edit_file",
  "apply_patch",
  "edit",
  "write",
]);

const COMMAND_TOOLS = new Set([
  "run_command",
  "run_test",
  "bash",
  "shell",
]);

export function isHiveMode(value: string): value is HiveMode {
  return (HIVE_SESSION_MODES as readonly string[]).includes(value);
}

export function cycleSessionMode(mode: HiveMode): HiveMode {
  const index = MODE_CYCLE.indexOf(mode);
  const next = MODE_CYCLE[(index + 1) % MODE_CYCLE.length];
  return next ?? "guarded";
}

export function describeMode(mode: HiveMode): string {
  switch (mode) {
    case "guarded":
      return "Asks before changes. Push and pull requests stay behind --confirmed.";
    case "standard":
      return "Applies in-workspace edits. Asks before commands. Publish stays behind --confirmed.";
    case "autonomous":
      return "Applies in-workspace edits and local commands. Push and pull requests still need --confirmed.";
    case "plan":
      return "Reads and proposes. Does not apply edits.";
    case "review":
      return "Read-only review. Does not apply edits or publish.";
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

export function sessionHelpLines(): string[] {
  return [
    "  HIVE session",
    "  ------------",
    "  /help          Show this list",
    "  /mode [name]   Show or set guarded, standard, autonomous, plan, review",
    "  /plan [task]   Switch to plan mode. A task stays read-only.",
    "  /clear         Clear the transcript",
    "  /sessions      List saved coding sessions",
    "  /new           Start a new saved conversation",
    "  /resume [id]   Choose or restore a saved conversation",
    "  /continue      Restore the most recent conversation",
    "  /rename title  Rename this conversation",
    "  /fork [title]  Copy conversation, index and files to an independent worktree",
    "  /model p/m     Select an approved provider/model for this conversation",
    "  /context       Inspect actual prompt size and estimates",
    "  /compact       Locally summarize earlier context; saved history is kept",
    "  /export [file] Export conversation as Markdown without overwriting",
    "  /copy [all]    Copy the last assistant response or all messages",
    "  /diff          Inspect current workspace changes",
    "  /review [task] Review without changing files",
    "  /find text     Search visible transcript entries",
    "  /mcp           Discover, trust and attach MCP servers; /mcp help",
    "  /skills        Discover skills; /skill <id> selects trusted instructions",
    "  /plugins       Manage local plugin bundles",
    "  /hooks         Inspect trusted lifecycle hooks",
    "  /image file    Attach actual image data; /image off clears attachments",
    "  /rewind        Restore the transcript to the previous user turn",
    "  /checkpoints   List file checkpoints for this coding workspace",
    "  /rewind files [id] Preview and confirm restoring a file checkpoint",
    "  !command       Run a local command with streaming output and cancellation",
    "  /exit          Leave the session",
    "  ",
    "  A plain prompt starts a turn. @ opens a file picker and marks a path.",
    "  / filters commands. Enter selects a row. Esc closes the picker.",
    "  Esc or Ctrl+C interrupts the turn. Ctrl+C again exits.",
    "  PgUp and PgDn scroll the transcript. The mouse wheel does too.",
    "  Ctrl+U and Ctrl+D scroll when the wheel is not available.",
    "  Unicode and bracketed paste are supported. Pasted newlines never submit.",
    "  Left/Right move by grapheme. Home/End or Ctrl+A/E move to draft edges.",
    "  Ctrl+W deletes a word; Ctrl+K deletes to the end. Alt+B/F moves words.",
    "  Backspace and Delete edit at the cursor. Ctrl+J inserts a newline.",
    "  Enter submits. Ctrl+O toggles the focused tool card. Ctrl+Left/Right or [ ] moves focus.",
    "  Enter during a turn queues it. Esc cancels and keeps the queue; a second Esc or Ctrl+C clears it.",
    "  Shift+Tab cycles the session mode.",
    "  Guarded and plan ask before changes. Plan does not apply edits.",
    "  Push and pull requests always need hive push --confirmed or hive pr --confirmed.",
  ];
}

export interface RewindResult {
  lines: string[];
  notice: string;
  changed: boolean;
}

/**
 * Drop the latest user turn from the transcript.
 * This does not touch files or the on-disk coding session.
 */
export function rewindTranscript(transcript: readonly string[]): RewindResult {
  const starts: number[] = [];
  transcript.forEach((line, index) => {
    if (line.trim().startsWith("[User] ")) starts.push(index);
  });
  if (starts.length === 0) {
    return { lines: [...transcript], notice: "  Nothing to rewind.", changed: false };
  }
  let cut = starts[starts.length - 1] ?? 0;
  while (cut > 0) {
    const previous = transcript[cut - 1]?.trim() ?? "";
    if (previous.startsWith("$ ") || previous.startsWith("Working:") || previous.startsWith("context ")) {
      cut -= 1;
      continue;
    }
    break;
  }
  return {
    lines: transcript.slice(0, cut),
    notice: "  Rewound the transcript to the previous user turn. Files and the saved coding session were not changed.",
    changed: true,
  };
}

export function formatSessionList(
  sessions: readonly { id: string; status: string; archived?: boolean }[],
): string[] {
  if (sessions.length === 0) return ["  No saved sessions."];
  return sessions.map((session) => {
    const archived = session.archived ? "  archived" : "";
    return `  ${session.id}  ${session.status}${archived}`;
  });
}

/**
 * Coding-runtime posture for a HIVE mode.
 * Plan and review ignore overrides so a follow-up cannot start writing.
 * Autonomous uses workspace changes, never an approval bypass.
 */
export function resolveSessionPosture(
  mode: HiveMode,
  override: Partial<SessionPosture> = {},
): SessionPosture {
  const base = runtimePostureForMode(mode);
  if (mode === "plan" || mode === "review") return base;
  return {
    mode: override.mode ?? base.mode,
    approvalPolicy: override.approvalPolicy ?? base.approvalPolicy,
  };
}

export function runtimePostureForMode(mode: HiveMode): SessionPosture {
  switch (mode) {
    case "plan":
      return { mode: "plan", approvalPolicy: "safe" };
    case "review":
      return { mode: "review", approvalPolicy: "safe" };
    case "guarded":
      return { mode: "auto", approvalPolicy: "safe" };
    case "standard":
    case "autonomous":
      return { mode: "auto", approvalPolicy: "changes" };
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

export function decidePermission(
  mode: HiveMode,
  action: SessionAction,
  context: PermissionContext = {},
): PermissionDecision {
  const target = safeDisplayTarget(action.kind, action.target);
  const decision = { kind: action.kind, target };

  if (action.kind === "read") {
    return { ...decision, outcome: "allow", canApply: true, reason: "Reads stay available in every mode." };
  }

  if (action.kind === "push" || action.kind === "pull_request") {
    if (action.confirmed) {
      return {
        ...decision,
        outcome: "allow",
        canApply: true,
        reason: "Confirmed with the existing publish gate.",
      };
    }
    const command = action.kind === "push" ? "hive push --confirmed" : "hive pr --confirmed";
    return {
      ...decision,
      outcome: "deny",
      canApply: false,
      reason: `Publish stays behind ${command}.`,
    };
  }

  if (!action.inWorkspace) {
    return {
      ...decision,
      outcome: "deny",
      canApply: false,
      reason: "Changes stay inside the workspace.",
    };
  }

  if (
    context.editsApproved &&
    mode !== "plan" &&
    mode !== "review" &&
    (mode === "guarded" || mode === "autonomous" || (mode === "standard" && action.kind === "command"))
  ) {
    return {
      ...decision,
      outcome: "allow",
      canApply: true,
      reason: "Approved for this session. Publish still needs --confirmed.",
    };
  }

  switch (mode) {
    case "plan":
      return {
        ...decision,
        outcome: "ask",
        canApply: false,
        reason: "Plan mode does not apply edits.",
      };
    case "review":
      return {
        ...decision,
        outcome: "deny",
        canApply: false,
        reason: "Review mode is read-only.",
      };
    case "guarded":
      return {
        ...decision,
        outcome: "ask",
        canApply: true,
        reason: "Guarded mode asks before changes.",
      };
    case "standard":
      if (action.kind === "command") {
        return {
          ...decision,
          outcome: "ask",
          canApply: true,
          reason: "Standard mode asks before commands.",
        };
      }
      return {
        ...decision,
        outcome: "allow",
        canApply: true,
        reason: "Standard mode applies in-workspace edits.",
      };
    case "autonomous":
      return {
        ...decision,
        outcome: "allow",
        canApply: true,
        reason: "Autonomous mode applies in-workspace work.",
      };
    default: {
      const exhaustive: never = mode;
      return exhaustive;
    }
  }
}

export function formatActivityLine(activity: ActivityView): string {
  return `${activity.kind} ${safeDisplayTarget(activity.kind, activity.target)}`;
}

export function formatDecisionLine(decision: PermissionDecision): string {
  const posture = decision.outcome === "allow"
    ? "allowed"
    : decision.outcome === "ask"
      ? "asking"
      : "denied";
  return `permission ${decision.kind} ${decision.target} - ${posture} - ${decision.reason}`;
}

export interface PermissionSettlement {
  applied: boolean;
  decision: PermissionDecision;
  /** Reason recorded when the ask is not applied. */
  detail: string;
}

/**
 * Re-check a pending ask through decidePermission, then accept or reject.
 * A stale allow cannot override plan, review, or a workspace boundary.
 */
export function settlePermissionAsk(
  mode: HiveMode,
  pending: PermissionDecision,
  accept: boolean,
  context: PermissionContext = {},
): PermissionSettlement {
  const fresh = decidePermission(mode, {
    kind: pending.kind,
    target: pending.target,
    inWorkspace: pending.reason !== "Changes stay inside the workspace.",
    confirmed: false,
  }, context);
  const decision = fresh.canApply && !pending.canApply && pending.outcome === "deny"
    ? pending
    : fresh;
  const applied = accept && decision.canApply && decision.outcome !== "deny";
  return {
    applied,
    decision,
    detail: decision.canApply ? "Declined." : decision.reason,
  };
}

export interface ToolCardDraft {
  id: string;
  kind: ActivityKind | "other";
  tool: string;
  summary: string;
  mutating: boolean;
  activity: string;
}

/** Header fields for a tool activity. Null when the event is not a tool. */
export function toolCardDraft(event: RuntimeActivityEvent & { id?: string }): ToolCardDraft | null {
  const activity = activityLineForRuntimeEvent(event);
  if (!activity) return null;
  const payload = asRecord(event.payload);
  const id = typeof event.id === "string" ? event.id : "";
  const summary = activity.includes(" ") ? activity.slice(activity.indexOf(" ") + 1) : activity;

  if (event.type === "subagent.tool_call") {
    const tool = stringField(payload, ["tool", "name"]) ?? "tool";
    const kind = toolActivityKind(tool) ?? "other";
    return {
      id,
      kind,
      tool: safeToken(tool),
      summary,
      mutating: kind === "edit" || kind === "command",
      activity,
    };
  }

  if (event.type === "command.started" || event.type === "validation.started") {
    return {
      id,
      kind: "command",
      tool: event.type === "validation.started" ? "validation" : "command",
      summary,
      mutating: true,
      activity,
    };
  }

  if (event.type === "file.changed" || event.type === "subagent.file_changed") {
    return {
      id,
      kind: "edit",
      tool: "edit",
      summary,
      mutating: true,
      activity,
    };
  }

  return {
    id,
    kind: "other",
    tool: "tool",
    summary,
    mutating: false,
    activity,
  };
}

export function permissionPromptText(decision: PermissionDecision): string {
  if (!decision.canApply) {
    return `Plan will not apply ${decision.kind} ${decision.target}. Acknowledge? [y/n]`;
  }
  if (decision.kind === "edit" && decision.target === "workspace") {
    return "Allow in-workspace edits? [y/n]";
  }
  return `Allow ${decision.kind} ${decision.target}? [y/n]`;
}

export function extractFileMentions(input: string): string[] {
  const found: string[] = [];
  const pattern = /(^|\s)@([A-Za-z0-9_./\\-]+)/g;
  for (const match of input.matchAll(pattern)) {
    const raw = match[2];
    if (!raw || raw.includes("..")) continue;
    const safe = safeDisplayTarget("read", raw);
    if (!found.includes(safe)) found.push(safe);
  }
  return found;
}

export function activityLineForRuntimeEvent(event: RuntimeActivityEvent): string | null {
  const payload = asRecord(event.payload);
  if (event.type === "command.output") return null;

  if (event.type === "subagent.tool_call") {
    const tool = stringField(payload, ["tool", "name"]) ?? "tool";
    const input = asRecord(payload?.input) ?? asRecord(payload?.arguments);
    const kind = toolActivityKind(tool);
    if (kind === "command") {
      return formatActivityLine({ kind, target: commandTarget(input) });
    }
    if (kind === "edit") {
      return formatActivityLine({ kind, target: pathTarget(input, "file") });
    }
    if (kind === "read") {
      const named = tool === "search_text" || tool === "search_symbols" || tool === "search_files" || tool === "grep"
        ? "search"
        : pathTarget(input, tool);
      return formatActivityLine({ kind, target: named });
    }
    return `tool ${safeToken(tool)}`;
  }

  if (event.type === "file.changed" || event.type === "subagent.file_changed") {
    const change = asRecord(payload?.change);
    const pathValue = stringField(payload, ["path"]) ?? stringField(change, ["path"]) ?? "file";
    return formatActivityLine({ kind: "edit", target: pathValue });
  }

  if (event.type === "command.started" || event.type === "validation.started") {
    return formatActivityLine({ kind: "command", target: commandTarget(payload) });
  }

  return null;
}

export function permissionDecisionForRuntimeEvent(
  mode: HiveMode,
  event: RuntimeActivityEvent,
  context: PermissionContext = {},
): PermissionDecision | null {
  const payload = asRecord(event.payload);

  if (event.type === "session.paused") {
    const reason = stringField(payload, ["reason"]) ?? "";
    if (!/approval|edit/i.test(reason)) return null;
    return decidePermission(mode, {
      kind: "edit",
      target: "workspace",
      inWorkspace: true,
      confirmed: false,
    }, context);
  }

  if (event.type === "subagent.tool_call") {
    const tool = stringField(payload, ["tool", "name"]) ?? "";
    const kind = toolActivityKind(tool);
    if (kind !== "edit" && kind !== "command") return null;
    const input = asRecord(payload?.input) ?? asRecord(payload?.arguments);
    const target = kind === "command" ? commandTarget(input) : pathTarget(input, "file");
    return decidePermission(mode, {
      kind,
      target,
      inWorkspace: true,
      confirmed: false,
    }, context);
  }

  if (event.type === "command.started") {
    const command = stringField(payload, ["command"]) ?? commandTarget(payload);
    const publish = publishKind(command);
    if (publish) {
      return decidePermission(mode, {
        kind: publish,
        target: publish === "push" ? "git push" : "pull request",
        inWorkspace: true,
        confirmed: false,
      }, context);
    }
    return decidePermission(mode, {
      kind: "command",
      target: command,
      inWorkspace: true,
      confirmed: false,
    }, context);
  }

  if (event.type === "file.changed" || event.type === "subagent.file_changed") {
    const change = asRecord(payload?.change);
    const pathValue = stringField(payload, ["path"]) ?? stringField(change, ["path"]) ?? "file";
    return decidePermission(mode, {
      kind: "edit",
      target: pathValue,
      inWorkspace: true,
      confirmed: false,
    }, context);
  }

  return null;
}

export async function playTurn(options: PlayTurnOptions): Promise<PlayTurnResult> {
  const lines: string[] = [];
  const decisions: PermissionDecision[] = [];
  const applied: SessionAction[] = [];
  const emit = (line: string): void => {
    lines.push(line);
    options.onLine(line);
  };

  for (const chunk of options.chunks) {
    if (options.signal?.aborted) {
      emit("Turn interrupted.");
      return { lines, decisions, applied, interrupted: true };
    }
    await Promise.resolve();

    if (chunk.kind === "text") {
      const text = redactKnownSecrets(chunk.text).trim();
      if (text) emit(text);
      continue;
    }

    if (chunk.kind === "activity") {
      emit(formatActivityLine(chunk.activity));
      continue;
    }

    const decision = decidePermission(options.mode, chunk.action);
    decisions.push(decision);
    emit(formatDecisionLine(decision));
    if (decision.outcome === "ask") {
      emit(permissionPromptText(decision));
      const allowed = options.answer ? await options.answer(decision) : false;
      if (options.signal?.aborted) {
        emit("Turn interrupted.");
        return { lines, decisions, applied, interrupted: true };
      }
      if (!allowed || !decision.canApply) {
        const reason = decision.canApply ? "Declined." : decision.reason;
        emit(`permission ${decision.kind} ${decision.target} - denied - ${reason}`);
        continue;
      }
      applied.push({ ...chunk.action, target: decision.target });
      emit(`permission ${decision.kind} ${decision.target} - allowed`);
      continue;
    }

    if (decision.outcome === "allow" && decision.canApply) {
      applied.push({ ...chunk.action, target: decision.target });
    }
  }

  return { lines, decisions, applied, interrupted: false };
}

/**
 * Esc cancels a live turn. Ctrl+C cancels once, then exits.
 * Matches the hive chat REPL: one interrupt, a second Ctrl+C leaves.
 */
export function nextInterrupt(input: InterruptInput): InterruptResult {
  if (input.key === "escape") {
    if (input.permissionPending) {
      return {
        action: "decline-permission",
        turnLive: input.turnLive,
        exitArmed: input.exitArmed,
      };
    }
    if (input.turnLive) {
      return { action: "cancel-turn", turnLive: false, exitArmed: true };
    }
    return { action: "ignore", turnLive: false, exitArmed: input.exitArmed };
  }

  if (input.permissionPending && input.turnLive) {
    return { action: "cancel-turn", turnLive: false, exitArmed: true };
  }
  if (input.permissionPending) {
    return { action: "decline-permission", turnLive: false, exitArmed: true };
  }
  if (input.turnLive) {
    return { action: "cancel-turn", turnLive: false, exitArmed: true };
  }
  if (input.exitArmed) {
    return { action: "exit", turnLive: false, exitArmed: true };
  }
  return { action: "arm-exit", turnLive: false, exitArmed: true };
}

const COMMAND_PREVIEW_LIMIT = 200;
const READ_PREVIEW_LINES = 12;
const FILE_READ_TOOLS = new Set(["read_file", "read"]);

/** Full shell command for a tool card: redacted, flattened, and cut near 200 characters. */
export function shellCommandPreview(raw: string): string {
  const flat = redactKnownSecrets(raw.replace(/[\r\n\t]+/g, " ").trim());
  if (!flat) return "";
  if (flat.length <= COMMAND_PREVIEW_LIMIT) return flat;
  return `${flat.slice(0, COMMAND_PREVIEW_LIMIT - 3)}...`;
}

/** Command string already on a shell event. Activity lines stay on the executable name. */
export function commandTextFromEvent(event: RuntimeActivityEvent): string | undefined {
  const payload = asRecord(event.payload);
  if (event.type === "command.started" || event.type === "validation.started") {
    const preview = shellCommandPreview(fullCommandText(payload));
    return preview || undefined;
  }
  if (event.type !== "subagent.tool_call") return undefined;
  const tool = stringField(payload, ["tool", "name"]) ?? "";
  if (toolActivityKind(tool) !== "command") return undefined;
  const input = asRecord(payload?.input) ?? asRecord(payload?.arguments);
  const preview = shellCommandPreview(fullCommandText(input));
  return preview || undefined;
}

/**
 * Up to 12 redacted lines from a read tool result already on the event.
 * This does not open a path from disk.
 */
export function readResultPreview(event: RuntimeActivityEvent): string[] {
  if (event.type !== "subagent.tool_call" && event.type !== "subagent.tool_result") return [];
  const payload = asRecord(event.payload);
  const tool = stringField(payload, ["tool", "name"]) ?? "";
  if (!FILE_READ_TOOLS.has(tool)) return [];
  const text = toolResultText(payload);
  if (text === undefined || text.length === 0) return [];
  const redacted = redactKnownSecrets(text).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = redacted.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.slice(0, READ_PREVIEW_LINES);
}

function fullCommandText(source: Record<string, unknown> | undefined): string {
  if (!source) return "";
  const command = source.command ?? source.cmd;
  if (typeof command === "string") return command;
  if (Array.isArray(command)) {
    return command.filter((entry): entry is string => typeof entry === "string").join(" ");
  }
  return "";
}

function toolResultText(payload: Record<string, unknown> | undefined): string | undefined {
  if (!payload) return undefined;
  const direct = previewString(payload, ["output", "result", "toolResult", "stdout"]);
  if (direct !== undefined) return direct;
  for (const key of ["output", "result", "toolResult"]) {
    const nested = previewString(asRecord(payload[key]), ["content", "text", "output", "stdout"]);
    if (nested !== undefined) return nested;
  }
  return undefined;
}

function previewString(source: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function toolActivityKind(tool: string): ActivityKind | undefined {
  if (READ_TOOLS.has(tool)) return "read";
  if (EDIT_TOOLS.has(tool)) return "edit";
  if (COMMAND_TOOLS.has(tool)) return "command";
  return undefined;
}

function publishKind(command: string): "push" | "pull_request" | null {
  const redacted = redactKnownSecrets(command);
  if (/\bgit\s+push\b/i.test(redacted) || /\bhive\s+push\b/i.test(redacted)) return "push";
  if (/\bgh\s+pr\s+create\b/i.test(redacted) || /\bhive\s+pr\b/i.test(redacted)) return "pull_request";
  return null;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

function stringField(source: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value;
  }
  return undefined;
}

function commandTarget(source: Record<string, unknown> | undefined): string {
  if (!source) return "command";
  const command = source.command ?? source.cmd;
  if (typeof command === "string") return command;
  if (Array.isArray(command)) {
    const first = command.find((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
    return first ?? "command";
  }
  return "command";
}

function pathTarget(source: Record<string, unknown> | undefined, fallback: string): string {
  return stringField(source, ["path", "file", "file_path", "target"]) ?? fallback;
}

function safeToken(value: string): string {
  const redacted = redactKnownSecrets(value.trim());
  if (!redacted || redacted.includes("[REDACTED]")) return "tool";
  if (!/^[A-Za-z0-9._-]+$/.test(redacted)) return "tool";
  return redacted;
}

export function safeDisplayTarget(kind: SessionActionKind | ActivityKind, raw: string): string {
  const trimmed = raw.trim();
  if (kind === "push") return "git push";
  if (kind === "pull_request") return "pull request";
  if (!trimmed) return kind === "command" ? "command" : "file";

  if (kind === "command") {
    const publish = publishKind(trimmed);
    if (publish === "push") return "git push";
    if (publish === "pull_request") return "pull request";
    const token = trimmed.split(/\s+/)[0] ?? "command";
    const base = token.split(/[/\\]/).pop() ?? token;
    const redacted = redactKnownSecrets(base);
    if (!redacted || redacted.includes("[REDACTED]") || !/^[A-Za-z0-9._-]+$/.test(redacted)) {
      return "shell";
    }
    return redacted;
  }

  const pathPart = trimmed.split(/\s+/)[0] ?? "file";
  const redactedPath = redactKnownSecrets(pathPart);
  if (redactedPath.includes("[REDACTED]")) return "[redacted]";
  if (pathPart.length > 180) return `${pathPart.slice(0, 177)}...`;
  return pathPart;
}
