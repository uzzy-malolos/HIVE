import { useMemo, useState } from "react";
import type { DesktopChatSummary } from "../../../../../src/desktop/types";
import { formatTime } from "../../utils";

export interface SessionRailProps {
  conversations: DesktopChatSummary[];
  activeId: string | null;
  onLoad: (conversationId: string) => void;
  onCreate: () => void;
  onArchive: (conversationId: string) => void;
  onToggleSidebar?: () => void;
  onOpenSearch?: () => void;
  userName?: string;
  userTier?: string;
}

interface SidebarItem {
  id: string;
  label: string;
  icon: string;
  color?: string;
  type?: "pinned" | "project" | "nav";
}

const NAV_ITEMS: SidebarItem[] = [
  { id: "nav-council", label: "Swarm Council", icon: "⬡" },
  { id: "nav-security", label: "Security & Audits", icon: "🛡️" },
  { id: "nav-plugins", label: "MCP Plugins", icon: "🔌" },
  { id: "nav-receipts", label: "Signed Receipts", icon: "📜" },
];

const PINNED_ITEMS: SidebarItem[] = [
  { id: "pin-arch", label: "Architecture Blast Radius", icon: "📐", color: "#8b5cf6" },
  { id: "pin-audit", label: "Vulnerability Scan", icon: "🛡️", color: "#22c55e" },
  { id: "pin-refactor", label: "Verified Multi-Agent Refactor", icon: "⚡", color: "#38bdf8" },
  { id: "pin-test", label: "E2E Test Matrix", icon: "🧪", color: "#f59e0b" },
  { id: "pin-release", label: "Release & Artifact Gate", icon: "📦", color: "#a78bfa" },
];

const PROJECT_ITEMS: SidebarItem[] = [
  { id: "proj-hive", label: "HIVE Engine", icon: "⬡", color: "#8b5cf6" },
  { id: "proj-agentic", label: "Agent Swarm", icon: "🤖", color: "#6366f1" },
  { id: "proj-safe", label: "SafeStorage DPAPI", icon: "🔒", color: "#10b981" },
  { id: "proj-receipts", label: "Receipts Log", icon: "📄", color: "#38bdf8" },
];

/** Left rail for the chat surface: HIVE Intelligence Hub sidebar with Pinned Workflows, Projects, and Chats. */
export function SessionRail({
  conversations,
  activeId,
  onLoad,
  onCreate,
  onArchive,
  onToggleSidebar,
  onOpenSearch,
  userName = "HIVE Operator",
  userTier = "BYOK Active",
}: SessionRailProps) {
  const [filter, setFilter] = useState("");
  const [showSearch, setShowSearch] = useState(false);
  const [showAllProjects, setShowAllProjects] = useState(false);
  const needle = filter.trim().toLowerCase();

  const { active, archived } = useMemo(() => {
    const matches = conversations.filter(
      (conversation) =>
        !needle ||
        conversation.title.toLowerCase().includes(needle) ||
        conversation.role.toLowerCase().includes(needle),
    );
    return {
      active: matches.filter((conversation) => !conversation.archived),
      archived: matches.filter((conversation) => conversation.archived),
    };
  }, [conversations, needle]);

  const visibleProjects = showAllProjects ? PROJECT_ITEMS : PROJECT_ITEMS.slice(0, 5);

  return (
    <div className="gpt-sidebar">
      {/* Top Header with Brand and Controls */}
      <div className="gpt-sidebar-header">
        <button
          type="button"
          className="sidebar-icon-btn brand-btn"
          aria-label="HIVE Home"
          title="HIVE"
          onClick={onCreate}
        >
          <svg className="gpt-brand-icon" viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2">
            <path d="M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <div className="gpt-header-controls">
          <button
            type="button"
            className="sidebar-icon-btn"
            aria-label="Search chats"
            title="Search chats"
            onClick={() => {
              setShowSearch((prev) => !prev);
              onOpenSearch?.();
            }}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
          </button>
          <button
            type="button"
            className="sidebar-icon-btn"
            aria-label="Toggle sidebar"
            title="Toggle sidebar"
            onClick={onToggleSidebar}
          >
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
        </div>
      </div>

      {/* Main Action: New Chat */}
      <button type="button" className="new-chat-btn gpt-new-chat" onClick={onCreate}>
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M12 5v14M5 12h14" strokeLinecap="round" />
        </svg>
        <span>New chat</span>
      </button>

      {/* Filter / Search Input */}
      <div className="gpt-filter-container">
        <input
          type="search"
          className="chat-filter gpt-filter-input"
          placeholder="Filter conversations..."
          aria-label="Filter conversations"
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
      </div>

      {/* Scrollable Sidebar Body */}
      <div className="gpt-sidebar-scroll">
        {/* Navigation Quick Links */}
        <div className="gpt-nav-section" aria-label="Navigation">
          {NAV_ITEMS.map((item) => (
            <button key={item.id} type="button" className="gpt-nav-item">
              <span className="gpt-nav-icon">{item.icon}</span>
              <span className="gpt-nav-label">{item.label}</span>
            </button>
          ))}
        </div>

        {/* Pinned Section */}
        <div className="gpt-section" aria-label="Pinned chats">
          <div className="gpt-section-title">Pinned</div>
          <ul className="plain-list gpt-item-list">
            {PINNED_ITEMS.map((pin) => (
              <li key={pin.id}>
                <button type="button" className="gpt-list-row">
                  <span className="gpt-item-glyph" style={{ color: pin.color }}>{pin.icon}</span>
                  <span className="gpt-row-title">{pin.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>

        {/* Projects Section */}
        <div className="gpt-section" aria-label="Projects">
          <div className="gpt-section-title">Projects</div>
          <ul className="plain-list gpt-item-list">
            {visibleProjects.map((proj) => (
              <li key={proj.id}>
                <button type="button" className="gpt-list-row">
                  <span className="gpt-item-glyph" style={{ color: proj.color }}>{proj.icon}</span>
                  <span className="gpt-row-title">{proj.label}</span>
                </button>
              </li>
            ))}
            <li>
              <button
                type="button"
                className="gpt-show-more-btn"
                onClick={() => setShowAllProjects((prev) => !prev)}
              >
                {showAllProjects ? "Show less" : "Show more"}
              </button>
            </li>
          </ul>
        </div>

        {/* Chats History Section */}
        <div className="gpt-section" aria-label="Recent chats">
          <div className="gpt-section-title">Chats</div>
          <ul className="plain-list thread-list chat-conversations" aria-label="Conversations">
            {active.map((conversation) => (
              <li key={conversation.id}>
                <button
                  type="button"
                  aria-current={conversation.id === activeId ? "page" : undefined}
                  className={conversation.id === activeId ? "conversation-row current" : "conversation-row"}
                  onClick={() => onLoad(conversation.id)}
                >
                  <span className="conversation-title">{conversation.title}</span>
                  <span className="conversation-meta">
                    <span className="role-chip">[{conversation.role}]</span>
                    <span>{conversation.messageCount} msgs</span>
                    <span>{formatTime(conversation.updatedAt)}</span>
                  </span>
                </button>
              </li>
            ))}
            {active.length === 0 && archived.length === 0 && (
              <li className="rail-empty">No conversations.</li>
            )}
          </ul>

          {archived.length > 0 && (
            <details className="archived-chats">
              <summary>Archived [{archived.length}]</summary>
              <ul className="plain-list thread-list">
                {archived.map((conversation) => (
                  <li key={conversation.id}>
                    <span className="conversation-row archived">
                      <span className="conversation-title">{conversation.title}</span>
                      <span className="conversation-meta">
                        <span className="role-chip">[{conversation.role}]</span>
                        <span>{conversation.messageCount} msgs</span>
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      </div>

      {/* Bottom Profile / Operator Footer */}
      <div className="gpt-profile-footer">
        <div className="gpt-user-avatar hive-operator-avatar">
          <span>⬡</span>
        </div>
        <div className="gpt-user-details">
          <span className="gpt-user-name">{userName}</span>
          <span className="gpt-user-tier">{userTier}</span>
        </div>
        <button
          type="button"
          className="gpt-config-btn"
          aria-label="Provider configuration"
          title="Configure Providers & Keys"
        >
          ⚙ Config
        </button>
      </div>
    </div>
  );
}
