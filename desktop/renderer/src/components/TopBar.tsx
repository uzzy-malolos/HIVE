import { useState } from "react";
import { ModeSwitch } from "./ModeSwitch";
import type { DesktopMode } from "../state";
import { StatusPill } from "./StatusPill";

export interface TopBarProps {
  worker: string;
  modalOpen: boolean;
  activeRun?: boolean;
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
  mode,
  onModeChange,
  onPopOut,
  onRecombine,
  canRecombine = false,
  onToggleLeftRail,
  onToggleRightRail,
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

  return (
    <header className="topbar gpt-topbar" role="banner" aria-hidden={modalOpen || undefined}>
      <div className="gpt-topbar-left">
        {mode === "chat" ? (
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
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2">
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
        ) : (
          <div>
            <span className={`wordmark ${activeRun ? "anim-running" : ""}`} aria-label="HIVE">
              HIVE
            </span>
            <span className="tagline">Hyper Intelligence for Verified Engineering</span>
          </div>
        )}
      </div>

      {mode && onModeChange && <ModeSwitch mode={mode} onModeChange={onModeChange} />}

      <div className="topbar-actions gpt-topbar-actions">
        {mode === "chat" && (
          <button
            type="button"
            className="hive-verified-badge-btn"
            aria-label="Provider configuration"
            title="BYOK DPAPI Encrypted"
            onClick={onOpenSettings}
          >
            <span className="verified-dot" />
            <span>BYOK Active</span>
          </button>
        )}

        {mode === "coder" && (
          <button
            type="button"
            className="topbar-open-ide-btn"
            title="Open in IDE (VS Code / Cursor)"
            aria-label="Open in IDE"
            onClick={onOpenSettings}
          >
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" className="open-ide-icon">
              <polygon points="12 2 2 22 22 22" />
            </svg>
            <span>Open IDE</span>
          </button>
        )}

        {mode === "coder" && onPopOut && (
          <button
            type="button"
            className="topbar-btn secondary"
            aria-label="Pop the Hive Code cockpit out into its own window"
            title="Pop out Hive Code window [^]"
            onClick={onPopOut}
          >
            [^]
          </button>
        )}
        {canRecombine && onRecombine && (
          <button
            type="button"
            className="topbar-btn secondary"
            aria-label="Close the popped-out coder window"
            title="Recombine windows"
            onClick={onRecombine}
          >
            [v]
          </button>
        )}
        {onToggleLeftRail && (
          <button
            type="button"
            className="topbar-btn secondary"
            aria-label="Toggle left rail"
            title="Toggle repository rail [/]"
            onClick={onToggleLeftRail}
          >
            [/]
          </button>
        )}
        {onToggleRightRail && (
          <button
            type="button"
            className="topbar-btn secondary"
            aria-label="Toggle right rail"
            title="Toggle inspector rail [\]"
            onClick={onToggleRightRail}
          >
            [\]
          </button>
        )}
        {onOpenSettings && (
          <button
            type="button"
            className="topbar-btn secondary"
            aria-label="Open settings"
            title="Preferences & Accessibility [*]"
            onClick={onOpenSettings}
          >
            [*]
          </button>
        )}
        <StatusPill tone={tone}>{worker}</StatusPill>
      </div>
    </header>
  );
}

