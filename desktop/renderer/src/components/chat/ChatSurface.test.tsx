import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { ChatSurface } from "./ChatSurface";
import { initialDesktopState } from "../../state";
import type { DesktopChatConversation, DesktopChatSummary } from "../../../../../src/desktop/types";

describe("ChatSurface", () => {
  it("renders sidebar with grouped history, Local Mode profile, and message composer", () => {
    const send = vi.fn().mockResolvedValue({ type: "request.completed", timestamp: new Date().toISOString() });
    const state = initialDesktopState();

    const now = new Date().toISOString();
    const yesterday = new Date(Date.now() - 86400000).toISOString();

    const convToday: DesktopChatSummary = {
      id: "conv-1",
      title: "Explain React Server Components",
      role: "assistant",
      updatedAt: now,
      archived: false,
      messageCount: 2,
    };

    const convYesterday: DesktopChatSummary = {
      id: "conv-2",
      title: "Electron IPC patterns",
      role: "assistant",
      updatedAt: yesterday,
      archived: false,
      messageCount: 4,
    };

    const activeConv: DesktopChatConversation = {
      id: "conv-1",
      cwd: "C:\\Dev\\hive-desktop",
      role: "assistant",
      ground: false,
      createdAt: now,
      updatedAt: now,
      messages: [
        {
          id: "m1",
          role: "user",
          content: "Explain React Server Components",
          at: now,
        },
        {
          id: "m2",
          role: "assistant",
          content: "React Server Components let you render components on the server.",
          at: now,
          receipt: {
            role: "assistant",
            providerId: "deepseek",
            model: "deepseek-chat",
            totalTokens: 150,
            latencyMs: 1200,
          },
        },
      ],
    };

    state.repositoryRoot = "C:\\Dev\\hive-desktop";
    state.chat.conversations = [convToday, convYesterday];
    state.chat.active = activeConv;

    render(
      <ChatSurface
        state={state}
        send={send}
        activeModelName="deepseek / deepseek-chat"
      />
    );

    // Active conversation
    expect(screen.getAllByText("Explain React Server Components").length).toBeGreaterThan(0);
    expect(screen.getByText(/React Server Components let you render components on the server/i)).toBeInTheDocument();

    // Floating composer
    const textarea = screen.getByPlaceholderText(/message HIVE/i);
    expect(textarea).toBeInTheDocument();

    // Sending a message
    fireEvent.change(textarea, { target: { value: "How do client components work?" } });
    const sendBtn = screen.getByRole("button", { name: /send message/i });
    fireEvent.click(sendBtn);

    expect(send).toHaveBeenCalled();
  });

  it("empty state is a new chat, not HiveBot or persona cards", () => {
    const send = vi.fn().mockResolvedValue({ type: "request.completed", timestamp: new Date().toISOString() });
    const state = initialDesktopState();

    render(
      <ChatSurface
        state={state}
        send={send}
        activeModelName="deepseek / deepseek-chat"
      />,
    );

    expect(screen.queryByText("HiveBot")).not.toBeInTheDocument();
    expect(screen.queryByText(/specialized personas/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/7 specialists/i)).not.toBeInTheDocument();
    expect(screen.getByTestId("chat-empty-state")).toHaveTextContent(/what's on the agenda/i);
    expect(screen.getByText(/enter sends/i)).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/message HIVE/i)).toBeInTheDocument();
  });

  it("points first-run users at Settings when no provider is configured", () => {
    const send = vi.fn().mockResolvedValue({ type: "request.completed", timestamp: new Date().toISOString() });
    const onOpenSettings = vi.fn();
    const state = initialDesktopState();
    state.providers = [
      {
        id: "cloud",
        name: "Cloud model",
        kind: "openai-compatible",
        authType: "api-key",
        approved: true,
        configured: false,
        defaultModel: "hive-cloud",
      },
    ];

    render(
      <ChatSurface
        state={state}
        send={send}
        activeModelName="deepseek / deepseek-chat"
        onOpenSettings={onOpenSettings}
      />,
    );

    expect(screen.getByRole("status")).toHaveTextContent(/api key/i);
    fireEvent.click(screen.getByRole("button", { name: /open settings/i }));
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("keeps the draft when send fails", async () => {
    const send = vi.fn().mockResolvedValue({
      type: "request.failed",
      timestamp: new Date().toISOString(),
      requestId: "r1",
      message: "Provider unavailable.",
      recoverable: true,
    });
    const state = initialDesktopState();

    render(<ChatSurface state={state} send={send} />);

    const textarea = screen.getByRole("textbox", { name: /message hive/i });
    fireEvent.change(textarea, { target: { value: "Keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: /send message/i }));

    expect(send).toHaveBeenCalled();
    expect(await screen.findByDisplayValue("Keep this draft")).toBeInTheDocument();
    expect(screen.getByRole("alert")).toHaveTextContent(/provider unavailable/i);
  });

  it("keeps a separate draft for each conversation", () => {
    const send = vi.fn().mockResolvedValue({ type: "request.completed", timestamp: new Date().toISOString() });
    const now = new Date().toISOString();
    const first: DesktopChatConversation = {
      id: "conv-1",
      cwd: "C:\\HIVE",
      role: "assistant",
      ground: false,
      createdAt: now,
      updatedAt: now,
      messages: [{ id: "m1", role: "user", content: "First", at: now }],
    };
    const second: DesktopChatConversation = {
      ...first,
      id: "conv-2",
      messages: [{ id: "m2", role: "user", content: "Second", at: now }],
    };
    const state = initialDesktopState();
    state.chat.conversations = [
      { id: "conv-1", title: "First", role: "assistant", updatedAt: now, archived: false, messageCount: 1 },
      { id: "conv-2", title: "Second", role: "assistant", updatedAt: now, archived: false, messageCount: 1 },
    ];
    state.chat.active = first;

    const { rerender } = render(<ChatSurface state={state} send={send} />);
    fireEvent.change(screen.getByRole("textbox", { name: /message hive/i }), {
      target: { value: "Draft for first chat" },
    });

    const switched = { ...state, chat: { ...state.chat, active: second, activeId: second.id } };
    rerender(<ChatSurface state={switched} send={send} />);
    expect(screen.getByRole("textbox", { name: /message hive/i })).toHaveValue("");

    rerender(<ChatSurface state={state} send={send} />);
    expect(screen.getByRole("textbox", { name: /message hive/i })).toHaveValue("Draft for first chat");
  });

  it("shows a turn failure from chat.failed on the composer", () => {
    const send = vi.fn().mockResolvedValue({ type: "request.completed", timestamp: new Date().toISOString() });
    const now = new Date().toISOString();
    const state = initialDesktopState();
    state.chat.active = {
      id: "conv-1",
      cwd: "C:\\HIVE",
      role: "assistant",
      ground: false,
      createdAt: now,
      updatedAt: now,
      messages: [{ id: "m1", role: "user", content: "Hello", at: now }],
    };
    state.chat.lastFailed = { conversationId: "conv-1", turnId: "turn-1", message: "Model timed out." };

    render(<ChatSurface state={state} send={send} />);
    expect(screen.getByRole("alert")).toHaveTextContent(/model timed out/i);
  });
});
