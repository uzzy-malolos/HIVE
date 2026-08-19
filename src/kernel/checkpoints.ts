import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";
import type { KernelCheckpoint, KernelCheckpointFile } from "./types.js";

export class CheckpointManager {
  /**
   * Capture file states before mutation to create a shadow checkpoint.
   */
  public static async capture(
    workspaceRoot: string,
    sessionId: string,
    description: string,
    relativePaths: string[]
  ): Promise<KernelCheckpoint> {
    const files: KernelCheckpointFile[] = [];

    for (const relPath of relativePaths) {
      const fullPath = path.resolve(workspaceRoot, relPath);
      let beforeContent: string | null = null;

      try {
        beforeContent = await fs.readFile(fullPath, "utf-8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          throw err;
        }
      }

      files.push({
        relativePath: relPath,
        beforeContent,
      });
    }

    return {
      id: `chk_${Date.now()}_${crypto.randomBytes(4).toString("hex")}`,
      sessionId,
      timestamp: new Date().toISOString(),
      description,
      files,
    };
  }

  /**
   * Restore files on disk to their pre-mutation state.
   */
  public static async rewind(workspaceRoot: string, checkpoint: KernelCheckpoint): Promise<string[]> {
    const restoredPaths: string[] = [];

    for (const file of checkpoint.files) {
      const fullPath = path.resolve(workspaceRoot, file.relativePath);

      if (file.beforeContent === null) {
        // File did not exist before — remove it
        try {
          await fs.unlink(fullPath);
          restoredPaths.push(file.relativePath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      } else {
        // Restore previous content
        await fs.mkdir(path.dirname(fullPath), { recursive: true });
        await fs.writeFile(fullPath, file.beforeContent, "utf-8");
        restoredPaths.push(file.relativePath);
      }
    }

    return restoredPaths;
  }
}
