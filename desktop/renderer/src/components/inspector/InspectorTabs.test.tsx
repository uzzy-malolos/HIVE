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
  function stateWithRun(status: "running" | "completed") {
    const state = initialDesktopState();
    state.threads = [{
      schemaVersion: 1,
      id: "th-1",
      title: "Review",
      createdAt: "2026-08-17T00:00:00.000Z",
      updatedAt: "2026-08-17T00:00:00.000Z",
      archived: false,
      messages: [],
      runs: [{ userMessageId: "m1", codingSessionId: "ses-1", status, createdAt: "2026-08-17T00:00:00.000Z", updatedAt: "2026-08-17T00:00:00.000Z" }],
    }];
    state.activeThreadId = "th-1";
    return state;
  }

  it("offers previews only once the run has settled", () => {
    const onPreviewGit = vi.fn();
    const { rerender } = render(<InspectorTabs state={stateWithRun("running")} onPreviewGit={onPreviewGit} />);
    expect(screen.queryByRole("group", { name: "Guarded Git actions" })).not.toBeInTheDocument();

    rerender(<InspectorTabs state={stateWithRun("completed")} onPreviewGit={onPreviewGit} />);
    fireEvent.click(screen.getByRole("button", { name: "Preview commit" }));
    fireEvent.click(screen.getByRole("button", { name: "Preview PR" }));
    expect(onPreviewGit.mock.calls).toEqual([["commit"], ["pull-request"]]);
  });

  it("reports tab selection so the owner can load the diff or report", () => {
    const onSelectTab = vi.fn();
    render(<InspectorTabs state={stateWithRun("completed")} onSelectTab={onSelectTab} />);
    fireEvent.click(screen.getByRole("tab", { name: "Evidence" }));
    fireEvent.click(screen.getByRole("tab", { name: /^Changes/ }));
    expect(onSelectTab.mock.calls).toEqual([["evidence"], ["changes"]]);
  });
});
