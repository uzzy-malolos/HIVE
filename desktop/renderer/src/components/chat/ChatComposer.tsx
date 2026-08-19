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
  agent: boolean;
  onAgentChange: (agent: boolean) => void;
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
    agent,
    onAgentChange,
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

  const modelLabel = override
    ? `${override.model ?? override.providerId}`
    : routes[role]?.model ?? providers.find((provider) => provider.configured)?.defaultModel ?? "HIVE Auto";

  return (
    <form
      className="chat-composer harness-composer"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {toolsDrawerOpen && (
        <div className="composer-advanced" aria-label="Composer options">
          <RolePicker role={role} routes={routes} send={send} onSelect={onRoleChange} />
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
            {sendWithEnter ? "Enter sends" : "Ctrl+Enter sends"}
          </button>
        </div>
      )}

      <div className="mockup-composer-pill">
      <textarea
        className="harness-textarea"
        value={draft}
        rows={rows}
        maxLength={MAX_CHARS}
        aria-label={`Message HIVE (${conversation.role})`}
        placeholder={council ? "Describe the goal for the council..." : "Ask anything..."}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={handleKeyDown}
      />
      <div className="mockup-composer-tools">
        <button
          type="button"
          className={`harness-bar-btn${toolsDrawerOpen ? " is-on" : ""}`}
          aria-label="Add tools or attachments"
          title="More composer options"
          onClick={() => setToolsDrawerOpen((prev) => !prev)}
        >
          +
        </button>
        <button
          type="button"
          className={`harness-bar-btn${ground ? " is-on" : ""}`}
          aria-pressed={ground}
          aria-label="Toggle Scout grounding"
          title="Add repository context"
          onClick={() => onGroundChange(!ground)}
        >
          G
        </button>
        <button
          type="button"
          className={`harness-bar-btn${agent ? " is-on" : ""}`}
          aria-pressed={agent}
          aria-label="Toggle agentic mode"
          title="Let HiveBot use read-only repository tools"
          onClick={() => onAgentChange(!agent)}
        >
          A
        </button>
        <button
          type="button"
          className={`harness-bar-btn${council ? " is-on" : ""}`}
          aria-pressed={council}
          aria-label="Toggle council mode"
          title="Route through the six-role council"
          onClick={() => onCouncilChange(!council)}
        >
          C
        </button>
        {council && (
          <label className="harness-preset">
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
        <span className="char-counter gpt-char-counter" aria-label="Character count">
          {draft.length} / {MAX_CHARS.toLocaleString()}
        </span>
        <div className="chip-popover harness-model-pop">
          <button
            type="button"
            className="harness-model-btn"
            aria-haspopup="listbox"
            aria-expanded={providerMenuOpen}
            aria-label="Provider override"
            onClick={() => setProviderMenuOpen((value) => !value)}
          >
            {modelLabel}
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
        {streaming ? (
          <button type="button" className="stop-btn" aria-label="Stop generation" onClick={onStop}>
            Stop
          </button>
        ) : (
          <button type="submit" className="mockup-send" disabled={!canSend} aria-label="Send message">
            Send
          </button>
        )}
      </div>
      </div>
    </form>
  );
}

