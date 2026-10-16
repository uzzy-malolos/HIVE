import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { groupSessionsByDate, Sidebar, type SidebarProps } from "./Sidebar";

afterEach(cleanup);

function renderSidebar(overrides: Partial<SidebarProps> = {}) {
  const props: SidebarProps = {
    mode: "chat",
    onSelectMode: vi.fn(),
    onCreateTask: vi.fn(),
    sessions: [],
    onSelectSession: vi.fn(),
    onOpenUsage: vi.fn(),
    onOpenSettings: vi.fn(),
    onOpenRepository: vi.fn(async () => {}),
    ...overrides,
  };
  return { props, ...render(<Sidebar {...props} />) };
}

describe("Sidebar project switcher", () => {
  it("starts expanded with no project and opens a typed path", async () => {
    const user = userEvent.setup();
    const { props } = renderSidebar();
    expect(screen.getByRole("button", { name: "Choose a project" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByLabelText("Repository path")).toHaveAttribute("placeholder", "C:\\source\\project");
    await user.type(screen.getByLabelText("Repository path"), "C:\\work\\api");
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(props.onOpenRepository).toHaveBeenCalledWith("C:\\work\\api");
  });

  it("collapses to the current project and lists other recent projects", async () => {
    const user = userEvent.setup();
    const { props } = renderSidebar({
      repositoryPath: "C:\\work\\api",
      recentProjects: [
        { path: "C:\\work\\api", lastOpenedAt: "2026-10-16T00:00:00.000Z" },
        { path: "C:\\work\\web", lastOpenedAt: "2026-10-15T00:00:00.000Z" },
      ],
    });
    const current = screen.getByRole("button", { name: "Switch project, current api" });
    expect(current).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByLabelText("Repository path")).not.toBeInTheDocument();
    await user.click(current);
    const recent = screen.getByRole("group", { name: "Recent projects" });
    expect(within(recent).queryByRole("button", { name: /\(C:\\work\\api\)/ })).not.toBeInTheDocument();
    await user.click(within(recent).getByRole("button", { name: "Open project web (C:\\work\\web)" }));
    expect(props.onOpenRepository).toHaveBeenCalledWith("C:\\work\\web");
  });

  it("follows a project opened elsewhere", () => {
    const { rerender, props } = renderSidebar();
    rerender(<Sidebar {...props} repositoryPath="/home/me/hive" />);
    expect(screen.getByRole("button", { name: "Switch project, current hive" })).toHaveAttribute("aria-expanded", "false");
  });

  it("offers the native folder picker", async () => {
    const user = userEvent.setup();
    const onPickRepository = vi.fn(async () => {});
    renderSidebar({ onPickRepository });
    await user.click(screen.getByRole("button", { name: /browse for folder/i }));
    expect(onPickRepository).toHaveBeenCalledOnce();
  });
});

describe("Sidebar sessions", () => {
  it("names the search after what the list holds", () => {
    renderSidebar({ mode: "coder" });
    expect(screen.getByRole("searchbox", { name: "Search tasks" })).toBeInTheDocument();
    cleanup();
    renderSidebar({ mode: "split" });
    expect(screen.getByRole("searchbox", { name: "Search chats" })).toBeInTheDocument();
    expect(screen.getByText("Recent chats")).toBeInTheDocument();
  });

  it("groups sessions by local calendar day", () => {
    const now = new Date(2026, 9, 16, 15, 0);
    const at = (days: number) => new Date(2026, 9, 16 - days, 9, 0).toISOString();
    const groups = groupSessionsByDate([
      { id: "a", title: "A", kind: "chat", active: false, updatedAt: at(0) },
      { id: "b", title: "B", kind: "chat", active: false, updatedAt: at(1) },
      { id: "c", title: "C", kind: "chat", active: false, updatedAt: at(4) },
      { id: "d", title: "D", kind: "chat", active: false, updatedAt: at(30) },
      { id: "e", title: "E", kind: "chat", active: false },
    ], now);
    expect(groups.map((group) => [group.label, group.sessions.map((session) => session.id)])).toEqual([
      ["Today", ["a"]],
      ["Yesterday", ["b"]],
      ["Previous 7 days", ["c"]],
      ["Older", ["d", "e"]],
    ]);
  });
});
