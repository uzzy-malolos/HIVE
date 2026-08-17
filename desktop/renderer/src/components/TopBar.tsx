import { useState } from "react";
import type { DesktopMode } from "../state";
import { StatusPill } from "./StatusPill";

export interface TopBarProps {
  worker: string;
  modalOpen: boolean;
  activeRun?: boolean;
  repositoryRoot?: string | null;
  mode?: DesktopMode;
  onModeChange?: (mode: DesktopMode) => void;
  onPopOut?: () => void;
  onRecombine?: () => void;
  canRecombine?: boolean;
  onToggleLeftRail?: () => void;
  onToggleRightRail?: () => void;
  onOpenSettings?: () => void;
  activeModelName?: string;
  onSelectModel?: (model: string) => void;
}

export function TopBar({
  worker,
  modalOpen,
  activeRun = false,
  repositoryRoot,
  onToggleLeftRail,
  onOpenSettings,
  activeModelName = "HIVE Auto",
  onSelectModel,
}: TopBarProps) {
  const tone = worker === "failed" ? "error" : worker === "running" ? "success" : "neutral";
  const [modelDropdownOpen, setModelDropdownOpen] = useState(false);

  const modelOptions = [
    { id: "auto", label: "HIVE Auto (Smart Router)", desc: "Intelligently routes turns to specialist swarms" },
    { id: "council", label: "HIVE Council (6-Role)", desc: "Multi-agent planning, building & verification swarm" },
    { id: "deepseek", label: "DeepSeek V4 Flash", desc: "High-speed reasoning with cryptographic receipts" },
    { id: "claude", label: "Claude Opus 5", desc: "Advanced architecture & systems design" },
    { id: "custom", label: "Custom BYOK", desc: "Local or custom configured provider endpoint" },
  ];

  const repoDisplay = repositoryRoot
    ? repositoryRoot.split(/[/\\]/).filter(Boolean).at(-1) ?? repositoryRoot
    : "No workspace";

  return (
    <header className="topbar dual-topbar" role="banner" aria-hidden={modalOpen || undefined}>
      <div className="topbar-brand-area">
        {onToggleLeftRail && (
          <button
            type="button"
            className="topbar-icon-btn sidebar-toggle-btn"
            aria-label="Toggle workspace sidebar [/]"
            title="Toggle sidebar [/]"
            onClick={onToggleLeftRail}
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
              <line x1="9" y1="3" x2="9" y2="21" />
            </svg>
          </button>
        )}
        <div className="wordmark-container">
          <span className={`wordmark ${activeRun ? "anim-running" : ""}`} aria-label="HIVE">
            HIVE
          </span>
          <span className="workspace-badge" title={repositoryRoot ?? "No repository open"}>
            {repoDisplay}
          </span>
        </div>
      </div>

      <div className="topbar-center-area">
        <div className="gpt-model-selector-container">
          <button
            type="button"
            className="gpt-model-dropdown-btn"
            aria-haspopup="listbox"
            aria-expanded={modelDropdownOpen}
            aria-label="Select AI model"
            onClick={() => setModelDropdownOpen((prev) => !prev)}
          >
            <span className="hive-top-squircle">⬡</span>
            <span className="gpt-model-title">{activeModelName}</span>
            <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </button>

          {modelDropdownOpen && (
            <ul className="gpt-model-menu" role="listbox" aria-label="Available models">
              {modelOptions.map((opt) => (
                <li key={opt.id} role="option" aria-selected={activeModelName.toLowerCase().includes(opt.id)}>
                  <button
                    type="button"
                    className="gpt-model-menu-item"
                    onClick={() => {
                      onSelectModel?.(opt.label);
                      setModelDropdownOpen(false);
                    }}
                  >
                    <div className="gpt-model-menu-label">{opt.label}</div>
                    <div className="gpt-model-menu-desc">{opt.desc}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="topbar-actions">
        {onOpenSettings && (
          <button
            type="button"
            className="topbar-icon-btn"
            aria-label="Open settings"
            title="Preferences & Accessibility [*]"
            onClick={onOpenSettings}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z" />
            </svg>
          </button>
        )}
        <StatusPill tone={tone}>{worker}</StatusPill>
      </div>
    </header>
  );
}
