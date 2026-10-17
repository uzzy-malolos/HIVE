import React, { useEffect, useState } from "react";
import type { DesktopMode } from "../state";
import { projectName } from "../utils";

export interface SidebarSession {
  id: string;
  title: string;
  kind: "chat" | "coder";
  active: boolean;
  status?: string;
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
  /** Opens the chat/task search dialog. */
  onOpenSearch?: () => void;
  sessions: SidebarSession[];
  onSelectSession: (id: string) => void;
  onArchiveSession?: (id: string) => void;
  /** Session ids pinned to the Starred section. */
  starredIds?: string[];
  onToggleStar?: (id: string) => void;
  onOpenUsage: () => void;
  onOpenSettings: () => void;
  onOpenShortcuts?: () => void;
  repositoryPath?: string;
  setRepositoryPath?: (path: string) => void;
  onOpenRepository?: (path: string) => Promise<void>;
  /** Opens the native folder picker and then the chosen project. */
  onPickRepository?: () => Promise<void>;
  recentProjects?: SidebarRecentProject[];
  busy?: boolean;
  /** Icon-only rail, as ChatGPT and Claude show when the sidebar is closed. */
  collapsed?: boolean;
  /** Secondary line on the account button, e.g. the active model. */
  accountDetail?: string;
}

const RECENT_PROJECT_LIMIT = 5;

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
  compose: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z" />
    </svg>
  ),
  search: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </svg>
  ),
  plus: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M12 5v14M5 12h14" />
    </svg>
  ),
  more: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="5" cy="12" r="1" />
      <circle cx="12" cy="12" r="1" />
      <circle cx="19" cy="12" r="1" />
    </svg>
  ),
  star: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3l-5.6 2.9 1.1-6.2L3 9.6l6.2-.9Z" />
    </svg>
  ),
  archive: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="4" rx="1" />
      <path d="M5 8v11a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8M10 12h4" />
    </svg>
  ),
  keyboard: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="2" y="6" width="20" height="12" rx="2" />
      <path d="M6 10h.01M10 10h.01M14 10h.01M18 10h.01M7 14h10" />
    </svg>
  ),
  chevron: (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="m6 9 6 6 6-6" />
    </svg>
  ),
};

type SectionKey = "projects" | "starred" | "sessions";

export function Sidebar({
  mode,
  onSelectMode,
  onCreateTask,
  onOpenSearch,
  sessions,
  onSelectSession,
  onArchiveSession,
  starredIds = [],
  onToggleStar,
  onOpenUsage,
  onOpenSettings,
  onOpenShortcuts,
  repositoryPath = "",
  setRepositoryPath,
  onOpenRepository,
  onPickRepository,
  recentProjects = [],
  busy = false,
  collapsed = false,
  accountDetail,
}: SidebarProps) {
  const [path, setPath] = useState(repositoryPath);
  const [addingProject, setAddingProject] = useState(!repositoryPath && recentProjects.length === 0);
  const [closedSections, setClosedSections] = useState<Record<SectionKey, boolean>>({ projects: false, starred: false, sessions: false });
  const [menu, setMenu] = useState<string | null>(null);

  // Follow the open project when it changes from elsewhere (palette, picker, startup).
  useEffect(() => {
    if (!repositoryPath) return;
    setPath(repositoryPath);
    setAddingProject(false);
  }, [repositoryPath]);

  // Popover menus close on an outside click or Escape, like the reference sidebars.
  useEffect(() => {
    if (!menu) return;
    const onPointer = (event: MouseEvent) => {
      if (!(event.target instanceof Element) || !event.target.closest("[data-sidebar-menu]")) setMenu(null);
    };
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setMenu(null); };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => { document.removeEventListener("mousedown", onPointer); document.removeEventListener("keydown", onKey); };
  }, [menu]);

  const listsTasks = mode === "coder";
  const starred = new Set(starredIds);
  const starredSessions = sessions.filter((session) => starred.has(session.id));
  const otherSessions = sessions.filter((session) => !starred.has(session.id));
  const currentKey = repositoryPath.toLowerCase();
  const otherProjects = recentProjects
    .filter((project) => project.path.toLowerCase() !== currentKey)
    .slice(0, RECENT_PROJECT_LIMIT);

  const toggleSection = (key: SectionKey) => setClosedSections((current) => ({ ...current, [key]: !current[key] }));
  const openProject = (target: string): void => {
    const value = target.trim();
    if (!value || !onOpenRepository) return;
    setRepositoryPath?.(value);
    void onOpenRepository(value);
  };

  const topItems: { key: string; label: string; ariaLabel: string; glyph: React.ReactNode; active?: boolean; title?: string; onClick: () => void }[] = [
    { key: "new", label: "New chat", ariaLabel: "New chat", glyph: GLYPHS.compose, title: "New chat (Ctrl+Shift+O)", onClick: onCreateTask },
    ...(onOpenSearch ? [{ key: "search", label: listsTasks ? "Search tasks" : "Search chats", ariaLabel: listsTasks ? "Search tasks" : "Search chats", glyph: GLYPHS.search, title: "Search (Ctrl+Shift+F)", onClick: onOpenSearch }] : []),
    { key: "chat", label: "HiveChat", ariaLabel: "Chat", glyph: GLYPHS.chat, active: mode === "chat", onClick: () => onSelectMode("chat") },
    { key: "coder", label: "Hive Code", ariaLabel: "Codex", glyph: GLYPHS.coder, active: mode === "coder", onClick: () => onSelectMode("coder") },
    { key: "split", label: "Split Workspace", ariaLabel: "Split Workspace", glyph: GLYPHS.split, active: mode === "split", onClick: () => onSelectMode("split") },
  ];

  const accountMenu = (
    <div className="hive-sidebar-account" data-sidebar-menu>
      <button
        type="button"
        className={`hive-account-btn${menu === "account" ? " is-open" : ""}`}
        onClick={() => setMenu((current) => current === "account" ? null : "account")}
        aria-haspopup="menu"
        aria-expanded={menu === "account"}
        aria-label="Account and settings"
        title={collapsed ? "Account and settings" : undefined}
      >
        <span className="hive-account-avatar" aria-hidden="true">H</span>
        {!collapsed && (
          <span className="hive-account-text">
            <span className="hive-account-name">HIVE</span>
            {accountDetail ? <span className="hive-account-detail">{accountDetail}</span> : null}
          </span>
        )}
      </button>
      {menu === "account" && (
        <div className="hive-sidebar-menu hive-account-menu" role="menu" aria-label="Account">
          <button type="button" role="menuitem" className="hive-menu-item" onClick={() => { setMenu(null); onOpenSettings(); }}>
            <span className="hive-nav-icon" aria-hidden="true">{GLYPHS.settings}</span>Settings
          </button>
          <button type="button" role="menuitem" className={`hive-menu-item${mode === "usage" ? " is-active" : ""}`} onClick={() => { setMenu(null); onOpenUsage(); }}>
            <span className="hive-nav-icon" aria-hidden="true">{GLYPHS.usage}</span>Usage &amp; Telemetry
          </button>
          {onOpenShortcuts && (
            <button type="button" role="menuitem" className="hive-menu-item" onClick={() => { setMenu(null); onOpenShortcuts(); }}>
              <span className="hive-nav-icon" aria-hidden="true">{GLYPHS.keyboard}</span>Keyboard shortcuts
            </button>
          )}
        </div>
      )}
    </div>
  );

  if (collapsed) {
    return (
      <nav className="hive-sidebar is-collapsed" aria-label="Global Navigation" data-collapsed="true">
        <div className="hive-sidebar-rail">
          {topItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`hive-nav-item hive-rail-item${item.active ? " is-active" : ""}`}
              onClick={item.onClick}
              aria-label={item.ariaLabel}
              aria-pressed={item.active}
              title={item.title ?? item.label}
            >
              <span className="hive-nav-icon" aria-hidden="true">{item.glyph}</span>
            </button>
          ))}
        </div>
        <div className="hive-sidebar-footer">{accountMenu}</div>
      </nav>
    );
  }

  const sectionHeader = (key: SectionKey, label: string, action?: React.ReactNode) => (
    <div className="hive-section-header">
      <button
        type="button"
        className="hive-section-toggle"
        onClick={() => toggleSection(key)}
        aria-expanded={!closedSections[key]}
      >
        <span>{label}</span>
        <span className={`hive-section-chevron${closedSections[key] ? " is-closed" : ""}`} aria-hidden="true">{GLYPHS.chevron}</span>
      </button>
      {action}
    </div>
  );

  const sessionRow = (session: SidebarSession) => {
    const isStarred = starred.has(session.id);
    const menuId = `session:${session.id}`;
    const hasMenu = Boolean(onToggleStar || onArchiveSession);
    const titleId = `hive-session-title-${session.id}`;
    const optionsLabel = session.kind === "coder" ? "Task options" : "Chat options";
    return (
      <div key={session.id} className={`hive-session-item${menu === menuId ? " is-menu-open" : ""}`} data-sidebar-menu={menu === menuId ? true : undefined}>
        <button
          type="button"
          className={`hive-session-row${session.active ? " is-active" : ""}`}
          onClick={() => onSelectSession(session.id)}
          title={session.title}
          aria-current={session.active ? "page" : undefined}
        >
          <span id={titleId} className="hive-session-title">{session.title}</span>
          {session.status ? (
            <span className={`hive-session-status is-${session.status.toLowerCase()}`}>{session.status}</span>
          ) : null}
        </button>
        {hasMenu && (
          <button
            type="button"
            className="hive-session-more"
            onClick={() => setMenu((current) => current === menuId ? null : menuId)}
            aria-haspopup="menu"
            aria-expanded={menu === menuId}
            aria-label={optionsLabel}
            aria-describedby={titleId}
            data-sidebar-menu
          >
            {GLYPHS.more}
          </button>
        )}
        {menu === menuId && (
          <div className="hive-sidebar-menu hive-session-menu" role="menu" aria-label={optionsLabel} aria-describedby={titleId} data-sidebar-menu>
            {onToggleStar && (
              <button type="button" role="menuitem" className="hive-menu-item" onClick={() => { setMenu(null); onToggleStar(session.id); }}>
                <span className="hive-nav-icon" aria-hidden="true">{GLYPHS.star}</span>{isStarred ? "Unstar" : "Star"}
              </button>
            )}
            {onArchiveSession && (
              <button type="button" role="menuitem" className="hive-menu-item" onClick={() => { setMenu(null); onArchiveSession(session.id); }}>
                <span className="hive-nav-icon" aria-hidden="true">{GLYPHS.archive}</span>Archive
              </button>
            )}
          </div>
        )}
      </div>
    );
  };

  const emptyCopy = listsTasks
    ? repositoryPath ? "No tasks yet" : "Open a project to see its tasks"
    : "No chats yet";

  return (
    <nav className="hive-sidebar" aria-label="Global Navigation">
      <div className="hive-sidebar-scroll">
        {/* Primary actions and surfaces, as plain icon rows */}
        <div className="hive-sidebar-group">
          {topItems.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`hive-nav-item${item.active ? " is-active" : ""}`}
              onClick={item.onClick}
              aria-label={item.ariaLabel}
              aria-pressed={item.active}
              title={item.title}
            >
              <span className="hive-nav-icon" aria-hidden="true">{item.glyph}</span>
              <span className="hive-nav-label">{item.label}</span>
            </button>
          ))}
        </div>

        {/* Projects: the open folder, recent folders, and a way to open another */}
        {onOpenRepository && (
          <div className="hive-sidebar-group hive-project">
            {sectionHeader("projects", "Projects", (
              <button
                type="button"
                className={`hive-section-action${addingProject ? " is-open" : ""}`}
                onClick={() => { setAddingProject((open) => !open); setClosedSections((current) => ({ ...current, projects: false })); }}
                aria-label="Open project"
                aria-expanded={addingProject}
                title="Open project"
              >
                {GLYPHS.plus}
              </button>
            ))}
            {!closedSections.projects && (
              <>
                {addingProject && (
                  <div className="hive-project-switcher">
                    {onPickRepository && (
                      <button type="button" className="hive-btn-secondary hive-project-browse" onClick={() => void onPickRepository()}>
                        Browse for folder...
                      </button>
                    )}
                    <form onSubmit={(event) => { event.preventDefault(); openProject(path); }}>
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
                        <button type="submit" disabled={!path.trim()} className="hive-btn-secondary hive-repo-open">Open</button>
                      </div>
                    </form>
                  </div>
                )}
                <div className="hive-session-list" role="group" aria-label="Projects">
                  {repositoryPath ? (
                    <button
                      type="button"
                      className="hive-session-row hive-project-row is-active"
                      aria-current="true"
                      aria-label={`${projectName(repositoryPath)} (${repositoryPath})`}
                      title={repositoryPath}
                      onClick={() => setAddingProject(false)}
                    >
                      <span className="hive-nav-icon" aria-hidden="true">{GLYPHS.folder}</span>
                      <span className="hive-session-title">{projectName(repositoryPath)}</span>
                    </button>
                  ) : busy ? (
                    <div className="hive-session-row hive-session-empty">
                      <span className="hive-session-title">Opening project...</span>
                    </div>
                  ) : null}
                  {otherProjects.map((project) => (
                    <button
                      key={project.path}
                      type="button"
                      className="hive-session-row hive-project-row"
                      onClick={() => openProject(project.path)}
                      aria-label={`Open project ${projectName(project.path)} (${project.path})`}
                      title={project.path}
                    >
                      <span className="hive-nav-icon" aria-hidden="true">{GLYPHS.folder}</span>
                      <span className="hive-session-title">{projectName(project.path)}</span>
                    </button>
                  ))}
                  {!repositoryPath && !busy && otherProjects.length === 0 && !addingProject ? (
                    <div className="hive-session-row hive-session-empty">
                      <span className="hive-session-title">No projects yet</span>
                    </div>
                  ) : null}
                </div>
              </>
            )}
          </div>
        )}

        {starredSessions.length > 0 && (
          <div className="hive-sidebar-group">
            {sectionHeader("starred", "Starred")}
            {!closedSections.starred && <div className="hive-session-list">{starredSessions.map(sessionRow)}</div>}
          </div>
        )}

        <div className="hive-sidebar-group">
          {sectionHeader("sessions", listsTasks ? "Tasks" : "Chats")}
          {!closedSections.sessions && (
            <div className="hive-session-list">
              {otherSessions.length === 0 && starredSessions.length === 0 ? (
                <div className="hive-session-row hive-session-empty">
                  <span className="hive-session-title">{emptyCopy}</span>
                </div>
              ) : otherSessions.map(sessionRow)}
            </div>
          )}
        </div>
      </div>

      <div className="hive-sidebar-footer">{accountMenu}</div>
    </nav>
  );
}
