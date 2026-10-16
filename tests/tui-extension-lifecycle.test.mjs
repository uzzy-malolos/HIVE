import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { runQueenTuiSession } from "../dist/tui/runtime-adapter.js";
import { setExtensionState } from "../dist/extensions/index.js";
import { publicText } from "../dist/extensions/io.js";

test("an ending hook cannot hide the primary coding startup failure", async (t) => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hive-hook-failures-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const cwd = path.join(temporary, "workspace");
  await fs.mkdir(path.join(cwd, ".hive"), { recursive: true });
  const hook = path.join(cwd, "ending.cjs");
  await fs.writeFile(hook, 'process.stdin.resume(); process.stdin.on("end",()=>{ console.error("ending-hook-fixture"); process.exitCode=9; });');
  await fs.writeFile(path.join(cwd, ".hive/extensions.json"), JSON.stringify({ version: 1, hooks: { end: { event: "session_end", command: process.execPath, args: [hook] } } }));
  const extensionOptions = { trustStateDir: path.join(temporary, "trust") };
  await setExtensionState(cwd, "hook:end", "trust", extensionOptions);
  await setExtensionState(cwd, "hook:end", "enable", extensionOptions);
  await assert.rejects(runQueenTuiSession({ cwd, objective: "Fixture outside a Git repository", signal: new AbortController().signal, onEvent() {}, extensionOptions }), (error) => {
    assert.ok(error instanceof AggregateError);
    assert.equal(error.errors.length, 2);
    assert.match(error.message, /Unable to detect a Git repository/);
    assert.match(error.message, /ending-hook-fixture/);
    return true;
  });
});

test("extension public output removes ESC and C1 terminal operations before CLI emission", () => {
  for (const control of ["\x1b[2J", "\x9b2J", "\x1b]52;c;Y2xpcGJvYXJk\x07", "\x9d52;c;Y2xpcGJvYXJk\x9c", "\x90private\x9c"]) {
    const result = publicText(`before${control}after\rmore`);
    assert.equal(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/u.test(result), false);
    assert.equal(result, "beforeafter\nmore");
  }
});
