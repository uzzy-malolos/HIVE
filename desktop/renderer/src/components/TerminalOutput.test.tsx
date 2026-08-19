import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TerminalOutput } from "./TerminalOutput";

describe("TerminalOutput", () => {
  it("shows empty copy with no events", () => {
    render(<TerminalOutput events={[]} />);
    expect(screen.getByText(/no run output yet/i)).toBeInTheDocument();
  });

  it("formats command output events", () => {
    render(
      <TerminalOutput
        events={[
          {
            schemaVersion: 1,
            id: "e1",
            sequence: 1,
            sessionId: "s1",
            timestamp: "2026-08-17T00:00:00.000Z",
            type: "command.started",
            payload: { commandId: "c1", command: "npm test", cwd: "C:\\HIVE" },
          },
          {
            schemaVersion: 1,
            id: "e2",
            sequence: 2,
            sessionId: "s1",
            timestamp: "2026-08-17T00:00:00.000Z",
            type: "command.output",
            payload: { commandId: "c1", stream: "stdout", chunk: "ok" },
          },
        ]}
      />,
    );
    expect(screen.getByRole("log")).toHaveTextContent("$ npm test");
    expect(screen.getByRole("log")).toHaveTextContent("ok");
  });
});
