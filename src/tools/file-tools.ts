import fs from "node:fs/promises";
import path from "node:path";
import type { KernelTool, ToolExecutionContext } from "../kernel/types.js";
import { CheckpointManager } from "../kernel/checkpoints.js";

const DENIED_SUBSTRINGS = [".git", "node_modules", ".hivemind", ".env"];

function assertWithinWorkspace(targetPath: string, workspaceRoot: string): string {
  const resolved = path.resolve(workspaceRoot, targetPath);
  const normalizedRoot = path.resolve(workspaceRoot);
  if (!resolved.startsWith(normalizedRoot)) {
    throw new Error(`Access denied: path '${targetPath}' escapes workspace root '${workspaceRoot}'.`);
  }

  const relative = path.relative(normalizedRoot, resolved);
  const parts = relative.split(/[/\\]/);
  for (const part of parts) {
    for (const denied of DENIED_SUBSTRINGS) {
      if (part === denied || (denied.endsWith("*") && part.startsWith(denied.slice(0, -1)))) {
        throw new Error(`Access denied: path '${relative}' contains prohibited segment '${part}'.`);
      }
      if (part.startsWith(".env")) {
        throw new Error(`Access denied: path '${relative}' contains prohibited environment secret file.`);
      }
    }
  }

  return resolved;
}

export const readFileTool: KernelTool = {
  definition: {
    name: "read_file",
    description: "Read the full contents of a file within the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path of the file to read" },
      },
      required: ["path"],
    },
    readOnly: true,
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<string> {
    if (!context.workspaceRoot) throw new Error("A workspace must be open to use read_file.");
    const relPath = String(args.path);
    const fullPath = assertWithinWorkspace(relPath, context.workspaceRoot);

    try {
      const content = await fs.readFile(fullPath, "utf-8");
      return content;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`File not found: ${relPath}`);
      }
      throw err;
    }
  },
};

export const writeFileTool: KernelTool = {
  definition: {
    name: "write_file",
    description: "Write content to a file in the workspace, creating parent directories if needed. Creates a shadow checkpoint.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path of the file to write" },
        content: { type: "string", description: "The content to write into the file" },
      },
      required: ["path", "content"],
    },
    readOnly: false,
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<string> {
    if (!context.workspaceRoot) throw new Error("A workspace must be open to use write_file.");
    const relPath = String(args.path);
    const content = String(args.content);
    const fullPath = assertWithinWorkspace(relPath, context.workspaceRoot);

    // Pre-mutation Shadow Checkpoint
    const checkpoint = await CheckpointManager.capture(
      context.workspaceRoot,
      context.sessionId || "default",
      `Write file ${relPath}`,
      [relPath]
    );
    if (context.recordCheckpoint) {
      await context.recordCheckpoint(checkpoint.description, checkpoint.files);
    }

    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
    return `Successfully wrote ${content.length} characters to ${relPath} (Checkpoint ${checkpoint.id} saved).`;
  },
};

export const editFileTool: KernelTool = {
  definition: {
    name: "edit_file",
    description: "Perform exact search-and-replace edit on a file in the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path of the file to edit" },
        find: { type: "string", description: "Exact text snippet to replace" },
        replace: { type: "string", description: "Replacement text" },
      },
      required: ["path", "find", "replace"],
    },
    readOnly: false,
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<string> {
    if (!context.workspaceRoot) throw new Error("A workspace must be open to use edit_file.");
    const relPath = String(args.path);
    const findText = String(args.find);
    const replaceText = String(args.replace);
    const fullPath = assertWithinWorkspace(relPath, context.workspaceRoot);

    const original = await fs.readFile(fullPath, "utf-8");
    if (!original.includes(findText)) {
      throw new Error(`Target text to replace was not found in ${relPath}.`);
    }

    // Pre-mutation Shadow Checkpoint
    const checkpoint = await CheckpointManager.capture(
      context.workspaceRoot,
      context.sessionId || "default",
      `Edit file ${relPath}`,
      [relPath]
    );
    if (context.recordCheckpoint) {
      await context.recordCheckpoint(checkpoint.description, checkpoint.files);
    }

    const modified = original.replace(findText, replaceText);
    await fs.writeFile(fullPath, modified, "utf-8");
    return `Successfully edited ${relPath} (Checkpoint ${checkpoint.id} saved).`;
  },
};

export const listDirTool: KernelTool = {
  definition: {
    name: "list_dir",
    description: "List directory contents within the workspace.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Relative path of the directory to list (optional, defaults to root)" },
      },
    },
    readOnly: true,
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<string> {
    if (!context.workspaceRoot) throw new Error("A workspace must be open to use list_dir.");
    const relPath = String(args.path || "");
    const fullPath = assertWithinWorkspace(relPath, context.workspaceRoot);

    const entries = await fs.readdir(fullPath, { withFileTypes: true });
    const formatted = entries
      .filter((e) => !DENIED_SUBSTRINGS.includes(e.name))
      .map((e) => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`)
      .join("\n");

    return formatted || "(empty directory)";
  },
};
