import { FormEvent, MutableRefObject, useRef } from "react";
import type { CodingFinalReport } from "../../../../src/coding/types";
import type { DesktopEvent, DesktopProviderMetadata, GuardedGitActionPreview, ThreadRecordV1, ThreadRunRef } from "../../../../src/desktop/types";
import type { DesktopCommandInput } from "../bridge";
import type { CenterTab, DesktopViewState } from "../state";
import { CenterStage } from "./CenterStage";
import { ChatView } from "./chat/ChatView";
import { Inspector } from "./Inspector";
import { LeftRail } from "./LeftRail";
import { ResizeHandle } from "./ResizeHandle";

export interface DualCockpitProps {
  state: DesktopViewState;
  modalOpen?: boolean;
  send: (command: DesktopCommandInput) => Promise<DesktopEvent>;
  repositoryPath: string;
  setRepositoryPath: (path: string) => void;
  busy: boolean;
  activeThread?: ThreadRecordV1;
  activeRun: ThreadRunRef | null;
  currentRun: ThreadRunRef | null;
  repositoryActiveRun: ThreadRunRef | null;
  report: CodingFinalReport | null;
  sessionId?: string;
  composer: string;
  setComposer: (value: string) => void;
  saving: boolean;
  retryMessageId: string | null;
  newThreadTitle: string;
  setNewThreadTitle: (title: string) => void;
  splitRatio: number;
  onSplitRatioChange: (ratio: number) => void;
  mainRef: MutableRefObject<HTMLElement | null>;
  tabRefs: MutableRefObject<Record<CenterTab, HTMLButtonElement | null>>;
  onOpenRepository: (path: string) => Promise<void>;
  onCreateThread: (event: FormEvent) => Promise<void>;
  onLoadThread: (thread: ThreadRecordV1) => Promise<void>;
  onArchiveThread: (threadId: string) => Promise<void>;
  onChooseTab: (tab: CenterTab) => Promise<void>;
  onRetryRun: (messageId: string) => Promise<void>;
  onSubmitMessage: (event: FormEvent) => Promise<void>;
  onClearCredential: () => void;
  onProviderChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  onOpenProviderDialog: () => void;
  onRunAction: (type: "pause" | "resume" | "cancel") => Promise<void>;
  onPreviewGit: (action: "commit" | "discard" | "push" | "pull-request") => Promise<void>;
  onSendExternal: (command: DesktopCommandInput) => Promise<DesktopEvent>;
  onToggleLeftRail: () => void;
  onToggleRightRail?: () => void;
  onOpenSettings: () => void;
  onHandoffToCoder?: (threadId: string) => void;
}

export function DualCockpit({
  state,
  modalOpen,
  send,
  repositoryPath,
  setRepositoryPath,
  busy,
  activeThread,
  activeRun,
  currentRun,
  repositoryActiveRun,
  report,
  sessionId,
  composer,
  setComposer,
  saving,
  retryMessageId,
  newThreadTitle,
  setNewThreadTitle,
  splitRatio,
  onSplitRatioChange,
  mainRef,
  tabRefs,
  onOpenRepository,
  onCreateThread,
  onLoadThread,
  onArchiveThread,
  onChooseTab,
  onRetryRun,
  onSubmitMessage,
  onClearCredential,
  onProviderChange,
  onOpenProviderDialog,
  onRunAction,
  onPreviewGit,
  onSendExternal,
  onToggleLeftRail,
  onToggleRightRail,
  onOpenSettings,
  onHandoffToCoder,
}: DualCockpitProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const leftRailOpen = state.rails.left;
  const rightRailOpen = state.rails.right;
  const isPausing = Boolean(currentRun && state.pausingSessionId === currentRun.codingSessionId);

  // Calculate percentage column sizes
  const chatPct = Math.round(splitRatio * 100);
  const coderPct = 100 - chatPct;

  return (
    <div
      ref={containerRef}
      className={`dual-cockpit ${!leftRailOpen ? "hide-left-rail" : ""}`}
      data-testid="dual-cockpit-workspace"
      aria-hidden={modalOpen || undefined}
    >
      {/* Left Navigation: Unified Project & Task Tree */}
      {leftRailOpen && (
        <aside className="dual-left-rail-container" aria-label="Workspace navigation">
          <LeftRail
            repositoryPath={repositoryPath}
            setRepositoryPath={setRepositoryPath}
            busy={busy}
            repositories={state.repositories}
            repositoryRoot={state.repositoryRoot}
            threads={state.threads}
            activeThreadId={state.activeThreadId}
            newThreadTitle={newThreadTitle}
            setNewThreadTitle={setNewThreadTitle}
            onOpenRepository={onOpenRepository}
            onCreateThread={onCreateThread}
            onLoadThread={onLoadThread}
            onOpenSettings={onOpenSettings}
          />
        </aside>
      )}

      {/* Main Dual Stage: Chat Stream (Left) + Coder Workspace (Right) */}
      <div className="dual-stage" style={{ gridTemplateColumns: `${chatPct}% 4px ${coderPct}%` }}>
        {/* Left Stage: HiveBot Conversational Stream & Planning */}
        <section className="dual-chat-pane" aria-label="HiveBot conversation stream">
          <div className="pane-header">
            <div className="pane-title">
              <span className="pane-dot hive-chat-dot" />
              <strong>HiveBot</strong>
              <span className="pane-sub">Chatbot & Council Stream</span>
            </div>
            <div className="pane-actions">
              <button
                type="button"
                className="pane-action-btn"
                title="Toggle Left Rail [/]"
                onClick={onToggleLeftRail}
              >
                [/]
              </button>
            </div>
          </div>
          <div className="pane-content">
            <ChatView
              state={state}
              send={send}
              embedded
              onToggleLeftRail={onToggleLeftRail}
              onHandoffToCoder={onHandoffToCoder}
            />
          </div>
        </section>

        {/* Draggable Divider */}
        <ResizeHandle
          splitRatio={splitRatio}
          onSplitRatioChange={onSplitRatioChange}
          containerRef={containerRef}
        />

        {/* Right Stage: Hive Code Coder Workspace, Diff & Verified Reports */}
        <section className="dual-coder-pane" aria-label="Hive Code workspace and verification">
          <div className="pane-header">
            <div className="pane-title">
              <span className="pane-dot hive-code-dot" />
              <strong>Hive Code</strong>
              <span className="pane-sub">Verified Worktree & Diffs</span>
            </div>
            <div className="pane-actions">
              {currentRun && (
                <div className="pane-status-chip">
                  <span className={`status-indicator status-${currentRun.status}`} />
                  <span>{currentRun.status}</span>
                </div>
              )}
              {onToggleRightRail && (
                <button
                  type="button"
                  className="pane-action-btn"
                  title="Toggle Inspector [\]"
                  onClick={onToggleRightRail}
                >
                  [\]
                </button>
              )}
            </div>
          </div>
          <div className="coder-pane-split">
            <div className="coder-stage-main">
              <CenterStage
                state={state}
                activeThread={activeThread}
                activeRun={activeRun}
                currentRun={currentRun}
                repositoryActiveRun={repositoryActiveRun}
                report={report}
                sessionId={sessionId}
                composer={composer}
                setComposer={setComposer}
                saving={saving}
                retryMessageId={retryMessageId}
                mainRef={mainRef}
                tabRefs={tabRefs}
                onArchiveThread={onArchiveThread}
                onChooseTab={onChooseTab}
                onRetryRun={onRetryRun}
                onSubmitMessage={onSubmitMessage}
              />
            </div>
            {rightRailOpen && (
              <aside className="coder-stage-inspector">
                <Inspector
                  state={state}
                  currentRun={currentRun}
                  activeRun={activeRun}
                  isPausing={isPausing}
                  sessionId={sessionId}
                  report={report}
                  onClearCredential={onClearCredential}
                  onProviderChange={onProviderChange}
                  onOpenProviderDialog={onOpenProviderDialog}
                  onRunAction={onRunAction}
                  onPreviewGit={onPreviewGit}
                  onSendExternal={onSendExternal}
                />
              </aside>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
