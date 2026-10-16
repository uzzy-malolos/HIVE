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
