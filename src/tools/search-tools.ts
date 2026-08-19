import fs from "node:fs/promises";
import path from "node:path";
import type { KernelTool, ToolExecutionContext } from "../kernel/types.js";

export const grepTool: KernelTool = {
  definition: {
    name: "grep",
    description: "Search for text occurrences across files in the workspace.",
    parameters: {
      type: "object",
      properties: {
        pattern: { type: "string", description: "Search string pattern" },
        path: { type: "string", description: "Subfolder path to search in (optional)" },
      },
      required: ["pattern"],
    },
    readOnly: true,
  },
  async execute(args: Record<string, unknown>, context: ToolExecutionContext): Promise<string> {
    if (!context.workspaceRoot) throw new Error("A workspace must be open to use grep.");
    const pattern = String(args.pattern).toLowerCase();
    const searchSubdir = args.path ? String(args.path) : "";
    const baseDir = path.resolve(context.workspaceRoot, searchSubdir);

    const matches: string[] = [];
    const maxMatches = 50;

    async function walk(dir: string) {
      if (matches.length >= maxMatches) return;
      const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        if (matches.length >= maxMatches) return;
        if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "dist") continue;

        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile()) {
          try {
            const content = await fs.readFile(full, "utf-8");
            const lines = content.split("\n");
            for (let i = 0; i < lines.length; i++) {
              if (lines[i].toLowerCase().includes(pattern)) {
                const rel = path.relative(context.workspaceRoot!, full);
                matches.push(`${rel}:${i + 1}: ${lines[i].trim()}`);
                if (matches.length >= maxMatches) break;
              }
            }
          } catch {
            // Ignore binary/unreadable files
          }
        }
      }
    }

    await walk(baseDir);
    return matches.length > 0 ? matches.join("\n") : `No matches found for '${pattern}'.`;
  },
};
