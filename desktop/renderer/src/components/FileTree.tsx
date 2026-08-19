import type { GitFileMark, WorkspaceTreeEntry, WorkspaceTreeListing } from "../../../../src/desktop/types";
import { markCodeForGitXy } from "../git-mark";
import { EmptyState } from "./EmptyState";

export interface FileTreeProps {
  listing: WorkspaceTreeListing | null;
  listings: Record<string, WorkspaceTreeListing>;
  expanded: Record<string, boolean>;
  selectedPath: string | null;
  fileMarks?: GitFileMark[];
  truncated?: boolean;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  onOpenFile?: (path: string) => void;
}

function badgeFor(path: string, fileMarks?: GitFileMark[]): string | null {
  const mark = fileMarks?.find((entry) => entry.path.replaceAll("\\", "/") === path);
  if (!mark) return null;
  const code = markCodeForGitXy(mark.code);
  return code === "." ? null : code;
}

function TreeRows({
  entries,
  listings,
  expanded,
  selectedPath,
  fileMarks,
  depth,
  onToggleDir,
  onSelectFile,
  onOpenFile,
}: {
  entries: WorkspaceTreeEntry[];
  listings: Record<string, WorkspaceTreeListing>;
  expanded: Record<string, boolean>;
  selectedPath: string | null;
  fileMarks?: GitFileMark[];
  depth: number;
  onToggleDir: (path: string) => void;
  onSelectFile: (path: string) => void;
  onOpenFile?: (path: string) => void;
}) {
  return (
    <ul className="file-tree-list" style={{ paddingLeft: depth === 0 ? 0 : 12 }}>
      {entries.map((entry) => {
        const isDir = entry.kind === "dir";
        const isOpen = Boolean(expanded[entry.path]);
        const badge = badgeFor(entry.path, fileMarks);
        const selected = selectedPath === entry.path;
        return (
          <li key={entry.path}>
            <button
              type="button"
              className={`file-tree-row${selected ? " is-selected" : ""}`}
              aria-expanded={isDir ? isOpen : undefined}
              aria-current={selected ? "true" : undefined}
              onClick={() => (isDir ? onToggleDir(entry.path) : onSelectFile(entry.path))}
              onDoubleClick={() => {
                if (!isDir) onOpenFile?.(entry.path);
              }}
            >
              <span className="file-tree-chevron" aria-hidden="true">{isDir ? (isOpen ? "▾" : "▸") : "·"}</span>
              <span className="file-tree-name">{entry.name}</span>
              {badge && <span className={`file-tree-badge badge-${badge}`}>{badge}</span>}
            </button>
            {isDir && isOpen && listings[entry.path] && (
              <TreeRows
                entries={listings[entry.path].entries}
                listings={listings}
                expanded={expanded}
                selectedPath={selectedPath}
                fileMarks={fileMarks}
                depth={depth + 1}
                onToggleDir={onToggleDir}
                onSelectFile={onSelectFile}
                onOpenFile={onOpenFile}
              />
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function FileTree({
  listing,
  listings,
  expanded,
  selectedPath,
  fileMarks,
  truncated,
  onToggleDir,
  onSelectFile,
  onOpenFile,
}: FileTreeProps) {
  return (
    <section className="workbench-panel file-tree-panel" aria-label="File tree">
      <div className="workbench-panel-header">
        <strong>File Tree</strong>
        {truncated && <span className="file-tree-truncated">truncated</span>}
      </div>
      <div className="workbench-panel-body">
        {!listing ? (
          <EmptyState>Open a workspace to browse files.</EmptyState>
        ) : listing.entries.length === 0 ? (
          <EmptyState>No files in this folder.</EmptyState>
        ) : (
          <TreeRows
            entries={listing.entries}
            listings={listings}
            expanded={expanded}
            selectedPath={selectedPath}
            fileMarks={fileMarks}
            depth={0}
            onToggleDir={onToggleDir}
            onSelectFile={onSelectFile}
            onOpenFile={onOpenFile}
          />
        )}
      </div>
    </section>
  );
}
