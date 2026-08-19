import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { readFileTool, writeFileTool, editFileTool, listDirTool } from "../dist/tools/file-tools.js";
import { CheckpointManager } from "../dist/kernel/checkpoints.js";

test("Kernel file tools: jailed path enforcement", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hive-kernel-test-"));
  try {
    const ctx = {
      workspaceRoot: tmpDir,
      surface: "codex",
      posture: "auto",
    };

    // Writing a valid file
    await writeFileTool.execute({ path: "src/index.ts", content: "console.log('hello');" }, ctx);
    const read = await readFileTool.execute({ path: "src/index.ts" }, ctx);
    assert.equal(read, "console.log('hello');");

    // Editing the file
    await editFileTool.execute({ path: "src/index.ts", find: "hello", replace: "world" }, ctx);
    const updated = await readFileTool.execute({ path: "src/index.ts" }, ctx);
    assert.equal(updated, "console.log('world');");

    // Listing directory
    const list = await listDirTool.execute({ path: "src" }, ctx);
    assert.ok(list.includes("index.ts"));

    // Directory escape attempt
    await assert.rejects(
      async () => readFileTool.execute({ path: "../../secret.txt" }, ctx),
      /escapes workspace root/
    );

    // .env secret access attempt
    await assert.rejects(
      async () => writeFileTool.execute({ path: ".env", content: "SECRET=123" }, ctx),
      /prohibited environment secret file/
    );
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});

test("Kernel checkpoints: capture and rewind restoration on disk", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hive-chk-test-"));
  try {
    const filePath = "app.txt";
    const fullPath = path.join(tmpDir, filePath);
    await fs.writeFile(fullPath, "Initial state");

    // Capture checkpoint before editing
    const checkpoint = await CheckpointManager.capture(tmpDir, "ses-1", "Edit app.txt", [filePath]);
    assert.equal(checkpoint.files[0].beforeContent, "Initial state");

    // Mutate file
    await fs.writeFile(fullPath, "Mutated broken state");
    assert.equal(await fs.readFile(fullPath, "utf-8"), "Mutated broken state");

    // Rewind
    const restored = await CheckpointManager.rewind(tmpDir, checkpoint);
    assert.deepEqual(restored, [filePath]);
    assert.equal(await fs.readFile(fullPath, "utf-8"), "Initial state");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
