import React, { useState } from "react";
import type { DesktopMode } from "../state";

export interface SidebarSession {
  id: string;
  title: string;
  kind: "chat" | "coder";
  active: boolean;
  status?: string;
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
  busy?: boolean;
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
  busy = false,
}: SidebarProps) {
  const [path, setPath] = useState(repositoryPath);
  const [chatQuery, setChatQuery] = useState("");
  const needle = chatQuery.trim().toLowerCase();
  const visibleSessions = needle
    ? sessions.filter((session) => session.title.toLowerCase().includes(needle))
    : sessions;
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
              value={chatQuery}
              onChange={(event) => setChatQuery(event.target.value)}
              placeholder="Search chats"
              aria-label="Search chats"
              onFocus={() => onOpenSearch?.()}
            />
          </label>
        </div>

        {/* Workspace Path Picker */}
        {onOpenRepository && setRepositoryPath && (
          <div className="hive-sidebar-group">
            <form
              onSubmit={(event) => {
                event.preventDefault();
                if (path.trim()) void onOpenRepository(path.trim());
              }}
            >
              <div className="hive-sidebar-label">Repository</div>
              <div className="hive-repo-row">
                <input
                  id="sidebar-repo-path"
                  value={path}
                  onChange={(event) => setPath(event.target.value)}
                  placeholder="C:\\source\\project"
                  aria-label="Repository path"
                  className="hive-form-input hive-repo-input"
                />
                <button
                  type="submit"
                  disabled={!path.trim()}
                  className="hive-btn-secondary hive-repo-open"
                >
                  {busy || repositoryPath ? "Open another" : "Open"}
                </button>
              </div>
            </form>
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

        {/* Zone C: Contextual Sessions */}
        <div className="hive-sidebar-group">
          <div className="hive-sidebar-label">
            {mode === "chat" ? "Recent chats" : "Active work"}
          </div>
          <div className="hive-session-list">
            {visibleSessions.length === 0 ? (
              <div className="hive-session-row" style={{ color: "var(--hive-text-dim)" }}>
                <span className="hive-session-title">
                  {needle ? "No matching chats" : mode === "coder" ? "No active work" : "No chats yet"}
                </span>
              </div>
            ) : (
              visibleSessions.map((session) => (
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