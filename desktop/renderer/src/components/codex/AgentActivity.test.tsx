import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RuntimeEvent } from "../../../../../src/coding/types";
import { AgentActivity } from "./AgentActivity";
import { deriveAgentActivity } from "./agent-activity";

const BASE = Date.parse("2026-08-17T00:00:00.000Z");

function at(seconds: number): string {
  return new Date(BASE + seconds * 1000).toISOString();
}

function runtime(sequence: number, type: string, payload: object, seconds = sequence, sessionId = "ses-1"): RuntimeEvent {
  return {
    schemaVersion: 1,
    id: `e-${sequence}`,
    sequence,
    sessionId,
    timestamp: at(seconds),
    type,
    payload,
  } as RuntimeEvent;
}

describe("deriveAgentActivity", () => {
  it("shows the five harness roles as not started when nothing has run", () => {
    const rows = deriveAgentActivity([]);
    expect(rows.map((row) => row.label)).toEqual(["Scout", "Planner", "Builder", "Validator", "Reviewer"]);
    expect(rows.every((row) => row.detail === "not started" && row.elapsedLabel === "—")).toBe(true);
    expect(JSON.stringify(rows)).not.toMatch(/indexed repository|0\.4s|symbols/i);
  });

  it("marks unseen roles waiting while a run is live and not run after it settles", () => {
    expect(deriveAgentActivity([], { runStatus: "running" }).every((row) => row.detail === "waiting")).toBe(true);
    expect(deriveAgentActivity([], { runStatus: "completed" }).every((row) => row.detail === "not run")).toBe(true);
  });

  it("derives scout, planner, and builder rows from runtime events", () => {
    const rows = deriveAgentActivity([
      runtime(1, "subagent.created", { subagentId: "bee-scout", task: { id: "bee-scout", role: "scout" } }, 1),
      runtime(2, "subagent.started", { subagentId: "bee-scout", attempt: 1 }, 2),
      runtime(3, "subagent.completed", { subagentId: "bee-scout", summary: "Captured repository context" }, 6),
      runtime(4, "plan.created", { summary: "Ship the preview", taskIds: ["bee-builder"] }, 8),
      runtime(5, "subagent.created", { subagentId: "bee-builder", task: { id: "bee-builder", role: "builder" } }, 9),
      runtime(6, "subagent.file_changed", {
        subagentId: "bee-builder",
        path: "desktop/renderer/src/App.tsx",
        operation: "modified",
      }, 10),
    ], { now: BASE + 14_000, runStatus: "running", sessionId: "ses-1" });

    const scout = rows.find((row) => row.role === "scout");
    const planner = rows.find((row) => row.role === "planner");
    const builder = rows.find((row) => row.role === "builder");
    expect(scout).toMatchObject({ phase: "done", detail: "Captured repository context", elapsedLabel: "4s" });
    expect(planner).toMatchObject({ phase: "done", detail: "Ship the preview" });
    expect(builder).toMatchObject({ phase: "active", detail: "editing desktop/renderer/src/App.tsx", elapsedLabel: "4s" });
    expect(rows.find((row) => row.role === "validator")?.detail).toBe("waiting");
    expect(rows.find((row) => row.role === "reviewer")?.detail).toBe("waiting");
  });

  it("counts real file edits and records a failed validation", () => {
    const rows = deriveAgentActivity([
      runtime(1, "subagent.created", { subagentId: "bee-1", task: { id: "bee-1", role: "builder" } }, 1),
      runtime(2, "subagent.file_changed", { subagentId: "bee-1", path: "a.ts", operation: "modified" }, 2),
      runtime(3, "subagent.completed", { subagentId: "bee-1" }, 3),
      runtime(4, "subagent.created", { subagentId: "bee-2", task: { id: "bee-2", role: "builder" } }, 4),
      runtime(5, "subagent.file_changed", { subagentId: "bee-2", path: "b.ts", operation: "modified" }, 5),
      runtime(6, "subagent.completed", { subagentId: "bee-2" }, 6),
      runtime(7, "validation.completed", {
        result: { id: "val-1", command: "npm test", status: "failed", startedAt: at(7) },
      }, 8),
    ], { now: BASE + 8_000, runStatus: "failed" });

    expect(rows.find((row) => row.role === "builder")).toMatchObject({ phase: "done", detail: "edited 2 files" });
    expect(rows.find((row) => row.role === "validator")).toMatchObject({ phase: "failed", detail: "failed npm test" });
  });

  it("does not render tool-call inputs", () => {
    const rows = deriveAgentActivity([
      runtime(1, "subagent.created", { subagentId: "bee-b", task: { id: "bee-b", role: "builder" } }),
      runtime(2, "subagent.tool_call", {
        subagentId: "bee-b",
        tool: "write_file",
        input: { content: "SECRET_TOKEN_VALUE" },
      }),
    ], { runStatus: "running" });
    expect(rows.find((row) => row.role === "builder")?.detail).toBe("write_file");
    expect(JSON.stringify(rows)).not.toContain("SECRET_TOKEN_VALUE");
  });

  it("ignores events from another session and appends fixer only when it ran", () => {
    const hidden = deriveAgentActivity([
      runtime(1, "plan.created", { summary: "Other session", taskIds: [] }, 1, "ses-other"),
    ], { sessionId: "ses-1" });
    expect(hidden.every((row) => row.detail === "not started")).toBe(true);

    const rows = deriveAgentActivity([
      runtime(1, "subagent.created", { subagentId: "bee-f", task: { id: "bee-f", role: "fixer" } }, 1),
      runtime(2, "subagent.started", { subagentId: "bee-f", attempt: 1 }, 2),
    ], { now: BASE + 5_000, runStatus: "running" });
    expect(rows.map((row) => row.role)).toEqual(["scout", "planner", "builder", "validator", "reviewer", "fixer"]);
    expect(rows.find((row) => row.role === "fixer")).toMatchObject({ phase: "active", detail: "working" });
  });
});

describe("AgentActivity", () => {
  it("renders a log of truthful rows", () => {
    render(<AgentActivity events={[]} now={BASE} />);
    expect(screen.getByRole("log", { name: "Agent activity" })).toBeInTheDocument();
    expect(screen.getByLabelText("Scout: not started")).toBeInTheDocument();
    expect(screen.queryByText(/indexed repository/i)).not.toBeInTheDocument();
  });
});
