import React from "react";

export interface WorkspaceTab {
  id: string;
  label: string;
  kind?: "chat" | "coder";
}

export interface WorkspaceTabsProps {
  tabs: WorkspaceTab[];
  activeId?: string | null;
  onSelect?: (id: string) => void;
  onClose?: (id: string) => void;
  onNew?: () => void;
}

/** OpenCode-style session tabs in the titlebar. */
export function WorkspaceTabs({ tabs, activeId, onSelect, onClose, onNew }: WorkspaceTabsProps) {
  return (
    <div className="hive-tabs" role="tablist" aria-label="Open sessions">
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <div key={tab.id} className={`hive-tab${active ? " is-active" : ""}`} role="presentation">
            <button
              type="button"
              role="tab"
              aria-selected={active}
              className="hive-tab"
              onClick={() => onSelect?.(tab.id)}
              title={tab.label}
            >
              <span className="hive-tab-label">{tab.label}</span>
            </button>
            {onClose ? (
              <button
                type="button"
                className="hive-tab-close"
                aria-label={`Close ${tab.label}`}
                onClick={(event) => {
                  event.stopPropagation();
                  onClose(tab.id);
                }}
              >
                ×
              </button>
            ) : null}
          </div>
        );
      })}
      {onNew ? (
        <button type="button" className="hive-tab hive-tab-new" aria-label="New session" onClick={onNew} title="New session">
          +
        </button>
      ) : null}
    </div>
  );
}