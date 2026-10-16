import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CodingFinalReport } from "../../../../../src/coding/types";
import { EvidencePanel } from "./EvidencePanel";

function report(overrides: Partial<CodingFinalReport> = {}): CodingFinalReport {
  return {
    result: "completed",
    subagents: {
      total: 1, active: 0, working: 0, waiting: 0, blocked: 0, done: 1, completed: 1, failed: 0, cancelled: 0, skipped: 0,
    },
    filesChanged: [],
    validation: [],
    review: [],
    outstanding: [],
    completedAt: "2026-08-17T00:00:00.000Z",
    ...overrides,
  };
}

describe("EvidencePanel", () => {
  it("does not invent a passing gate when no report exists", () => {
    render(<EvidencePanel report={null} />);
    expect(screen.getByText("No evidence yet")).toBeInTheDocument();
    expect(screen.queryByText(/112/)).not.toBeInTheDocument();
    expect(screen.queryByText(/GATE PASSED/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/0 ERRORS/i)).not.toBeInTheDocument();
  });

  it("shows the recorded verdict and check statuses", () => {
    render(<EvidencePanel report={report({
      verdict: "REPAIRABLE",
      verdictReasons: ["npm test failed"],
      validation: [
        { label: "npm test", status: "failed" },
        { label: "typecheck", status: "passed" },
      ],
      review: ["Rename the helper"],
      outstanding: ["npm test"],
    })} />);

    expect(screen.getByText("REPAIRABLE")).toBeInTheDocument();
    expect(screen.getByText("npm test failed")).toBeInTheDocument();
    expect(screen.getByText("npm test").closest(".hive-evidence-row")).toHaveTextContent("failed");
    expect(screen.getByText("typecheck").closest(".hive-evidence-row")).toHaveTextContent("passed");
    expect(screen.getByText("Rename the helper")).toBeInTheDocument();
    expect(screen.queryByText(/112/)).not.toBeInTheDocument();
    expect(screen.queryByText(/ISOLATED/i)).not.toBeInTheDocument();
  });

  it("labels a report that has no verdict", () => {
    render(<EvidencePanel report={report()} />);
    expect(screen.getByText("NO VERDICT")).toBeInTheDocument();
    expect(screen.getByText("No checks recorded")).toBeInTheDocument();
    expect(screen.getByText("None recorded")).toBeInTheDocument();
  });
});
