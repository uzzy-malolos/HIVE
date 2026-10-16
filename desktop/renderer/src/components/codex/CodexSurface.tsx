import React, { useState, useRef, useEffect } from "react";
import type { DesktopViewState } from "../../state";
import type { DesktopCommandInput } from "../../bridge";
import type { DesktopEvent, ThreadMessage } from "../../../../../src/desktop/types";
import { identifier, preferredScrollBehavior } from "../../utils";
import { renderMarkdown } from "../../markdown";
import { InspectorTabs } from "../inspector/InspectorTabs";
import { AgentActivity } from "./AgentActivity";

export interface CodexSurfaceProps {
  state: DesktopViewState;
  send: (command: DesktopCommandInput) => Promise<DesktopEvent>;
  activeModelName?: string;
  onOpenModelPicker?: () => void;
  onOpenSettings?: () => void;
  onOpenRepositoryPicker?: () => void;
  onSelectFile?: (filePath: string) => Promise<void>;
  onToggleDir?: (dirPath: string) => Promise<void>;
  onPreviewGit?: (action: "commit" | "discard" | "push" | "pull-request") => void;
  onLoadThread?: (threadId: string) => Promise<void>;
  onRewindCheckpoint?: () => Promise<void>;
  hideInspector?: boolean;
  defaultInspectorTab?: "changes" | "files" | "terminal" | "evidence" | "run";
}

export type CodexComposerMode = "agent" | "plan" | "goal" | "council";
export type CodexApprovalPosture = "ask" | "auto" | "autonomous";

export function CodexSurface({
  state,
  send,
  activeModelName = "deepseek / deepseek-coder",
  onOpenModelPicker,
  onOpenSettings,
  onSelectFile,
  onToggleDir,
  onPreviewGit,
  hideInspector = false,
  defaultInspectorTab = "changes",
}: CodexSurfaceProps) {
  const { repositoryRoot, threads, activeThreadId, reports, runtimeEvents, run, selectedSessionId } = state;

  const [composerMode, setComposerMode] = useState<CodexComposerMode>("agent");
  const [posture, setPosture] = useState<CodexApprovalPosture>("auto");
  const [inputTask, setInputTask] = useState("");
  const transcriptEndRef = useRef<HTMLDivElement>(null);

  const activeThread = threads.find((t) => t.id === activeThreadId);
  const latestRun = activeThread?.runs[activeThread.runs.length - 1];
  const codingSessionId = selectedSessionId ?? run?.codingSessionId ?? latestRun?.codingSessionId ?? null;
  const activeReport = codingSessionId ? reports[codingSessionId] ?? null : null;

  useEffect(() => {
    try {
      if (transcriptEndRef.current && typeof transcriptEndRef.current.scrollIntoView === "function") {
        transcriptEndRef.current.scrollIntoView({ behavior: preferredScrollBehavior() });
      }
    } catch {
      // Ignore jsdom absence
    }
  }, [activeThread?.messages?.length]);

  const handleSendTask = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputTask.trim()) return;
    const task = inputTask.trim();

    if (activeThreadId && repositoryRoot) {
      const message: ThreadMessage = {
        id: identifier("message"),
        role: "user",
        content: task,
        createdAt: new Date().toISOString(),
      };
      const res = await send({
        type: "thread.message.append",
        input: {
          threadId: activeThreadId,
          message,
        },
      });
      if (res.type === "request.failed") {
        return;
      }
      setInputTask("");
      await send({
        type: "run.start",
        input: {
          threadId: activeThreadId,
          repositoryRoot,
          currentUserMessageId: message.id,
          options: {
            mode: composerMode === "plan" ? "plan" : "auto",
            approvalPolicy: posture === "ask" ? "always" : posture === "autonomous" ? "safe" : "changes",
          },
        },
      });
    }
  };

  const displayModel = activeModelName || "deepseek / deepseek-coder";
  const missionTitle = activeThread?.title || (repositoryRoot ? "Autonomous Engineering Mission" : "Open a repository to start");

  return (
    <div className="hive-code-layout" aria-label="Hive Code Surface">
      <main className="hive-code-center" role="main">
        <div className="hive-mission-header">
          <div className="hive-mission-title-group">
            <div className="hive-mission-dot" />
            <span className="hive-mission-title">{missionTitle}</span>
          </div>

          <div className="hive-posture-selector" role="group" aria-label="Safety Posture">
            <button
              type="button"
              className={`hive-posture-btn ${posture === "ask" ? "is-active" : ""}`}
              onClick={() => setPosture("ask")}
              title="Guarded: Confirm each file modification"
            >
              Guarded
            </button>
            <button
              type="button"
              className={`hive-posture-btn ${posture === "auto" ? "is-active" : ""}`}
              onClick={() => setPosture("auto")}
              title="Standard: Auto-apply safe changes"
            >
              Standard
            </button>
            <button
              type="button"
              className={`hive-posture-btn ${posture === "autonomous" ? "is-active" : ""}`}
              onClick={() => setPosture("autonomous")}
              title="Autonomous: Unbounded execution within worktree"
            >
              Autonomous
            </button>
          </div>
        </div>

        <div className="hive-code-stream">
          <AgentActivity
            events={runtimeEvents}
            runStatus={run?.status ?? latestRun?.status ?? null}
            sessionId={selectedSessionId}
          />

          {activeThread && activeThread.messages.length > 0 ? (
            <div className="messages-flow" style={{ display: "flex", flexDirection: "column", gap: "16px" }}>
              {activeThread.messages.map((m) => (
                <div key={m.id} className={`hive-message-row ${m.role === "user" ? "is-user" : ""}`}>
                  {m.role === "user" ? (
                    <div className="hive-user-bubble">
                      <div>{m.content}</div>
                    </div>
                  ) : (
                    <div className="hive-assistant-flow">
                      <div className="hive-assistant-body">
                        {renderMarkdown(m.content)}
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="hive-code-empty">
              <p>Describe the change. HIVE edits, tests, and records evidence in this workspace.</p>
            </div>
          )}
          <div ref={transcriptEndRef} />
        </div>

        <form className="hive-composer-container" onSubmit={(event) => void handleSendTask(event)}>
          <div className="hive-composer-box">
            <textarea
              rows={1}
              aria-label="Message HIVE"
              maxLength={20000}
              className="hive-composer-input"
              placeholder="Ask HIVE to implement, test, or refactor..."
              value={inputTask}
              onChange={(e) => setInputTask(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void handleSendTask();
                }
              }}
            />
            <div className="hive-composer-toolbar">
              <div className="hive-composer-left">
                <button
                  type="button"
                  className="hive-composer-btn"
                  onClick={() => setComposerMode(composerMode === "agent" ? "plan" : "agent")}
                >
                  <span className="hive-composer-kicker">Mode</span>
                  <span className="hive-composer-value">{composerMode.toUpperCase()}</span>
                </button>
                <button
                  type="button"
                  className="hive-composer-btn hive-composer-model-btn"
                  onClick={onOpenModelPicker || onOpenSettings}
                >
                  <span className="hive-composer-kicker">Model</span>
                  <span className="hive-composer-value">{displayModel}</span>
                  <span className="hive-composer-chevron" aria-hidden="true">▾</span>
                </button>
              </div>
              <button
                type="submit"
                className="hive-composer-send-btn"
                disabled={!inputTask.trim()}
                aria-label="Send task"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="19" x2="12" y2="5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
              </button>
            </div>
          </div>
        </form>
      </main>

      {!hideInspector && (
        <InspectorTabs
          state={state}
          report={activeReport}
          sessionId={codingSessionId ?? undefined}
          defaultTab={defaultInspectorTab}
          onSelectFile={onSelectFile}
          onToggleDir={onToggleDir}
          onPreviewGit={onPreviewGit}
        />
      )}
    </div>
  );
}
