import { useEffect, useMemo, useState } from "react";
import type { DesktopEvent, DesktopModelInfo } from "../../../../../src/desktop/types";
import type { DesktopCommandInput } from "../../bridge";
import type { DesktopViewState } from "../../state";
import { Dialog } from "../../Dialog";
import { usePrefs } from "../../prefs";
import { ChatComposer } from "./ChatComposer";
import { ChatStream } from "./ChatStream";
import { SessionRail } from "./SessionRail";
import { Welcome } from "./Welcome";

export interface GoalView {
  text: string;
  status: "active" | "paused" | "complete";
  evidence?: string[];
}

export interface ChatViewProps {
  state: DesktopViewState;
  send: (command: DesktopCommandInput) => Promise<DesktopEvent>;
  embedded?: boolean;
  onToggleLeftRail?: () => void;
  onHandoffToCoder?: (threadId: string) => void;
  activeModelName?: string;
  onSelectModel?: (model: string) => void;
  goal?: GoalView | null;
  onGoalChange?: (goal: GoalView | null) => void;
  showComposer?: boolean;
  onManageModels?: () => void;
  availableModels?: Array<{ providerId: string; providerName: string; models: DesktopModelInfo[] }>;
}

/** Primary conversational surface: sessions rail + welcome or live conversation. */
export function ChatView({ state, send, embedded = false, onToggleLeftRail, onHandoffToCoder, activeModelName = "HIVE Auto", onSelectModel, goal = null, onGoalChange, showComposer = true, onManageModels, availableModels }: ChatViewProps) {
  const { chat, modelsByProvider } = state;
  const { prefs } = usePrefs();
  const active = chat.active;
  const streaming = active ? chat.streaming[active.id] : undefined;
  const failed = Boolean(active && chat.lastFailed?.conversationId === active.id);

  const [draft, setDraft] = useState("");
  const [roleChoice, setRoleChoice] = useState<string | undefined>(undefined);
  const [ground, setGround] = useState(false);
  const [agent, setAgent] = useState(false);
  const [council, setCouncil] = useState(false);
  const [councilPreset, setCouncilPreset] = useState("standard");
  const [override, setOverride] = useState<{ providerId?: string; model?: string } | undefined>(undefined);
  const [handoffPending, setHandoffPending] = useState<string | null>(null);

  const modelGroups = useMemo(() => {
    if (availableModels) {
      const enabledMap = prefs.enabledModels ?? {};
      return availableModels
        .map((group) => ({
          ...group,
          models: group.models.filter((model) => enabledMap[model.id] !== false),
        }))
        .filter((group) => group.models.length > 0);
    }
    const enabledMap = prefs.enabledModels ?? {};
    return (state.providers || [])
      .map((provider) => ({
        providerId: provider.id,
        providerName: provider.name,
        models: (modelsByProvider[provider.id] || []).filter((model) => enabledMap[model.id] !== false),
      }))
      .filter((group) => group.models.length > 0);
  }, [availableModels, state.providers, modelsByProvider, prefs.enabledModels]);

  // Conversation switches reset per-conversation composer state.
  useEffect(() => {
    setDraft("");
    setRoleChoice(undefined);
    setGround(active?.ground ?? false);
    setAgent(false);
    setOverride(undefined);
  }, [active?.id]);

  async function createConversation(role?: string): Promise<void> {
    await send({ type: "chat.create", input: role ? { role } : {} });
  }

  async function loadConversation(conversationId: string): Promise<void> {
    await send({ type: "chat.load", conversationId });
  }

  async function archiveConversation(conversationId: string): Promise<void> {
    await send({ type: "chat.archive", conversationId });
  }

  async function pickRole(role: string): Promise<void> {
    await createConversation(role);
  }

  async function pickSuggestion(text: string): Promise<void> {
    const created = await send({ type: "chat.create", input: {} });
    if (created.type !== "chat.changed") return;
    await send({ type: "chat.send", input: { conversationId: created.conversation.id, content: text } });
  }

  async function retryMessage(content: string): Promise<void> {
    if (!active) return;
    await send({ type: "chat.send", input: { conversationId: active.id, content } });
  }

  async function sendMessage(): Promise<void> {
    if (!draft.trim()) return;
    let content = draft.trim();
    setDraft("");

    const goalCommand = content.match(/^\/goal(?:\s+(pause|resume|clear)|(?:\s+(.+)))?$/i);
    if (goalCommand) {
      const action = goalCommand[1]?.toLowerCase();
      const objective = goalCommand[2]?.trim();
      if (action === "pause" && goal) {
        onGoalChange?.({ ...goal, status: "paused" });
        return;
      }
      if (action === "resume" && goal) {
        onGoalChange?.({ ...goal, status: "active" });
        return;
      }
      if (action === "clear") {
        onGoalChange?.(null);
        return;
      }
      if (objective) {
        onGoalChange?.({ text: objective, status: "active" });
        setAgent(true);
        content = objective;
      } else {
        return;
      }
    }

    let conversationId = active?.id;
    if (!conversationId) {
      const created = await send({ type: "chat.create", input: roleChoice ? { role: roleChoice } : {} });
      if (created.type === "chat.changed") {
        conversationId = created.conversation.id;
      } else {
        return;
      }
    }

    if (council) {
      await send({
        type: "council.start",
        input: {
          task: content,
          preset: councilPreset as "quick" | "standard" | "deep" | "audit",
          ...(override?.providerId || override?.model ? { providerId: override.providerId, model: override.model } : {}),
        },
      });
      return;
    }
    await send({
      type: "chat.send",
      input: {
        conversationId,
        content,
        ...(roleChoice ? { role: roleChoice } : {}),
        ...(override?.providerId || override?.model ? { providerId: override.providerId, model: override.model } : {}),
        ground,
        agent,
      },
    });
  }

  async function stopStreaming(): Promise<void> {
    if (!active) return;
    const councilRun = chat.councilByConv[active.id];
    if (!streaming && councilRun && !councilRun.summary && !councilRun.failed) {
      await send({ type: "council.cancel", runId: councilRun.runId });
      return;
    }
    await send({ type: "chat.cancel", conversationId: active.id });
  }

  async function openArtifacts(relativeDir: string): Promise<void> {
    if (!state.repositoryRoot) return;
    await send({ type: "external.open-explorer", input: { repositoryRoot: state.repositoryRoot, path: relativeDir } });
  }

  async function confirmHandoff(): Promise<void> {
    if (!active || !handoffPending) return;
    const sourceMessageId = handoffPending;
    setHandoffPending(null);
    const result = await send({ type: "coder.handoff", input: { conversationId: active.id, sourceMessageId } });
    if (result.type === "coder.handoff.started") onHandoffToCoder?.(result.threadId);
  }

  const containerClass = embedded ? "chat-embedded-pane" : `chat-grid${!state.rails.left ? " hide-left" : ""}`;

  return (
    <div className={containerClass}>
      {!embedded && (
        <aside className="chat-rail" aria-label="Conversations" hidden={!state.rails.left}>
          <SessionRail
            conversations={chat.conversations}
            activeId={chat.activeId}
            onLoad={(id) => void loadConversation(id)}
            onCreate={() => void createConversation()}
            onArchive={(id) => void archiveConversation(id)}
            onToggleSidebar={onToggleLeftRail}
          />
        </aside>
      )}

      <section className="chat-center" aria-label="Conversation">
        <div className="chat-conversation">
          <div className="chat-conversation-header workbench-chat-header">
            <ModelChip label={activeModelName} onSelect={onSelectModel} onManageModels={onManageModels} groups={modelGroups} />
            {active && (
              <button type="button" className="link-btn archive-link" onClick={() => void archiveConversation(active.id)}>
                Archive
              </button>
            )}
          </div>
          {!active ? (
            <Welcome
              repositoryRoot={state.repositoryRoot}
              routes={chat.routes}
              send={send}
              onPickRole={(role) => void pickRole(role)}
              onPickSuggestion={(text) => void pickSuggestion(text)}
            />
          ) : (
            <ChatStream
              conversation={active}
              streaming={streaming}
              route={chat.routes[roleChoice ?? active.role] ?? chat.routes.auto}
              councilRun={chat.councilByConv[active.id]}
              repositoryRoot={state.repositoryRoot}
              disabled={Boolean(streaming)}
              onRetry={(content) => void retryMessage(content)}
              onOpenArtifacts={(relativeDir) => void openArtifacts(relativeDir)}
              handoffAvailable={Boolean(state.repositoryRoot)}
              onHandoff={(messageId) => setHandoffPending(messageId)}
            />
          )}
          {showComposer && <ChatComposer
            conversation={active ?? {
              id: "draft",
              cwd: state.repositoryRoot ?? "",
              role: roleChoice ?? "auto",
              ground,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
              messages: [],
            }}
            draft={draft}
            setDraft={setDraft}
            streaming={Boolean(streaming) || Boolean(active && chat.councilByConv[active.id] && !chat.councilByConv[active.id]!.summary && !chat.councilByConv[active.id]!.failed)}
            providers={state.providers}
            routes={chat.routes}
            role={roleChoice ?? active?.role ?? "auto"}
            onRoleChange={setRoleChoice}
            ground={ground}
            onGroundChange={setGround}
            agent={agent}
            onAgentChange={setAgent}
            council={council}
            onCouncilChange={setCouncil}
            councilPreset={councilPreset}
            onCouncilPresetChange={setCouncilPreset}
            override={override}
            onOverrideChange={setOverride}
            send={send}
            onSend={() => void sendMessage()}
            onStop={() => void stopStreaming()}
            failed={failed}
          />}
        </div>
      </section>

      {handoffPending && (
        <Dialog title="Send to Hive Code" onClose={() => setHandoffPending(null)}>
          <span className="eyebrow">Hive Code handoff</span>
          <p>Hand this HiveBot answer to Hive Code as a verified run? It will create a coder thread and start an isolated, approve-before-commit harness run.</p>
          <div className="dialog-actions">
            <button type="button" className="secondary" onClick={() => setHandoffPending(null)}>Cancel</button>
            <button type="button" onClick={() => void confirmHandoff()}>Send to Hive Code</button>
          </div>
        </Dialog>
      )}
    </div>
  );
}

function formatContext(tokens?: number): string {
  if (!tokens) return "";
  if (tokens >= 1_000_000) return `${tokens % 1_000_000 === 0 ? tokens / 1_000_000 : (tokens / 1_000_000).toFixed(1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return `${tokens}`;
}

function ModelChip({
  label,
  onSelect,
  onManageModels,
  groups = [],
}: {
  label: string;
  onSelect?: (model: string) => void;
  onManageModels?: () => void;
  groups?: Array<{ providerId: string; providerName: string; models: DesktopModelInfo[] }>;
}) {
  const [open, setOpen] = useState(false);
  const baseOptions = [
    { id: "auto", label: "HIVE Auto" },
    { id: "council", label: "HIVE Council" },
  ];

  return (
    <div className="gpt-model-selector-container">
      <button
        type="button"
        className="gpt-model-dropdown-btn"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label="Select AI model"
        onClick={() => setOpen((prev) => !prev)}
      >
        <span className="gpt-model-title">{label}</span>
        <span aria-hidden="true">▾</span>
      </button>
      {open && (
        <ul className="gpt-model-menu" role="listbox" aria-label="Available models">
          {baseOptions.map((opt) => (
            <li key={opt.id} role="option" aria-selected={label === opt.label}>
              <button
                type="button"
                className="gpt-model-menu-item"
                onClick={() => {
                  onSelect?.(opt.label);
                  setOpen(false);
                }}
              >
                {opt.label}
              </button>
            </li>
          ))}
          {groups.flatMap((group) => [
            <li key={`group-${group.providerId}`} className="model-menu-group" role="presentation">
              <span className="model-menu-group-label">{group.providerName}</span>
            </li>,
            ...group.models.map((model) => {
              const modelLabel = model.name || model.id;
              const context = formatContext(model.contextWindow);
              return (
                <li key={`${group.providerId}:${model.id}`} role="option" aria-selected={label === modelLabel || label === model.id}>
                  <button
                    type="button"
                    className="gpt-model-menu-item"
                    onClick={() => {
                      onSelect?.(modelLabel);
                      setOpen(false);
                    }}
                  >
                    <span className="model-menu-id">{model.id}</span>
                    {context && <span className="model-context-badge">{context}</span>}
                  </button>
                </li>
              );
            }),
          ])}
          {onManageModels && (
            <li role="option" aria-selected={false}>
              <button
                type="button"
                className="gpt-model-menu-item"
                onClick={() => {
                  setOpen(false);
                  onManageModels();
                }}
              >
                Configure providers…
              </button>
            </li>
          )}
        </ul>
      )}
    </div>
  );
}
