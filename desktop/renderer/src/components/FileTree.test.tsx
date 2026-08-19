import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { FileTree } from "./FileTree";

const listing = {
  repositoryRoot: "C:\\HIVE",
  path: "",
  truncated: false,
  entries: [
    { name: "src", path: "src", kind: "dir" as const },
    { name: "README.md", path: "README.md", kind: "file" as const },
  ],
};

describe("FileTree", () => {
  it("renders entries and expands a directory", async () => {
    const onToggleDir = vi.fn();
    const onSelectFile = vi.fn();
    const user = userEvent.setup();
    render(
      <FileTree
        listing={listing}
        listings={{}}
        expanded={{}}
        selectedPath={null}
        onToggleDir={onToggleDir}
        onSelectFile={onSelectFile}
      />,
    );
    expect(screen.getByRole("region", { name: /file tree/i })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /src/i }));
    expect(onToggleDir).toHaveBeenCalledWith("src");
    await user.click(screen.getByRole("button", { name: /README.md/i }));
    expect(onSelectFile).toHaveBeenCalledWith("README.md");
  });
});
