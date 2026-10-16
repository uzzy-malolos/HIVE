import React, { useState, useRef, useEffect } from "react";
import type { DesktopViewState } from "../../state";
import type { DesktopCommandInput } from "../../bridge";
import type { DesktopEvent } from "../../../../../src/desktop/types";
import { copyTextToClipboard, renderMarkdown } from "../../markdown";
import { preferredScrollBehavior } from "../../utils";

export interface ChatModelOption {
  providerId: string;
  providerName: string;
  model: string;
}

export interface ChatSurfaceProps {
  state: DesktopViewState;
  send: (command: DesktopCommandInput) => Promise<DesktopEvent>;
  activeModelName?: string;
  modelOptions?: ChatModelOption[];
  selectedModel?: { providerId: string; model: string } | null;
  onSelectModel?: (choice: ChatModelOption) => void;
  onOpenModelPicker?: () => void;
  onOpenSettings?: () => void;
  onHandoffToCoder?: (threadId?: string) => void;
}

export function ChatSurface({
  state,
  send,
  activeModelName = "No model",
  modelOptions = [],
  selectedModel = null,
  onSelectModel,
  onOpenModelPicker,
  onOpenSettings,
  onHandoffToCoder,
}: ChatSurfaceProps) {
  const { chat } = state;
  const active = chat.active;
  const streaming = active ? chat.streaming[active.id] : undefined;
  const matchedModel = modelOptions.find((option) => option.providerId === selectedModel?.providerId && option.model === selectedModel?.model);
  const displayModel = matchedModel ? `${matchedModel.providerName} / ${matchedModel.model}` : activeModelName;

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastSentRef = useRef<string | null>(null);
  const draftKey = active?.id ?? "new";
  const inputMessage = drafts[draftKey] ?? "";
  const setInputMessage = (value: string) => {
    setDrafts((prev) => ({ ...prev, [draftKey]: value }));
  };
  const quietStop = chat.lastFailed?.message === "Cancelled.";
  const turnFailed = Boolean(active && chat.lastFailed?.conversationId === active.id && !quietStop);
  const composerError = sendError ?? (turnFailed ? chat.lastFailed?.message ?? null : null);
  const lastAssistantId = [...(active?.messages ?? [])].reverse().find((message) => message.role === "assistant")?.id;
  const lastUserContent = [...(active?.messages ?? [])].reverse().find((message) => message.role === "user")?.content;

  useEffect(() => {
    textareaRef.current?.focus();
    setSendError(null);
    setModelMenuOpen(false);
  }, [active?.id]);

  useEffect(() => {
    if (turnFailed && lastSentRef.current) {
      setInputMessage(lastSentRef.current);
      lastSentRef.current = null;
    }
    if (streaming) lastSentRef.current = null;
  }, [turnFailed, streaming]);

  useEffect(() => {
    try {
      if (messagesEndRef.current && typeof messagesEndRef.current.scrollIntoView === "function") {
        messagesEndRef.current.scrollIntoView({ behavior: preferredScrollBehavior() });
      }
    } catch {
      // Ignore jsdom scrollIntoView absence
    }
  }, [active?.messages?.length, streaming?.text]);

  function modelOverride(): { providerId?: string; model?: string } {
    if (!selectedModel) return {};
    return { providerId: selectedModel.providerId, model: selectedModel.model };
  }

  const handleSend = async (event?: React.FormEvent) => {
    if (event) event.preventDefault();
    if (streaming || !inputMessage.trim() || sending) return;
    const text = inputMessage.trim();
    lastSentRef.current = text;
    setSendError(null);
    setSending(true);
    try {
      if (active) {
        const sent = await send({
          type: "chat.send",
          input: { conversationId: active.id, content: text, ...modelOverride() },
        });
        if (sent.type === "request.failed") {
          setSendError(sent.message);
          return;
        }
      } else {
        const created = await send({ type: "chat.create", input: {} });
        if (created.type === "request.failed") {
          setSendError(created.message);
          return;
        }
        if (created.type !== "chat.changed") {
          setSendError("Could not start a chat. Try again.");
          return;
        }
        const sent = await send({
          type: "chat.send",
          input: { conversationId: created.conversation.id, content: text, ...modelOverride() },
        });
        if (sent.type === "request.failed") {
          setSendError(sent.message);
          return;
        }
      }
      setInputMessage("");
    } catch (error) {
      setSendError(error instanceof Error ? error.message : "Could not send that message.");
    } finally {
      setSending(false);
      textareaRef.current?.focus();
    }
  };

  const handleStop = async () => {
    if (!active || !streaming) return;
    await send({ type: "chat.cancel", conversationId: active.id });
  };

  const handleRegenerate = async () => {
    if (!active || streaming || !lastUserContent) return;
    setSendError(null);
    const sent = await send({
      type: "chat.send",
      input: { conversationId: active.id, content: lastUserContent, regenerate: true, ...modelOverride() },
    });
    if (sent.type === "request.failed") setSendError(sent.message);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (!streaming) void handleSend();
    }
  };

  const copyMessage = (id: string, content: string) => {
    void copyTextToClipboard(content).then(() => {
      setCopiedId(id);
      window.setTimeout(() => setCopiedId((current) => (current === id ? null : current)), 1_500);
    });
  };

  const needsProvider = state.providers.length > 0 && !state.providers.some((provider) => provider.configured);
  const groupedModels = modelOptions.reduce<Array<{ providerId: string; providerName: string; models: ChatModelOption[] }>>((groups, option) => {
    const existing = groups.find((group) => group.providerId === option.providerId);
    if (existing) existing.models.push(option);
    else groups.push({ providerId: option.providerId, providerName: option.providerName, models: [option] });
    return groups;
  }, []);

  return (
    <div className="hive-chat-surface" aria-label="HiveChat Surface">
      <div className="hive-chat-scroll" id="main-workspace" tabIndex={-1}>
        <div className="hive-chat-column">
          {needsProvider && (
            <div className="chat-setup-banner" role="status">
              <p>Add an API key in Settings so HIVE can reply.</p>
              {onOpenSettings && (
                <button type="button" className="chat-setup-btn" onClick={onOpenSettings}>
                  Open Settings
                </button>
              )}
            </div>
          )}

          {active && active.messages.length > 0 ? (
            <div className="messages-flow">
              {active.messages.map((msg) => (
                <div key={msg.id} className={`chat-message-row role-${msg.role}`}>
                  {msg.role === "user" ? (
                    <div className="user-message-bubble">
                      <div className="message-content">{msg.content}</div>
                      <div className="message-footer">
                        <span className="msg-time">
                          {new Date(msg.at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                        </span>
                      </div>
                    </div>
                  ) : (
                    <div className="assistant-message-card">
                      <div className="assistant-avatar-hex">
                        <HiveMark />
                      </div>
                      <div className="assistant-content">
                        {renderMarkdown(msg.content)}
                        {msg.receipt && (
                          <div className="receipt-chip">
                            {msg.receipt.model}
                            {typeof msg.receipt.totalTokens === "number" ? ` · ${msg.receipt.totalTokens.toLocaleString()} tokens` : ""}
                            {typeof msg.receipt.latencyMs === "number" ? ` · ${(msg.receipt.latencyMs / 1000).toFixed(2)}s` : ""}
                          </div>
                        )}
                        {msg.id === lastAssistantId && (
                          <div className="hive-message-actions">
                            <button type="button" onClick={() => copyMessage(msg.id, msg.content)}>
                              {copiedId === msg.id ? "Copied" : "Copy"}
                            </button>
                            {lastUserContent && (
                              <button type="button" disabled={Boolean(streaming)} onClick={() => void handleRegenerate()}>
                                Regenerate
                              </button>
                            )}
                          </div>
                        )}
                        {onHandoffToCoder && (msg.content.includes("```") || msg.content.toLowerCase().includes("implement") || msg.content.toLowerCase().includes("phase")) && (
                          <div className="hive-handoff-banner" style={{ marginTop: "12px" }}>
                            <span className="hive-handoff-text">Ready to execute in verified runtime?</span>
                            <button type="button" className="hive-handoff-btn" onClick={() => onHandoffToCoder()}>
                              Build in Hive Code →
                            </button>
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {streaming && (
                <div className="chat-message-row role-assistant is-streaming">
                  <div className="assistant-avatar-hex">
                    <HiveMark />
                  </div>
                  <div className="assistant-content">
                    {renderMarkdown(streaming.text || "...")}
                    {streaming.text && (
                      <div className="hive-message-actions">
                        <button type="button" onClick={() => copyMessage(streaming.turnId, streaming.text)}>
                          {copiedId === streaming.turnId ? "Copied" : "Copy"}
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="chat-empty-state" data-testid="chat-empty-state">
              <p className="chat-empty-copy">Ask HIVE about this workspace. Enter sends, Shift+Enter adds a line.</p>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      <form className="hive-composer-container" onSubmit={(event) => void handleSend(event)}>
        <div className="hive-composer-box">
          <textarea
            ref={textareaRef}
            rows={1}
            className="hive-composer-input"
            placeholder="Message HIVE..."
            aria-label="Message HIVE"
            aria-describedby="chat-composer-hint"
            value={inputMessage}
            onChange={(event) => setInputMessage(event.target.value)}
            onKeyDown={handleKeyDown}
          />
          <p id="chat-composer-hint" className="hive-composer-hint">Enter sends. Shift+Enter adds a line.</p>
          <div className="hive-composer-toolbar">
            <div className="hive-composer-left">
              <button
                type="button"
                className="hive-composer-btn hive-composer-model-btn"
                aria-haspopup="listbox"
                aria-expanded={modelMenuOpen}
                aria-label="Select model"
                onClick={() => {
                  if (modelOptions.length === 0) {
                    (onOpenModelPicker ?? onOpenSettings)?.();
                    return;
                  }
                  setModelMenuOpen((open) => !open);
                }}
              >
                <span className="hive-composer-kicker">Model</span>
                <span className="hive-composer-value">{displayModel}</span>
                <span className="hive-composer-chevron" aria-hidden="true">▾</span>
              </button>
              {modelMenuOpen && modelOptions.length > 0 && (
                <ul className="hive-model-menu" role="listbox" aria-label="Configured models">
                  {groupedModels.map((group) => (
                    <li key={group.providerId}>
                      <div className="hive-model-group">{group.providerName}</div>
                      <ul>
                        {group.models.map((option) => {
                          const selected = option.providerId === selectedModel?.providerId && option.model === selectedModel?.model;
                          return (
                            <li key={`${option.providerId}:${option.model}`}>
                              <button
                                type="button"
                                role="option"
                                aria-selected={selected}
                                className={`hive-model-option${selected ? " is-selected" : ""}`}
                                onClick={() => {
                                  onSelectModel?.(option);
                                  setModelMenuOpen(false);
                                }}
                              >
                                {option.model}
                              </button>
                            </li>
                          );
                        })}
                      </ul>
                    </li>
                  ))}
                  {onOpenSettings && (
                    <li>
                      <button
                        type="button"
                        className="hive-model-option"
                        onClick={() => {
                          setModelMenuOpen(false);
                          onOpenSettings();
                        }}
                      >
                        Configure providers
                      </button>
                    </li>
                  )}
                </ul>
              )}
            </div>
            {streaming ? (
              <button type="button" className="hive-composer-send-btn is-stop" aria-label="Stop generation" onClick={() => void handleStop()}>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <rect x="1" y="1" width="10" height="10" rx="1.5" fill="currentColor" />
                </svg>
              </button>
            ) : (
              <button
                type="submit"
                className="hive-composer-send-btn"
                disabled={!inputMessage.trim() || sending}
                aria-label="Send message"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="19" x2="12" y2="5" />
                  <polyline points="5 12 12 5 19 12" />
                </svg>
              </button>
            )}
          </div>
        </div>
        {composerError && (
          <p className="composer-send-error" role="alert">{composerError}</p>
        )}
      </form>
    </div>
  );
}

function HiveMark() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M12 2L20.66 7V17L12 22L3.34 17V7L12 2Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}
