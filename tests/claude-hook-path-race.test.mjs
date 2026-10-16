import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createCodingClaudeHookHost } from "../dist/coding/claude-hook-host.js";
import { setExtensionState } from "../dist/extensions/catalog.js";

const execute = promisify(execFile);
const privateMarker = "PRIVATE_VERIFIER_ANCESTOR_RACE_VALUE";

async function fixture(run, indexed = false) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hive-claude-path-race-"));
  const root = path.join(temporary, "workspace");
  const publicDirectory = path.join(root, "docs");
  const privateDirectory = path.join(root, ".ssh");
  const target = path.join(publicDirectory, "source.ts");
  const privateTarget = path.join(privateDirectory, "source.ts");
  const retainedDirectory = path.join(root, "retained-docs");
  const extensionOptions = { trustStateDir: path.join(temporary, "trust") };
  const originalOpen = fs.open;
  try {
    await fs.mkdir(path.join(root, ".hive"), { recursive: true });
    await fs.mkdir(publicDirectory);
    await fs.mkdir(privateDirectory);
    await fs.writeFile(target, "export const publicFact = 1;\n");
    await fs.writeFile(privateTarget, `export const privateFact = "${privateMarker}";\n`);
    await fs.writeFile(path.join(root, ".hive", "extensions.json"), JSON.stringify({ version: 1, hooks: {
      verifier: { event: "before_tool", claude: { event: "PreToolUse", handler: { type: "agent", prompt: "Verify the source." } } },
    } }));
    for (const action of ["trust", "enable"]) await setExtensionState(root, "hook:verifier", action, extensionOptions);
    if (indexed) {
      const git = (args) => execute("git", args, { cwd: root, windowsHide: true });
      await git(["init", "--quiet", "--template="]);
      await git(["add", "docs/source.ts"]);
      await git(["-c", "user.name=Hook Race Fixture", "-c", "user.email=hook-race@example.invalid", "commit", "--quiet", "-m", "fixture baseline"]);
      await fs.writeFile(target, "export const publicFact = 2;\n");
    }
    let swaps = 0;
    let privateHandleOpened = false;
    fs.open = async function (file, ...args) {
      if (file !== target || swaps !== 0) return originalOpen.call(this, file, ...args);
      swaps += 1;
      // Only schedule the race: the real open still reads the actual filesystem.
      // Restoring the directory before returning defeats a leaf-path-only recheck.
      await fs.rename(publicDirectory, retainedDirectory);
      await fs.symlink(privateDirectory, publicDirectory, process.platform === "win32" ? "junction" : "dir");
      let opened;
      try {
        opened = await originalOpen.call(this, file, ...args);
        const actual = await opened.stat();
        const expected = await fs.stat(privateTarget);
        privateHandleOpened = actual.dev === expected.dev && actual.ino === expected.ino;
        return opened;
      } finally {
        await fs.unlink(publicDirectory);
        await fs.rename(retainedDirectory, publicDirectory);
      }
    };
    await run({ root, extensionOptions, get swaps() { return swaps; }, get privateHandleOpened() { return privateHandleOpened; } });
    assert.equal(await fs.readFile(target, "utf8"), indexed ? "export const publicFact = 2;\n" : "export const publicFact = 1;\n");
  } finally {
    fs.open = originalOpen;
    assert.equal(path.dirname(temporary), path.resolve(os.tmpdir()));
    await fs.rm(temporary, { recursive: true, force: true });
  }
}

for (const [name, args] of [
  ["read_file", { path: "docs/source.ts" }],
  ["search_text", { query: "Fact", paths: ["docs"] }],
  ["search_symbols", { query: "Fact", paths: ["docs"] }],
  ["inspect_diff", {}],
]) {
  test(`Claude verifier ${name} refuses an ancestor swap even when the original directory is restored before postchecks`, { concurrency: false }, async () => fixture(async (context) => {
    const prompts = [];
    const router = {
      async resolve() { return { providerId: "fixture", model: "selected-model", config: { model: "selected-model" } }; },
      async complete(request) {
        prompts.push(request.prompt);
        return { output: JSON.stringify(prompts.length === 1 ? { toolCalls: [{ name, arguments: args }] } : { ok: true }) };
      },
    };
    const host = createCodingClaudeHookHost({ cwd: context.root, router, extensionOptions: context.extensionOptions, requestPermission: async () => true });
    await assert.rejects(host.evaluate({ hookId: "hook:verifier", event: "PreToolUse", type: "agent", prompt: "Inspect the source using read-only tools.", input: {}, cwd: context.root, maxTurns: 2, signal: new AbortController().signal }), /changed|identity|linked|verification/iu);
    assert.equal(context.swaps, 1, "The actual target open must encounter the scheduled filesystem race");
    assert.equal(context.privateHandleOpened, true, "The actual open must resolve to the private file before the identity guard rejects it");
    assert.equal(prompts.length, 1, "A rejected filesystem snapshot must never reach another model turn");
    assert.ok(prompts.every((prompt) => !prompt.includes(privateMarker)), "Private bytes reached a verifier model prompt");
  }, name === "inspect_diff"));
}
