import { useMemo } from "react";
import type { DesktopChatMessage } from "../../../../../src/desktop/types";
import { renderMarkdown } from "../../markdown";
import { formatTime } from "../../utils";
import { MessageActions } from "./MessageActions";

export interface MessageListProps {
  messages: DesktopChatMessage[];
  disabled: boolean;
  onRetry: (content: string) => void;
  onHandoff?: (messageId: string) => void;
  handoffAvailable?: boolean;
}

/** Completed conversation messages, newest last, with hover actions on replies. */
export function MessageList({ messages, disabled, onRetry, onHandoff, handoffAvailable }: MessageListProps) {
  const rendered = useMemo(
    () =>
      messages.map((message, index) => {
        const isUser = message.role === "user";
        const precedingUser = !isUser ? [...messages.slice(0, index)].reverse().find((entry) => entry.role === "user") : undefined;
        return (
          <li key={message.id} className={`message message-${message.role} bubble-row anim-in`}>
            {!isUser && <span className="assistant-mark" aria-hidden="true" title="HIVE" />}
            <div className="message-bubble" title={formatTime(message.at)}>
              <div className="message-body">{isUser ? <p>{message.content}</p> : renderMarkdown(message.content)}</div>
            {!isUser && (
              <MessageActions
                message={message}
                disabled={disabled}
                onRetry={() => precedingUser && onRetry(precedingUser.content)}
                retryAvailable={Boolean(precedingUser)}
                handoffAvailable={handoffAvailable}
                onHandoff={onHandoff ? () => onHandoff(message.id) : undefined}
              />
            )}
            </div>
          </li>
        );
      }),
    [messages, disabled, onRetry, onHandoff, handoffAvailable],
  );
  return <>{rendered}</>;
}
