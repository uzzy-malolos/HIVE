import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { CHECKPOINT_FILE_LIMIT, extractPatchPaths, projectPatch } from "../dist/coding/patch-projection.js";

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-patch-projection-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const stage = path.join(root, ".hivemind", "checkpoints", "session-1", `.projection-${randomUUID()}`);
  await fs.mkdir(stage, { recursive: true });
  return { root, stage };
}

function patch(file, before, after) {
  const oldLines = before === null ? [] : before.slice(0, -1).split("\n");
  const newLines = after === null ? [] : after.slice(0, -1).split("\n");
  return [
    `diff --git a/${file} b/${file}`,
    ...(before === null ? ["new file mode 100644"] : after === null ? ["deleted file mode 100644"] : []),
    before === null ? "--- /dev/null" : `--- a/${file}`,
    after === null ? "+++ /dev/null" : `+++ b/${file}`,
    `@@ -${before === null ? 0 : 1},${oldLines.length} +${after === null ? 0 : 1},${newLines.length} @@`,
    ...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`), "",
  ].join("\n");
}

test("patch paths distinguish hunk content from file and metadata headers", () => {
  const text = patch("actual.txt", "-- a/removed-looking.txt\nGIT binary patch\n", "++ b/added-looking.txt\nnew file mode 120000\n");
  assert.deepEqual(extractPatchPaths(text), ["actual.txt"]);
  assert.deepEqual(extractPatchPaths(`${text}${patch("next.txt", null, "next\n")}`), ["actual.txt", "next.txt"]);
});

test("quoted Git paths preserve spaces and decode UTF-8 octal bytes", () => {
  assert.deepEqual(extractPatchPaths('diff --git "a/space name.txt" "b/space name.txt"\n'), ["space name.txt"]);
  assert.deepEqual(extractPatchPaths('diff --git "a/caf\\303\\251.txt" "b/caf\\303\\251.txt"\n'), ["café.txt"]);
  assert.throws(() => extractPatchPaths('diff --git "a/\\377.txt" "b/\\377.txt"\n'), /UTF-8/);
});

test("real Git diffs of unquoted filenames with spaces project exact file bytes", async (t) => {
  const { root, stage } = await workspace(t);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  const files = ["space name.txt", "folder b/other name.txt"];
  for (const file of files) { await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true }); await fs.writeFile(path.join(root, file), "before\n"); }
  execFileSync("git", ["add", "--", ...files], { cwd: root });
  for (const file of files) await fs.writeFile(path.join(root, file), "after\n");
  const text = execFileSync("git", ["-c", "core.autocrlf=false", "diff", "--", ...files], { cwd: root, encoding: "utf8" });
  assert.match(text, /diff --git a\/space name.txt b\/space name.txt/);
  assert.deepEqual(extractPatchPaths(text).sort(), files.sort());
  const outputs = await projectPatch(new Map(files.map((file) => [file, Buffer.from("before\n")])), text, stage);
  for (const file of files) assert.deepEqual(outputs.get(file), Buffer.from("after\n"));
});

test("real binary, symbolic-link, traversal, and incomplete hunk inputs are rejected", () => {
  for (const metadata of ["GIT binary patch", "new file mode 120000", "new file mode 160000", "new mode 120000"]) {
    assert.throws(() => extractPatchPaths(`diff --git a/file.txt b/file.txt\n${metadata}\n`), /not supported/);
  }
  assert.throws(() => extractPatchPaths("diff --git a/../escape.txt b/../escape.txt\n"), /unsafe/);
  assert.throws(() => extractPatchPaths("--- a/file.txt\n+++ b/file.txt\n@@ -1,2 +1,2 @@\n only one\n"), /incomplete/);
});

test("projection returns exact created, changed, and deleted bytes without touching the workspace", async (t) => {
  const { root, stage } = await workspace(t);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  await fs.writeFile(path.join(root, "actual.txt"), "workspace stays unchanged\n");
  const before = "-- a/removed-looking.txt\nGIT binary patch\n";
  const after = "++ b/added-looking.txt\nnew file mode 120000\n";
  const originals = new Map([["actual.txt", Buffer.from(before)], ["created.txt", null], ["gone.txt", Buffer.from("remove\n")]]);
  const text = `${patch("actual.txt", before, after)}${patch("created.txt", null, "created\n")}${patch("gone.txt", "remove\n", null)}`;
  const outputs = await projectPatch(originals, text, stage);
  assert.deepEqual([...outputs.keys()], [...originals.keys()]);
  assert.deepEqual(outputs.get("actual.txt"), Buffer.from(after));
  assert.deepEqual(outputs.get("created.txt"), Buffer.from("created\n"));
  assert.equal(outputs.get("gone.txt"), null);
  assert.equal(await fs.readFile(path.join(root, "actual.txt"), "utf8"), "workspace stays unchanged\n");
  await assert.rejects(fs.stat(path.join(root, "created.txt")), { code: "ENOENT" });
});

test("projection measures each file output instead of adding all patch growth to every file", async (t) => {
  const { stage } = await workspace(t);
  const before = `${"a".repeat(1024 * 1024 - 1)}\n`;
  const after = `${"b".repeat(1792 * 1024 - 1)}\n`;
  const originals = new Map([["a.txt", Buffer.from(before)], ["b.txt", Buffer.from(before)]]);
  const outputs = await projectPatch(originals, `${patch("a.txt", before, after)}${patch("b.txt", before, after)}`, stage);
  assert.equal(outputs.get("a.txt").length, 1792 * 1024);
  assert.equal(outputs.get("b.txt").length, 1792 * 1024);
});

test("header-looking additions cannot evade the exact 2 MiB output bound", async (t) => {
  const { root, stage } = await workspace(t);
  const line = "++ b/new.txt\n";
  const after = line.repeat(Math.floor(CHECKPOINT_FILE_LIMIT / Buffer.byteLength(line)) + 1);
  const text = patch("new.txt", null, after);
  assert.deepEqual(extractPatchPaths(text), ["new.txt"]);
  await assert.rejects(projectPatch(new Map([["new.txt", null]]), text, stage), /2 MiB/);
  await assert.rejects(fs.stat(path.join(root, "new.txt")), { code: "ENOENT" });
});

test("exact before and after bytes share the 8 MiB snapshot budget", async (t) => {
  const { stage } = await workspace(t);
  const before = `${"a".repeat(1536 * 1024 - 1)}\n`;
  const after = `b${before.slice(1)}`;
  const files = ["a.txt", "b.txt", "c.txt"];
  const originals = new Map(files.map((file) => [file, Buffer.from(before)]));
  await assert.rejects(projectPatch(originals, files.map((file) => patch(file, before, after)).join(""), stage), /8 MiB/);
});

test("undeclared paths and oversized originals are rejected before staging writes", async (t) => {
  const { stage } = await workspace(t);
  await assert.rejects(projectPatch(new Map([["allowed.txt", null]]), patch("other.txt", null, "other\n"), stage), /outside its declared/);
  await assert.rejects(projectPatch(new Map([["allowed.txt", Buffer.alloc(CHECKPOINT_FILE_LIMIT + 1)]]), patch("allowed.txt", null, "other\n"), stage), /2 MiB/);
  assert.deepEqual(await fs.readdir(stage), []);
});

test("projection ignores inherited Git repository overrides", async (t) => {
  const { root, stage } = await workspace(t);
  const previousDirectory = process.env.GIT_DIR;
  const previousWorktree = process.env.GIT_WORK_TREE;
  process.env.GIT_DIR = path.join(root, "nonexistent-repository");
  process.env.GIT_WORK_TREE = root;
  try {
    const outputs = await projectPatch(new Map([["new.txt", null]]), patch("new.txt", null, "created\n"), stage);
    assert.deepEqual(outputs.get("new.txt"), Buffer.from("created\n"));
    await assert.rejects(fs.stat(path.join(root, "new.txt")), { code: "ENOENT" });
  } finally {
    if (previousDirectory === undefined) delete process.env.GIT_DIR; else process.env.GIT_DIR = previousDirectory;
    if (previousWorktree === undefined) delete process.env.GIT_WORK_TREE; else process.env.GIT_WORK_TREE = previousWorktree;
  }
});

test("Git failures do not expose searched patch content", async (t) => {
  const { stage } = await workspace(t);
  const privateFixture = "PRIVATE_PATCH_FIXTURE_SHOULD_NOT_APPEAR";
  await assert.rejects(projectPatch(new Map([["file.txt", Buffer.from("different\n")]]), patch("file.txt", `${privateFixture}\n`, "after\n"), stage), (error) => {
    assert.match(error.message, /Patch projection failed/);
    assert.equal(error.message.includes(privateFixture), false);
    return true;
  });
});
