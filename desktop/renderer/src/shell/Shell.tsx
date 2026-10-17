import React from "react";
import type { DesktopMode } from "../state";
import { Sidebar, type SidebarRecentProject, type SidebarSession } from "./Sidebar";
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
  onOpenSearch?: () => void;
  onArchiveSession?: (id: string) => void;
  onRenameSession?: (id: string, title: string) => void;
  onDeleteSession?: (id: string) => void;
  starredIds?: string[];
  onToggleStar?: (id: string) => void;
  onOpenShortcuts?: () => void;
  onOpenArchived?: () => void;

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
  onPickRepository?: () => Promise<void>;
  recentProjects?: SidebarRecentProject[];
  busy?: boolean;
  /** When false the global sidebar shrinks to an icon rail (Ctrl+B or the titlebar toggle). */
  sidebarOpen?: boolean;
  onToggleSidebar?: () => void;

  children: React.ReactNode;
}

/** One persistent desktop shell: titlebar, global sidebar, routed workspace, status bar. */
export function Shell({
  mode,
  onSelectMode,
  onCreateTask,
  sessions,
  onSelectSession,
  onOpenSearch,
  onArchiveSession,
  onRenameSession,
  onDeleteSession,
  starredIds,
  onToggleStar,
  onOpenShortcuts,
  onOpenArchived,
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
  onPickRepository,
  recentProjects,
  busy,
  sidebarOpen = true,
  onToggleSidebar,
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
        sidebarOpen={sidebarOpen}
        onToggleSidebar={onToggleSidebar}
      />

      <div className="hive-body">
        <Sidebar
          mode={mode}
          collapsed={!sidebarOpen}
          onOpenSearch={onOpenSearch}
          onArchiveSession={onArchiveSession}
          onRenameSession={onRenameSession}
          onDeleteSession={onDeleteSession}
          starredIds={starredIds}
          onToggleStar={onToggleStar}
          onOpenShortcuts={onOpenShortcuts}
          onOpenArchived={onOpenArchived}
          accountDetail={activeModelName}
          onSelectMode={onSelectMode}
          onCreateTask={onCreateTask}
          sessions={sessions}
          onSelectSession={onSelectSession}
          onOpenUsage={onOpenUsage}
          onOpenSettings={onOpenSettings}
          repositoryPath={repositoryPath}
          setRepositoryPath={setRepositoryPath}
          onOpenRepository={onOpenRepository}
          onPickRepository={onPickRepository}
          recentProjects={recentProjects}
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