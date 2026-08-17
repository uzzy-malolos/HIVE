import { KeyboardEvent, useEffect, useRef, useState } from "react";
import type { DesktopChatConversation, DesktopEvent, DesktopProviderMetadata } from "../../../../../src/desktop/types";
import type { DesktopCommandInput } from "../../bridge";
import { usePrefs } from "../../prefs";
import type { ChatRouteInfo } from "../../state";
import { RolePicker } from "./RolePicker";

const MAX_CHARS = 24_000;
const MAX_ROWS = 8;

export interface ChatComposerProps {
  conversation: DesktopChatConversation;
  draft: string;
  setDraft: (value: string) => void;
  streaming: boolean;
  providers: DesktopProviderMetadata[];
  routes: Record<string, ChatRouteInfo>;
  role: string;
  onRoleChange: (role: string) => void;
  ground: boolean;
  onGroundChange: (ground: boolean) => void;
  council: boolean;
  onCouncilChange: (council: boolean) => void;
  councilPreset: string;
  onCouncilPresetChange: (preset: string) => void;
  override: { providerId?: string; model?: string } | undefined;
  onOverrideChange: (override: { providerId?: string; model?: string } | undefined) => void;
  send: (command: DesktopCommandInput) => Promise<DesktopEvent>;
  onSend: () => void;
  onStop: () => void;
  failed: boolean;
}

/** Bottom-anchored composer: ChatGPT-style capsule input bar with plus button, voice waveform, and tools. */
export function ChatComposer(props: ChatComposerProps) {
  const {
    conversation,
    draft,
    setDraft,
    streaming,
    providers,
    routes,
    role,
    onRoleChange,
    ground,
    onGroundChange,
    council,
    onCouncilChange,
    councilPreset,
    onCouncilPresetChange,
    override,
    onOverrideChange,
    send,
    onSend,
    onStop,
    failed,
  } = props;
  const { prefs, updatePrefs } = usePrefs();
  const sendWithEnter = prefs.composerSendWithEnter ?? true;
  const [providerMenuOpen, setProviderMenuOpen] = useState(false);
  const [toolsDrawerOpen, setToolsDrawerOpen] = useState(false);
  const lastSentRef = useRef<string | null>(null);

  // A failed turn restores the draft so the user can edit and resend.
  useEffect(() => {
    if (failed && lastSentRef.current !== null) {
      setDraft(lastSentRef.current);
      lastSentRef.current = null;
    }
  }, [failed]);

  const rows = Math.min(MAX_ROWS, Math.max(1, draft.split("\n").length));
  const canSend = !streaming && draft.trim().length > 0;

  function submit(): void {
    if (!canSend) return;
    lastSentRef.current = draft;
    setDraft("");
    onSend();
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    const enterSends = sendWithEnter
      ? event.key === "Enter" && !event.shiftKey
      : event.key === "Enter" && (event.ctrlKey || event.metaKey);
    if (enterSends) {
      event.preventDefault();
      submit();
    }
  }

  return (
    <form
      className="chat-composer gpt-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {/* Options Bar / Tools Drawer */}
      <div className={`composer-chips gpt-tools-drawer${toolsDrawerOpen ? " is-open" : ""}`} aria-label="Composer options">
        <RolePicker role={role} routes={routes} send={send} onSelect={onRoleChange} />
        <button
          type="button"
          className={`composer-chip toggle${ground ? " on" : ""}`}
          aria-pressed={ground}
          aria-label="Toggle Scout grounding"
          title="Prepend a Scout context pack from this repository"
          onClick={() => onGroundChange(!ground)}
        >
          [/ground{ground ? ": on" : ""}]
        </button>
        <div className="chip-popover">
          <button
            type="button"
            className="composer-chip"
            aria-haspopup="listbox"
            aria-expanded={providerMenuOpen}
            aria-label="Provider override"
            onClick={() => setProviderMenuOpen((value) => !value)}
          >
            [{override ? `${override.providerId}/${override.model ?? "default"}` : "provider: role default"} v]
          </button>
          {providerMenuOpen && (
            <ul className="chip-menu" role="listbox" aria-label="Providers">
              <li role="option" aria-selected={!override}>
                <button
                  type="button"
                  className="chip-option"
                  onClick={() => {
                    onOverrideChange(undefined);
                    setProviderMenuOpen(false);
                  }}
                >
                  <span>role default</span>
                </button>
              </li>
              {providers.map((provider) => (
                <li key={provider.id} role="option" aria-selected={override?.providerId === provider.id}>
                  <button
                    type="button"
                    className="chip-option"
                    onClick={() => {
                      onOverrideChange({ providerId: provider.id, model: provider.defaultModel });
                      setProviderMenuOpen(false);
                    }}
                  >
                    <span>{provider.name}</span>
                    <span className="route-chip">{provider.defaultModel ? `${provider.id}/${provider.defaultModel}` : provider.id}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
        <button
          type="button"
          className={`composer-chip toggle${council ? " on" : ""}`}
          aria-pressed={council}
          aria-label="Toggle council mode"
          title="Route the next message through the six-role hivebot council"
          onClick={() => onCouncilChange(!council)}
        >
          [/council{council ? ": on" : ""}]
        </button>
        {council && (
          <label className="composer-chip preset">
            preset:
            <select
              aria-label="Council preset"
              value={councilPreset}
              onChange={(event) => onCouncilPresetChange(event.target.value)}
            >
              <option value="quick">quick</option>
              <option value="standard">standard</option>
              <option value="deep">deep</option>
              <option value="audit">audit</option>
            </select>
          </label>
        )}
        <button
          type="button"
          className="composer-chip toggle"
          aria-pressed={sendWithEnter}
          aria-label="Toggle Enter to send"
          title={sendWithEnter ? "Enter sends; Shift+Enter inserts a newline" : "Ctrl+Enter sends; Enter inserts a newline"}
          onClick={() => updatePrefs({ composerSendWithEnter: !sendWithEnter })}
        >
          [{sendWithEnter ? "enter: send" : "ctrl-enter: send"}]
        </button>
      </div>

      {/* Main ChatGPT Capsule Bar */}
      <div className="composer-main gpt-capsule-container">
        {/* Left Plus / Tool Toggle Button */}
        <button
          type="button"
          className={`capsule-icon-btn plus-btn${toolsDrawerOpen ? " active" : ""}`}
          aria-label="Add tools or attachments"
          title="Toggle tools & grounding options"
          onClick={() => setToolsDrawerOpen((prev) => !prev)}
        >
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5">
            <line x1="12" y1="5" x2="12" y2="19" strokeLinecap="round" />
            <line x1="5" y1="12" x2="19" y2="12" strokeLinecap="round" />
          </svg>
        </button>

        {/* Input Text Area */}
        <textarea
          className="capsule-textarea"
          value={draft}
          rows={rows}
          maxLength={MAX_CHARS}
          aria-label={`Message HIVE (${conversation.role})`}
          placeholder={council ? "Describe the task for the council..." : "Ask anything"}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={handleKeyDown}
        />

        {/* Character Counter */}
        <span className="char-counter gpt-char-counter" aria-label="Character count">
          {draft.length} / {MAX_CHARS.toLocaleString()}
        </span>

        {/* Right Actions: Mic, Stop, or Voice/Send */}
        <div className="gpt-right-actions">
          <button
            type="button"
            className="capsule-icon-btn mic-btn"
            aria-label="Voice input"
            title="Voice input"
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
              <path d="M19 10v2a7 7 0 0 1-14 0v-2" strokeLinecap="round" />
              <line x1="12" y1="19" x2="12" y2="23" strokeLinecap="round" />
              <line x1="8" y1="23" x2="16" y2="23" strokeLinecap="round" />
            </svg>
          </button>

          {streaming ? (
            <button type="button" className="stop-btn gpt-stop-btn" aria-label="Stop generation" onClick={onStop}>
              Stop
            </button>
          ) : draft.trim().length > 0 ? (
            <button type="submit" className="send-btn gpt-send-btn" disabled={!canSend} aria-label="Send message">
              Send
            </button>
          ) : (
            <button
              type="submit"
              className="capsule-voice-pill"
              aria-label="Start voice or send message"
              title="Voice conversation"
            >
              <span className="wave-bars">
                <span className="bar bar-1"></span>
                <span className="bar bar-2"></span>
                <span className="bar bar-3"></span>
                <span className="bar bar-4"></span>
              </span>
            </button>
          )}
        </div>
      </div>
    </form>
  );
}

