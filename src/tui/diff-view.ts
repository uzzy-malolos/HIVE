/**
 * diff-view.ts
 * Bounded unified diffs for edit activity. Secrets are redacted.
 * A write that did not carry the previous file says so.
 */

import { redactKnownSecrets } from "../security/secrets.js";
import { safeDisplayTarget } from "./interaction.js";

const MAX_BODY_LINES = 16;
const MAX_INPUT_LINES = 80;
const MAX_LINE_CHARS = 120;
const MAX_PATCH_SCAN = 2_000;

export interface UnifiedDiffInput {
  path: string;
  before?: string;
  after?: string;
  patch?: string;
  /** `missing` means the event did not include the previous file text. */
  baseline?: "exact" | "empty" | "missing";
}

interface DiffOp {
  kind: "eq" | "add" | "del";
  text: string;
}

export function formatUnifiedDiff(input: UnifiedDiffInput): string[] {
  const file = safeDisplayTarget("edit", input.path);
  if (input.patch !== undefined && input.patch.trim()) return formatPatch(file, input.patch);
  const before = input.before ?? "";
  const after = input.after ?? "";
  if (!before && !after) return [];
  if (before.includes("\0") || after.includes("\0")) return [`diff ${file}  binary content omitted`];

  const beforeLines = clampLines(before);
  const afterLines = clampLines(after);
  const ops = lineDiff(beforeLines.lines, afterLines.lines);
  let added = 0;
  let removed = 0;
  for (const op of ops) {
    if (op.kind === "add") added += 1;
    if (op.kind === "del") removed += 1;
  }
  const body = formatBody(ops);
  const truncated = beforeLines.truncated || afterLines.truncated || body.truncated;
  const lines = [`diff ${file}  +${added} -${removed}`];
  if (input.baseline === "missing") lines.push("previous file text was not on the event");
  lines.push(`--- a/${file}`, `+++ b/${file}`, ...body.lines);
  if (truncated) lines.push("...[truncated]");
  return lines;
}

export function diffLinesForRuntimeEvent(event: { type: string; payload?: unknown }): string[] {
  if (event.type !== "subagent.tool_call") return [];
  const payload = asRecord(event.payload);
  const tool = stringField(payload, ["tool", "name"]);
  const input = asRecord(payload?.input) ?? asRecord(payload?.arguments);
  if (!tool || !input) return [];

  if (tool === "edit_file" || tool === "edit") {
    const file = stringField(input, ["path", "file", "file_path"]) ?? "file";
    const search = stringField(input, ["search", "old_string", "oldString"]);
    const replacement = stringField(input, ["replacement", "new_string", "newString"]) ?? "";
    if (search === undefined) return [];
    return formatUnifiedDiff({ path: file, before: search, after: replacement, baseline: "exact" });
  }

  if (tool === "apply_patch") {
    const patch = stringField(input, ["patch", "diff"]);
    if (!patch) return [];
    return formatUnifiedDiff({ path: patchPath(patch), patch, baseline: "exact" });
  }

  if (tool === "create_file") {
    const file = stringField(input, ["path", "file", "file_path"]) ?? "file";
    const content = stringField(input, ["content", "contents"]);
    if (content === undefined) return [];
    return formatUnifiedDiff({ path: file, before: "", after: content, baseline: "empty" });
  }

  if (tool === "write_file" || tool === "write") {
    const file = stringField(input, ["path", "file", "file_path"]) ?? "file";
    const content = stringField(input, ["content", "contents"]);
    if (content === undefined) return [];
    return formatUnifiedDiff({ path: file, before: "", after: content, baseline: "missing" });
  }

  return [];
}

function formatPatch(file: string, patch: string): string[] {
  if (patch.includes("\0")) return [`diff ${file}  binary content omitted`];
  const rawLines = patch.split(/\r?\n/);
  const scanned = rawLines.slice(0, MAX_PATCH_SCAN);
  let added = 0;
  let removed = 0;
  let omitted = false;
  const body: string[] = [];
  for (const raw of scanned) {
    if (raw.startsWith("+") && !raw.startsWith("+++")) added += 1;
    else if (raw.startsWith("-") && !raw.startsWith("---")) removed += 1;
    if (!raw.trim()) continue;
    if (body.length >= MAX_BODY_LINES) {
      omitted = true;
      continue;
    }
    body.push(clip(redactKnownSecrets(raw)));
  }
  const truncated = rawLines.length > scanned.length || omitted;
  const lines = [`diff ${file}  +${added} -${removed}`, ...body];
  if (truncated) lines.push("...[truncated]");
  return lines;
}

function formatBody(ops: readonly DiffOp[]): { lines: string[]; truncated: boolean } {
  const interesting: string[] = [];
  for (let index = 0; index < ops.length; index += 1) {
    const nearby = ops.slice(Math.max(0, index - 1), index + 2).some((op) => op.kind !== "eq");
    if (!nearby) continue;
    const op = ops[index];
    if (!op) continue;
    const prefix = op.kind === "add" ? "+" : op.kind === "del" ? "-" : " ";
    interesting.push(`${prefix}${clip(redactKnownSecrets(op.text))}`);
  }
  return {
    lines: interesting.slice(0, MAX_BODY_LINES),
    truncated: interesting.length > MAX_BODY_LINES,
  };
}

function lineDiff(before: readonly string[], after: readonly string[]): DiffOp[] {
  const rows = before.length;
  const cols = after.length;
  if (rows * cols > 20_000) {
    return [
      ...before.slice(0, MAX_BODY_LINES).map((text) => ({ kind: "del" as const, text })),
      ...after.slice(0, MAX_BODY_LINES).map((text) => ({ kind: "add" as const, text })),
    ];
  }
  const scores: number[][] = Array.from({ length: rows + 1 }, () => new Array<number>(cols + 1).fill(0));
  for (let row = rows - 1; row >= 0; row -= 1) {
    for (let col = cols - 1; col >= 0; col -= 1) {
      scores[row][col] = before[row] === after[col]
        ? (scores[row + 1]?.[col + 1] ?? 0) + 1
        : Math.max(scores[row + 1]?.[col] ?? 0, scores[row]?.[col + 1] ?? 0);
    }
  }
  const ops: DiffOp[] = [];
  let row = 0;
  let col = 0;
  while (row < rows && col < cols) {
    if (before[row] === after[col]) {
      ops.push({ kind: "eq", text: before[row] ?? "" });
      row += 1;
      col += 1;
    } else if ((scores[row + 1]?.[col] ?? 0) >= (scores[row]?.[col + 1] ?? 0)) {
      ops.push({ kind: "del", text: before[row] ?? "" });
      row += 1;
    } else {
      ops.push({ kind: "add", text: after[col] ?? "" });
      col += 1;
    }
  }
  while (row < rows) {
    ops.push({ kind: "del", text: before[row] ?? "" });
    row += 1;
  }
  while (col < cols) {
    ops.push({ kind: "add", text: after[col] ?? "" });
    col += 1;
  }
  return ops;
}

function clampLines(value: string): { lines: string[]; truncated: boolean } {
  const normalized = value.replace(/\r\n/g, "\n");
  const trimmed = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  if (!trimmed) return { lines: [], truncated: false };
  const lines = trimmed.split("\n");
  if (lines.length <= MAX_INPUT_LINES) return { lines, truncated: false };
  return { lines: lines.slice(0, MAX_INPUT_LINES), truncated: true };
}

function clip(value: string): string {
  return value.length > MAX_LINE_CHARS ? `${value.slice(0, MAX_LINE_CHARS - 3)}...` : value;
}

function patchPath(patch: string): string {
  const git = patch.match(/^diff --git a\/(.+?) b\/(.+)$/m);
  if (git?.[2]) return git[2];
  const plus = patch.match(/^\+\+\+ (?:b\/)?(.+)$/m);
  if (plus?.[1]) return plus[1];
  return "patch";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return Object.fromEntries(Object.entries(value));
}

function stringField(source: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (!source) return undefined;
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string") return value;
  }
  return undefined;
}
