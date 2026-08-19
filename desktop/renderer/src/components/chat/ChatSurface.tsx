import React, { useState, useRef, useEffect, useMemo } from "react";
import type { DesktopViewState } from "../../state";
import type { DesktopCommandInput } from "../../bridge";
import type { DesktopEvent, DesktopChatSummary } from "../../../../../src/desktop/types";
import { renderMarkdown } from "../../markdown";

export interface ChatSurfaceProps {
  state: DesktopViewState;
  send: (command: DesktopCommandInput) => Promise<DesktopEvent>;
  activeModelName?: string;
  onOpenModelPicker?: () => void;
  onOpenSettings?: () => void;
  onHandoffToCoder?: (threadId?: string) => void;
}

interface GroupedConversations {
  today: DesktopChatSummary[];
  yesterday: DesktopChatSummary[];
  older: DesktopChatSummary[];
}

function groupConversationsByDate(conversations: DesktopChatSummary[]): GroupedConversations {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);

  const groups: GroupedConversations = {
    today: [],
    yesterday: [],
    older: [],
  };

  for (const conv of conversations) {
    if (conv.archived) continue;
    const date = new Date(conv.updatedAt);
    if (date >= today) {
      groups.today.push(conv);
    } else if (date >= yesterday) {
      groups.yesterday.push(conv);
    } else {
      groups.older.push(conv);
    }
  }

  return groups;
}

export function ChatSurface({
  state,
  send,
  activeModelName = "HIVE Auto",
  onOpenModelPicker,
  onOpenSettings,
  onHandoffToCoder,
}: ChatSurfaceProps) {
  const { chat, repositoryRoot } = state;
  const active = chat.active;
  const streaming = active ? chat.streaming[active.id] : undefined;
  const displayModel = activeModelName || "HIVE Auto";

  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [searchQuery, setSearchQuery] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const lastSentRef = useRef<string | null>(null);
  const draftKey = active?.id ?? "new";
  const inputMessage = drafts[draftKey] ?? "";
  const setInputMessage = (value: string) => {
    setDrafts((prev) => ({ ...prev, [draftKey]: value }));
  };
  const turnFailed = Boolean(active && chat.lastFailed?.conversationId === active.id);
  const composerError = sendError ?? (turnFailed ? chat.lastFailed?.message ?? null : null);

  useEffect(() => {
    textareaRef.current?.focus();
    setSendError(null);
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
        messagesEndRef.current.scrollIntoView({ behavior: "smooth" });
      }
    } catch {
      // Ignore jsdom scrollIntoView absence
    }
  }, [active?.messages?.length, streaming?.text]);

  const handleSend = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!inputMessage.trim() || sending) return;
    const text = inputMessage.trim();
    lastSentRef.current = text;
    setSendError(null);
    setSending(true);
    try {
      if (active) {
        const sent = await send({
          type: "chat.send",
          input: { conversationId: active.id, content: text },
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
          input: { conversationId: created.conversation.id, content: text },
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

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleNewChat = async () => {
    await send({ type: "chat.create", input: {} });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && (event.key === "n" || event.key === "N")) {
        const target = event.target;
        if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) return;
        event.preventDefault();
        void handleNewChat();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [send]);

  const handleSelectConv = async (id: string) => {
    await send({ type: "chat.load", conversationId: id });
  };

  // Filter real conversations with search query
  const filteredConversations = useMemo(() => {
    if (!searchQuery.trim()) return chat.conversations;
    const q = searchQuery.toLowerCase();
    return chat.conversations.filter(
      (c) => c.title.toLowerCase().includes(q) || c.role.toLowerCase().includes(q)
    );
  }, [chat.conversations, searchQuery]);

  const grouped = useMemo(
    () => groupConversationsByDate(filteredConversations),
    [filteredConversations]
  );
  const searching = searchQuery.trim().length > 0;
  const visibleCount = grouped.today.length + grouped.yesterday.length + grouped.older.length;
  const starters = [
    "Explain this project in plain language",
    "Help me plan a small, safe change",
    "What should I look at first?",
  ];

  const projectsList = useMemo(() => {
    if (!repositoryRoot) return [];
    const name = repositoryRoot.split(/[/\\]/).filter(Boolean).pop() || "Workspace";
    return [{ name, path: repositoryRoot, pinned: true }];
  }, [repositoryRoot]);

  // Determine active conversation title
  const activeSummary = chat.conversations.find((c) => c.id === active?.id);
  const activeTitle = activeSummary?.title || (active ? "New chat" : "Chat");
  const needsProvider = state.providers.length > 0 && !state.providers.some((provider) => provider.configured);

  return (
    <div className="hive-chat-surface" aria-label="HiveChat Surface">
      {/* Scrollable Conversation Stream */}
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
                        <div className="msg-avatar user-avatar">U</div>
                      </div>
                    </div>
                  ) : (
                    <div className="assistant-message-card">
                      <div className="assistant-avatar-hex">
                        <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                          <path
                            d="M12 2L20.66 7V17L12 22L3.34 17V7L12 2Z"
                            stroke="#8b5cf6"
                            strokeWidth="2"
                            fill="rgba(139, 92, 246, 0.2)"
                          />
                        </svg>
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
                    <svg width="22" height="22" viewBox="0 0 24 24" fill="none">
                      <path
                        d="M12 2L20.66 7V17L12 22L3.34 17V7L12 2Z"
                        stroke="#a855f7"
                        strokeWidth="2"
                        fill="rgba(168, 85, 247, 0.2)"
                      />
                    </svg>
                  </div>
                  <div className="assistant-content">
                    {renderMarkdown(streaming.text || "...")}
                  </div>
                </div>
              )}
            </div>
          ) : (
            <div className="chat-empty-state" data-testid="chat-empty-state">
              <div className="chat-empty-mark" aria-hidden="true">
                <svg width="36" height="36" viewBox="0 0 24 24" fill="none">
                  <path
                    d="M12 2L20.66 7V17L12 22L3.34 17V7L12 2Z"
                    stroke="#8b5cf6"
                    strokeWidth="2"
                    fill="rgba(139, 92, 246, 0.2)"
                  />
                </svg>
              </div>
              <p className="chat-empty-title">What's on the agenda?</p>
              <p className="chat-empty-copy">Type below to start. Enter sends, Shift+Enter adds a line. Nothing leaves this machine.</p>
              <div className="chat-empty-starters">
                {starters.map((starter) => (
                  <button
                    key={starter}
                    type="button"
                    className="chat-starter-chip"
                    onClick={() => {
                      setInputMessage(starter);
                      textareaRef.current?.focus();
                    }}
                  >
                    {starter}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>
      </div>

      {/* COMPACT REFINED COMPOSER */}
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
            onChange={(e) => setInputMessage(e.target.value)}
            onKeyDown={handleKeyDown}
          />
          <div className="hive-composer-toolbar">
            <div className="hive-composer-left">
              <button
                type="button"
                className="hive-composer-btn"
                onClick={onOpenModelPicker || onOpenSettings}
                aria-label="Composer Model selector"
              >
                <span>Model:</span>
                <span style={{ color: "var(--hive-text)", fontWeight: 600 }}>{displayModel}</span>
                <span>▾</span>
              </button>
            </div>
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
          </div>
        </div>
        {composerError && (
          <p className="composer-send-error" role="alert">{composerError}</p>
        )}
      </form>
    </div>
  );
}
