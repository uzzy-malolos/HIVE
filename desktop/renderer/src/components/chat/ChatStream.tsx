import { useEffect, useRef } from "react";
import type { DesktopChatConversation } from "../../../../../src/desktop/types";
import { renderMarkdown } from "../../markdown";
import type { ChatRouteInfo, CouncilRunView, ToolActivity } from "../../state";
import { CouncilTranscript } from "./CouncilTranscript";
import { MessageList } from "./MessageList";
import { TypingLoader } from "./TypingLoader";

export interface ChatStreamProps {
  conversation: DesktopChatConversation;
  streaming: { turnId: string; text: string; tools?: ToolActivity[] } | undefined;
  route?: ChatRouteInfo;
  councilRun?: CouncilRunView;
  repositoryRoot: string | null;
  disabled: boolean;
  onRetry: (content: string) => void;
  onOpenArtifacts: (relativeDir: string) => void;
  onHandoff?: (messageId: string) => void;
  handoffAvailable?: boolean;
}

const NEAR_BOTTOM_PX = 80;

function toolKind(name: string): string {
  const value = name.toLowerCase();
  if (value.includes("search") || value.includes("grep") || value.includes("glob")) return "Searched";
  if (value.includes("read") || value.includes("list") || value.includes("stat")) return "Explored";
  if (value.includes("write") || value.includes("create")) return "Wrote";
  if (value.includes("edit") || value.includes("patch") || value.includes("apply")) return "Updated";
  if (value.includes("run") || value.includes("exec") || value.includes("command") || value.includes("bash")) return "Ran";
  return "Used";
}

/** Streaming conversation surface: log role, live markdown, caret, stick-to-bottom scroll. */
export function ChatStream({ conversation, streaming, route, councilRun, repositoryRoot, disabled, onRetry, onOpenArtifacts, onHandoff, handoffAvailable }: ChatStreamProps) {
  const scrollRef = useRef<HTMLOListElement>(null);
  const tools = streaming?.tools ?? [];

  // Stick to bottom only while the reader is already near the bottom.
  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < NEAR_BOTTOM_PX;
    if (nearBottom) element.scrollTop = element.scrollHeight;
  }, [conversation.messages, streaming?.text, streaming?.tools?.length, councilRun?.stages.length, councilRun?.summary]);

  return (
    <ol className="chat-messages" role="log" aria-live="polite" aria-label="Conversation messages" ref={scrollRef}>
      <MessageList messages={conversation.messages} disabled={disabled} onRetry={onRetry} onHandoff={onHandoff} handoffAvailable={handoffAvailable} />
      {councilRun && (
        <li className="message message-assistant council-message bubble-row">
          <span className="assistant-mark" aria-hidden="true" />
          <div className="message-bubble">
            <CouncilTranscript run={councilRun} repositoryRoot={repositoryRoot} onOpenArtifacts={onOpenArtifacts} />
          </div>
        </li>
      )}
      {streaming && (
        <li className="message message-assistant message-streaming bubble-row anim-in">
          <span className="assistant-mark" aria-hidden="true" />
          <div className="message-bubble">
          <div className="message-body">
            {tools.length > 0 && (
              <ul className="agent-tool-strip harness-tool-cards" aria-label="HiveBot tool activity">
                {tools.map((tool, index) => (
                  <li key={`${tool.name}-${index}`} className="harness-tool-card anim-in">
                    <span className="harness-tool-kind">{toolKind(tool.name)}</span>
                    <span className="harness-tool-label">[{tool.label}]</span>
                  </li>
                ))}
              </ul>
            )}
            {streaming.text ? (
              <>
                {renderMarkdown(streaming.text)}
                <span className="stream-caret" aria-hidden="true" />
              </>
            ) : tools.length === 0 ? (
              <TypingLoader role={conversation.role} route={route} />
            ) : null}
          </div>
          </div>
        </li>
      )}
    </ol>
  );
}
