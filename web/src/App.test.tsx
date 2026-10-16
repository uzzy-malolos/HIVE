import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { COMMERCIAL_ENTITLEMENTS } from "../../src/commercial/contracts";
import { App } from "./App";

describe("workspace home screen", () => {
  it("renders the local control-plane preview", () => {
    render(<App />);

    expect(screen.getByRole("heading", { name: "Workspace" })).toBeInTheDocument();
    expect(screen.getByText("HiveChat")).toBeInTheDocument();
    expect(screen.getByText("Hive Code")).toBeInTheDocument();
    expect(screen.getByText("hive push --confirmed")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Sign in" })).toBeDisabled();

    const cloudSessions = screen.getByTestId("entitlement-cloud_sessions");
    expect(within(cloudSessions).getByText("cloud_sessions")).toBeInTheDocument();
    expect(within(cloudSessions).getByText("Not connected")).toBeInTheDocument();

    expect(screen.getByTestId("boundary-authentication")).toHaveTextContent("Not connected");
    expect(screen.getByTestId("boundary-billing")).toHaveTextContent("Not connected");
    expect(screen.getByTestId("boundary-metering")).toHaveTextContent("Measured usage is unavailable");
    expect(screen.getByTestId("boundary-cloud_execution")).toHaveTextContent("Not connected");
    expect(screen.getAllByRole("row")).toHaveLength(COMMERCIAL_ENTITLEMENTS.length + 1);
    expect(document.body.textContent).not.toMatch(/\$[0-9]|USD|EUR/);
  });
});
