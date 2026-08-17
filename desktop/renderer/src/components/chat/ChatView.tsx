import { useEffect, useState } from "react";
import type { DesktopEvent } from "../../../../../src/desktop/types";
import type { DesktopCommandInput } from "../../bridge";
import type { DesktopViewState } from "../../state";
import { Dialog } from "../../Dialog";
import { ChatComposer } from "./ChatComposer";
import { ChatStream } from "./ChatStream";
import { SessionRail } from "./SessionRail";
import { Welcome } from "./Welcome";

export interface ChatViewProps {
  state: DesktopViewState;
  send: (command: DesktopCommandInput) => Promise<DesktopEvent>;
  onToggleLeftRail?: () => void;
  onHandoffToCoder?: (threadId: string) => void;
}

/** Primary conversational surface: sessions rail + welcome or live conversation. */
export function ChatView({ state, send, onToggleLeftRail, onHandoffToCoder }: ChatViewProps) {
  const { chat } = state;
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
    if (!active || !draft.trim()) return;
    const content = draft.trim();
    setDraft("");
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
        conversationId: active.id,
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

  return (
    <div className={`chat-grid${!state.rails.left ? " hide-left" : ""}`}>
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

      <section className="chat-center" aria-label="Conversation">
        {!active ? (
          <Welcome
            repositoryRoot={state.repositoryRoot}
            routes={chat.routes}
            send={send}
            onPickRole={(role) => void pickRole(role)}
            onPickSuggestion={(text) => void pickSuggestion(text)}
          />
        ) : (
          <div className="chat-conversation">
            <header className="chat-conversation-header">
              <strong>{chat.conversations.find((entry) => entry.id === active.id)?.title ?? "Conversation"}</strong>
              <span className="role-chip">[{roleChoice ?? active.role}]</span>
              <button type="button" className="link-btn" onClick={() => void archiveConversation(active.id)}>
                archive
              </button>
            </header>
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
            <ChatComposer
              conversation={active}
              draft={draft}
              setDraft={setDraft}
              streaming={Boolean(streaming) || Boolean(chat.councilByConv[active.id] && !chat.councilByConv[active.id]!.summary && !chat.councilByConv[active.id]!.failed)}
              providers={state.providers}
              routes={chat.routes}
              role={roleChoice ?? active.role}
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
            />
          </div>
        )}
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
