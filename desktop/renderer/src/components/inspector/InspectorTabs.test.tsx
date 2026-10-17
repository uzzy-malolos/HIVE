import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { ThreadRecordV1 } from "../../../../../src/desktop/types";
import { initialDesktopState } from "../../state";
import { InspectorTabs } from "./InspectorTabs";

describe("InspectorTabs run readout", () => {
  it("does not invent a session id, branch, or repository", () => {
    render(<InspectorTabs state={initialDesktopState()} defaultTab="run" />);
    expect(screen.getByText("no run")).toBeInTheDocument();
    expect(screen.getByText("No repository")).toBeInTheDocument();
    expect(screen.getAllByText("—").length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText("sess-live")).not.toBeInTheDocument();
    expect(screen.queryByText("main")).not.toBeInTheDocument();
  });

  it("shows the active run's recorded session and branch", () => {
    const state = initialDesktopState();
    const thread: ThreadRecordV1 = {
      schemaVersion: 1,
      id: "th-1",
      title: "Preview",
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
      archived: false,
      messages: [],
      runs: [{
        userMessageId: "m1",
        codingSessionId: "ses-9",
        status: "running",
        createdAt: "2026-08-17T00:00:00.000Z",
        updatedAt: "2026-08-17T00:00:00.000Z",
      }],
    };
    state.threads = [thread];
    state.activeThreadId = thread.id;
    state.repositoryRoot = "C:\\HIVE";
    state.gitStatus = {
      repositoryRoot: "C:\\HIVE",
      branch: "feat/truth",
      head: "abc",
      dirty: false,
      changedFiles: [],
      ahead: 0,
      behind: 0,
    };

    render(<InspectorTabs state={state} defaultTab="run" />);
    expect(screen.getByText("ses-9")).toBeInTheDocument();
    expect(screen.getByText("running")).toBeInTheDocument();
    expect(screen.getByText("HIVE")).toBeInTheDocument();
    expect(screen.getByText("feat/truth")).toBeInTheDocument();
  });
});

describe("InspectorTabs guarded Git actions", () => {
  const now = "2026-08-17T00:00:00.000Z";
  const stateWith = (status: "running" | "completed", eligibility?: "eligible" | "review-required") => {
    const state = initialDesktopState();
    state.repositoryRoot = "/work/api";
    state.threads = [{ schemaVersion: 1, id: "th-1", title: "Fix", createdAt: now, updatedAt: now, archived: false, messages: [], runs: [{ userMessageId: "m1", codingSessionId: "ses-1", status, createdAt: now, updatedAt: now }] }];
    state.activeThreadId = "th-1";
    if (eligibility) state.diff = { repositoryRoot: "/work/api", codingSessionId: "ses-1", patch: "", truncated: false, recordedFiles: ["a.ts"], reviewedFiles: ["a.ts"], commitEligibility: eligibility };
    return state;
  };

  it("previews commit, push, PR and discard for a stopped run", () => {
    const onPreviewGit = vi.fn();
    render(<InspectorTabs state={stateWith("completed", "eligible")} onPreviewGit={onPreviewGit} />);
    for (const [label, action] of [["Preview commit", "commit"], ["Preview push", "push"], ["Preview PR", "pull-request"], ["Preview discard", "discard"]] as const) {
      fireEvent.click(screen.getByRole("button", { name: label }));
      expect(onPreviewGit).toHaveBeenLastCalledWith(action);
    }
  });

  it("explains why commit is blocked and hides actions while the run is live", () => {
    const { rerender } = render(<InspectorTabs state={stateWith("completed", "review-required")} onPreviewGit={vi.fn()} />);
    expect(screen.getByRole("button", { name: "Preview commit" })).toBeDisabled();
    expect(screen.getByText("Session review must pass before commit.")).toBeInTheDocument();
    rerender(<InspectorTabs state={stateWith("running", "eligible")} onPreviewGit={vi.fn()} />);
    expect(screen.queryByRole("group", { name: "Guarded Git actions" })).not.toBeInTheDocument();
  });
});
