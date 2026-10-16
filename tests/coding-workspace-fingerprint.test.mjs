import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { inspectManagedWorktree } from "../dist/coding/runtime.js";
import { WorktreeManager } from "../dist/worktree.js";

const exec = promisify(execFile);

async function git(cwd, args) {
  return (await exec("git", ["-c", "diff.autoRefreshIndex=false", ...args], {
    cwd,
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
    windowsHide: true,
  })).stdout;
}

async function fixture(t, { dependencies = false } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-raw-fingerprint-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await git(root, ["init", "-b", "main"]);
  await git(root, ["config", "user.email", "hive@example.test"]);
  await git(root, ["config", "user.name", "HIVE Test"]);
  await git(root, ["config", "core.autocrlf", "false"]);
  await fs.writeFile(path.join(root, ".gitignore"), ".hivemind/\nnode_modules/\nignored-cache/\n");
  await fs.writeFile(path.join(root, ".gitattributes"), "tracked.txt diff=constant filter=constant\n");
  await fs.writeFile(path.join(root, "tracked.txt"), "baseline-raw\r\n");
  await fs.writeFile(path.join(root, "swap-file"), "file before transition\n");
  await fs.mkdir(path.join(root, "swap-dir"));
  await fs.writeFile(path.join(root, "swap-dir", "child.txt"), "directory before transition\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-m", "fingerprint fixture"]);
  if (dependencies) {
    await fs.mkdir(path.join(root, "node_modules"));
    await fs.writeFile(path.join(root, "node_modules", "dependency.txt"), "shared dependency\n");
  }
  const id = "fingerprint";
  const workspace = await new WorktreeManager(root).createWorktreeFrom(id, "HEAD");
  const fingerprint = async () => (await inspectManagedWorktree(root, id, workspace)).fingerprint;
  return { root, workspace, id, fingerprint };
}

async function rawIndex(workspace) {
  const file = (await git(workspace, ["rev-parse", "--path-format=absolute", "--git-path", "index"])).trim();
  return fs.readFile(file);
}

async function blob(workspace, content) {
  const directory = path.join(workspace, ".hivemind");
  await fs.mkdir(directory, { recursive: true });
  const file = path.join(directory, "raw-object");
  await fs.writeFile(file, content);
  return (await git(workspace, ["hash-object", "--no-filters", "-w", file])).trim();
}

const shellQuote = (value) => `'${value.replaceAll("\\", "/").replaceAll("'", "'\\''")}'`;

test("fingerprints raw tracked bytes without executing clean or textconv drivers that hide changes", async (t) => {
  const { root, workspace, fingerprint } = await fixture(t);
  const metadata = path.join(root, ".hivemind");
  const driver = path.join(metadata, "constant-driver.mjs");
  const marker = path.join(metadata, "driver-ran");
  await fs.writeFile(driver, `import { appendFileSync } from "node:fs"; appendFileSync(${JSON.stringify(marker)}, process.argv[2] + "\\n"); process.stdout.write("constant filtered output\\n");\n`);
  const command = `${shellQuote(process.execPath)} ${shellQuote(driver)}`;
  await git(root, ["config", "filter.constant.clean", `${command} clean`]);
  await git(root, ["config", "diff.constant.textconv", `${command} textconv`]);
  await git(root, ["config", "diff.constant.cachetextconv", "false"]);
  const file = path.join(workspace, "tracked.txt");
  await fs.writeFile(file, "variant-one\n");

  // Establish that these real configured drivers execute, and that textconv
  // erases the difference before testing the raw inspector's boundary.
  assert.equal(await git(workspace, ["diff", "--textconv", "HEAD", "--", "tracked.txt"]), "");
  await git(workspace, ["hash-object", "--path=tracked.txt", "tracked.txt"]);
  const invocations = await fs.readFile(marker, "utf8");
  assert.match(invocations, /textconv/);
  assert.match(invocations, /clean/);
  await fs.unlink(marker);
  const indexBefore = await rawIndex(workspace);
  const first = await fingerprint();
  const originalStat = await fs.stat(file);
  await fs.writeFile(file, "variant-two\n");
  await fs.utimes(file, originalStat.atime, originalStat.mtime);
  const second = await fingerprint();

  assert.match(first, /^[a-f0-9]{64}$/);
  assert.notEqual(second, first, "same-length bytes hidden by both Git drivers still change the fingerprint");
  await assert.rejects(fs.lstat(marker), { code: "ENOENT" });
  assert.deepEqual(await rawIndex(workspace), indexBefore, "inspection does not rewrite index stat or extension data");
});

test("staged blob changes alter the fingerprint even when HEAD and raw worktree bytes stay identical", async (t) => {
  const { workspace, fingerprint } = await fixture(t);
  const originalBytes = await fs.readFile(path.join(workspace, "tracked.txt"));
  const originalHead = await git(workspace, ["rev-parse", "HEAD"]);
  const first = await fingerprint();
  const oid = await blob(workspace, "different staged blob\n");
  await git(workspace, ["update-index", "--cacheinfo", `100644,${oid},tracked.txt`]);
  const stagedIndex = await rawIndex(workspace);

  assert.notEqual(await fingerprint(), first);
  assert.equal(await git(workspace, ["rev-parse", "HEAD"]), originalHead);
  assert.deepEqual(await fs.readFile(path.join(workspace, "tracked.txt")), originalBytes);
  assert.deepEqual(await rawIndex(workspace), stagedIndex);
});

test("conflict stages and their blob identities contribute to the fingerprint", async (t) => {
  const { workspace, fingerprint } = await fixture(t);
  const firstBlob = await blob(workspace, "conflict one\n");
  const secondBlob = await blob(workspace, "conflict two\n");
  async function setStages(lastBlob) {
    const input = `0 ${"0".repeat(firstBlob.length)}\ttracked.txt\n100644 ${firstBlob} 1\ttracked.txt\n100644 ${firstBlob} 2\ttracked.txt\n100644 ${lastBlob} 3\ttracked.txt\n`;
    await new Promise((resolve, reject) => {
      const child = execFile("git", ["update-index", "--index-info"], { cwd: workspace, windowsHide: true }, (error) => error ? reject(error) : resolve());
      child.stdin.end(input);
    });
  }
  await setStages(firstBlob);
  const first = await fingerprint();
  await setStages(secondBlob);
  const indexBefore = await rawIndex(workspace);

  assert.notEqual(await fingerprint(), first, "changing only stage 3 is visible");
  assert.deepEqual(await rawIndex(workspace), indexBefore);
  assert.match(await git(workspace, ["ls-files", "--unmerged"]), new RegExp(`${secondBlob} 3\\ttracked\\.txt`));
});

test("a different HEAD commit changes the fingerprint even with identical files and index entries", async (t) => {
  const { workspace, fingerprint } = await fixture(t);
  const first = await fingerprint();
  const bytes = await fs.readFile(path.join(workspace, "tracked.txt"));
  const entries = await git(workspace, ["ls-files", "--stage", "-z"]);
  await git(workspace, ["commit", "--allow-empty", "-m", "new history, identical content"]);

  assert.notEqual(await fingerprint(), first);
  assert.deepEqual(await fs.readFile(path.join(workspace, "tracked.txt")), bytes);
  assert.equal(await git(workspace, ["ls-files", "--stage", "-z"]), entries);
});

test("index flags are semantic state, while their hidden raw working changes remain detectable", async (t) => {
  const { workspace, fingerprint } = await fixture(t);
  const file = path.join(workspace, "tracked.txt");
  const first = await fingerprint();
  await git(workspace, ["update-index", "--assume-unchanged", "tracked.txt"]);
  const assumed = await fingerprint();
  assert.notEqual(assumed, first);
  await fs.writeFile(file, "hidden raw change\n");
  assert.notEqual(await fingerprint(), assumed, "assume-unchanged cannot hide actual bytes");
  await fs.writeFile(file, "baseline-raw\r\n");
  await git(workspace, ["update-index", "--no-assume-unchanged", "tracked.txt"]);
  assert.equal(await fingerprint(), first, "volatile stat-cache fields do not change semantic identity");
  await git(workspace, ["update-index", "--skip-worktree", "tracked.txt"]);
  const skipped = await fingerprint();
  assert.notEqual(skipped, first);
  await fs.writeFile(file, "hidden skipped change\n");
  assert.notEqual(await fingerprint(), skipped, "skip-worktree cannot hide actual bytes");
});

test("index executable mode changes alter fingerprints without requiring filesystem mode support", async (t) => {
  const { workspace, fingerprint } = await fixture(t);
  const first = await fingerprint();
  await git(workspace, ["update-index", "--chmod=+x", "tracked.txt"]);
  const indexBefore = await rawIndex(workspace);

  assert.notEqual(await fingerprint(), first);
  assert.deepEqual(await rawIndex(workspace), indexBefore);
  await git(workspace, ["update-index", "--chmod=-x", "tracked.txt"]);
  assert.equal(await fingerprint(), first);
});

test("intent-to-add and an empty staged addition have distinct semantic fingerprints", async (t) => {
  const { workspace, fingerprint } = await fixture(t);
  await fs.writeFile(path.join(workspace, "empty.txt"), "");
  await git(workspace, ["add", "--intent-to-add", "empty.txt"]);
  const pending = await fingerprint();
  const entries = await git(workspace, ["ls-files", "--stage", "-z"]);
  await git(workspace, ["add", "empty.txt"]);
  assert.equal(await git(workspace, ["ls-files", "--stage", "-z"]), entries, "stage/OID output alone cannot identify this change");
  assert.notEqual(await fingerprint(), pending);
});

test("read-only inspection preserves exact index bytes when tracked file stat caches are stale", async (t) => {
  const { workspace, fingerprint } = await fixture(t);
  const first = await fingerprint();
  const before = await rawIndex(workspace);
  const changedStat = new Date(Date.now() + 30_000);
  await fs.utimes(path.join(workspace, "tracked.txt"), changedStat, changedStat);

  assert.equal(await fingerprint(), first, "touching unchanged bytes does not change content identity");
  assert.deepEqual(await rawIndex(workspace), before, "inspection cannot refresh even stale cached timestamps");
  assert.equal(await fingerprint(), first);
  assert.deepEqual(await rawIndex(workspace), before);
});

test("ignored dependency junctions, ignored files, and HIVE runtime metadata stay outside workspace identity", async (t) => {
  const { root, workspace, fingerprint } = await fixture(t, { dependencies: true });
  assert.equal(await fs.realpath(path.join(workspace, "node_modules")), await fs.realpath(path.join(root, "node_modules")));
  const first = await fingerprint();
  await fs.writeFile(path.join(root, "node_modules", "dependency.txt"), "updated dependency cache\n");
  await fs.mkdir(path.join(workspace, "ignored-cache"));
  await fs.writeFile(path.join(workspace, "ignored-cache", "cache.txt"), "cache bytes\n");
  await fs.mkdir(path.join(workspace, ".hivemind"));
  await fs.writeFile(path.join(workspace, ".hivemind", "session.json"), "runtime bytes\n");

  assert.equal(await fingerprint(), first);
});

test("raw untracked bytes and exact filenames change fingerprints independently of file timestamps", async (t) => {
  const { workspace, fingerprint } = await fixture(t);
  const empty = await fingerprint();
  const file = path.join(workspace, "untracked [literal] ü.bin");
  await fs.writeFile(file, Buffer.from([0, 1, 255, 2]));
  const first = await fingerprint();
  assert.notEqual(first, empty);
  const stat = await fs.stat(file);
  await fs.writeFile(file, Buffer.from([0, 3, 255, 4]));
  await fs.utimes(file, stat.atime, stat.mtime);
  assert.notEqual(await fingerprint(), first);
  await fs.writeFile(file, Buffer.from([0, 1, 255, 2]));
  assert.equal(await fingerprint(), first);
  await fs.rename(file, path.join(workspace, "renamed [literal] ü.bin"));
  assert.notEqual(await fingerprint(), first);
});

test("file-to-directory and directory-to-file transitions remain fingerprintable before and after staging", async (t) => {
  const { workspace, fingerprint } = await fixture(t);
  const first = await fingerprint();
  await fs.unlink(path.join(workspace, "swap-file"));
  await fs.mkdir(path.join(workspace, "swap-file"));
  await fs.writeFile(path.join(workspace, "swap-file", "child.txt"), "new child\n");
  await fs.unlink(path.join(workspace, "swap-dir", "child.txt"));
  await fs.rmdir(path.join(workspace, "swap-dir"));
  await fs.writeFile(path.join(workspace, "swap-dir"), "new file\n");
  const unstaged = await fingerprint();
  assert.notEqual(unstaged, first);
  await git(workspace, ["add", "--", "swap-file", "swap-dir"]);
  const indexBefore = await rawIndex(workspace);

  assert.notEqual(await fingerprint(), unstaged, "index transitions contribute separately from their working bytes");
  assert.deepEqual(await rawIndex(workspace), indexBefore);
});

test("literal symlink targets are fingerprinted without following their external contents", async (t) => {
  const { root, workspace, fingerprint } = await fixture(t);
  const target = path.join(root, "outside-target.txt");
  const other = path.join(root, "other-target.txt");
  const link = path.join(workspace, "literal-link");
  await fs.writeFile(target, "outside first\n");
  await fs.writeFile(other, "outside second\n");
  try { await fs.symlink(target, link, "file"); }
  catch (error) {
    if (["EPERM", "EACCES", "ENOTSUP"].includes(error.code)) { t.skip("Creating file symlinks is not permitted on this host; directory junction rejection is covered separately."); return; }
    throw error;
  }
  const first = await fingerprint();
  await fs.writeFile(target, "outside changed\n");
  assert.equal(await fingerprint(), first, "external bytes are not included by dereferencing a symlink");
  await fs.unlink(link);
  await fs.symlink(other, link, "file");
  assert.notEqual(await fingerprint(), first, "changing a literal target changes workspace state");
});

test("a tracked path through a directory junction fails closed instead of reading outside the worktree", async (t) => {
  const { root, workspace, fingerprint } = await fixture(t);
  const outside = path.join(root, "outside-directory");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "child.txt"), "external child\n");
  await fs.unlink(path.join(workspace, "swap-dir", "child.txt"));
  await fs.rmdir(path.join(workspace, "swap-dir"));
  await fs.symlink(outside, path.join(workspace, "swap-dir"), process.platform === "win32" ? "junction" : "dir");
  const indexBefore = await rawIndex(workspace);

  await assert.rejects(fingerprint(), /alias|link|symbolic|escape|resolve|directory/i);
  assert.deepEqual(await rawIndex(workspace), indexBefore);
  assert.equal(await fs.readFile(path.join(outside, "child.txt"), "utf8"), "external child\n");
});
