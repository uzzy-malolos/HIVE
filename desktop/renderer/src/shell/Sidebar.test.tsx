import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Sidebar, type SidebarProps } from "./Sidebar";

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

const sessions = [
  { id: "chat-a", title: "Alpha", kind: "chat" as const, active: true },
  { id: "chat-b", title: "Beta", kind: "chat" as const, active: false },
];

describe("Sidebar projects", () => {
  it("shows the open-project form when there is nothing to pick from", async () => {
    const user = userEvent.setup();
    const { props } = renderSidebar();
    expect(screen.getByLabelText("Repository path")).toHaveAttribute("placeholder", "C:\\source\\project");
    await user.type(screen.getByLabelText("Repository path"), "C:\\work\\api");
    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(props.onOpenRepository).toHaveBeenCalledWith("C:\\work\\api");
  });

  it("lists the open project first and opens another recent one", async () => {
    const user = userEvent.setup();
    const { props } = renderSidebar({
      repositoryPath: "C:\\work\\api",
      recentProjects: [
        { path: "C:\\work\\api", lastOpenedAt: "2026-10-16T00:00:00.000Z" },
        { path: "C:\\work\\web", lastOpenedAt: "2026-10-15T00:00:00.000Z" },
      ],
    });
    const projects = screen.getByRole("group", { name: "Projects" });
    const rows = within(projects).getAllByRole("button");
    expect(rows.map((row) => row.getAttribute("aria-label"))).toEqual(["api (C:\\work\\api)", "Open project web (C:\\work\\web)"]);
    // Without onCloseRepository there is no "No project" row.
    expect(rows[0]).toHaveAttribute("aria-current", "true");
    expect(screen.queryByLabelText("Repository path")).not.toBeInTheDocument();
    await user.click(rows[1]);
    expect(props.onOpenRepository).toHaveBeenCalledWith("C:\\work\\web");
  });

  it("offers No project to leave the open folder", async () => {
    const user = userEvent.setup();
    const onCloseRepository = vi.fn(async () => {});
    renderSidebar({ repositoryPath: "C:\\work\\api", onCloseRepository });
    const none = screen.getByRole("button", { name: /^No project/ });
    expect(none).not.toHaveAttribute("aria-current");
    await user.click(none);
    expect(onCloseRepository).toHaveBeenCalledOnce();
  });

  it("reveals the folder picker and path form from the Projects + button", async () => {
    const user = userEvent.setup();
    const onPickRepository = vi.fn(async () => {});
    renderSidebar({ repositoryPath: "/home/me/hive", onPickRepository });
    await user.click(screen.getByRole("button", { name: "Open project" }));
    expect(screen.getByLabelText("Repository path")).toHaveValue("/home/me/hive");
    await user.click(screen.getByRole("button", { name: /browse for folder/i }));
    expect(onPickRepository).toHaveBeenCalledOnce();
  });

  it("collapses a section from its header", async () => {
    const user = userEvent.setup();
    renderSidebar({ repositoryPath: "C:\\work\\api" });
    await user.click(screen.getByRole("button", { name: "Projects" }));
    expect(screen.getByRole("button", { name: "Projects" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("group", { name: "Projects" })).not.toBeInTheDocument();
  });
});

describe("Sidebar sessions", () => {
  it("stars and archives from the row menu", async () => {
    const user = userEvent.setup();
    const onToggleStar = vi.fn();
    const onArchiveSession = vi.fn();
    renderSidebar({ sessions, onToggleStar, onArchiveSession });
    await user.click(screen.getByRole("button", { name: "Chat options", description: "Beta" }));
    await user.click(within(screen.getByRole("menu", { name: "Chat options", description: "Beta" })).getByRole("menuitem", { name: "Star" }));
    expect(onToggleStar).toHaveBeenCalledWith("chat-b");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Chat options", description: "Alpha" }));
    await user.click(screen.getByRole("menuitem", { name: "Archive" }));
    expect(onArchiveSession).toHaveBeenCalledWith("chat-a");
  });

  it("renames a chat inline, committing once on Enter", async () => {
    const user = userEvent.setup();
    const onRenameSession = vi.fn();
    renderSidebar({ sessions, onRenameSession });
    await user.click(screen.getByRole("button", { name: "Chat options", description: "Beta" }));
    await user.click(screen.getByRole("menuitem", { name: "Rename" }));
    const input = screen.getByRole("textbox", { name: "Rename Beta" });
    expect(input).toHaveFocus();
    await user.clear(input);
    await user.type(input, "  Release   notes {Enter}");
    expect(onRenameSession).toHaveBeenCalledTimes(1);
    expect(onRenameSession).toHaveBeenCalledWith("chat-b", "Release notes");
    expect(screen.queryByRole("textbox", { name: "Rename Beta" })).not.toBeInTheDocument();
  });

  it("drops a rename on Escape, and on blur when blank or unchanged", async () => {
    const user = userEvent.setup();
    const onRenameSession = vi.fn();
    renderSidebar({ sessions, onRenameSession });
    const startRename = async (title: string) => {
      await user.click(screen.getByRole("button", { name: "Chat options", description: title }));
      await user.click(screen.getByRole("menuitem", { name: "Rename" }));
      return screen.getByRole("textbox", { name: `Rename ${title}` });
    };
    await user.type(await startRename("Beta"), " draft{Escape}");
    await user.clear(await startRename("Beta"));
    await user.click(document.body);
    await startRename("Alpha");
    await user.click(document.body);
    expect(onRenameSession).not.toHaveBeenCalled();
  });

  it("offers Rename and Delete for chats but not tasks", async () => {
    const user = userEvent.setup();
    const onDeleteSession = vi.fn();
    renderSidebar({
      mode: "coder",
      sessions: [{ id: "thread-1", title: "Task one", kind: "coder", active: false }],
      onRenameSession: vi.fn(),
      onDeleteSession,
      onArchiveSession: vi.fn(),
    });
    await user.click(screen.getByRole("button", { name: "Task options", description: "Task one" }));
    expect(screen.queryByRole("menuitem", { name: "Rename" })).not.toBeInTheDocument();
    expect(screen.queryByRole("menuitem", { name: "Delete" })).not.toBeInTheDocument();
    cleanup();
    renderSidebar({ sessions, onDeleteSession });
    await user.click(screen.getByRole("button", { name: "Chat options", description: "Alpha" }));
    await user.click(screen.getByRole("menuitem", { name: "Delete" }));
    expect(onDeleteSession).toHaveBeenCalledWith("chat-a");
  });

  it("disables rename, archive and delete while a reply is streaming, but keeps star", async () => {
    const user = userEvent.setup();
    renderSidebar({
      sessions: [{ ...sessions[0], busy: true }],
      onRenameSession: vi.fn(),
      onDeleteSession: vi.fn(),
      onArchiveSession: vi.fn(),
      onToggleStar: vi.fn(),
    });
    await user.click(screen.getByRole("button", { name: "Chat options", description: "Alpha" }));
    for (const name of ["Rename", "Archive", "Delete"]) expect(screen.getByRole("menuitem", { name })).toBeDisabled();
    expect(screen.getByRole("menuitem", { name: "Star" })).toBeEnabled();
    expect(screen.getByText("Available once the reply finishes")).toBeInTheDocument();
  });

  it("moves starred sessions into their own section", () => {
    renderSidebar({ sessions, starredIds: ["chat-b"], onToggleStar: vi.fn() });
    const [starredHeader, chatsHeader] = [screen.getByRole("button", { name: "Starred" }), screen.getByRole("button", { name: "Chats" })];
    const beta = screen.getByRole("button", { name: "Beta" });
    expect(starredHeader.compareDocumentPosition(beta) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(beta.compareDocumentPosition(chatsHeader) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("closes a row menu on Escape", async () => {
    const user = userEvent.setup();
    renderSidebar({ sessions, onArchiveSession: vi.fn() });
    await user.click(screen.getByRole("button", { name: "Chat options", description: "Beta" }));
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("names search and the list after what it holds", () => {
    renderSidebar({ mode: "coder", onOpenSearch: vi.fn() });
    expect(screen.getByRole("button", { name: "Search tasks" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Tasks" })).toBeInTheDocument();
    expect(screen.getByText("Open a project to see its tasks")).toBeInTheDocument();
  });
});

describe("Sidebar chrome", () => {
  it("opens settings, usage and shortcuts from the account menu", async () => {
    const user = userEvent.setup();
    const onOpenShortcuts = vi.fn();
    const { props } = renderSidebar({ onOpenShortcuts, accountDetail: "Local / hive-local" });
    expect(screen.getByText("Local / hive-local")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Account and settings" }));
    await user.click(screen.getByRole("menuitem", { name: /usage/i }));
    expect(props.onOpenUsage).toHaveBeenCalledOnce();
    await user.click(screen.getByRole("button", { name: "Account and settings" }));
    await user.click(screen.getByRole("menuitem", { name: /keyboard shortcuts/i }));
    expect(onOpenShortcuts).toHaveBeenCalledOnce();
    expect(screen.queryByRole("menuitem", { name: "Archived chats" })).not.toBeInTheDocument();
  });

  it("collapses to an icon rail that keeps the main actions", async () => {
    const user = userEvent.setup();
    const { props } = renderSidebar({ collapsed: true, sessions, onOpenSearch: vi.fn() });
    expect(screen.getByRole("navigation")).toHaveAttribute("data-collapsed", "true");
    expect(screen.queryByRole("button", { name: "Alpha" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "New chat" }));
    expect(props.onCreateTask).toHaveBeenCalledOnce();
    expect(screen.getByRole("button", { name: "Search chats" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Account and settings" })).toBeInTheDocument();
  });
});
