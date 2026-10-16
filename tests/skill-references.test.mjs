import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createExtensionToolExecutor } from "../dist/coding/extension-tools.js";
import { StructuredAgentLoop } from "../dist/coding/agent-loop.js";
import { setExtensionState } from "../dist/extensions/catalog.js";
import { readSkillReference } from "../dist/extensions/skill-files.js";

const task = { id: "bee-reference", sessionId: "skill-reference-session", role: "scout", title: "Read skill references", objective: "Use the selected instructions",
  status: "working", providerId: "fixture", dependencies: [], fileScope: [], expectedOutput: "Reference read",
  completionCriteria: [], validationCommands: [], depth: 0, attempt: 1, maxAttempts: 1, createdAt: new Date().toISOString() };

async function fixture(run) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hive-skill-reference-"));
  const root = path.join(temporary, "workspace");
  const worktree = path.join(temporary, "managed-worktree");
  const directory = path.join(root, ".agents", "skills", "selected");
  const other = path.join(root, ".agents", "skills", "other");
  await fs.mkdir(path.join(directory, "references"), { recursive: true });
  await fs.mkdir(other, { recursive: true });
  await fs.mkdir(worktree);
  const skillFile = path.join(directory, "SKILL.md");
  await fs.writeFile(skillFile, "---\nname: selected\ndescription: Reference fixture\n---\nRead references/workflow.md when needed.\n");
  await fs.writeFile(path.join(other, "SKILL.md"), "---\nname: other\n---\nOther skill\n");
  await fs.writeFile(path.join(directory, "references", "workflow.md"), "Follow the reference workflow.\n");
  await fs.writeFile(path.join(other, "private.md"), "Unselected reference content");
  const options = { trustStateDir: path.join(temporary, "trust") };
  const activate = async (id) => { await setExtensionState(root, id, "trust", options); await setExtensionState(root, id, "enable", options); };
  try { await run({ root, worktree, directory, other, skillFile, options, activate, temporary }); }
  finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

test("trusted skill references return bounded UTF-8 instructions with credentials redacted", async () => fixture(async ({ root, directory, options, activate }) => {
  await activate("skill:selected");
  const file = path.join(directory, "references", "workflow.md");
  await fs.writeFile(file, '\uFEFFUse café and 日本語.\nAPI_KEY="sk-abcdefghijklmnopqrstuv"\nBearer opaque-example-token\n');
  const result = await readSkillReference(root, "selected", "references/workflow.md", options);
  assert.equal(result.id, "skill:selected");
  assert.equal(result.path, await fs.realpath(file));
  assert.match(result.content, /Use café and 日本語/);
  assert.match(result.content, /\[REDACTED\]/);
  assert.ok(!result.content.includes("abcdefghijklmnopqrstuv") && !result.content.includes("opaque-example-token"));
}));

test("reference reads require current trust and enablement and revoke after SKILL.md changes", async () => fixture(async ({ root, skillFile, options, activate }) => {
  await assert.rejects(readSkillReference(root, "selected", "references/workflow.md", options), /untrusted/);
  await activate("skill:selected");
  await setExtensionState(root, "skill:selected", "disable", options);
  await assert.rejects(readSkillReference(root, "selected", "references/workflow.md", options), /disabled/);
  await setExtensionState(root, "skill:selected", "enable", options);
  await fs.appendFile(skillFile, "Changed instructions.\n");
  await assert.rejects(readSkillReference(root, "selected", "references/workflow.md", options), /untrusted|changed/);
}));

test("skill references reject traversal, arbitrary workspace files and private path aliases", async () => fixture(async ({ root, directory, other, options, activate }) => {
  await activate("skill:selected");
  await fs.writeFile(path.join(root, "workspace.md"), "Outside skill");
  await fs.mkdir(path.join(directory, ".hivemind"));
  await fs.writeFile(path.join(directory, ".hivemind", "state.md"), "Private metadata");
  await fs.mkdir(path.join(directory, "credentials"));
  await fs.writeFile(path.join(directory, "credentials", "guide.md"), "Private credential");
  await fs.symlink(other, path.join(directory, "outside-alias"), process.platform === "win32" ? "junction" : "dir");
  await fs.symlink(path.join(directory, ".hivemind"), path.join(directory, "metadata-alias"), process.platform === "win32" ? "junction" : "dir");
  await fs.symlink(path.join(directory, "credentials"), path.join(directory, "credential-alias"), process.platform === "win32" ? "junction" : "dir");
  const denied = ["../other/private.md", "../../../../workspace.md", path.join(root, "workspace.md"), "outside-alias/private.md",
    ".hivemind/state.md", "metadata-alias/state.md", "credential-alias/guide.md", "credentials/guide.md", ".env.txt", "references/workflow.md:stream", "references/../SKILL.md", "references/workflow.js", "references/workflow.md."];
  for (const file of denied) await assert.rejects(readSkillReference(root, "selected", file, options), /inside|relative|traversal|private|Markdown/);
  await fs.link(path.join(directory, "references", "workflow.md"), path.join(directory, "hardlink.md"));
  await assert.rejects(readSkillReference(root, "selected", "hardlink.md", options), /single-link/);
}));

test("reference failures identify missing, oversized, non-UTF-8 and non-file inputs", async () => fixture(async ({ root, directory, options, activate }) => {
  await activate("skill:selected");
  await assert.rejects(readSkillReference(root, "selected", "missing.md", options), /does not exist/);
  await fs.writeFile(path.join(directory, "large.txt"), Buffer.alloc(64 * 1024 + 1, 65));
  await assert.rejects(readSkillReference(root, "selected", "large.txt", options), /65536 byte limit/);
  await fs.writeFile(path.join(directory, "invalid.md"), Buffer.from([0xc3, 0x28]));
  await assert.rejects(readSkillReference(root, "selected", "invalid.md", options), /UTF-8/);
  await fs.mkdir(path.join(directory, "directory.md"));
  await assert.rejects(readSkillReference(root, "selected", "directory.md", options), /regular single-link file/);
}));

test("executor advertises only selected trusted skills in read-only modes without starting hooks or MCP", async () => fixture(async ({ root, worktree, options, activate }) => {
  await activate("skill:selected"); await activate("skill:other");
  const marker = path.join(root, "should-not-run.txt");
  const processFile = path.join(root, "extension.mjs");
  await fs.writeFile(processFile, `import{writeFileSync}from'node:fs';writeFileSync(${JSON.stringify(marker)},'started');`);
  await fs.mkdir(path.join(root, ".hive"), { recursive: true });
  await fs.writeFile(path.join(root, ".hive", "extensions.json"), JSON.stringify({ version: 1,
    mcpServers: { fixture: { transport: "stdio", command: process.execPath, args: [processFile] } },
    hooks: { before: { event: "before_tool", command: process.execPath, args: [processFile] } },
  }));
  await activate("mcp:fixture"); await activate("hook:before");
  for (const mode of ["plan", "review", "auto"]) {
    const controller = new AbortController();
    const tools = await createExtensionToolExecutor({ base: { async execute() { throw new Error("Unexpected builtin execution"); } },
      extensionRoot: root, repositoryRoot: worktree, enabledSkillIds: ["selected"], enabledMcpServers: ["mcp:fixture"],
      extensionOptions: options, mode, signal: controller.signal });
    try {
      assert.equal(tools.toolDefinitions.length, 1);
      assert.equal(tools.toolDefinitions[0].name, "read_skill_reference");
      assert.deepEqual(tools.toolDefinitions[0].inputSchema.properties.skillId.enum, ["skill:selected"]);
      const allowed = await tools.execute("read_skill_reference", { skillId: "skill:selected", path: "references/workflow.md" }, task, controller.signal);
      assert.equal(allowed.ok, true); assert.match(JSON.parse(allowed.output).content, /reference workflow/);
      assert.equal(allowed.metadata.readOnly, true);
      const denied = await tools.execute("read_skill_reference", { skillId: "skill:other", path: "private.md" }, task, controller.signal);
      assert.equal(denied.ok, false); assert.match(denied.output, /selected/);
      await assert.rejects(fs.access(marker), { code: "ENOENT" });
    } finally { await tools.close(); }
  }
}));

test("StructuredAgentLoop reads selected references from the policy root rather than the managed worktree", async () => fixture(async ({ root, worktree, options, activate }) => {
  await activate("skill:selected");
  const controller = new AbortController();
  const tools = await createExtensionToolExecutor({ base: { async execute() { throw new Error("Unexpected builtin execution"); } },
    extensionRoot: root, repositoryRoot: worktree, enabledSkillIds: ["skill:selected"], extensionOptions: options, mode: "review", signal: controller.signal });
  let calls = 0;
  try {
    const result = await new StructuredAgentLoop().run({ task, cwd: worktree, sharedContext: "Use the selected skill.", tools, signal: controller.signal,
      completionClient: { async complete(request) {
        assert.match(request.systemPrompt, /read_skill_reference/);
        if (calls++ === 0) return { output: JSON.stringify({ done: false, toolCalls: [{ name: "read_skill_reference", arguments: { skillId: "skill:selected", path: "references/workflow.md" } }] }) };
        assert.match(request.prompt, /Follow the reference workflow/);
        return { output: JSON.stringify({ done: true, summary: "Read and followed the selected reference" }) };
      } },
    });
    assert.equal(result.summary, "Read and followed the selected reference");
    await fs.appendFile(path.join(root, ".agents", "skills", "selected", "SKILL.md"), "Changed.\n");
    const revoked = await tools.execute("read_skill_reference", { skillId: "skill:selected", path: "references/workflow.md" }, task, controller.signal);
    assert.equal(revoked.ok, false); assert.match(revoked.output, /untrusted|changed/);
  } finally { await tools.close(); }
}));
