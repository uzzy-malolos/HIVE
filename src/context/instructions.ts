import fs from "node:fs/promises";
import path from "node:path";

export async function loadWorkspaceInstructions(workspaceRoot: string): Promise<string | null> {
  const possibleNames = ["AGENTS.md", "HIVE.md", ".claude/CLAUDE.md", "CLAUDE.md"];
  const instructions: string[] = [];

  for (const name of possibleNames) {
    const fullPath = path.resolve(workspaceRoot, name);
    try {
      const content = await fs.readFile(fullPath, "utf-8");
      if (content.trim()) {
        instructions.push(`--- Instructions from ${name} ---\n${content.trim()}`);
      }
    } catch {
      // Ignore missing files
    }
  }

  return instructions.length > 0 ? instructions.join("\n\n") : null;
}
