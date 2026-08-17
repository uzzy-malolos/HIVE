import type { ThreadRecordV1 } from "../../../../src/desktop/types";
import { latestRun } from "../state";
import { formatRelativeTime } from "../utils";
import { EmptyState } from "./EmptyState";

export interface ThreadListProps {
  threads: ThreadRecordV1[];
  activeId: string | null;
  onLoad: (thread: ThreadRecordV1) => Promise<void>;
}

export function ThreadList({ threads, activeId, onLoad }: ThreadListProps) {
  if (!threads.length) return <EmptyState>No threads found.</EmptyState>;

  return (
    <ul className="plain-list thread-list">
      {threads.map((thread) => {
        const run = latestRun(thread);
        const isRunning = run && !["completed", "failed", "cancelled"].includes(run.status);
        const isCompleted = run?.status === "completed";
        const isFailed = run?.status === "failed" || run?.status === "cancelled";
        const relTime = formatRelativeTime(thread.updatedAt || thread.createdAt);

        return (
          <li key={thread.id}>
            <button
              className={`thread-item-btn ${thread.id === activeId ? "active" : ""}`}
              aria-current={thread.id === activeId ? "page" : undefined}
              onClick={() => void onLoad(thread)}
            >
              <div className="thread-row">
                <div className="thread-row-info">
                  <span className="thread-title">{thread.title}</span>
                  <small className="thread-meta-count sr-only">{thread.messages.length} messages / {thread.runs.length} runs</small>
                </div>
                <div className="thread-row-status">
                  {isRunning ? (
                    <span className="thread-running-spinner" aria-hidden="true">↻</span>
                  ) : relTime ? (
                    <span className="thread-rel-time">{relTime}</span>
                  ) : null}
                  {run && (
                    <span
                      className={`thread-badge ${
                        isRunning ? "badge-running anim-running" : isCompleted ? "badge-completed" : isFailed ? "badge-failed" : ""
                      }`}
                    >
                      {isRunning ? "[~]" : isCompleted ? "[ok]" : isFailed ? "[!!]" : ""}
                    </span>
                  )}
                </div>
              </div>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
