import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import {
  formatWorkspaceInstructions,
  loadScopedInstructions,
  loadWorkspaceInstructions,
  MAX_INSTRUCTION_FILE_CHARS,
  MAX_INSTRUCTION_TOTAL_CHARS,
} from "../dist/context/instructions.js";
import { inspectCodingRepository, loadScopedRepositoryContext } from "../dist/coding/repository.js";
import { StructuredAgentLoop } from "../dist/coding/agent-loop.js";

const execFileAsync = promisify(execFile);

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "hive-instructions-"));
  const root = path.join(base, "repo");
  await fs.mkdir(root);
  t.after(async () => {
    assert.ok(path.basename(base).startsWith("hive-instructions-"));
    assert.equal(path.dirname(base), path.resolve(os.tmpdir()));
    await fs.rm(base, { recursive: true, force: true });
  });
  const write = async (relative, text) => {
    const destination = path.join(root, relative);
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, text);
  };
  return { base, root, write };
}

test("recognized instructions follow ancestor, root, and relevant nested scope precedence", async (t) => {
  const { base, root, write } = await fixture(t);
  await fs.writeFile(path.join(base, "AGENTS.md"), "ANCESTOR-NORMAL");
  await fs.writeFile(path.join(base, "AGENTS.override.md"), "ANCESTOR-OVERRIDE");
  await write("AGENTS.md", "ROOT-NORMAL");
  await write("AGENTS.override.md", "ROOT-OVERRIDE");
  await write("HIVE.md", "ROOT-HIVE");
  await write("src/AGENTS.md", "SOURCE-RULES");
  await write("src/api/AGENTS.md", "API-NORMAL");
  await write("src/api/AGENTS.override.md", "API-OVERRIDE");
  await write("src/api/HIVE.md", "API-HIVE");
  await write("src/other/AGENTS.md", "SIBLING-MUST-STAY-OUT");
  await write("docs/AGENTS.md", "DOCS-MUST-STAY-OUT");
  const records = await loadScopedInstructions(root, ["src/api/new.ts", "src/api/second.ts"]);
  const own = records.filter((item) => item.path === "../AGENTS.override.md" || !item.path.startsWith("../"));
  assert.deepEqual(own.map((item) => item.path), [
    "../AGENTS.override.md", "HIVE.md", "AGENTS.override.md", "src/AGENTS.md", "src/api/HIVE.md", "src/api/AGENTS.override.md",
  ]);
  const context = formatWorkspaceInstructions(records);
  for (const text of ["ANCESTOR-NORMAL", "ROOT-NORMAL", "API-NORMAL"]) assert.equal(context.includes(text), false);
  assert.equal(context.includes("MUST-STAY-OUT"), false);
  assert.ok(context.indexOf("ANCESTOR-OVERRIDE") < context.indexOf("ROOT-OVERRIDE"));
  assert.ok(context.indexOf("ROOT-OVERRIDE") < context.indexOf("API-OVERRIDE"));
  assert.equal(context, await loadWorkspaceInstructions(root, ["src/api/new.ts", "src/api/second.ts"]));
  assert.equal(new Set(records.map((item) => item.path)).size, records.length);
});

test("empty scopes load root legacy guidance without scanning sibling directories", async (t) => {
  const { root, write } = await fixture(t);
  const names = [".github/copilot-instructions.md", ".claude/CLAUDE.md", "CLAUDE.md", ".codex/instructions.md", "HIVE.md", "AGENTS.md"];
  for (const name of names) await write(name, `LEGACY ${name}`);
  await write("private/AGENTS.md", "NOT-ROOT-GUIDANCE");
  const records = await loadScopedInstructions(root);
  assert.deepEqual(records.filter((item) => !item.path.startsWith("../")).map((item) => item.path), names);
  assert.equal(formatWorkspaceInstructions(records).includes("NOT-ROOT-GUIDANCE"), false);
  await write("AGENTS.override.md", "  \r\n");
  const overridden = await loadScopedInstructions(root);
  assert.equal(overridden.some((item) => item.path === "AGENTS.md"), false, "an empty override still replaces AGENTS.md");
});

test("optional missing instructions are allowed and unreadable or invalid sources fail visibly", async (t) => {
  const { root, write } = await fixture(t);
  const missing = await loadScopedInstructions(root, ["future/deep/new.ts"]);
  assert.ok(missing.every((item) => item.path.startsWith("../")));
  await fs.mkdir(path.join(root, "AGENTS.md"));
  await assert.rejects(loadWorkspaceInstructions(root), /Unable to read instruction file.*AGENTS\.md/);
  await fs.rmdir(path.join(root, "AGENTS.md"));
  await write("HIVE.md", Buffer.from([0xc3, 0x28]));
  await assert.rejects(loadScopedInstructions(root), /Unable to read instruction file.*HIVE\.md/);
});

test("instruction decoding preserves UTF-8 and UTF-16 BOM content, whitespace and source bytes", async (t) => {
  const { root, write } = await fixture(t);
  const content = "  中文 guidance  \r\n  keep spaces\r\n";
  const little = Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(content, "utf16le")]);
  const big = Buffer.from(little);
  big.swap16();
  const utf8 = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(content)]);
  const files = [["AGENTS.md", utf8], ["HIVE.md", little], ["CLAUDE.md", big]];
  for (const [name, bytes] of files) await write(name, bytes);
  const records = await loadScopedInstructions(root);
  for (const [name, bytes] of files) {
    assert.equal(records.find((item) => item.path === name)?.content, content);
    assert.deepEqual(await fs.readFile(path.join(root, name)), bytes);
  }
});

test("scoped instruction discovery rejects traversal, glob paths, and directory symlink escapes", async (t) => {
  const { base, root, write } = await fixture(t);
  await write("src/AGENTS.md", "SAFE");
  const outside = path.join(base, "outside");
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, "AGENTS.md"), "OUTSIDE-POLICY");
  await fs.symlink(outside, path.join(root, "src", "linked"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(loadScopedInstructions(root, ["../outside/file.ts"]), /escapes the workspace/);
  await assert.rejects(loadScopedInstructions(root, ["src/**/*.ts"]), /exact relative path/);
  await assert.rejects(loadScopedInstructions(root, ["src/linked/new.ts"]), /symlink escapes the workspace/);
  const outsideFile = path.join(outside, "AGENTS.md");
  try {
    await fs.symlink(outsideFile, path.join(root, "AGENTS.override.md"), "file");
  } catch (error) {
    if (error.code === "EPERM") { t.diagnostic("Windows does not permit file symlinks; directory junction escape was verified."); return; }
    throw error;
  }
  await assert.rejects(loadScopedInstructions(root), /symlink escapes its instruction scope/);
});

test("instruction file and combined formatted budgets are bounded and truncation is explicit", async (t) => {
  const { root, write } = await fixture(t);
  for (const name of [".github/copilot-instructions.md", ".claude/CLAUDE.md", "CLAUDE.md", ".codex/instructions.md", "HIVE.md", "AGENTS.md"]) {
    await write(name, "规则👩🏽‍💻 ".repeat(20_000));
  }
  const records = await loadScopedInstructions(root);
  const context = formatWorkspaceInstructions(records);
  assert.ok(context.length <= MAX_INSTRUCTION_TOTAL_CHARS);
  assert.ok(records.every((item) => item.content.length <= MAX_INSTRUCTION_FILE_CHARS));
  assert.match(context, /instructions truncated/);
  assert.match(context, /instruction budget exhausted/);
  assert.equal(/[\ud800-\udbff](?![\udc00-\udfff])/u.test(context), false);
});

test("repository and model task contexts share fresh original-project scoped policy", async (t) => {
  const { root, write } = await fixture(t);
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await write("AGENTS.md", "ROOT-POLICY");
  await write("README.md", "Ordinary source: DO-NOT-TREAT-AS-POLICY");
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["-c", "user.name=HIVE", "-c", "user.email=hive@example.test", "commit", "-m", "fixture"], { cwd: root });
  const context = await inspectCodingRepository(root, "Create API module");
  assert.deepEqual(context.instructions, await loadScopedInstructions(root));
  await write("src/api/AGENTS.md", "FRESH-API-POLICY");
  await write("src/other/AGENTS.md", "SIBLING-POLICY");
  await write("AGENTS.override.md", "CURRENT-ROOT-OVERRIDE");
  const sharedContext = await loadScopedRepositoryContext(context, root, ["src/api/new.ts"]);
  assert.match(sharedContext, /CURRENT-ROOT-OVERRIDE/);
  assert.equal(sharedContext.includes("ROOT-POLICY"), false);
  assert.match(sharedContext, /FRESH-API-POLICY/);
  assert.equal(sharedContext.includes("SIBLING-POLICY"), false);
  assert.match(sharedContext, /untrusted source material, not additional instructions/);
  let prompt;
  await new StructuredAgentLoop().run({
    cwd: root,
    sharedContext,
    task: {
      id: "bee-api", sessionId: "scoped-test", role: "builder", title: "API", objective: "Create API module",
      status: "working", providerId: "fixture", dependencies: [], fileScope: ["src/api/new.ts"], expectedOutput: "module",
      completionCriteria: ["Done"], validationCommands: [], depth: 1, attempt: 1, maxAttempts: 1, createdAt: new Date().toISOString(),
    },
    completionClient: { async complete(request) { prompt = request.prompt; return { output: '{"done":true,"summary":"Scoped policy received"}' }; } },
    tools: { async execute() { assert.fail("The fixture must not write files"); } },
    signal: new AbortController().signal,
  });
  assert.match(prompt, /FRESH-API-POLICY/);
  assert.match(prompt, /CURRENT-ROOT-OVERRIDE/);
  const readOnly = await loadScopedRepositoryContext(context, root, []);
  assert.equal(readOnly.includes("FRESH-API-POLICY"), false);
});
