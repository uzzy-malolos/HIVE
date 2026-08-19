import type { DesktopChangesDiff, WorkspaceFilePreview } from "../../../../src/desktop/types";
import { ChangesView } from "./ChangesView";
import { EmptyState } from "./EmptyState";

export interface CodePreviewProps {
  file: WorkspaceFilePreview | null;
  diff: DesktopChangesDiff | null;
  selectedPath: string | null;
  hasWorkspace?: boolean;
  onOpenReport?: () => void;
  onPreviewGit?: (action: "commit" | "discard" | "push" | "pull-request") => void;
}

function filterPatch(patch: string, selectedPath: string): string | null {
  const chunks = patch.split(/(?=^diff --git )/m).filter(Boolean);
  const match = chunks.find((chunk) => chunk.includes(` b/${selectedPath}`) || chunk.includes(` b/${selectedPath.replaceAll("\\", "/")}`));
  return match ?? null;
}

export function CodePreview({ file, diff, selectedPath, hasWorkspace = false, onOpenReport, onPreviewGit }: CodePreviewProps) {
  const filtered = selectedPath && diff?.patch ? filterPatch(diff.patch, selectedPath) : null;
  const showDiff = Boolean(filtered);

  return (
    <section className="workbench-panel code-preview-panel" aria-label="Code preview">
      <div className="workbench-panel-header">
        <strong>Code Preview</strong>
        {selectedPath && <span className="code-preview-path">{selectedPath}</span>}
        <div className="pane-actions">
          {onOpenReport && (
            <button type="button" className="pane-action-btn" onClick={onOpenReport}>
              Report
            </button>
          )}
          {onPreviewGit && (
            <button type="button" className="pane-action-btn" onClick={() => onPreviewGit("commit")}>
              Commit
            </button>
          )}
        </div>
      </div>
      <div className="workbench-panel-body code-preview-body">
        {showDiff && filtered ? (
          <ChangesView patch={filtered} truncated={diff?.truncated} />
        ) : file ? (
          <pre className="file-preview-source">
            <code>{file.content}</code>
          </pre>
        ) : (
          <EmptyState>
            <strong>{hasWorkspace ? "No file selected." : "Open a repository to begin."}</strong>
            <span>{hasWorkspace ? "Choose a file in the tree to preview it." : "HIVE keeps threads and isolated worktrees with the project."}</span>
          </EmptyState>
        )}
      </div>
    </section>
  );
}
