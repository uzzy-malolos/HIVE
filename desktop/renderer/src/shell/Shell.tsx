import React from "react";
import type { DesktopMode } from "../state";
import { Sidebar, type SidebarSession } from "./Sidebar";
import { Titlebar } from "./Titlebar";
import type { WorkspaceTab } from "./WorkspaceTabs";

export interface ShellStatusItem {
  label: string;
  emphasis?: boolean;
}

export interface ShellProps {
  mode: DesktopMode;
  onSelectMode: (mode: DesktopMode) => void;
  onCreateTask: () => void;
  sessions: SidebarSession[];
  onSelectSession: (id: string) => void;

  projectName?: string;
  repositoryPath?: string;
  sessionTabs?: WorkspaceTab[];
  activeTabId?: string | null;
  onSelectTab?: (id: string) => void;
  onCloseTab?: (id: string) => void;
  onNewTab?: () => void;

  activeModelName?: string;
  onOpenModelPicker?: () => void;
  onOpenSettings: () => void;
  onOpenUsage: () => void;
  worker?: string;
  status?: ShellStatusItem[];
  setRepositoryPath?: (path: string) => void;
  onOpenRepository?: (path: string) => Promise<void>;
  busy?: boolean;

  children: React.ReactNode;
}

/** One persistent desktop shell: titlebar, global sidebar, routed workspace, status bar. */
export function Shell({
  mode,
  onSelectMode,
  onCreateTask,
  sessions,
  onSelectSession,
  projectName,
  repositoryPath,
  sessionTabs,
  activeTabId,
  onSelectTab,
  onCloseTab,
  onNewTab,
  activeModelName,
  onOpenModelPicker,
  onOpenSettings,
  onOpenUsage,
  worker,
  status,
  setRepositoryPath,
  onOpenRepository,
  busy,
  children,
}: ShellProps) {
  return (
    <div className="hive-shell hub-shell">
      <Titlebar
        projectName={projectName}
        repositoryPath={repositoryPath}
        sessionTabs={sessionTabs}
        activeTabId={activeTabId}
        onSelectTab={onSelectTab}
        onCloseTab={onCloseTab}
        onNewTab={onNewTab}
        activeModelName={activeModelName}
        onOpenModelPicker={onOpenModelPicker}
        onOpenSettings={onOpenSettings}
        worker={worker}
      />

      <div className="hive-body">
        <Sidebar
          mode={mode}
          onSelectMode={onSelectMode}
          onCreateTask={onCreateTask}
          sessions={sessions}
          onSelectSession={onSelectSession}
          onOpenUsage={onOpenUsage}
          onOpenSettings={onOpenSettings}
          repositoryPath={repositoryPath}
          setRepositoryPath={setRepositoryPath}
          onOpenRepository={onOpenRepository}
          busy={busy}
        />
        <main className="hive-main">
          {children}
        </main>
      </div>

      {status && status.length > 0 ? (
        <footer className="hive-statusbar">
          {status.map((item) => (
            <span key={item.label} className={`hive-statusbar-item${item.emphasis ? " is-emphasis" : ""}`}>
              {item.label}
            </span>
          ))}
        </footer>
      ) : null}
    </div>
  );
}