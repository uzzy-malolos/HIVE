import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compatibleManifest } from "../dist/extensions/marketplace-compat.js";
import { parsePluginDependencies, pluginVersionSatisfies, convertClaudeAgentLspComponents } from "../dist/extensions/plugin-components.js";
import { parsePluginAgent, runPluginAgent } from "../dist/extensions/plugin-agents.js";
import { importClaudeHooks, claudeHookInput } from "../dist/extensions/claude-hooks.js";
import { addMarketplace, installMarketplacePlugin } from "../dist/extensions/marketplace.js";
import { discoverExtensions, setExtensionState } from "../dist/extensions/catalog.js";
import { runHooks } from "../dist/extensions/hooks.js";

const file = (name, content) => ({ name, bytes: Buffer.from(typeof content === "string" ? content : JSON.stringify(content)), executable: false });
const agentText = (header = "") => `---\nname: reviewer\ndescription: Review assigned source\n${header}---\nInspect actual source and explain the result.\n`;
const imported = (manifest, files = [], entry = {}) => compatibleManifest([file(".claude-plugin/plugin.json", { name: "compatible", ...manifest }), ...files], "compatible.team", "C:/fixture/plugin", entry);
const nativeManifest = (result) => JSON.parse(result.files.find((entry) => entry.name === "hive.plugin.json").bytes.toString());

test("Claude dependency strings and strict objects canonicalize without installations or defaults", () => {
  assert.deepEqual(parsePluginDependencies(["logger", "vault@shared", { name: "database", marketplace: "team", version: "~2.1.0" }]), [
    { name: "logger" }, { name: "vault", marketplace: "shared" }, { name: "database", marketplace: "team", version: "~2.1.0" },
  ]);
  assert.deepEqual(parsePluginDependencies(undefined), []);
  for (const value of [null, {}, "logger", Array(33).fill("logger"), [""], ["x@"], ["x@y@z"], ["../x"], ["Logger", "logger"], [{ name: "x", command: "node" }], [{ name: "x", version: "latest" }], [{ name: "x", version: "^1\n2" }]]) assert.throws(() => parsePluginDependencies(value));
});

test("installed semantic versions honor documented ranges without fetching release tags", () => {
  const matches = [
    ["2.1.8", "~2.1.0"], ["2.1.0", "~2.1"], ["2.9.9", "^2.0"], ["1.4.0", ">=1.4"], ["2.1.0", "=2.1.0"],
    ["0.2.9", "^0.2.0"], ["0.0.3", "^0.0.3"], ["0.9.9", "^0"], ["0.0.8", "^0.0"], ["1.2.3", "1.2.x"],
    ["1.2.3", "1.*"], ["1.5.0", ">1.4"], ["1.4.9", "<=1.4"], ["2.3.99", "1.2 - 2.3"], ["2.3.4", "1.2.0 - 2.3.4"],
    ["3.2.1", "^2 || ^3"], ["2.5.0", ">=2.0 <3.0"], ["2.0.0-beta.1", "^2.0.0-0"], ["1.2.3+build.7", "1.2.3"], ["9.0.0", "*"],
  ];
  const misses = [
    ["2.2.0", "~2.1.0"], ["3.0.0", "^2.0"], ["1.3.99", ">=1.4"], ["2.1.1", "=2.1.0"], ["0.3.0", "^0.2"],
    ["0.0.4", "^0.0.3"], ["0.1.0", "^0.0"], ["1.3.0", "1.2.x"], ["1.4.99", ">1.4"], ["1.5.0", "<=1.4"],
    ["2.4.0", "1.2 - 2.3"], ["2.3.5", "1.2.0 - 2.3.4"], ["2.0.0-beta.1", "^2.0"], ["2.1.0-beta.1", "^2.0.0-0"],
    ["9.0.0-beta", "*"], [undefined, "^1"], ["release-candidate", "*"], ["1.2", "*"],
    ["1.2.0-beta", ">=1.2.0-beta <1.2"], ["1.3.0-beta", ">1.2 >=1.3.0-beta"],
  ];
  for (const [version, range] of matches) assert.equal(pluginVersionSatisfies(version, range), true, `${version} satisfies ${range}`);
  for (const [version, range] of misses) assert.equal(pluginVersionSatisfies(version, range), false, `${version} does not satisfy ${range}`);
  for (const range of ["latest", "", "1.02.3", "1.0.0-01", ">*", "1 ||", "^".repeat(20), "1 ".repeat(150), "1 2 3 4 5 6 7 8 9"]) assert.throws(() => pluginVersionSatisfies("1.0.0", range), /range|version|comparator|wildcard/);
});

test("marketplace conversion preserves dependency requirements and versions as inspectable native data", () => {
  const result = imported({ version: "3.1.0", dependencies: ["logger", { name: "vault", marketplace: "shared", version: "^2.0" }] });
  const manifest = nativeManifest(result);
  assert.equal(manifest.version, 1); assert.equal(manifest.pluginVersion, "3.1.0");
  assert.deepEqual(manifest.dependencies, [{ name: "logger" }, { name: "vault", marketplace: "shared", version: "^2.0" }]);
  assert.match(result.warnings.join("\n"), /never installs or enables dependencies automatically/);
  const overrides = nativeManifest(imported({ version: "1.0.0", dependencies: ["old"] }, [], { version: "2.0.0", dependencies: ["new@team"] }));
  assert.equal(overrides.pluginVersion, "2.0.0"); assert.deepEqual(overrides.dependencies, [{ name: "new", marketplace: "team" }]);
  const native = compatibleManifest([file("hive.plugin.json", manifest)], "another", "C:/fixture/another", {});
  assert.equal(nativeManifest(native).name, "another"); assert.deepEqual(nativeManifest(native).dependencies, manifest.dependencies);
  assert.throws(() => imported({ dependencies: [{ name: "x", version: "execute()" }] }), /range/);
});

test("agent skill frontmatter is bounded and no longer merely informational metadata", () => {
  for (const header of ["skills: [guide, other:review, skill:compatible.team.audit]\n", "skills:\n  - guide\n  - other:review\n  - skill:compatible.team.audit\n"]) {
    const agent = parsePluginAgent(agentText(header), "agents/reviewer.md");
    assert.deepEqual(agent.skills, ["guide", "other:review", "skill:compatible.team.audit"]);
    assert.equal(agent.metadata.skills, undefined); assert.equal(agent.warnings.some((warning) => warning.includes("skills")), false);
  }
  assert.deepEqual(parsePluginAgent(agentText("skills: [guide, guide]\n"), "agents/reviewer.md").skills, ["guide"]);
  for (const header of ["skills: [../escape]\n", "skills: [plugin:skill:extra]\n", `skills: [${Array.from({ length: 33 }, (_, index) => `skill${index}`).join(", ")}]\n`]) assert.throws(() => parsePluginAgent(agentText(header), "agents/reviewer.md"), /skills/);
});

test("plugin agent inline hooks, MCP and permission mode stay inert as Claude documents", async () => {
  const agent = parsePluginAgent(agentText(`tools: Read\nmodel: opus\nskills: [guide]\npermissionMode: bypassPermissions\nhooks:\n  PreToolUse:\n    - hooks:\n        - type: command\n          command: node do-not-run.mjs\nmcpServers:\n  - private:\n      command: node\n      args: [do-not-run.mjs]\n`), "agents/reviewer.md");
  assert.deepEqual(agent.tools, ["Read"]); assert.deepEqual(agent.skills, ["guide"]);
  assert.equal(agent.metadata.permissionMode, "bypassPermissions"); assert.match(agent.metadata.hooks, /do-not-run/); assert.match(agent.metadata.mcpServers, /do-not-run/);
  for (const field of ["hooks", "mcpServers", "permissionMode"]) assert.match(agent.warnings.join("\n"), new RegExp(`${field} is ignored for plugin agents`));
  let completions = 0, tools = 0;
  await runPluginAgent({ agent: { ...agent, id: "agent:fixture.reviewer", enabled: true, trusted: true, fingerprint: "a".repeat(64) }, cwd: process.cwd(), sharedContext: "", signal: new AbortController().signal,
    task: { id: "plugin-compat", sessionId: "plugin-compat", title: "Review", objective: "Review", status: "working", role: "builder", providerId: "selected", model: "selected-model", dependencies: [], fileScope: [], expectedOutput: "Summary", completionCriteria: [], validationCommands: [], depth: 0, attempt: 1, maxAttempts: 1, createdAt: "2026-10-17T00:00:00.000Z" },
    revalidate: async () => {}, tools: { async execute() { tools++; throw new Error("not reached"); } }, completionClient: { async complete(request) {
      completions++; assert.equal(request.providerId, "selected"); assert.equal(request.model, "selected-model");
      assert.doesNotMatch(request.systemPrompt, /do-not-run|bypassPermissions/);
      return { output: '{"done":true,"summary":"Reviewed without running ignored declarations"}' };
    } },
  });
  assert.equal(completions, 1); assert.equal(tools, 0);
});

test("declared agent files replace defaults and agent directories remain explicitly unsupported", () => {
  const files = [file("agents/default.md", agentText()), file("custom/review.md", agentText())];
  const result = convertClaudeAgentLspComponents(files, { agents: ["./custom/review.md"] }, {}, "C:/fixture/plugin");
  assert.deepEqual(result.agents, ["custom/review.md"]);
  assert.throws(() => convertClaudeAgentLspComponents(files, { agents: ["./custom/"] }, {}, "C:/fixture/plugin"), /Markdown/);
  const converted = imported({ agents: ["./custom/review.md"] }, files);
  assert.deepEqual(nativeManifest(converted).agents, ["custom/review.md"]);
});

test("documented LSP socket spelling imports as actual stdio with an explicit compatibility warning", () => {
  const result = imported({ lspServers: { language: { command: "server", transport: "socket", extensionToLanguage: { ".ts": "typescript" } } } });
  const server = nativeManifest(result).lspServers.language;
  assert.equal(server.command, "server"); assert.equal(server.transport, undefined);
  assert.match(result.warnings.join("\n"), /starts this server over stdio without opening a socket/);
});

test("PostToolUseFailure carries actual error context instead of a successful tool response", () => {
  const configuration = { event: "PostToolUseFailure", matcher: "Bash" };
  const input = claudeHookInput(configuration, { tool: "run_command", input: { command: "node failing.mjs" }, sessionId: "session", toolUseId: "call", error: "Exit code 1\nExpected fixture failure", duration_ms: 12.2, result: { ok: false } }, "C:/workspace");
  assert.equal(input.hook_event_name, "PostToolUseFailure"); assert.equal(input.tool_name, "Bash"); assert.equal(input.tool_use_id, "call");
  assert.equal(input.error, "Exit code 1\nExpected fixture failure"); assert.equal(input.duration_ms, 12); assert.equal(input.is_interrupt, false); assert.equal(input.tool_response, undefined);
  const result = importClaudeHooks([], "C:/fixture/plugin", [{ PostToolUseFailure: [{ matcher: "Bash", hooks: [{ type: "command", command: "node", args: ["${CLAUDE_PROJECT_DIR}/failure.mjs"] }] }] }]);
  assert.equal(Object.values(result)[0].event, "after_tool_failure");
});

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hive-plugin-compat-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "workspace with spaces"), market = path.join(temporary, "market");
  await fs.mkdir(root); await fs.mkdir(market);
  const options = { trustStateDir: path.join(temporary, "trust") };
  const write = async (name, data) => { const target = path.join(market, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, typeof data === "string" ? data : JSON.stringify(data)); };
  await write(".claude-plugin/marketplace.json", { name: "team", plugins: [{ name: "compatible", source: "./plugin" }] });
  return { temporary, root, market, options, write };
}

test("real marketplace dependency bundles install inertly and remain inspectable before dependency setup", async (t) => {
  const f = await fixture(t);
  await f.write("plugin/.claude-plugin/plugin.json", { name: "compatible", version: "3.0.0", dependencies: [{ name: "logger", version: "^2" }] });
  await f.write("plugin/skills/guide/SKILL.md", "---\nname: guide\n---\nUse this reviewed guide.\n");
  await f.write("plugin/server.mjs", "throw Error('Installation must stay inert');\n");
  await addMarketplace(f.root, f.market, f.options);
  const result = await installMarketplacePlugin(f.root, "compatible@team", f.options);
  assert.equal(result.plugin.trusted, false); assert.equal(result.plugin.enabled, false);
  const catalog = await discoverExtensions(f.root, f.options);
  assert.equal(catalog.plugins.length, 1); assert.equal(catalog.skills.length, 1);
  assert.equal(JSON.parse(await fs.readFile(path.join(result.plugin.path, "hive.plugin.json"), "utf8")).pluginVersion, "3.0.0");
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(f.root, ".hive/extensions.json"), "utf8")).plugins.logger, undefined);
});

test("trusted marketplace failure hooks run actual owned processes with project interpolation and fresh trust", async (t) => {
  const f = await fixture(t);
  await f.write("plugin/.claude-plugin/plugin.json", { name: "compatible", hooks: { PostToolUseFailure: [{ matcher: "Bash", hooks: [{ type: "command", command: process.execPath, args: ["${CLAUDE_PLUGIN_ROOT}/failure.mjs", "${CLAUDE_PROJECT_DIR}/failure-input.json"] }] }] } });
  await f.write("plugin/failure.mjs", `import {writeFileSync} from 'node:fs';let input='';process.stdin.on('data',chunk=>input+=chunk);process.stdin.on('end',()=>{const value=JSON.parse(input);writeFileSync(process.argv[2],JSON.stringify({value,project:process.env.CLAUDE_PROJECT_DIR}));process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'PostToolUseFailure',additionalContext:'Inspect the failing fixture before retrying'}}));});`);
  await addMarketplace(f.root, f.market, f.options);
  const result = await installMarketplacePlugin(f.root, "compatible@team", f.options);
  assert.deepEqual(await runHooks(f.root, "after_tool_failure", {}, f.options), []);
  const marker = path.join(f.root, "failure-input.json"); await assert.rejects(fs.access(marker), { code: "ENOENT" });
  await setExtensionState(f.root, result.plugin.id, "trust", f.options); await setExtensionState(f.root, result.plugin.id, "enable", f.options);
  assert.deepEqual(await runHooks(f.root, "after_tool_failure", { tool: "read_file" }, f.options), []);
  const outcomes = await runHooks(f.root, "after_tool_failure", { tool: "run_command", input: { command: "node failing.mjs" }, error: "Exit code 1", sessionId: "actual-session", workspace: f.root, duration_ms: 5 }, f.options);
  assert.equal(outcomes.length, 1); assert.equal(outcomes[0].ok, true); assert.equal(outcomes[0].additionalContext, "Inspect the failing fixture before retrying");
  const observed = JSON.parse(await fs.readFile(marker, "utf8")); assert.equal(observed.value.error, "Exit code 1"); assert.equal(observed.project, f.root); assert.equal(observed.value.cwd, f.root);
  await setExtensionState(f.root, result.plugin.id, "disable", f.options); await fs.unlink(marker);
  assert.deepEqual(await runHooks(f.root, "after_tool_failure", { tool: "run_command" }, f.options), []);
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
});
