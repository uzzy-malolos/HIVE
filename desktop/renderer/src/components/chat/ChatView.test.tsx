import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initialDesktopState } from "../../state";
import { ChatView } from "./ChatView";

const now = "2026-08-18T00:00:00.000Z";

describe("ChatView model picker", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("groups enabled models by provider with context badges and keeps HIVE Auto first", async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    const state = initialDesktopState();
    state.providers = [
      { id: "openai", name: "OpenAI", kind: "openai", authType: "api-key", approved: true, configured: true },
      { id: "ollama", name: "Ollama", kind: "ollama", authType: "none", approved: true, configured: true },
    ];
    state.modelsByProvider = {
      openai: [{ id: "gpt-4o", name: "GPT-4o", contextWindow: 128000 }],
      ollama: [{ id: "llama3.3:latest", name: "llama3.3:latest", contextWindow: 131072 }],
    };

    render(
      <ChatView
        state={state}
        send={vi.fn().mockResolvedValue({ type: "request.completed", timestamp: now, requestId: "r1" })}
        onSelectModel={onSelect}
        onManageModels={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /select ai model/i }));
    const menu = screen.getByRole("listbox", { name: /available models/i });

    expect(within(menu).getByRole("button", { name: /hive auto/i })).toBeInTheDocument();
    expect(within(menu).getByRole("button", { name: /hive council/i })).toBeInTheDocument();
    expect(within(menu).getByText("OpenAI")).toBeInTheDocument();
    expect(within(menu).getByText("Ollama")).toBeInTheDocument();
    expect(within(menu).getByText("128K")).toBeInTheDocument();
    expect(within(menu).queryByText("DeepSeek V4 Flash")).not.toBeInTheDocument();
    expect(within(menu).queryByText("Claude Opus 5")).not.toBeInTheDocument();
  });

  it("does not invent placeholder models when nothing has been discovered", async () => {
    const user = userEvent.setup();
    render(
      <ChatView
        state={initialDesktopState()}
        send={vi.fn().mockResolvedValue({ type: "request.completed", timestamp: now, requestId: "r1" })}
        onManageModels={vi.fn()}
      />,
    );

    await user.click(screen.getByRole("button", { name: /select ai model/i }));
    const menu = screen.getByRole("listbox", { name: /available models/i });
    expect(within(menu).getByRole("button", { name: /hive auto/i })).toBeInTheDocument();
    expect(within(menu).queryByText("DeepSeek V4 Flash")).not.toBeInTheDocument();
    expect(within(menu).queryByText("Claude Opus 5")).not.toBeInTheDocument();
  });
});
