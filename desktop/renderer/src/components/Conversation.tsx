import { FormEvent, useEffect, useRef, useState } from "react";
import type { RuntimeEvent } from "../../../../src/coding/types";
import type { DesktopProviderMetadata, ThreadRecordV1, ThreadRunRef } from "../../../../src/desktop/types";
import { MAX_THREAD_MESSAGE_CHARS } from "../../../../src/desktop/types";
import { terminalStatuses } from "../utils";
import { EmptyState } from "./EmptyState";
import { Message } from "./Message";
import { PromptStarters } from "./PromptStarters";
import { TurnProgress } from "./TurnProgress";

export interface ConversationProps {
  thread: ThreadRecordV1;
  composer: string;
  setComposer: (value: string) => void;
  saving: boolean;
  disabled: boolean;
  paused: boolean;
  retryMessageId: string | null;
  repositoryRoot?: string | null;
  currentRun?: ThreadRunRef | null;
  runtimeEvents?: RuntimeEvent[];
  isPausing?: boolean;
  providers?: DesktopProviderMetadata[];
  selectedProviderId?: string;
  onSelectProvider?: (providerId: string) => void;
  onRetry: (messageId: string) => Promise<void>;
  onSubmit: (event: FormEvent) => Promise<void>;
}

export function Conversation({
  thread,
  composer,
  setComposer,
  saving,
  disabled,
  paused,
  retryMessageId,
  repositoryRoot = null,
  currentRun,
  runtimeEvents = [],
  isPausing = false,
  providers = [],
  selectedProviderId,
  onSelectProvider,
  onRetry,
  onSubmit,
}: ConversationProps) {
  const listRef = useRef<HTMLOListElement>(null);
  const isNearBottomRef = useRef(true);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);

  const activeRun = currentRun && !terminalStatuses.has(currentRun.status) ? currentRun : null;
  const activeProvider = providers.find((p) => p.id === selectedProviderId) ?? providers[0];
  const modelDisplayName = activeProvider
    ? `${activeProvider.defaultModel ?? activeProvider.name}`
    : "HIVE Auto Swarm";

  const repoName = repositoryRoot
    ? repositoryRoot.split(/[/\\]/).filter(Boolean).at(-1) ?? "project"
    : "project";

  const handleScroll = () => {
    if (!listRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = listRef.current;
    isNearBottomRef.current = scrollHeight - scrollTop - clientHeight <= 80;
  };

  useEffect(() => {
    if (isNearBottomRef.current && listRef.current) {
      listRef.current.scrollTop = listRef.current.scrollHeight;
    }
  }, [thread.messages.length, activeRun]);

  return (
    <div className="conversation antigravity-conversation">
      {activeRun && (
        <TurnProgress
          events={runtimeEvents}
          status={activeRun.status}
          startedAt={activeRun.createdAt}
          pausing={isPausing}
        />
      )}

      <ol ref={listRef} onScroll={handleScroll} className="message-list">
        {thread.messages.length ? (
          thread.messages.map((message) => (
            <Message
              key={message.id}
              message={message}
              disabled={disabled}
              saving={saving}
              isRetryTarget={message.id === retryMessageId}
              onRetry={onRetry}
            />
          ))
        ) : (
          <div className="empty-thread-container">
            <div className="project-center-chip">
              <span className="folder-icon" aria-hidden="true">📁</span>
              <span className="project-chip-label">{repoName}</span>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <polyline points="6 9 12 15 18 9" />
              </svg>
            </div>
            <EmptyState className="thread-starter-empty">
              <strong>Describe what you want HIVE to build.</strong>
              <span>Each message starts a verified, multi-agent coding session.</span>
              <PromptStarters
                repositoryRoot={repositoryRoot}
                onInsert={(text) => setComposer(text)}
              />
            </EmptyState>
          </div>
        )}
      </ol>

      {/* Antigravity Floating Composer Card */}
      <div className="composer-wrapper">
        <form className="composer antigravity-composer-card" onSubmit={(event) => void onSubmit(event)}>
          <label htmlFor="composer" className="sr-only">Message HIVE</label>
          <textarea
            id="composer"
            value={composer}
            onChange={(event) => setComposer(event.target.value)}
            onKeyDown={(event) => {
              if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                event.preventDefault();
                if (!disabled && !saving && composer.trim()) {
                  void onSubmit(event as unknown as FormEvent);
                }
              }
            }}
            placeholder="Ask HIVE to plan, build, or verify changes across your codebase..."
            maxLength={MAX_THREAD_MESSAGE_CHARS}
            rows={3}
            disabled={disabled || saving}
            aria-describedby="composer-help"
          />

          <div className="composer-bottom-bar">
            {/* Left Controls: Model chip + Options */}
            <div className="composer-left-actions">
              <div className="model-chip-popover">
                <button
                  type="button"
                  className="model-selector-chip"
                  onClick={() => setModelMenuOpen((prev) => !prev)}
                  aria-haspopup="listbox"
                  aria-expanded={modelMenuOpen}
                  title="Select Model"
                >
                  <span className="plus-sym">+</span>
                  <span className="model-name-text">{modelDisplayName}</span>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                </button>

                {modelMenuOpen && providers.length > 0 && (
                  <ul className="model-chip-menu" role="listbox" aria-label="Providers">
                    {providers.map((provider) => (
                      <li key={provider.id}>
                        <button
                          type="button"
                          className="model-chip-option"
                          onClick={() => {
                            onSelectProvider?.(provider.id);
                            setModelMenuOpen(false);
                          }}
                        >
                          <span>{provider.name}</span>
                          <small>{provider.defaultModel ?? provider.kind}</small>
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>

            {/* Right Controls: Dictation & Circular Send Button */}
            <div className="composer-right-actions">
              <button
                type="button"
                className="dictation-btn"
                aria-label="Voice dictation"
                title="Voice dictation (unavailable)"
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                  <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                  <line x1="12" y1="19" x2="12" y2="23" />
                  <line x1="8" y1="23" x2="16" y2="23" />
                </svg>
              </button>

              <button
                type="submit"
                className="send-circle-btn"
                disabled={disabled || saving || !composer.trim()}
                aria-label={saving ? "Saving..." : "Send"}
                title="Send message (Ctrl+Enter)"
              >
                {saving ? (
                  <span className="saving-text">…</span>
                ) : (
                  <>
                    <span className="sr-only">Send</span>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="5" y1="12" x2="19" y2="12" />
                      <polyline points="12 5 19 12 12 19" />
                    </svg>
                  </>
                )}
              </button>
            </div>
          </div>
        </form>

        {/* Attached Workspace Mode Pill */}
        <div className="composer-mode-row">
          <div className="workspace-mode-pill">
            <span className="mode-folder-icon">📁</span>
            <span>Local</span>
            <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <polyline points="6 9 12 15 18 9" />
            </svg>
          </div>
          <small id="composer-help" className="composer-help-text">
            {paused
              ? "Resume or cancel the paused turn before sending another."
              : disabled
              ? "This repository already has an active run."
              : `${composer.length.toLocaleString()} / ${MAX_THREAD_MESSAGE_CHARS.toLocaleString()} chars`}
          </small>
        </div>
      </div>
    </div>
  );
}
