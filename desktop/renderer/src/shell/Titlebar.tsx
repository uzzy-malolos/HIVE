import React from "react";
import { WorkspaceTabs, type WorkspaceTab } from "./WorkspaceTabs";

export interface TitlebarProps {
  projectName?: string;
  repositoryPath?: string;
  sessionTabs?: WorkspaceTab[];
  activeTabId?: string | null;
  onSelectTab?: (id: string) => void;
  onCloseTab?: (id: string) => void;
  onNewTab?: () => void;
  activeModelName?: string;
  onOpenModelPicker?: () => void;
  onOpenSettings?: () => void;
  worker?: string;
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;
}

const HIVE_MARK = (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
    <path
      d="M12 2L20.66 7V17L12 22L3.34 17V7L12 2Z"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
    <path
      d="M12 7L16.33 9.5V14.5L12 17L7.67 14.5V9.5L12 7Z"
      stroke="currentColor"
      strokeWidth="1.25"
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  </svg>
);

/** Desktop chrome: brand + project identity, session tabs, model/settings strip. */
export function Titlebar({
  projectName = "HIVE",
  repositoryPath,
  sessionTabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
  activeModelName = "HIVE Auto",
  onOpenModelPicker,
  onOpenSettings,
  worker = "idle",
  sidebarOpen = true,
  onToggleSidebar,
}: TitlebarProps) {
  const showModelPicker = Boolean(onOpenModelPicker || onOpenSettings);
  const hasTabs = Boolean(sessionTabs && sessionTabs.length > 0);

  return (
    <header className="hive-titlebar" role="banner">
      {onToggleSidebar ? (
        <button
          type="button"
          className="hive-titlebar-btn hive-titlebar-sidebar-toggle"
          onClick={onToggleSidebar}
          aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
          aria-pressed={sidebarOpen}
          title={`${sidebarOpen ? "Collapse" : "Expand"} sidebar (Ctrl+B)`}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </button>
      ) : null}
      <div className="hive-titlebar-brand">
        <span className="hive-titlebar-mark" aria-hidden="true">
          {HIVE_MARK}
        </span>
        <span className="hive-titlebar-wordmark">HIVE</span>
      </div>

      {repositoryPath ? (
        <div className="hive-titlebar-project">
          <span className="hive-titlebar-project-name">{projectName}</span>
          <span className="hive-titlebar-project-path">{repositoryPath}</span>
        </div>
      ) : null}

      {hasTabs ? (
        <WorkspaceTabs
          tabs={sessionTabs!}
          activeId={activeTabId ?? null}
          onSelect={onSelectTab}
          onClose={onCloseTab}
          onNew={onNewTab}
        />
      ) : null}

      <div className="hive-titlebar-right">
        {worker !== "idle" ? (
          <span className="hive-titlebar-chip" aria-label={`Worker ${worker}`}>
            <span className={`hive-status-dot${worker === "running" ? " is-running" : ""}`} aria-hidden="true" />
            <span>{worker}</span>
          </span>
        ) : null}

        {showModelPicker ? (
          <button
            type="button"
            className="hive-titlebar-btn"
            onClick={onOpenModelPicker || onOpenSettings}
            title="Select AI model"
            aria-label={`Active model: ${activeModelName}`}
          >
            <span className="hive-titlebar-model">{activeModelName}</span>
          </button>
        ) : null}

        {onOpenSettings ? (
          <button
            type="button"
            className="hive-titlebar-btn"
            onClick={onOpenSettings}
            aria-label="Open settings"
            title="Settings - providers and API keys"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        ) : null}
      </div>
    </header>
  );
}