import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { DualCockpit } from "./DualCockpit";
import { initialDesktopState } from "../state";

describe("DualCockpit workspace", () => {
  it("renders both HiveBot chat pane and Hive Code coder pane side by side", () => {
    const state = {
      ...initialDesktopState(),
      repositoryRoot: "C:\\projects\\demo",
    };

    render(
      <DualCockpit
        state={state}
        send={vi.fn().mockResolvedValue({ type: "request.completed" })}
        repositoryPath="C:\\projects\\demo"
        setRepositoryPath={vi.fn()}
        busy={false}
        activeRun={null}
        currentRun={null}
        repositoryActiveRun={null}
        report={null}
        composer=""
        setComposer={vi.fn()}
        saving={false}
        retryMessageId={null}
        newThreadTitle="New HIVE task"
        setNewThreadTitle={vi.fn()}
        splitRatio={0.4}
        onSplitRatioChange={vi.fn()}
        mainRef={{ current: null }}
        tabRefs={{ current: { conversation: null, changes: null, report: null } }}
        onOpenRepository={vi.fn()}
        onCreateThread={vi.fn()}
        onLoadThread={vi.fn()}
        onArchiveThread={vi.fn()}
        onChooseTab={vi.fn()}
        onRetryRun={vi.fn()}
        onSubmitMessage={vi.fn()}
        onClearCredential={vi.fn()}
        onProviderChange={vi.fn()}
        onOpenProviderDialog={vi.fn()}
        onRunAction={vi.fn()}
        onPreviewGit={vi.fn()}
        onSendExternal={vi.fn().mockResolvedValue({ type: "request.completed" })}
        onToggleLeftRail={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByTestId("dual-cockpit-workspace")).toBeInTheDocument();
    expect(screen.getAllByText("HiveBot").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Hive Code")).toBeInTheDocument();
    expect(screen.getByRole("separator")).toBeInTheDocument();
  });

  it("hides the left rail when rails.left is false", () => {
    const state = {
      ...initialDesktopState(),
      rails: { left: false, right: true },
    };

    render(
      <DualCockpit
        state={state}
        send={vi.fn().mockResolvedValue({ type: "request.completed" })}
        repositoryPath=""
        setRepositoryPath={vi.fn()}
        busy={false}
        activeRun={null}
        currentRun={null}
        repositoryActiveRun={null}
        report={null}
        composer=""
        setComposer={vi.fn()}
        saving={false}
        retryMessageId={null}
        newThreadTitle="New HIVE task"
        setNewThreadTitle={vi.fn()}
        splitRatio={0.4}
        onSplitRatioChange={vi.fn()}
        mainRef={{ current: null }}
        tabRefs={{ current: { conversation: null, changes: null, report: null } }}
        onOpenRepository={vi.fn()}
        onCreateThread={vi.fn()}
        onLoadThread={vi.fn()}
        onArchiveThread={vi.fn()}
        onChooseTab={vi.fn()}
        onRetryRun={vi.fn()}
        onSubmitMessage={vi.fn()}
        onClearCredential={vi.fn()}
        onProviderChange={vi.fn()}
        onOpenProviderDialog={vi.fn()}
        onRunAction={vi.fn()}
        onPreviewGit={vi.fn()}
        onSendExternal={vi.fn().mockResolvedValue({ type: "request.completed" })}
        onToggleLeftRail={vi.fn()}
        onOpenSettings={vi.fn()}
      />,
    );

    expect(screen.getByTestId("dual-cockpit-workspace")).toHaveClass("hide-left-rail");
  });
});
