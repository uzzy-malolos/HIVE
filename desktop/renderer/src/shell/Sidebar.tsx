import React, { useEffect, useState } from "react";
import type { DesktopMode } from "../state";
import { projectName } from "../utils";

export interface SidebarSession {
  id: string;
  title: string;
  kind: "chat" | "coder";
  active: boolean;
  status?: string;
  /** ISO timestamp used to group the list into Today / Yesterday / Previous 7 days / Older. */
  updatedAt?: string;
}

export interface SidebarRecentProject {
  path: string;
  lastOpenedAt: string;
}

export interface SidebarProps {
  mode: DesktopMode;
  onSelectMode: (mode: DesktopMode) => void;
  onCreateTask: () => void;
  onOpenSearch?: () => void;
  sessions: SidebarSession[];
  onSelectSession: (id: string) => void;
  onOpenUsage: () => void;
  onOpenSettings: () => void;
  repositoryPath?: string;
  setRepositoryPath?: (path: string) => void;
  onOpenRepository?: (path: string) => Promise<void>;
  /** Opens the native folder picker and then the chosen project. */
  onPickRepository?: () => Promise<void>;
  recentProjects?: SidebarRecentProject[];
  busy?: boolean;
}

const RECENT_PROJECT_LIMIT = 5;
const DAY_MS = 24 * 60 * 60 * 1000;

type SessionGroup = { label: string; sessions: SidebarSession[] };

/** Buckets already-sorted sessions by local calendar day, preserving order. */
export function groupSessionsByDate(sessions: SidebarSession[], now: Date = new Date()): SessionGroup[] {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const buckets: SessionGroup[] = [
    { label: "Today", sessions: [] },
    { label: "Yesterday", sessions: [] },
    { label: "Previous 7 days", sessions: [] },
    { label: "Older", sessions: [] },
  ];
  for (const session of sessions) {
    const time = session.updatedAt ? Date.parse(session.updatedAt) : Number.NaN;
    const index = !Number.isFinite(time) ? 3
      : time >= startOfToday ? 0
      : time >= startOfToday - DAY_MS ? 1
      : time >= startOfToday - 7 * DAY_MS ? 2
      : 3;
    buckets[index].sessions.push(session);
  }
  return buckets.filter((bucket) => bucket.sessions.length > 0);
}

const GLYPHS: Record<string, React.ReactNode> = {
  chat: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 11.5a8.38 8.38 0 0 1-9 8.35 8.5 8.5 0 0 1-3.67-.87L3 21l1.13-5.09A8.38 8.38 0 0 1 3 11.5a8.5 8.5 0 0 1 18 0Z" />
    </svg>
  ),
  coder: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2" />
    </svg>
  ),
  split: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <line x1="12" y1="3" x2="12" y2="21" />
    </svg>
  ),
  usage: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M22 12h-4l-3 9L9 3l-3 9H2" />
    </svg>
  ),
  settings: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  folder: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  ),
};


export function Sidebar({
  mode,
  onSelectMode,
  onCreateTask,
  onOpenSearch,
  sessions,
  onSelectSession,
  onOpenUsage,
  onOpenSettings,
  repositoryPath = "",
  setRepositoryPath,
  onOpenRepository,
  onPickRepository,
  recentProjects = [],
  busy = false,
}: SidebarProps) {
  const [path, setPath] = useState(repositoryPath);
  const [switcherOpen, setSwitcherOpen] = useState(!repositoryPath);
  const [query, setQuery] = useState("");

  // Follow the open project when it changes from elsewhere (palette, picker, startup).
  useEffect(() => {
    if (!repositoryPath) return;
    setPath(repositoryPath);
    setSwitcherOpen(false);
  }, [repositoryPath]);

  const listsTasks = mode === "coder";
  const noun = listsTasks ? "tasks" : "chats";
  const needle = query.trim().toLowerCase();
  const visibleSessions = needle
    ? sessions.filter((session) => session.title.toLowerCase().includes(needle))
    : sessions;
  const groups = groupSessionsByDate(visibleSessions);
  const currentKey = repositoryPath.toLowerCase();
  const otherProjects = recentProjects
    .filter((project) => project.path.toLowerCase() !== currentKey)
    .slice(0, RECENT_PROJECT_LIMIT);
  const currentName = repositoryPath ? projectName(repositoryPath) : busy ? "Opening project..." : "No project open";

  const openProject = (target: string): void => {
    const value = target.trim();
    if (!value || !onOpenRepository) return;
    setRepositoryPath?.(value);
    void onOpenRepository(value);
  };

  const surfaceItems: { key: DesktopMode; label: string; ariaLabel: string; glyph: React.ReactNode }[] = [
    { key: "chat", label: "HiveChat", ariaLabel: "Chat", glyph: GLYPHS.chat },
    { key: "coder", label: "Hive Code", ariaLabel: "Codex", glyph: GLYPHS.coder },
    { key: "split", label: "Split Workspace", ariaLabel: "Split Workspace", glyph: GLYPHS.split },
  ];

  return (
    <nav className="hive-sidebar" aria-label="Global Navigation">
      <div className="hive-sidebar-scroll">
        {/* Zone A: Primary Actions */}
        <div className="hive-sidebar-actions">
          <button type="button" className="hive-btn-new-task" onClick={onCreateTask} title="New chat (Ctrl+Shift+O)">
            <span className="hive-btn-new-task__icon" aria-hidden="true">+</span>
            <span className="hive-btn-new-task__label">New chat</span>
          </button>
          <label className="hive-btn-search hive-chat-search">
            <input
              type="search"
              className="hive-chat-search-input"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={`Search ${noun}`}
              aria-label={`Search ${noun}`}
              onFocus={() => onOpenSearch?.()}
            />
          </label>
        </div>

        {/* Project switcher: current folder, recent folders, native picker, typed path */}
        {onOpenRepository && (
          <div className="hive-sidebar-group hive-project">
            <div className="hive-sidebar-label">Project</div>
            <button
              type="button"
              className={`hive-project-current${switcherOpen ? " is-open" : ""}`}
              onClick={() => setSwitcherOpen((open) => !open)}
              aria-expanded={switcherOpen}
              aria-controls="hive-project-switcher"
              aria-label={repositoryPath ? `Switch project, current ${currentName}` : "Choose a project"}
              title={repositoryPath || undefined}
            >
              <span className="hive-nav-icon" aria-hidden="true">{GLYPHS.folder}</span>
              <span className="hive-project-text">
                <span className="hive-project-name">{currentName}</span>
                {repositoryPath ? <span className="hive-project-path">{repositoryPath}</span> : null}
              </span>
              <span className="hive-project-chevron" aria-hidden="true">▾</span>
            </button>

            {switcherOpen && (
              <div id="hive-project-switcher" className="hive-project-switcher">
                {otherProjects.length > 0 && (
                  <div className="hive-project-recent" role="group" aria-label="Recent projects">
                    <div className="hive-project-sublabel">Recent</div>
                    {otherProjects.map((project) => (
                      <button
                        key={project.path}
                        type="button"
                        className="hive-project-row"
                        onClick={() => openProject(project.path)}
                        aria-label={`Open project ${projectName(project.path)} (${project.path})`}
                        title={project.path}
                      >
                        <span className="hive-nav-icon" aria-hidden="true">{GLYPHS.folder}</span>
                        <span className="hive-project-text">
                          <span className="hive-project-name">{projectName(project.path)}</span>
                          <span className="hive-project-path">{project.path}</span>
                        </span>
                      </button>
                    ))}
                  </div>
                )}

                {onPickRepository && (
                  <button type="button" className="hive-btn-secondary hive-project-browse" onClick={() => void onPickRepository()}>
                    Browse for folder...
                  </button>
                )}

                <form
                  onSubmit={(event) => {
                    event.preventDefault();
                    openProject(path);
                  }}
                >
                  <div className="hive-repo-row">
                    <input
                      id="sidebar-repo-path"
                      value={path}
                      onChange={(event) => setPath(event.target.value)}
                      placeholder={"C:\\source\\project"}
                      aria-label="Repository path"
                      className="hive-form-input hive-repo-input"
                      spellCheck={false}
                    />
                    <button type="submit" disabled={!path.trim()} className="hive-btn-secondary hive-repo-open">
                      Open
                    </button>
                  </div>
                </form>
              </div>
            )}
          </div>
        )}

        {/* Zone B: Primary Surfaces */}
        <div className="hive-sidebar-group">
          <div className="hive-sidebar-label">Workspace</div>
          {surfaceItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`hive-nav-item${mode === item.key ? " is-active" : ""}`}
              onClick={() => onSelectMode(item.key)}
              aria-label={item.ariaLabel}
              aria-pressed={mode === item.key}
            >
              <span className="hive-nav-icon" aria-hidden="true">{item.glyph}</span>
              <span className="hive-nav-label">{item.label}</span>
            </button>
          ))}
        </div>

        {/* Zone C: Contextual Sessions, grouped by recency */}
        <div className="hive-sidebar-group">
          <div className="hive-sidebar-label">{listsTasks ? "Active work" : "Recent chats"}</div>
          <div className="hive-session-list">
            {groups.length === 0 ? (
              <div className="hive-session-row hive-session-empty">
                <span className="hive-session-title">
                  {needle ? `No matching ${noun}` : listsTasks ? "No active work" : "No chats yet"}
                </span>
              </div>
            ) : (
              groups.map((group) => (
                <div key={group.label} className="hive-session-group" role="group" aria-label={group.label}>
                  {groups.length > 1 || group.label !== "Today" ? (
                    <div className="hive-session-group-label" aria-hidden="true">{group.label}</div>
                  ) : null}
                  {group.sessions.map((session) => (
                    <button
                      key={session.id}
                      type="button"
                      className={`hive-session-row${session.active ? " is-active" : ""}`}
                      onClick={() => onSelectSession(session.id)}
                      title={session.title}
                      aria-current={session.active ? "page" : undefined}
                    >
                      <span className="hive-session-title">{session.title}</span>
                      {session.status ? (
                        <span className={`hive-session-status is-${session.status.toLowerCase()}`}>
                          {session.status}
                        </span>
                      ) : null}
                    </button>
                  ))}
                </div>
              ))
            )}
          </div>
        </div>
      </div>

      {/* Footer Zone: Usage & Settings */}
      <div className="hive-sidebar-footer">
        <button
          type="button"
          className={`hive-nav-item${mode === "usage" ? " is-active" : ""}`}
          onClick={onOpenUsage}
        >
          <span className="hive-nav-icon" aria-hidden="true">{GLYPHS.usage}</span>
          <span className="hive-nav-label">Usage & Telemetry</span>
        </button>
        <button
          type="button"
          className={`hive-nav-item${mode === "settings" ? " is-active" : ""}`}
          onClick={onOpenSettings}
        >
          <span className="hive-nav-icon" aria-hidden="true">{GLYPHS.settings}</span>
          <span className="hive-nav-label">Settings</span>
        </button>
      </div>
    </nav>
  );
}
