import type { CodingSessionStatus, RuntimeEvent } from "../../../../../src/coding/types";
import { terminalStatuses } from "../../utils";

/** Roles the Hive Code harness always shows, in pipeline order. */
export const HARNESS_ROLES = ["scout", "planner", "builder", "validator", "reviewer"] as const;
export type HarnessRole = (typeof HARNESS_ROLES)[number];
export type ActivityRole = HarnessRole | "fixer";
export type ActivityPhase = "idle" | "waiting" | "active" | "done" | "failed";

export interface AgentActivityRow {
  role: ActivityRole;
  label: string;
  phase: ActivityPhase;
  glyph: "●" | "◉" | "○" | "✕";
  detail: string;
  elapsedLabel: string;
}

const ROLE_LABEL: Record<ActivityRole, string> = {
  scout: "Scout",
  planner: "Planner",
  builder: "Builder",
  validator: "Validator",
  reviewer: "Reviewer",
  fixer: "Fixer",
};

interface AgentSlice {
  phase: ActivityPhase;
  startedAt?: number;
  endedAt?: number;
}

interface RoleAccum {
  agents: Map<string, AgentSlice>;
  files: Set<string>;
  lastFile?: string;
  lastDetail?: string;
  /** Latest signal: a file edit should win over an older progress line while the role is active. */
  lastKind: "text" | "file" | "none";
}

export interface DeriveAgentActivityOptions {
  now?: number;
  runStatus?: CodingSessionStatus | null;
  sessionId?: string | null;
}

export function deriveAgentActivity(
  events: readonly RuntimeEvent[],
  options: DeriveAgentActivityOptions = {},
): AgentActivityRow[] {
  const now = options.now ?? Date.now();
  const scoped = options.sessionId
    ? events.filter((event) => event.sessionId === options.sessionId)
    : events;
  const ordered = [...scoped].sort((left, right) => left.sequence - right.sequence);
  const idToRole = new Map<string, ActivityRole>();
  const roles = new Map<ActivityRole, RoleAccum>();

  for (const event of ordered) {
    rememberRole(event, idToRole);
    const role = roleFor(event, idToRole);
    if (!role) continue;
    const accum = roles.get(role) ?? { agents: new Map(), files: new Set(), lastKind: "none" };
    roles.set(role, accum);
    const key = agentKey(event, role);
    const slice = accum.agents.get(key) ?? { phase: "waiting" };
    applyEvent(event, slice, accum);
    accum.agents.set(key, slice);
  }

  const visible: ActivityRole[] = [...HARNESS_ROLES];
  if (roles.has("fixer")) visible.push("fixer");

  return visible.map((role) => {
    const accum = roles.get(role);
    if (!accum || accum.agents.size === 0) {
      const unseen = unseenRow(options.runStatus);
      return toRow(role, unseen.phase, unseen.detail, "—");
    }
    const phase = foldPhase([...accum.agents.values()].map((slice) => slice.phase));
    return toRow(role, phase, summarize(accum, phase), elapsedLabel(accum, phase, now));
  });
}

export function formatElapsed(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest ? `${minutes}m ${rest}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const minuteRest = minutes % 60;
  return minuteRest ? `${hours}h ${minuteRest}m` : `${hours}h`;
}

function unseenRow(runStatus?: CodingSessionStatus | null): { phase: ActivityPhase; detail: string } {
  if (runStatus && terminalStatuses.has(runStatus)) return { phase: "idle", detail: "not run" };
  if (runStatus) return { phase: "waiting", detail: "waiting" };
  return { phase: "idle", detail: "not started" };
}

function toRow(role: ActivityRole, phase: ActivityPhase, detail: string, elapsedLabelText: string): AgentActivityRow {
  const glyph = phase === "done" ? "●" : phase === "active" ? "◉" : phase === "failed" ? "✕" : "○";
  return { role, label: ROLE_LABEL[role], phase, glyph, detail, elapsedLabel: elapsedLabelText };
}

function foldPhase(phases: ActivityPhase[]): ActivityPhase {
  if (phases.some((phase) => phase === "active")) return "active";
  const waiting = phases.some((phase) => phase === "waiting");
  const failed = phases.some((phase) => phase === "failed");
  const done = phases.some((phase) => phase === "done");
  if (waiting && (failed || done)) return "active";
  if (waiting) return "waiting";
  if (failed) return "failed";
  if (done) return "done";
  return "idle";
}

function summarize(accum: RoleAccum, phase: ActivityPhase): string {
  if (phase === "active" && accum.lastKind === "file" && accum.lastFile) {
    return clip(`editing ${accum.lastFile}`) ?? "editing file";
  }
  if (accum.lastDetail) return accum.lastDetail;
  if (accum.files.size > 0 && (phase === "done" || phase === "active")) {
    if (accum.files.size === 1 && accum.lastFile) {
      const verb = phase === "active" ? "editing" : "edited";
      return clip(`${verb} ${accum.lastFile}`) ?? `${verb} 1 file`;
    }
    const verb = phase === "active" ? "editing" : "edited";
    return `${verb} ${accum.files.size} files`;
  }
  if (phase === "active") return "working";
  if (phase === "failed") return "failed";
  if (phase === "done") return "completed";
  if (phase === "idle") return "skipped";
  return "waiting";
}

function elapsedLabel(accum: RoleAccum, phase: ActivityPhase, now: number): string {
  const slices = [...accum.agents.values()];
  const starts = slices.flatMap((slice) => (slice.startedAt === undefined ? [] : [slice.startedAt]));
  if (starts.length === 0) return "—";
  const start = Math.min(...starts);
  if (phase === "active" || phase === "waiting") return formatElapsed(now - start);
  const ends = slices.flatMap((slice) => (slice.endedAt === undefined ? [] : [slice.endedAt]));
  const end = ends.length > 0 ? Math.max(...ends) : start;
  return formatElapsed(end - start);
}

function applyEvent(event: RuntimeEvent, slice: AgentSlice, accum: RoleAccum): void {
  const detail = detailFor(event);
  if (detail) {
    accum.lastDetail = detail;
    accum.lastKind = "text";
  }
  const edited = trackFile(event, accum);
  if (edited) accum.lastKind = "file";
  const next = phaseFor(event);
  if (next) stamp(slice, event, next);
}

function stamp(slice: AgentSlice, event: RuntimeEvent, next: ActivityPhase): void {
  const time = Date.parse(event.timestamp);
  const known = !Number.isNaN(time);
  if ((next === "active" || next === "done" || next === "failed") && slice.startedAt === undefined && known) {
    slice.startedAt = time;
  }
  if (next === "done" || next === "failed") {
    if (known) slice.endedAt = time;
  } else if (next === "active") {
    slice.endedAt = undefined;
  }
  slice.phase = next;
}

function trackFile(event: RuntimeEvent, accum: RoleAccum): boolean {
  let path: string | undefined;
  if (event.type === "subagent.file_changed") path = event.payload.path;
  else if (event.type === "file.changed") path = event.payload.change.path;
  if (!path) return false;
  accum.files.add(path);
  accum.lastFile = path;
  return true;
}

function rememberRole(event: RuntimeEvent, map: Map<string, ActivityRole>): void {
  const task = taskIdentity(event);
  if (!task) return;
  map.set(task.id, task.role);
  if ("subagentId" in event.payload && typeof event.payload.subagentId === "string") {
    map.set(event.payload.subagentId, task.role);
  }
}

function taskIdentity(event: RuntimeEvent): { id: string; role: ActivityRole } | null {
  if (event.type !== "subagent.created" && event.type !== "task.created" && event.type !== "subagent.status_changed") return null;
  if (!isActivityRole(event.payload.task.role)) return null;
  return { id: event.payload.task.id, role: event.payload.task.role };
}

function roleFor(event: RuntimeEvent, map: Map<string, ActivityRole>): ActivityRole | null {
  if (event.type === "plan.created") return "planner";
  if (event.type === "validation.started" || event.type === "validation.completed") return "validator";
  if (event.type === "review.completed") return "reviewer";
  const direct = taskIdentity(event);
  if (direct) return direct.role;
  for (const id of linkedIds(event)) {
    const role = map.get(id);
    if (role) return role;
  }
  return null;
}

function agentKey(event: RuntimeEvent, role: ActivityRole): string {
  return linkedIds(event)[0] ?? role;
}

function linkedIds(event: RuntimeEvent): string[] {
  switch (event.type) {
    case "subagent.created":
    case "subagent.queued":
    case "subagent.started":
    case "subagent.progress":
    case "subagent.tool_call":
    case "subagent.file_changed":
    case "subagent.blocked":
    case "subagent.retrying":
    case "subagent.validating":
    case "subagent.completed":
    case "subagent.failed":
    case "subagent.cancelled":
    case "subagent.skipped":
    case "subagent.status_changed":
      return [event.payload.subagentId];
    case "task.created":
      return [event.payload.task.id];
    case "task.ready":
    case "task.started":
    case "task.progress":
    case "task.blocked":
    case "task.retrying":
    case "task.completed":
    case "task.failed":
    case "task.cancelled":
    case "task.skipped":
      return [event.payload.taskId];
    case "file.changed":
      return event.payload.change.taskId ? [event.payload.change.taskId] : [];
    case "command.started":
      return event.payload.taskId ? [event.payload.taskId] : [];
    case "validation.started":
      return event.payload.taskId ? [event.payload.taskId] : [];
    case "validation.completed":
      return event.payload.result.taskId ? [event.payload.result.taskId] : [];
    case "review.completed":
      return event.payload.result.taskId ? [event.payload.result.taskId] : [];
    default:
      return [];
  }
}

function phaseFor(event: RuntimeEvent): ActivityPhase | null {
  switch (event.type) {
    case "subagent.created":
    case "task.created":
    case "subagent.queued":
    case "task.ready":
      return "waiting";
    case "subagent.started":
    case "task.started":
    case "subagent.progress":
    case "task.progress":
    case "subagent.tool_call":
    case "subagent.file_changed":
    case "file.changed":
    case "subagent.retrying":
    case "task.retrying":
    case "subagent.validating":
    case "validation.started":
    case "command.started":
      return "active";
    case "plan.created":
    case "subagent.completed":
    case "task.completed":
      return "done";
    case "subagent.failed":
    case "task.failed":
    case "subagent.cancelled":
    case "task.cancelled":
    case "subagent.blocked":
    case "task.blocked":
      return "failed";
    case "subagent.skipped":
    case "task.skipped":
      return "idle";
    case "validation.completed": {
      const status = event.payload.result.status;
      return status === "failed" || status === "cancelled" ? "failed" : "done";
    }
    case "review.completed":
      return event.payload.result.status === "failed" ? "failed" : "done";
    case "subagent.status_changed":
      return phaseFromStatus(event.payload.status);
    default:
      return null;
  }
}

function phaseFromStatus(status: string): ActivityPhase | null {
  switch (status) {
    case "created":
    case "queued":
    case "waiting_for_dependencies":
      return "waiting";
    case "starting":
    case "working":
    case "retrying":
    case "validating":
      return "active";
    case "blocked":
    case "failed":
    case "cancelled":
      return "failed";
    case "completed":
      return "done";
    case "skipped":
      return "idle";
    default:
      return null;
  }
}

function detailFor(event: RuntimeEvent): string | null {
  switch (event.type) {
    case "plan.created":
      return clip(event.payload.summary) ?? "created implementation plan";
    case "subagent.progress":
    case "task.progress":
      return clip(event.payload.message);
    case "subagent.tool_call":
      return clip(event.payload.tool);
    case "subagent.completed":
    case "task.completed":
      return clip(event.payload.summary);
    case "validation.started":
      return clip(event.payload.command) ?? "validation started";
    case "validation.completed": {
      const result = event.payload.result;
      const command = clip(result.command);
      if (result.status === "passed") return command ? `passed ${command}` : "passed";
      if (result.status === "failed") return command ? `failed ${command}` : "failed";
      return command ? `${result.status} ${command}` : result.status;
    }
    case "review.completed":
      return clip(event.payload.result.summary) ?? `review ${event.payload.result.status}`;
    case "subagent.failed":
    case "task.failed":
      return clip(event.payload.error) ?? "failed";
    case "subagent.blocked":
    case "task.blocked":
    case "subagent.skipped":
    case "task.skipped":
    case "subagent.cancelled":
    case "task.cancelled":
      return clip(event.payload.reason);
    case "command.started":
      return clip(event.payload.command);
    case "subagent.status_changed": {
      const task = event.payload.task;
      if (event.payload.status === "completed") return clip(task.summary);
      if (event.payload.status === "failed") return clip(task.error) ?? clip(event.payload.reason);
      if (event.payload.status === "working") return clip(task.title);
      return clip(event.payload.reason);
    }
    default:
      return null;
  }
}

function isActivityRole(value: unknown): value is ActivityRole {
  return value === "scout" || value === "planner" || value === "builder"
    || value === "validator" || value === "reviewer" || value === "fixer";
}

function clip(value: unknown, max = 72): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}
