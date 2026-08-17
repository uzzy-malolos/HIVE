import { useEffect, useMemo, useState } from "react";
import type { DesktopEvent } from "../../../../../src/desktop/types";
import type { DesktopCommandInput } from "../../bridge";
import { CHAT_ROLE_CARDS } from "../../../../../src/chat/roles";
import type { ChatRouteInfo } from "../../state";

export interface WelcomeProps {
  repositoryRoot: string | null;
  routes: Record<string, ChatRouteInfo>;
  send: (command: DesktopCommandInput) => Promise<DesktopEvent>;
  onPickRole: (role: string) => void;
  onPickSuggestion: (text: string) => void;
}

const BEE_ART = "  ___   ___\n /   \\ /   \\\n \\___/ \\___/\n   \\___/";

function routeChip(routes: Record<string, ChatRouteInfo>, role: string): string {
  const route = routes[role];
  return route ? `${route.providerId}/${route.model}` : "route unresolved";
}

/** Empty-state welcome: ChatGPT-style centered greeting, capsule input bar, personas & prompt starters. */
export function Welcome({ repositoryRoot, routes, send, onPickRole, onPickSuggestion }: WelcomeProps) {
  const [welcomeInput, setWelcomeInput] = useState("");
  const repoName = repositoryRoot ? repositoryRoot.split(/[/\\]/).filter(Boolean).at(-1) ?? "project" : "project";

  // Resolve the trust chips once per mount — cheap BYOK registry reads.
  useEffect(() => {
    for (const role of ["auto", ...CHAT_ROLE_CARDS.map((card) => card.slug)]) {
      void send({ type: "chat.route", input: { role } });
    }
  }, []);

  const suggestions = useMemo(
    () => [
      `Explain the architecture of ${repoName}`,
      `Draft a refactoring plan for ${repoName}`,
      `Review the trickiest module in ${repoName} for bugs`,
    ],
    [repoName],
  );

  function handleWelcomeSubmit(event: React.FormEvent) {
    event.preventDefault();
    if (!welcomeInput.trim()) return;
    onPickSuggestion(welcomeInput.trim());
  }

  return (
    <div className="chat-welcome gpt-welcome-stage anim-in">
      <div className="gpt-welcome-center">
        {/* HIVE Brand Mark & Badge */}
        <div className="gpt-badge-row">
          <div className="hive-hero-squircle">
            <svg viewBox="0 0 32 32" width="36" height="36" fill="none">
              <rect x="2" y="2" width="28" height="28" rx="8" fill="url(#hiveWelcomeGrad)" stroke="rgba(139, 92, 246, 0.4)" strokeWidth="1.5" />
              <path d="M16 6l7 4.2v8.4L16 23l-7-4.4v-8.4L16 6z" stroke="#DDD6FE" strokeWidth="1.5" strokeLinejoin="round" fill="rgba(124, 58, 237, 0.35)" />
              <circle cx="16" cy="14.5" r="2.5" fill="#DDD6FE" />
              <defs>
                <linearGradient id="hiveWelcomeGrad" x1="0" y1="0" x2="32" y2="32" gradientUnits="userSpaceOnUse">
                  <stop stopColor="#1E1035" />
                  <stop offset="1" stopColor="#0F0B1A" />
                </linearGradient>
              </defs>
            </svg>
          </div>
          <span className="welcome-title gpt-wordmark">HiveBot</span>
        </div>

        {/* Hero Greeting */}
        <h1 className="gpt-hero-title">Hyper Intelligence for Verified Engineering</h1>
        <p className="gpt-hero-subline">Orchestrate autonomous agent swarms, verify cryptographic receipts, and build with precision.</p>

        {/* Centered Floating Capsule Input Pill */}
        <form className="gpt-capsule-bar" onSubmit={handleWelcomeSubmit}>
          <button
            type="button"
            className="capsule-icon-btn plus-btn"
            aria-label="Add tools or attachments"
            title="Attach / Ground / Options"
            onClick={() => onPickRole("auto")}
          >
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.5">
              <line x1="12" y1="5" x2="12" y2="19" strokeLinecap="round" />
              <line x1="5" y1="12" x2="19" y2="12" strokeLinecap="round" />
            </svg>
          </button>

          <input
            type="text"
            className="capsule-text-input"
            placeholder="Ask anything"
            aria-label="Ask anything"
            value={welcomeInput}
            onChange={(event) => setWelcomeInput(event.target.value)}
          />

          <div className="capsule-right-controls">
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
          </div>
        </form>

        {/* Starter Prompts */}
        <div className="prompt-starters gpt-starters-row" aria-label="Suggested first prompts">
          {suggestions.map((suggestion) => (
            <button
              key={suggestion}
              type="button"
              className="prompt-starter-chip gpt-starter-chip"
              onClick={() => onPickSuggestion(suggestion)}
            >
              <span>&gt; {suggestion}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Collapsible / Floating Persona Selector */}
      <details className="gpt-persona-drawer">
        <summary className="gpt-drawer-summary">
          <span>Specialized Personas & Route Verification</span>
          <span className="welcome-sub">({CHAT_ROLE_CARDS.length + 1} specialists available)</span>
        </summary>
        <ul className="persona-grid gpt-persona-grid" aria-label="Personas">
          <li>
            <button type="button" className="persona-card anim-in" onClick={() => onPickRole("auto")}>
              <span className="persona-name">Auto</span>
              <span className="persona-desc">Classifies each message and picks the right specialist.</span>
              <span className="route-chip">[route] {routeChip(routes, "auto")}</span>
            </button>
          </li>
          {CHAT_ROLE_CARDS.map((card) => (
            <li key={card.slug}>
              <button type="button" className="persona-card anim-in" onClick={() => onPickRole(card.slug)}>
                <span className="persona-name">{card.label}</span>
                <span className="persona-desc">{card.description}</span>
                <span className="route-chip">[route] {routeChip(routes, card.slug)}</span>
              </button>
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

