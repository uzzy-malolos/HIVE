import { FormEvent, useState } from "react";
import type { DesktopRecentRepository, ThreadRecordV1 } from "../../../../src/desktop/types";
import { formatTime } from "../utils";
import { EmptyState } from "./EmptyState";
import { ThreadList } from "./ThreadList";

export interface LeftRailProps {
  repositoryPath: string;
  setRepositoryPath: (path: string) => void;
  busy: boolean;
  repositories: DesktopRecentRepository[];
  repositoryRoot: string | null;
  threads: ThreadRecordV1[];
  activeThreadId: string | null;
  newThreadTitle: string;
  setNewThreadTitle: (title: string) => void;
  onOpenRepository: (path: string) => Promise<void>;
  onCreateThread: (event: FormEvent) => Promise<void>;
  onLoadThread: (thread: ThreadRecordV1) => Promise<void>;
  onOpenSettings?: () => void;
}

export function LeftRail({
  repositoryPath,
  setRepositoryPath,
  busy,
  repositories,
  repositoryRoot,
  threads,
  activeThreadId,
  newThreadTitle,
  setNewThreadTitle,
  onOpenRepository,
  onCreateThread,
  onLoadThread,
  onOpenSettings,
}: LeftRailProps) {
  const [showPathInput, setShowPathInput] = useState(!repositoryRoot);
  const [projectsExpanded, setProjectsExpanded] = useState(true);

  const activeThreads = threads.filter((thread) => !thread.archived);
  const archivedThreads = threads.filter((thread) => thread.archived);

  const activeRepoName = repositoryRoot
    ? repositoryRoot.split(/[/\\]/).filter(Boolean).at(-1) ?? repositoryRoot
    : null;

  return (
    <nav className="panel left-rail antigravity-rail" aria-label="Repositories and threads">
      {/* Top Navigation & App Header */}
      <div className="rail-top-nav">
        <div className="rail-nav-controls">
          <button type="button" className="rail-icon-btn" aria-label="Navigate back" title="Back">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <button type="button" className="rail-icon-btn" aria-label="Navigate forward" title="Forward">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="9 18 15 12 9 6" />
            </svg>
          </button>
        </div>
      </div>

      {/* Primary Action: + New Conversation */}
      <div className="rail-primary-action">
        <button
          type="button"
          className="new-conv-btn"
          onClick={(e) => {
            if (newThreadTitle.trim()) {
              void onCreateThread(e as unknown as FormEvent);
            }
          }}
          title="New Conversation (Ctrl+Shift+O)"
        >
          <span className="plus-icon">+</span>
          <span>New Conversation</span>
          <kbd className="key-hint">Ctrl+Shift+O</kbd>
        </button>
      </div>

      {/* Quick Navigation Items */}
      <div className="rail-quick-nav">
        <button type="button" className="rail-nav-item">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <polyline points="12 6 12 12 16 14" />
          </svg>
          <span>Conversation History</span>
        </button>
        <button type="button" className="rail-nav-item">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="4" width="18" height="18" rx="2" ry="2" />
            <line x1="16" y1="2" x2="16" y2="6" />
            <line x1="8" y1="2" x2="8" y2="6" />
            <line x1="3" y1="10" x2="21" y2="10" />
          </svg>
          <span>Scheduled Tasks</span>
        </button>
      </div>

      {/* Projects Section Header */}
      <div className="rail-projects-section">
        <div className="projects-header-row">
          <button
            type="button"
            className="projects-header-toggle"
            onClick={() => setProjectsExpanded((prev) => !prev)}
            aria-expanded={projectsExpanded}
          >
            <span className="projects-label">Projects</span>
          </button>
          <div className="projects-actions">
            <button
              type="button"
              className="rail-icon-btn small"
              onClick={() => setShowPathInput((prev) => !prev)}
              title="Open custom path"
              aria-label="Open custom path"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                <line x1="12" y1="11" x2="12" y2="17" />
                <line x1="9" y1="14" x2="15" y2="14" />
              </svg>
            </button>
          </div>
        </div>

        {/* Collapsible Manual Path Input */}
        {showPathInput && (
          <form
            className="stack compact rail-path-form"
            onSubmit={(event) => {
              event.preventDefault();
              void onOpenRepository(repositoryPath);
            }}
          >
            <label htmlFor="repository-path">Repository path</label>
            <div className="input-row">
              <input
                id="repository-path"
                value={repositoryPath}
                onChange={(event) => setRepositoryPath(event.target.value)}
                placeholder="C:\source\project"
              />
              <button disabled={!repositoryPath.trim()}>{busy || repositoryRoot ? "Open another" : "Open"}</button>
            </div>
          </form>
        )}

        {/* Projects Tree List */}
        {projectsExpanded && (
          <div className="projects-tree">
            {/* Active Project Folder */}
            {repositoryRoot && (
              <div className="project-tree-node active-node">
                <div className="project-node-header">
                  <span className="folder-icon" aria-hidden="true">📁</span>
                  <span className="project-name" title={repositoryRoot}>{activeRepoName}</span>
                  <span className="thread-count-chip">{activeThreads.length}</span>
                </div>

                {/* Inline New Thread input for active project */}
                <form className="tree-new-thread-form input-row" onSubmit={(event) => void onCreateThread(event)}>
                  <label className="sr-only" htmlFor="thread-title">New thread title</label>
                  <input
                    id="thread-title"
                    value={newThreadTitle}
                    onChange={(event) => setNewThreadTitle(event.target.value)}
                    placeholder="New thread..."
                    maxLength={200}
                  />
                  <button aria-label="Create thread" className="tree-add-btn">+</button>
                </form>

                {/* Threads under Active Project */}
                <div className="project-threads-list">
                  {activeThreads.length ? (
                    <ThreadList threads={activeThreads} activeId={activeThreadId} onLoad={onLoadThread} />
                  ) : (
                    <EmptyState>No active threads.</EmptyState>
                  )}
                </div>

                {/* Archived Threads for Active Project */}
                {archivedThreads.length > 0 && (
                  <details className="archived tree-archived">
                    <summary>Archived ({archivedThreads.length})</summary>
                    <ThreadList threads={archivedThreads} activeId={activeThreadId} onLoad={onLoadThread} />
                  </details>
                )}
              </div>
            )}

            {/* Other Recent Repositories */}
            <div className="other-repositories" aria-labelledby="recent-heading">
              <h2 id="recent-heading" className="sr-only">Recent</h2>
              <ul className="plain-list repo-tree-list">
                {repositories
                  .filter((repo) => repo.path !== repositoryRoot)
                  .map((repository) => {
                    const name = repository.path.split(/[/\\]/).filter(Boolean).at(-1) ?? repository.path;
                    return (
                      <li key={repository.path} className="project-tree-node inactive-node">
                        <button
                          className="repository-button project-node-btn"
                          aria-current={repositoryRoot === repository.path ? "page" : undefined}
                          onClick={() => void onOpenRepository(repository.path)}
                          title={repository.path}
                        >
                          <span className="folder-icon" aria-hidden="true">📁</span>
                          <span className="project-name">{repository.path}</span>
                          <small className="repo-time-hint">{formatTime(repository.lastOpenedAt)}</small>
                        </button>
                      </li>
                    );
                  })}
              </ul>
              {!repositoryRoot && repositories.length === 0 && (
                <EmptyState>No recent repositories.</EmptyState>
              )}
            </div>
          </div>
        )}
      </div>



      {/* Rail Bottom Footer */}
      <div className="rail-footer">
        <button
          type="button"
          className="rail-settings-btn"
          onClick={onOpenSettings}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="3" />
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
          </svg>
          <span>Settings</span>
        </button>
      </div>
    </nav>
  );
}
