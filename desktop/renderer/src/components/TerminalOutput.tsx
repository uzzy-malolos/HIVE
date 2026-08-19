import { useEffect, useRef } from "react";
import type { RuntimeEvent } from "../../../../src/coding/types";
import type { ToolActivity } from "../state";
import { EmptyState } from "./EmptyState";

export interface TerminalOutputProps {
  events: RuntimeEvent[];
  worker?: string;
  tools?: ToolActivity[];
  onOpenSystemTerminal?: () => void;
}

const MAX_LINES = 400;

export function formatRuntimeEvent(event: RuntimeEvent): string | null {
  const type = event.type;
  const payload = event.payload as Record<string, unknown>;
  if (type === "command.started") return `$ ${String(payload.command ?? "")}`;
  if (type === "command.output") return String(payload.chunk ?? "");
  if (type === "command.completed") return `[exit ${payload.exitCode ?? "?"}]`;
  if (type === "subagent.progress") return `[${payload.subagentId}] ${payload.message ?? ""}`;
  if (type === "subagent.tool_call") return `[${payload.subagentId}] ${payload.tool ?? ""}`;
  if (type === "subagent.failed") return `[${payload.subagentId}] failed: ${payload.error ?? ""}`;
  if (type === "validation.started") return `validate: ${payload.command ?? ""}`;
  if (type === "validation.completed") return "validate: completed";
  return null;
}

export function TerminalOutput({ events, worker, tools = [], onOpenSystemTerminal }: TerminalOutputProps) {
  const logRef = useRef<HTMLPreElement>(null);
  const lines = events.map(formatRuntimeEvent).filter((line): line is string => Boolean(line));
  if (worker === "starting") lines.unshift("worker starting...");
  if (worker === "failed") lines.push("worker failed.");
  for (const tool of tools) lines.push(`[tool] ${tool.label}`);
  const visible = lines.slice(-MAX_LINES);

  useEffect(() => {
    const node = logRef.current;
    if (!node) return;
    const nearBottom = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
    if (nearBottom) node.scrollTop = node.scrollHeight;
  }, [visible.length, visible.at(-1)]);

  return (
    <section className="workbench-panel terminal-panel" aria-label="Terminal output">
      <div className="workbench-panel-header">
        <strong>Run log</strong>
        {onOpenSystemTerminal && (
          <button type="button" className="pane-action-btn" onClick={onOpenSystemTerminal}>
            Open system terminal
          </button>
        )}
      </div>
      {visible.length === 0 ? (
        <EmptyState>No run output yet.</EmptyState>
      ) : (
        <pre ref={logRef} className="terminal-log" role="log" aria-live="polite">
          {visible.join("\n")}
        </pre>
      )}
    </section>
  );
}
