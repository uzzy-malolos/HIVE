import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { CodingFinalReport, RuntimeEvent } from "../../../../../src/coding/types";
import { CodexSurface } from "./CodexSurface";
import { initialDesktopState } from "../../state";

describe("CodexSurface", () => {
  it("renders 3-column layout: workspace tree, agent transcript with mode tabs, and editor preview / diff", () => {
    const send = vi.fn().mockResolvedValue({ type: "request.completed", timestamp: new Date().toISOString() });
    const state = initialDesktopState();

    state.repositoryRoot = "C:\\Dev\\hive-desktop";
    state.workspaceListings[""] = {
      repositoryRoot: "C:\\Dev\\hive-desktop",
      path: "",
      truncated: false,
      entries: [
        { name: "src", path: "src", kind: "dir" },
        { name: "App.tsx", path: "App.tsx", kind: "file" },
      ],
    };
    state.workspaceListings["src"] = {
      repositoryRoot: "C:\\Dev\\hive-desktop",
      path: "src",
      truncated: false,
      entries: [{ name: "index.ts", path: "src/index.ts", kind: "file" }],
    };

    state.threads = [
      {
        schemaVersion: 1,
        id: "th-1",
        title: "Implement file preview",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        archived: false,
        messages: [
          {
            id: "m1",
            role: "user",
            content: "Implement file preview in Codex",
            createdAt: new Date().toISOString(),
          },
          {
            id: "m2",
            role: "assistant",
            content: "I have updated the file preview layout.",
            createdAt: new Date().toISOString(),
          },
        ],
        runs: [],
      },
    ];
    state.activeThreadId = "th-1";

    state.workspaceFile = {
      repositoryRoot: "C:\\Dev\\hive-desktop",
      path: "App.tsx",
      content: "export function App() { return <div>HIVE</div>; }",
      languageHint: "TypeScript React",
      truncated: false,
    };
    state.selectedWorkspacePath = "App.tsx";

    state.diff = {
      repositoryRoot: "C:\\Dev\\hive-desktop",
      codingSessionId: "ses-1",
      patch: "--- a/App.tsx\n+++ b/App.tsx\n@@ -1 +1 @@\n-export function App() {}\n+export function App() { return <div>HIVE</div>; }",
      truncated: false,
      recordedFiles: ["App.tsx"],
      reviewedFiles: ["App.tsx"],
      commitEligibility: "eligible",
    };

    render(
      <CodexSurface
        state={state}
        send={send}
        activeModelName="deepseek / deepseek-coder"
      />
    );

    // Mission Header & Posture
    expect(screen.getAllByText(/Implement file preview/i).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /guarded/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /standard/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /autonomous/i })).toBeInTheDocument();

    // Agent activity is present, but idle until runtime events arrive.
    expect(screen.getByRole("log", { name: "Agent activity" })).toBeInTheDocument();
    expect(screen.getByText("Scout")).toBeInTheDocument();
    expect(screen.getByText("Planner")).toBeInTheDocument();
    expect(screen.getByText("Builder")).toBeInTheDocument();
    expect(screen.getAllByText("not started").length).toBeGreaterThanOrEqual(5);
    expect(screen.queryByText(/indexed repository/i)).not.toBeInTheDocument();

    // Transcript messages
    expect(screen.getByText("Implement file preview in Codex")).toBeInTheDocument();
    expect(screen.getByText(/I have updated the file preview layout/i)).toBeInTheDocument();

    // Composer
    expect(screen.getByPlaceholderText(/ask HIVE/i)).toBeInTheDocument();

    // 5-Tab Inspector
    expect(screen.getByRole("tab", { name: /changes/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /files/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /terminal/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /evidence/i })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /run/i })).toBeInTheDocument();
  });

  it("reads the session report and runtime events instead of placeholder harness state", () => {
    const send = vi.fn().mockResolvedValue({ type: "request.completed", timestamp: new Date().toISOString() });
    const state = initialDesktopState();
    state.repositoryRoot = "C:\\Dev\\hive-desktop";
    state.selectedSessionId = "ses-1";
    state.threads = [{
      schemaVersion: 1,
      id: "th-1",
      title: "Implement file preview",
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
      archived: false,
      messages: [],
      runs: [{
        userMessageId: "m1",
        codingSessionId: "ses-1",
        status: "running",
        createdAt: "2026-08-17T00:00:00.000Z",
        updatedAt: "2026-08-17T00:00:00.000Z",
      }],
    }];
    state.activeThreadId = "th-1";
    state.runtimeEvents = [{
      schemaVersion: 1,
      id: "e-1",
      sequence: 1,
      sessionId: "ses-1",
      timestamp: "2026-08-17T00:00:02.000Z",
      type: "plan.created",
      payload: { summary: "Ship the preview", taskIds: ["bee-1"] },
    } as RuntimeEvent];
    state.reports["ses-1"] = {
      result: "needs repair",
      verdict: "REJECTED",
      subagents: {
        total: 1, active: 0, working: 0, waiting: 0, blocked: 0, done: 0, completed: 0, failed: 1, cancelled: 0, skipped: 0,
      },
      filesChanged: [],
      validation: [{ label: "npm test", status: "failed" }],
      review: [],
      outstanding: ["npm test"],
      completedAt: "2026-08-17T00:00:08.000Z",
    } satisfies CodingFinalReport;

    render(<CodexSurface state={state} send={send} />);

    expect(screen.getByLabelText("Planner: Ship the preview")).toBeInTheDocument();
    expect(screen.queryByText(/indexed repository/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: /evidence/i }));
    expect(screen.getByText("REJECTED")).toBeInTheDocument();
    expect(screen.getByText("npm test")).toBeInTheDocument();
    expect(screen.queryByText(/112/)).not.toBeInTheDocument();
    expect(screen.queryByText(/GATE PASSED/i)).not.toBeInTheDocument();
  });
});

describe("CodexSurface task lifecycle", () => {
  const now = "2026-08-17T00:00:00.000Z";
  const thread = (status?: "running" | "paused" | "completed") => ({
    schemaVersion: 1 as const, id: "th-run", title: "Fix the build", createdAt: now, updatedAt: now, archived: false,
    messages: [{ id: "m1", role: "user" as const, content: "Fix the build", createdAt: now }],
    runs: status ? [{ userMessageId: "m1", codingSessionId: "ses-1", status, createdAt: now, updatedAt: now }] : [],
  });

  it("starts a new task from the first message when none is selected", async () => {
    const created = thread();
    const send = vi.fn(async (command: { type: string }) => {
      if (command.type === "thread.create") return { type: "thread.changed", timestamp: now, thread: { ...created, title: "Add a health check endpoint" } };
      if (command.type === "thread.message.append") return { type: "thread.changed", timestamp: now, thread: created };
      return { type: "request.completed", timestamp: now };
    });
    const state = initialDesktopState();
    state.repositoryRoot = "/work/api";
    render(<CodexSurface state={state} send={send as never} />);
    fireEvent.change(screen.getByLabelText("Message HIVE"), { target: { value: "Add a health check endpoint\nwith tests" } });
    fireEvent.click(screen.getByRole("button", { name: "Send task" }));
    await vi.waitFor(() => expect(send.mock.calls.map(([command]) => command.type)).toEqual(["thread.create", "thread.message.append", "run.start"]));
    expect(send.mock.calls[0][0]).toMatchObject({ input: { title: "Add a health check endpoint" } });
    expect(send.mock.calls[2][0]).toMatchObject({ input: { threadId: created.id, repositoryRoot: "/work/api" } });
  });

  it("offers pause and cancel while running, resume while paused, and new task once stopped", () => {
    const onRunAction = vi.fn(async () => {});
    const onNewTask = vi.fn();
    const send = vi.fn();
    const state = initialDesktopState();
    state.repositoryRoot = "/work/api";
    state.activeThreadId = "th-run";

    state.threads = [thread("running")];
    const { rerender } = render(<CodexSurface state={state} send={send} onRunAction={onRunAction} onNewTask={onNewTask} />);
    const controls = () => screen.getByRole("group", { name: "Run controls" });
    expect(controls()).toHaveTextContent("PauseCancelNew task");
    expect(screen.getByRole("button", { name: "New task" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    expect(onRunAction).toHaveBeenCalledWith("pause");

    rerender(<CodexSurface state={{ ...state, threads: [thread("paused")] }} send={send} onRunAction={onRunAction} onNewTask={onNewTask} />);
    expect(controls()).toHaveTextContent("ResumeCancelNew task");
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onRunAction).toHaveBeenLastCalledWith("resume");

    rerender(<CodexSurface state={{ ...state, threads: [thread("completed")] }} send={send} onRunAction={onRunAction} onNewTask={onNewTask} />);
    expect(controls()).toHaveTextContent("New task");
    expect(screen.queryByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "New task" }));
    expect(onNewTask).toHaveBeenCalledOnce();
  });
});
