import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { CheckpointStore, CHECKPOINT_FILE_LIMIT } from "../dist/coding/checkpoints.js";
import { RepositoryToolService } from "../dist/coding/tools.js";

async function workspace(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-checkpoints-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const checkpointDirectory = (root, id) => path.join(root, ".hivemind", "checkpoints", "session-1", id);
async function writeCheckpoint(store, root, files) {
  await store.runWrite(Object.keys(files), "write_file", async () => {
    for (const [name, content] of Object.entries(files)) await fs.writeFile(path.join(root, name), content);
  }, Object.values(files));
  return (await store.list())[0];
}

test("listing a new checkpoint store is read-only", async (t) => {
  const root = await workspace(t);
  assert.deepEqual(await new CheckpointStore(root, "session-1").list(), []);
  assert.deepEqual(await fs.readdir(root), []);
  assert.throws(() => new CheckpointStore(root, "../outside"), /safe session/);
});

test("built-in create, write, and edit produce private checkpoints and restore exact prior bytes", async (t) => {
  const root = await workspace(t);
  const events = [];
  const tools = new RepositoryToolService({ repositoryRoot: root, sessionId: "session-1", approvalPolicy: "changes", fileScope: ["file.txt"], onEvent: (event) => events.push(event) });
  const store = new CheckpointStore(root, "session-1");
  await tools.createFile("file.txt", "private fixture body\r\n");
  const created = (await store.list())[0];
  await tools.writeFile("file.txt", "second body\r\n");
  const written = (await store.list()).find((entry) => entry.operation === "write_file");
  await tools.editFile("file.txt", "second", "third");
  const edited = (await store.list()).find((entry) => entry.operation === "edit_file");
  assert.equal((await store.list()).length, 3);
  assert.equal(JSON.stringify(events).includes("private fixture body"), false);
  for (const checkpoint of [edited, written, created]) {
    const preview = await store.preview(checkpoint.id);
    assert.equal(preview.restorable, true);
    assert.equal(JSON.stringify(preview).includes("private fixture body"), false);
    assert.equal(typeof preview.confirmationToken, "string");
    const result = await new CheckpointStore(root, "session-1").restore(checkpoint.id, preview.confirmationToken);
    assert.deepEqual(result, { id: checkpoint.id, restoredPaths: ["file.txt"], invalidatesEvidence: true });
    assert.equal((await store.preview(checkpoint.id)).restorable, false);
  }
  await assert.rejects(fs.stat(path.join(root, "file.txt")), { code: "ENOENT" });
});

test("byte snapshots preserve binary data, BOM, and line endings", async (t) => {
  const root = await workspace(t);
  const before = Buffer.from([0xef, 0xbb, 0xbf, 0x61, 13, 10, 0, 0xff, 1]);
  await fs.writeFile(path.join(root, "data.bin"), before);
  const store = new CheckpointStore(root, "session-1");
  const entry = await writeCheckpoint(store, root, { "data.bin": Buffer.from([0, 1, 2, 3]) });
  const preview = await store.preview(entry.id);
  assert.equal(preview.paths[0].targetHash, hash(before));
  await store.restore(entry.id, preview.confirmationToken);
  assert.deepEqual(await fs.readFile(path.join(root, "data.bin")), before);
});

test("repository tools cannot expose private snapshot bytes or manifest records to provider context", async (t) => {
  const root = await workspace(t);
  const tools = new RepositoryToolService({ repositoryRoot: root, sessionId: "session-1", approvalPolicy: "changes", fileScope: ["a.txt"] });
  await tools.createFile("a.txt", "private fixture body");
  const [entry] = await new CheckpointStore(root, "session-1").list();
  const relative = `.hivemind/checkpoints/session-1/${entry.id}/manifest.json`;
  await assert.rejects(tools.readFile(relative), /snapshots are private/);
  await assert.rejects(tools.listDirectory(`.hivemind/checkpoints/session-1/${entry.id}`), /snapshots are private/);
  try { await fs.symlink(checkpointDirectory(root, entry.id), path.join(root, "checkpoint-alias"), "junction"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) return; throw error; }
  await assert.rejects(tools.readFile("checkpoint-alias/manifest.json"), /snapshots are private/);
});

test("a multi-file patch checkpoints modifications, creation, and deletion as one operation", async (t) => {
  const root = await workspace(t);
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  await fs.writeFile(path.join(root, "a.txt"), "old\n");
  await fs.writeFile(path.join(root, "gone.txt"), "remove\n");
  const tools = new RepositoryToolService({ repositoryRoot: root, sessionId: "session-1", approvalPolicy: "changes", fileScope: ["a.txt", "new.txt", "gone.txt"] });
  await tools.applyPatch([
    "diff --git a/a.txt b/a.txt", "--- a/a.txt", "+++ b/a.txt", "@@ -1 +1 @@", "-old", "+new",
    "diff --git a/new.txt b/new.txt", "new file mode 100644", "--- /dev/null", "+++ b/new.txt", "@@ -0,0 +1 @@", "+created",
    "diff --git a/gone.txt b/gone.txt", "deleted file mode 100644", "--- a/gone.txt", "+++ /dev/null", "@@ -1 +0,0 @@", "-remove", "",
  ].join("\n"));
  const store = new CheckpointStore(root, "session-1");
  const [entry] = await store.list();
  assert.equal(entry.operation, "apply_patch");
  const preview = await store.preview(entry.id);
  assert.deepEqual(preview.paths.map((file) => [file.path, file.action]), [["a.txt", "restore"], ["new.txt", "delete"], ["gone.txt", "recreate"]]);
  await store.restore(entry.id, preview.confirmationToken);
  assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "old\n");
  assert.equal(await fs.readFile(path.join(root, "gone.txt"), "utf8"), "remove\n");
  await assert.rejects(fs.stat(path.join(root, "new.txt")), { code: "ENOENT" });
});

test("newer edits reject the whole restore before any file is changed", async (t) => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, "a.txt"), "a-before");
  await fs.writeFile(path.join(root, "b.txt"), "b-before");
  const store = new CheckpointStore(root, "session-1");
  const entry = await writeCheckpoint(store, root, { "a.txt": "a-after", "b.txt": "b-after" });
  const preview = await store.preview(entry.id);
  await fs.writeFile(path.join(root, "b.txt"), "new user edit");
  assert.equal((await store.preview(entry.id)).restorable, false);
  await assert.rejects(store.restore(entry.id, preview.confirmationToken), /cannot be restored/);
  assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "a-after");
  assert.equal(await fs.readFile(path.join(root, "b.txt"), "utf8"), "new user edit");
});

test("restore requires the exact preview token and deletes only unchanged files created by this checkpoint", async (t) => {
  const root = await workspace(t);
  const store = new CheckpointStore(root, "session-1");
  const entry = await writeCheckpoint(store, root, { "created.txt": "created" });
  await fs.writeFile(path.join(root, "unrelated.txt"), "preserve");
  await assert.rejects(store.restore(entry.id, "0".repeat(64)), /exact preview confirmation token/);
  const preview = await store.preview(entry.id);
  await store.restore(entry.id, preview.confirmationToken);
  assert.equal(await fs.readFile(path.join(root, "unrelated.txt"), "utf8"), "preserve");
});

test("corrupt snapshots and malicious manifest paths cannot touch workspace files", async (t) => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, "a.txt"), "before");
  const store = new CheckpointStore(root, "session-1");
  const entry = await writeCheckpoint(store, root, { "a.txt": "after" });
  const directory = checkpointDirectory(root, entry.id);
  await fs.writeFile(path.join(directory, `${hash("before")}.bin`), "tamper");
  assert.equal((await store.preview(entry.id)).restorable, false);
  await assert.rejects(store.restore(entry.id, "0".repeat(64)), /cannot be restored/);
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.files[0].path = "../outside.txt";
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(store.preview(entry.id), /unsafe/);
  assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "after");
});

test("checkpoint writes reject traversal, metadata, sensitive files, and unsupported path spellings before mutation", async (t) => {
  const root = await workspace(t);
  const store = new CheckpointStore(root, "session-1");
  for (const file of ["../escape.txt", ".git/config", ".hivemind/sessions/record.json", ".env", "credentials.json", "secrets.json", "folder/../file.txt", "file.txt:stream", "file.txt."]) {
    await assert.rejects(store.runWrite([file], "write_file", async () => assert.fail("Unsafe write ran"), ["fixture"]), /unsafe|workspace-relative/);
  }
  assert.deepEqual(await fs.readdir(root), []);
});

test("declared source helpers and design tokens remain writable and checkpointed", async (t) => {
  const root = await workspace(t);
  const files = ["src/styles/tokens.css", "src/credentials.ts", "src/parser/tokens.ts", "src/tokens/colors.ts", "src/credentials/index.ts"];
  const tools = new RepositoryToolService({ repositoryRoot: root, sessionId: "session-1", approvalPolicy: "changes", fileScope: files });
  for (const file of files) await tools.createFile(file, "ordinary declared source\n");
  const entries = await new CheckpointStore(root, "session-1").list();
  assert.equal(entries.length, files.length);
  assert.deepEqual(entries.flatMap((entry) => entry.paths).sort(), [...files].sort());
  await assert.rejects(tools.createFile("secrets.json", "{}", { fileScope: ["secrets.json"] }), /sensitive/);
});

test("checkpoint writes reject oversized files and batches before mutation", async (t) => {
  const root = await workspace(t);
  const store = new CheckpointStore(root, "session-1");
  await assert.rejects(store.runWrite(["large.txt"], "create_file", async () => assert.fail("Oversized write ran"), ["a".repeat(CHECKPOINT_FILE_LIMIT + 1)]), /limit/);
  const names = ["a.bin", "b.bin", "c.bin", "d.bin", "e.bin"];
  for (const name of names) await fs.writeFile(path.join(root, name), Buffer.alloc(CHECKPOINT_FILE_LIMIT));
  await assert.rejects(store.runWrite(names, "write_file", async () => assert.fail("Oversized batch ran"), names.map(() => "")), /8 MiB/);
});

test("symlink targets, symlink parents, and symlink checkpoint storage are rejected", async (t) => {
  const root = await workspace(t);
  const outside = await workspace(t);
  await fs.writeFile(path.join(outside, "file.txt"), "outside");
  try { await fs.symlink(outside, path.join(root, "alias"), "junction"); }
  catch (error) { if (["EPERM", "EACCES"].includes(error.code)) { t.skip("Host disallows symlinks"); return; } throw error; }
  const store = new CheckpointStore(root, "session-1");
  await assert.rejects(store.runWrite(["alias/file.txt"], "write_file", async () => assert.fail("Symlink write ran"), ["fixture"]), /symbolic/);
  await fs.symlink(outside, path.join(root, ".hivemind"), "junction");
  await assert.rejects(store.runWrite(["new.txt"], "write_file", async () => assert.fail("Unsafe metadata write ran"), ["fixture"]), /symbolic/);
  assert.equal(await fs.readFile(path.join(outside, "file.txt"), "utf8"), "outside");
});

test("partial failed writes remain explicit, restorable checkpoints", async (t) => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, "a.txt"), "before");
  const store = new CheckpointStore(root, "session-1");
  await assert.rejects(store.runWrite(["a.txt"], "write_file", async () => {
    await fs.writeFile(path.join(root, "a.txt"), "partial");
    throw new Error("Fixture mutation failed");
  }, ["partial"]), /Fixture mutation failed/);
  const [entry] = await store.list();
  assert.equal(entry.status, "failed");
  const preview = await store.preview(entry.id);
  await store.restore(entry.id, preview.confirmationToken);
  assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "before");
});

test("checkpoint recording failure preserves a completed write and an explicit recovery manifest", async (t) => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, "a.txt"), "before");
  const store = new CheckpointStore(root, "session-1");
  const originalRename = fs.rename.bind(fs);
  let saves = 0;
  t.mock.method(fs, "rename", async (source, target) => {
    if (target.endsWith("manifest.json") && ++saves === 3) throw new Error("Fixture checkpoint commit failure");
    return originalRename(source, target);
  });
  await assert.rejects(writeCheckpoint(store, root, { "a.txt": "after" }), /Write completed.*needs recovery/);
  assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "after");
  const [entry] = await store.list();
  assert.equal(entry.status, "recovery-required");
  assert.equal((await store.preview(entry.id)).restorable, false);
  assert.equal(await fs.readFile(path.join(checkpointDirectory(root, entry.id), `${hash("before")}.bin`), "utf8"), "before");
});

test("a failure midway through restore rolls earlier files back to their after snapshots", async (t) => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, "a.txt"), "a-before");
  await fs.writeFile(path.join(root, "b.txt"), "b-before");
  const store = new CheckpointStore(root, "session-1");
  const entry = await writeCheckpoint(store, root, { "a.txt": "a-after", "b.txt": "b-after" });
  const preview = await store.preview(entry.id);
  const originalLink = fs.link.bind(fs);
  let failed = false;
  t.mock.method(fs, "link", async (source, target) => {
    if (!failed && path.basename(source).startsWith("restore-") && target === path.join(root, "b.txt")) { failed = true; throw new Error("Fixture restore failure"); }
    return originalLink(source, target);
  });
  await assert.rejects(store.restore(entry.id, preview.confirmationToken), /were rolled back/);
  assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "a-after");
  assert.equal(await fs.readFile(path.join(root, "b.txt"), "utf8"), "b-after");
  assert.equal((await store.preview(entry.id)).restorable, true);
});

test("failed rollback preserves newer edits and marks the durable manifest for manual recovery", async (t) => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, "a.txt"), "a-before");
  await fs.writeFile(path.join(root, "b.txt"), "b-before");
  const store = new CheckpointStore(root, "session-1");
  const entry = await writeCheckpoint(store, root, { "a.txt": "a-after", "b.txt": "b-after" });
  const preview = await store.preview(entry.id);
  const originalLink = fs.link.bind(fs);
  t.mock.method(fs, "link", async (source, target) => {
    if (path.basename(source).startsWith("restore-") && target === path.join(root, "b.txt")) {
      await fs.writeFile(path.join(root, "a.txt"), "new user edit");
      throw new Error("Fixture restore failure with concurrent edit");
    }
    return originalLink(source, target);
  });
  await assert.rejects(store.restore(entry.id, preview.confirmationToken), /manual recovery/);
  assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "new user edit");
  assert.equal((await store.list())[0].status, "recovery-required");
});

test("concurrent edits after a tool write never become checkpoint-owned output", async (t) => {
  const root = await workspace(t);
  const target = path.join(root, "a.txt");
  await fs.writeFile(target, "before");
  const store = new CheckpointStore(root, "session-1");
  const originalOpen = fs.open.bind(fs);
  let mutated = false;
  let injected = false;
  t.mock.method(fs, "open", async (file, ...args) => {
    if (file === target && mutated && !injected) { injected = true; await fs.writeFile(target, "newer!"); }
    return originalOpen(file, ...args);
  });
  await assert.rejects(store.runWrite(["a.txt"], "write_file", async () => {
    await fs.writeFile(target, "after!"); mutated = true;
  }, ["after!"]), /needs recovery/);
  const [entry] = await store.list();
  assert.equal(entry.status, "recovery-required");
  assert.equal((await store.preview(entry.id)).restorable, false);
  assert.equal(await fs.readFile(target, "utf8"), "newer!");
});

test("a newer edit in the final restore replacement gap is preserved", async (t) => {
  const root = await workspace(t);
  const target = path.join(root, "a.txt");
  await fs.writeFile(target, "before");
  const store = new CheckpointStore(root, "session-1");
  const entry = await writeCheckpoint(store, root, { "a.txt": "after" });
  const preview = await store.preview(entry.id);
  const originalRename = fs.rename.bind(fs);
  let injected = false;
  t.mock.method(fs, "rename", async (source, destination) => {
    if (source === target && !injected) { injected = true; await fs.writeFile(target, "new user edit"); }
    return originalRename(source, destination);
  });
  await assert.rejects(store.restore(entry.id, preview.confirmationToken), /manual recovery/);
  assert.equal(await fs.readFile(target, "utf8"), "new user edit");
  assert.equal((await store.list())[0].status, "recovery-required");
});

test("recreation cleanup failure is recorded as applied and recoverable rather than falsely rolled back", async (t) => {
  const root = await workspace(t);
  const target = path.join(root, "a.txt");
  await fs.writeFile(target, "before");
  const store = new CheckpointStore(root, "session-1");
  await store.runWrite(["a.txt"], "apply_patch", async () => fs.unlink(target), [null]);
  const [entry] = await store.list();
  const preview = await store.preview(entry.id);
  const originalUnlink = fs.unlink.bind(fs);
  t.mock.method(fs, "unlink", async (file) => {
    if (path.basename(file).startsWith("restore-")) { const error = new Error("Fixture cleanup failure"); error.code = "EPERM"; throw error; }
    return originalUnlink(file);
  });
  await assert.rejects(store.restore(entry.id, preview.confirmationToken), /manual recovery/);
  assert.equal(await fs.readFile(target, "utf8"), "before");
  assert.equal((await store.list())[0].status, "recovery-required");
  const manifest = JSON.parse(await fs.readFile(path.join(checkpointDirectory(root, entry.id), "manifest.json"), "utf8"));
  assert.deepEqual(manifest.appliedPaths, ["a.txt"]);
});

test("malformed status metadata is rejected without coercing an array into a valid status", async (t) => {
  const root = await workspace(t);
  const store = new CheckpointStore(root, "session-1");
  const entry = await writeCheckpoint(store, root, { "a.txt": "after" });
  const manifestPath = path.join(checkpointDirectory(root, entry.id), "manifest.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  manifest.status = ["complete"];
  await fs.writeFile(manifestPath, JSON.stringify(manifest));
  await assert.rejects(store.preview(entry.id), /manifest is invalid/);
});

test("restore retains displaced originals for writers holding an already-open descriptor", async (t) => {
  const root = await workspace(t);
  const target = path.join(root, "a.txt");
  await fs.writeFile(target, "before");
  const store = new CheckpointStore(root, "session-1");
  const entry = await writeCheckpoint(store, root, { "a.txt": "after!" });
  const writer = await fs.open(target, "r+");
  try {
    const preview = await store.preview(entry.id);
    await store.restore(entry.id, preview.confirmationToken);
    await writer.write(Buffer.from("newer!"), 0, 6, 0);
  } finally { await writer.close(); }
  const manifest = JSON.parse(await fs.readFile(path.join(checkpointDirectory(root, entry.id), "manifest.json"), "utf8"));
  const displaced = manifest.recoveryFiles.find((entry) => path.basename(entry.storagePath).startsWith("displaced-"));
  assert.equal(displaced.path, "a.txt");
  assert.equal(await fs.readFile(path.join(root, displaced.storagePath), "utf8"), "newer!");
  assert.equal(await fs.readFile(target, "utf8"), "before");
});

test("overlapping checkpoint stores cannot overwrite a successful restore journal", async (t) => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, "a.txt"), "before");
  const store = new CheckpointStore(root, "session-1");
  const entry = await writeCheckpoint(store, root, { "a.txt": "after!" });
  const preview = await store.preview(entry.id);
  let entered;
  let release;
  const blocked = new Promise((resolve) => { entered = resolve; });
  const resumed = new Promise((resolve) => { release = resolve; });
  const originalRename = fs.rename.bind(fs);
  let held = false;
  t.mock.method(fs, "rename", async (source, target) => {
    if (!held && target.endsWith("manifest.json") && JSON.parse(await fs.readFile(source, "utf8")).status === "restoring") {
      held = true; entered(); await resumed;
    }
    return originalRename(source, target);
  });
  const restoring = store.restore(entry.id, preview.confirmationToken);
  try {
    await blocked;
    await assert.rejects(new CheckpointStore(root, "session-1").restore(entry.id, preview.confirmationToken), /already locked/);
  } finally { release(); }
  await restoring;
  const manifest = JSON.parse(await fs.readFile(path.join(checkpointDirectory(root, entry.id), "manifest.json"), "utf8"));
  assert.equal(manifest.status, "restored");
  assert.ok(manifest.recoveryFiles.some((entry) => entry.path === "a.txt" && entry.storagePath.includes("displaced-")));
  await assert.rejects(fs.access(path.join(checkpointDirectory(root, entry.id), "restore.lock")), { code: "ENOENT" });
});

test("a crashed restore lock requires explicit recovery and never changes files", async (t) => {
  const root = await workspace(t);
  await fs.writeFile(path.join(root, "a.txt"), "before");
  const store = new CheckpointStore(root, "session-1");
  const entry = await writeCheckpoint(store, root, { "a.txt": "after" });
  const preview = await store.preview(entry.id);
  await fs.writeFile(path.join(checkpointDirectory(root, entry.id), "restore.lock"), "stale fixture");
  await assert.rejects(store.restore(entry.id, preview.confirmationToken), /prior process crashed/);
  assert.equal(await fs.readFile(path.join(root, "a.txt"), "utf8"), "after");
});
