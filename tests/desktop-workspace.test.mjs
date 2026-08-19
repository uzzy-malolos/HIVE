import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAX_WORKSPACE_LIST_ENTRIES,
  listWorkspaceEntries,
  readWorkspaceFile,
  resolveWorkspacePath,
} from "../dist/desktop/workspace-tree.js";

async function tempRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "hive-workspace-"));
  await writeFile(path.join(root, "README.md"), "# hive\n", "utf8");
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "main.js"), "export default 1;\n", "utf8");
  await mkdir(path.join(root, "node_modules", "left-pad"), { recursive: true });
  await writeFile(path.join(root, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n", "utf8");
  await mkdir(path.join(root, ".git"));
  await writeFile(path.join(root, ".git", "HEAD"), "ref: refs/heads/main\n", "utf8");
  return root;
}

test("listWorkspaceEntries lists root files and skips deny-listed directories", async () => {
  const root = await tempRoot();
  try {
    const listing = await listWorkspaceEntries(root, "");
    const names = listing.entries.map((entry) => entry.name);
    assert.ok(names.includes("README.md"));
    assert.ok(names.includes("src"));
    assert.ok(!names.includes("node_modules"));
    assert.ok(!names.includes(".git"));
    assert.equal(listing.path, "");
    assert.equal(listing.truncated, false);
    const src = listing.entries.find((entry) => entry.name === "src");
    assert.equal(src?.kind, "dir");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listWorkspaceEntries lists a nested directory and refuses escapes", async () => {
  const root = await tempRoot();
  try {
    const listing = await listWorkspaceEntries(root, "src");
    assert.deepEqual(listing.entries.map((entry) => entry.path), ["src/main.js"]);
    await assert.rejects(() => listWorkspaceEntries(root, "../escape"), /outside/);
    assert.equal(resolveWorkspacePath(root, "../escape"), null);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listWorkspaceEntries skips symlinks and deny-listed nested paths", async () => {
  const root = await tempRoot();
  try {
    try {
      await symlink(path.join(root, "README.md"), path.join(root, "linked-readme"));
    } catch {
      // Windows may refuse symlink creation without privilege.
    }
    const listing = await listWorkspaceEntries(root, "");
    assert.ok(!listing.entries.some((entry) => entry.name === "linked-readme"));
    await assert.rejects(() => listWorkspaceEntries(root, "node_modules"), /deny-listed/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("listWorkspaceEntries sets truncated when a directory exceeds the cap", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "hive-workspace-cap-"));
  try {
    for (let index = 0; index < MAX_WORKSPACE_LIST_ENTRIES + 5; index += 1) {
      await writeFile(path.join(root, `file-${String(index).padStart(4, "0")}.txt`), "x\n", "utf8");
    }
    const listing = await listWorkspaceEntries(root, "");
    assert.equal(listing.entries.length, MAX_WORKSPACE_LIST_ENTRIES);
    assert.equal(listing.truncated, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("readWorkspaceFile returns text, language hint, and refuses binary and deny-listed files", async () => {
  const root = await tempRoot();
  try {
    const preview = await readWorkspaceFile(root, "src/main.js");
    assert.equal(preview.path, "src/main.js");
    assert.match(preview.content, /export default 1/);
    assert.equal(preview.languageHint, "js");
    assert.equal(preview.truncated, false);
    await assert.rejects(() => readWorkspaceFile(root, "node_modules/left-pad/index.js"), /deny-listed/);
    await writeFile(path.join(root, "blob.bin"), Buffer.from([0, 1, 2, 3]));
    await assert.rejects(() => readWorkspaceFile(root, "blob.bin"), /binary/);
    await assert.rejects(() => readWorkspaceFile(root, "../secret.txt"), /outside/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
