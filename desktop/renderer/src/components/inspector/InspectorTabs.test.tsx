import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
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
