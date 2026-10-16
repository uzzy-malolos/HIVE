/**
 * tool-card.ts
 * One transcript entry per tool activity. The header is always one record.
 * Expanded cards carry the bounded diff or redacted command output.
 */

export type ToolCardKind = "read" | "edit" | "command" | "other";

export interface ToolCard {
  id: string;
  kind: ToolCardKind;
  tool: string;
  summary: string;
  status: string;
  expanded: boolean;
  mutating: boolean;
  /** Guarded Accept / Reject. Plan cards stay promptless and do not apply. */
  prompt: boolean;
  body: string[];
}

const MARK = "@@tool";

function field(value: string): string {
  const cleaned = value.replace(/[\t\r\n]/g, " ").trim();
  return cleaned || "-";
}

export function serializeToolCard(card: ToolCard): string {
  const head = [
    MARK,
    field(card.id),
    card.kind,
    field(card.tool),
    field(card.summary),
    field(card.status),
    card.expanded ? "1" : "0",
    card.mutating ? "1" : "0",
    card.prompt ? "1" : "0",
  ].join("\t");
  return card.body.length > 0 ? `${head}\n${card.body.join("\n")}` : head;
}

export function parseToolCard(entry: string): ToolCard | null {
  const normalized = entry.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const breakAt = normalized.indexOf("\n");
  const head = breakAt === -1 ? normalized : normalized.slice(0, breakAt);
  if (!head.startsWith(`${MARK}\t`)) return null;
  const parts = head.split("\t");
  if (parts.length !== 9) return null;
  const [, id, kind, tool, summary, status, expanded, mutating, prompt] = parts;
  if (!id || !tool || !summary || !status) return null;
  if (kind !== "read" && kind !== "edit" && kind !== "command" && kind !== "other") return null;
  if (expanded !== "0" && expanded !== "1") return null;
  if (mutating !== "0" && mutating !== "1") return null;
  if (prompt !== "0" && prompt !== "1") return null;
  const body = breakAt === -1 ? [] : normalized.slice(breakAt + 1).split("\n");
  return {
    id,
    kind,
    tool,
    summary,
    status,
    expanded: expanded === "1",
    mutating: mutating === "1",
    prompt: prompt === "1",
    body,
  };
}

export function collapseToolCards(transcript: readonly string[]): string[] {
  return transcript.map((entry) => {
    const card = parseToolCard(entry);
    if (!card?.expanded) return entry;
    return serializeToolCard({ ...card, expanded: false });
  });
}

export function toggleLatestToolCard(transcript: readonly string[]): string[] {
  let target = -1;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (parseToolCard(transcript[index] ?? "")) {
      target = index;
      break;
    }
  }
  if (target < 0) return [...transcript];
  return transcript.map((entry, index) => {
    if (index !== target) return entry;
    const card = parseToolCard(entry);
    if (!card) return entry;
    return serializeToolCard({ ...card, expanded: !card.expanded });
  });
}

/** The newest mutating card is the one that can show Accept / Reject. */
export function promptNewestMutatingCard(transcript: readonly string[], status: string): string[] {
  let target = -1;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const card = parseToolCard(transcript[index] ?? "");
    if (card?.mutating) {
      target = index;
      break;
    }
  }
  if (target < 0) return [...transcript];
  return transcript.map((entry, index) => {
    const card = parseToolCard(entry);
    if (!card) return entry;
    if (index === target) return serializeToolCard({ ...card, status, prompt: true, expanded: true });
    if (!card.prompt) return entry;
    return serializeToolCard({ ...card, prompt: false });
  });
}

export function closePromptedToolCard(transcript: readonly string[], status: string): string[] {
  let target = -1;
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    if (parseToolCard(transcript[index] ?? "")?.prompt) {
      target = index;
      break;
    }
  }
  if (target < 0) return [...transcript];
  return transcript.map((entry, index) => {
    if (index !== target) return entry;
    const card = parseToolCard(entry);
    if (!card) return entry;
    return serializeToolCard({ ...card, prompt: false, status });
  });
}

export function updateToolCard(transcript: readonly string[], id: string, status: string, body?: readonly string[]): string[] {
  return transcript.map((entry) => {
    const card = parseToolCard(entry);
    if (!card || card.id !== id) return entry;
    return serializeToolCard({ ...card, status, body: body ? [...body] : card.body });
  });
}

/** Cancellation suppresses late prose, so close active cards at the same boundary. */
export function cancelActiveToolCards(transcript: readonly string[]): string[] {
  return transcript.map((entry) => {
    const card = parseToolCard(entry);
    if (!card || (card.status !== "running" && card.status !== "asking")) return entry;
    return serializeToolCard({ ...card, status: "cancelled", prompt: false });
  });
}

export function toolCardCount(transcript: readonly string[]): number {
  let count = 0;
  for (const entry of transcript) {
    if (parseToolCard(entry)) count += 1;
  }
  return count;
}

/** Absent or out-of-range focus follows the latest card. */
export function focusedToolCardPosition(count: number, focus: number | undefined): number {
  if (count <= 0) return -1;
  if (focus === undefined || !Number.isInteger(focus) || focus < 0 || focus >= count) return count - 1;
  return focus;
}

export function moveToolCardFocus(count: number, focus: number | undefined, delta: -1 | 1): number {
  const current = focusedToolCardPosition(count, focus);
  if (current < 0) return 0;
  return Math.max(0, Math.min(count - 1, current + delta));
}

export function toggleFocusedToolCard(transcript: readonly string[], focus: number | undefined): string[] {
  const indexes: number[] = [];
  transcript.forEach((entry, index) => {
    if (parseToolCard(entry)) indexes.push(index);
  });
  const position = focusedToolCardPosition(indexes.length, focus);
  const target = position >= 0 ? indexes[position] : undefined;
  if (target === undefined) return [...transcript];
  return transcript.map((entry, index) => {
    if (index !== target) return entry;
    const card = parseToolCard(entry);
    if (!card) return entry;
    return serializeToolCard({ ...card, expanded: !card.expanded });
  });
}

/** Session and agent identity keep reused provider IDs from matching another card. */
export function toolCallCardId(sessionId: string, subagentId: string, callId: string): string {
  return ["tool", sessionId, subagentId, callId].map(encodeURIComponent).join(":");
}

/** Attach redacted command output only to its correlated card. */
export function appendCommandCardOutput(transcript: readonly string[], id: string, line: string): string[] | null {
  for (let index = transcript.length - 1; index >= 0; index -= 1) {
    const card = parseToolCard(transcript[index] ?? "");
    if (!card || card.id !== id) continue;
    const next = [...transcript];
    next[index] = serializeToolCard({ ...card, body: [...card.body, line] });
    return next;
  }
  return null;
}
