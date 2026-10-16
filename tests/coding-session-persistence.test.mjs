import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { CodingSessionStore } from "../dist/coding/session-store.js";

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-persistence-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const store = new CodingSessionStore(root);
  const now = new Date().toISOString();
  const record = {
    schemaVersion: 1, id: "session-atomic", objective: "Persist the repair frontier",
    mode: "auto", approvalPolicy: "changes", status: "running", createdAt: now, updatedAt: now,
    repository: { root, capturedAt: now, dirty: false, changedFiles: [] },
    tasks: [], events: [], providerBindings: [], validationResults: [], reviewResults: [], files: [],
  };
  await store.save(record);
  return { root, store, record, destination: path.join(store.getSessionDirectory(record.id), "session.json") };
}

function sharingViolation(code = "EPERM") {
  return Object.assign(new Error("A reader temporarily denies atomic replacement"), { code });
}

for (const code of ["EPERM", "EBUSY"]) {
  test(`session snapshot retries the same atomic replacement after transient ${code}`, async (t) => {
    const { store, record, destination } = await fixture(t);
    const rename = fs.rename;
    const sources = [];
    t.mock.method(fs, "rename", async (source, target) => {
      if (target !== destination) return rename(source, target);
      sources.push(source);
      if (sources.length === 1) {
        assert.equal((await store.load(record.id)).status, "running");
        throw sharingViolation(code);
      }
      return rename(source, target);
    });
    await store.save({ ...record, status: "paused" });
    assert.equal(sources.length, 2);
    assert.equal(new Set(sources).size, 1, "retry must publish the already synced snapshot");
    assert.equal((await store.load(record.id)).status, "paused");
    assert.deepEqual(await fs.readdir(store.getSessionDirectory(record.id)), ["session.json"]);
  });
}

test("active-session pointer survives a transient reader lock without losing its previous value", async (t) => {
  const { store, record } = await fixture(t);
  await store.setActive(record.id);
  const next = { ...record, id: "session-next" };
  await store.save(next);
  const destination = path.join(store.baseDirectory, "active-session.txt");
  const rename = fs.rename;
  let attempts = 0;
  t.mock.method(fs, "rename", async (source, target) => {
    if (target !== destination) return rename(source, target);
    attempts += 1;
    if (attempts === 1) {
      assert.equal((await store.getActive()).id, record.id);
      throw sharingViolation("EBUSY");
    }
    return rename(source, target);
  });
  await store.setActive(next.id);
  assert.equal(attempts, 2);
  assert.equal((await store.getActive()).id, next.id);
});

test("persistent sharing failures remain bounded and preserve the previous snapshot", async (t) => {
  const { store, record, destination } = await fixture(t);
  const original = await fs.readFile(destination);
  let attempts = 0;
  t.mock.method(fs, "rename", async () => { attempts += 1; throw sharingViolation(); });
  await assert.rejects(store.save({ ...record, status: "paused" }), { code: "EPERM" });
  assert.equal(attempts, 6);
  assert.deepEqual(await fs.readFile(destination), original);
  assert.deepEqual(await fs.readdir(store.getSessionDirectory(record.id)), ["session.json"]);
});

test("non-sharing persistence errors propagate immediately", async (t) => {
  const { store, record, destination } = await fixture(t);
  const original = await fs.readFile(destination);
  let attempts = 0;
  t.mock.method(fs, "rename", async () => {
    attempts += 1;
    throw Object.assign(new Error("No space left"), { code: "ENOSPC" });
  });
  await assert.rejects(store.save({ ...record, status: "paused" }), { code: "ENOSPC" });
  assert.equal(attempts, 1);
  assert.deepEqual(await fs.readFile(destination), original);
});

test("a changed snapshot is preserved rather than overwritten during sharing retries", async (t) => {
  const { store, record, destination } = await fixture(t);
  let attempts = 0;
  const foreign = "Changed by a different writer while the first rename was blocked\n";
  t.mock.method(fs, "rename", async () => {
    attempts += 1;
    await fs.writeFile(destination, foreign);
    throw sharingViolation();
  });
  await assert.rejects(store.save({ ...record, status: "paused" }), /target changed.*newer file was preserved/);
  assert.equal(attempts, 1);
  assert.equal(await fs.readFile(destination, "utf8"), foreign);
  assert.deepEqual(await fs.readdir(store.getSessionDirectory(record.id)), ["session.json"]);
});

test("an unexpected new destination is preserved during sharing retries", async (t) => {
  const { store, record } = await fixture(t);
  const next = { ...record, id: "session-new" };
  const destination = path.join(store.getSessionDirectory(next.id), "session.json");
  let attempts = 0;
  t.mock.method(fs, "rename", async () => {
    attempts += 1;
    await fs.writeFile(destination, "Another writer created this snapshot\n");
    throw sharingViolation();
  });
  await assert.rejects(store.save(next), /target changed.*newer file was preserved/);
  assert.equal(attempts, 1);
  assert.equal(await fs.readFile(destination, "utf8"), "Another writer created this snapshot\n");
});

async function windowsReader(root, target) {
  const script = path.join(root, "reader.ps1");
  await fs.writeFile(script, [
    "param([string]$target)",
    "$stream = [System.IO.File]::Open($target, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite)",
    "try { [Console]::Out.WriteLine('LOCKED'); [Console]::Out.Flush(); [void][Console]::In.ReadLine() } finally { $stream.Dispose() }",
  ].join("\n"));
  const child = spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", script, target], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`Reader exited ${code}: ${stderr}`)));
  });
  void closed.catch(() => undefined);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("Windows reader did not acquire its fixture file")), 5_000);
      const ready = (chunk) => { if (String(chunk).includes("LOCKED")) { clearTimeout(timer); resolve(); } };
      child.stdout.on("data", ready);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", () => { clearTimeout(timer); reject(new Error(`Reader exited before locking: ${stderr}`)); });
    });
  } catch (error) {
    child.kill();
    await closed.catch(() => undefined);
    throw error;
  }
  let released = false;
  return async () => { if (!released) { released = true; child.stdin.end("release\n"); } await closed; };
}

test("actual Windows sharing violation recovers without deleting the saved snapshot", { skip: process.platform !== "win32" }, async (t) => {
  const { root, store, record, destination } = await fixture(t);
  const release = await windowsReader(root, destination);
  const rename = fs.rename;
  const codes = [];
  try {
    t.mock.method(fs, "rename", async (source, target) => {
      try { return await rename(source, target); }
      catch (error) {
        codes.push(error.code);
        assert.equal((await store.load(record.id)).status, "running");
        await release();
        throw error;
      }
    });
    await store.save({ ...record, status: "paused" });
    assert.deepEqual(codes, ["EPERM"], "the real OS reader must deny the first atomic replacement");
    assert.equal((await store.load(record.id)).status, "paused");
  } finally { await release(); }
});
