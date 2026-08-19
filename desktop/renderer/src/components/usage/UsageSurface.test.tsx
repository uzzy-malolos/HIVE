import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UsageSurface } from "./UsageSurface";

describe("UsageSurface", () => {
  it("does not fabricate empty-workspace metrics", () => {
    render(<UsageSurface />);

    expect(screen.getByText("0.00M")).toBeInTheDocument();
    expect(screen.getByText("0 / 30")).toBeInTheDocument();
    expect(screen.getByText("No completed runs")).toBeInTheDocument();
    expect(screen.getByText("Unavailable", { exact: true })).toBeInTheDocument();
    expect(screen.getByText("Model-level usage is not persisted")).toBeInTheDocument();
    expect(screen.getByText(/Unavailable: model-level usage is not persisted/i)).toBeInTheDocument();
    expect(screen.queryByText("Qwen 2.5 Coder")).not.toBeInTheDocument();
  });
});
