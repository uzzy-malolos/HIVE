import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { compatibleManifest } from "../dist/extensions/marketplace-compat.js";
import { addMarketplace, installMarketplacePlugin } from "../dist/extensions/marketplace.js";
import { readGitTree, writeTree } from "../dist/extensions/marketplace-io.js";
import { discoverExtensions, installLocalPlugin, loadSkill, setExtensionState } from "../dist/extensions/catalog.js";
import { connectMcp } from "../dist/extensions/mcp.js";
import { readSkillReference } from "../dist/extensions/skill-files.js";

const treeFile = (name, value) => ({ name, bytes: Buffer.from(typeof value === "object" ? JSON.stringify(value) : value), executable: false });
const manifestFile = (value) => treeFile(".claude-plugin/plugin.json", { name: "compatible", ...value });
const convert = (value, files = [], entry = {}) => compatibleManifest([manifestFile(value), ...files], "compatible.team", "C:\\test workspace\\plugin", entry);
const imported = (result) => JSON.parse(result.files.find((file) => file.name === "hive.plugin.json").bytes);

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hive-plugin-compatibility-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "workspace"); const market = path.join(temporary, "market");
  await fs.mkdir(root); await fs.mkdir(market);
  const options = { trustStateDir: path.join(temporary, "trust") };
  const write = async (file, value) => { const target = path.join(market, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, typeof value === "object" && !Buffer.isBuffer(value) ? JSON.stringify(value) : value); return target; };
  const publish = async (manifest, files = []) => {
    await write(".claude-plugin/marketplace.json", { name: "team", plugins: [{ name: "compatible", source: "./plugin" }] });
    await write("plugin/.claude-plugin/plugin.json", { name: "compatible", ...manifest });
    for (const file of files) await write(`plugin/${file.name}`, file.bytes);
    await addMarketplace(root, market, options);
    return installMarketplacePlugin(root, "compatible@team", options);
  };
  return { temporary, root, market, options, write, publish };
}

test("Claude directory forms add skills, replace default commands and interpolate installed Markdown paths", () => {
  const result = convert({ skills: ["./extra-skills/", "./direct/"], commands: ["./custom/", "./single.md"] }, [
    treeFile("skills/base/SKILL.md", "---\nname: base\n---\nBase skill."),
    treeFile("extra-skills/check/SKILL.md", "---\nname: check\n---\nRead ${CLAUDE_PLUGIN_ROOT}/shared/check.md"),
    treeFile("direct/SKILL.md", "---\nname: direct\n---\nDirect skill."),
    treeFile("commands/ignored.md", "Ignored default command."),
    treeFile("custom/review.md", "---\ndescription: Review the repository\n---\nReview ${CLAUDE_PLUGIN_ROOT}/shared/check.md"),
    treeFile("single.md", "Single command."), treeFile("shared/check.md", "Reference ${CLAUDE_PLUGIN_ROOT}/scripts/check.mjs"),
  ]);
  const manifest = imported(result);
  assert.deepEqual(manifest.skills, ["skills/base/SKILL.md", "extra-skills/check/SKILL.md", "direct/SKILL.md", ".hive-imported/commands/review/SKILL.md", ".hive-imported/commands/single/SKILL.md"]);
  assert.equal(result.files.some((file) => file.name.includes("/ignored/SKILL.md")), false);
  const command = result.files.find((file) => file.name === ".hive-imported/commands/review/SKILL.md").bytes.toString();
  assert.match(command, /description: "Review the repository"/);
  assert.match(command, /original source "custom\/review.md"; resolve relative links from plugin-root directory "custom"/);
  assert.match(command, /C:\/test workspace\/plugin\/shared\/check.md/);
  assert.match(result.files.find((file) => file.name === "shared/check.md").bytes.toString(), /C:\/test workspace\/plugin\/scripts\/check.mjs/);
  assert.deepEqual(result.warnings, []);
  assert.deepEqual(imported(convert({ commands: "./" }, [treeFile("root-command.md", "Root command body.")])).skills, [".hive-imported/commands/root-command/SKILL.md"]);
});

test("Claude root skills and command maps import with explicit inactive routing and permission metadata", () => {
  const root = treeFile("SKILL.md", "---\nname: root-skill\ndescription: Root instructions\n---\nRoot body.");
  assert.deepEqual(imported(convert({}, [root])).skills, ["SKILL.md"]);
  assert.deepEqual(imported(convert({ skills: "./" }, [root])).skills, ["SKILL.md"]);
  assert.match(convert({}, [treeFile("SKILL.md", "Root instructions without metadata.")]).files.find((file) => file.name === "SKILL.md").bytes.toString(), /^---\nname: compatible.team\n/);
  const scoped = convert({}, [root, treeFile("skills/other/SKILL.md", "Other package."), treeFile("selected/SKILL.md", "Selected package.")], { source: ".", skills: "./selected/" });
  assert.deepEqual(imported(scoped).skills, ["selected/SKILL.md"]);
  const result = convert({ commands: { source: { source: "./source.md", argumentHint: "[file]", model: "other-model", allowedTools: ["Bash"] }, inline: { content: "Use $ARGUMENTS and !`git status`." } } }, [
    treeFile("source.md", "---\nallowed-tools: Bash\nmodel: other\n---\nSource body."),
  ]);
  assert.equal(imported(result).skills.length, 2);
  assert.match(result.warnings.join("\n"), /allowedTools.*HIVE provider, permissions/);
  assert.match(result.warnings.join("\n"), /allowed-tools.*instruction metadata only/);
  assert.match(result.warnings.join("\n"), /shell preprocessing is not executed/);
  assert.match(result.files.find((file) => file.name === ".hive-imported/commands/inline/SKILL.md").bytes.toString(), /original source "inline plugin manifest"; resolve relative links from plugin-root directory "\."/);
  for (const command of [{}, { source: "./source.md", content: "both" }, { content: 12 }]) assert.throws(() => convert({ commands: { bad: command } }), /exactly one|content must be a string/);
  assert.throws(() => convert({ commands: { bad: { source: "./script.js" } } }, [treeFile("script.js", "Body")]), /Markdown file/);
  assert.throws(() => convert({ skills: "./empty/" }, [treeFile("empty/readme.md", "No skill.")]), /no SKILL.md/);
  assert.throws(() => convert({ skills: "./skills/" }), /no SKILL.md/);
  assert.throws(() => convert({ commands: { bad: { content: "---\nmodel: x" } } }), /Unterminated/);
  assert.match(convert({ commands: { empty: { content: "---\n---\nBody after empty metadata." } } }).files.find((file) => file.name === ".hive-imported/commands/empty/SKILL.md").bytes.toString(), /Body after empty metadata/);
});

test("Claude MCP mixed config arrays merge default files in order and reject ambiguous transports", () => {
  const result = convert({ mcpServers: ["./config/servers.json", { replace: { type: "http", url: "https://example.test/last", headers: { Authorization: "Bearer ${HIVE_PLUGIN_API_KEY}" } }, extra: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/extra.mjs"] } }] }, [
    treeFile(".mcp.json", { replace: { type: "http", url: "https://example.test/default" }, base: { command: "node", args: [] } }),
    treeFile("config/servers.json", { mcpServers: { replace: { type: "http", url: "https://example.test/first" }, file: { command: "node" } } }),
  ]);
  const servers = imported(result).mcpServers;
  assert.deepEqual(Object.keys(servers), ["replace", "base", "file", "extra"]);
  assert.equal(servers.replace.url, "https://example.test/last");
  assert.equal(servers.replace.bearerTokenEnv, "HIVE_PLUGIN_API_KEY");
  assert.equal(servers.extra.args[0], "C:\\test workspace\\plugin/extra.mjs");
  for (const server of [
    { type: "http", transport: "stdio", url: "https://example.test/mcp" },
    { transport: "sse", url: "https://example.test/mcp" },
    { type: "http", url: "https://example.test/mcp", command: "node" },
    { command: "node", headers: {} },
    { url: "https://${PRIVATE_HOST}/mcp" },
  ]) assert.throws(() => convert({ mcpServers: { bad: server } }), /agree|Streamable HTTP|process fields|HTTP fields|unresolved/);
  for (const value of ["./server.mcpb", "https://example.test/server.dxt"]) assert.throws(() => convert({ mcpServers: value }), /binary bundles/);
  assert.throws(() => convert({ mcpServers: ["./missing.json"] }), /Missing MCP configuration/);
  assert.throws(() => convert({ mcpServers: [["./config.json"]] }), /must be an object/);
});

test("Claude unsupported components and unsafe paths fail instead of registering a partial interpretation", () => {
  for (const key of ["themes", "monitors", "workflows", "channels", "settings", "experimental"]) {
    assert.throws(() => convert({ [key]: ["./component"] }), /not supported/);
    assert.throws(() => convert({}, [], { [key]: ["./component"] }), /not supported/);
  }
  assert.throws(() => convert({ dependencies: "unvalidated dependency" }), /dependencies/);
  assert.throws(() => convert({ dependencies: [{ name: "fixture", version: "latest" }] }), /version range/);
  assert.throws(() => convert({ agents: ["./missing.md"] }), /existing Markdown/);
  assert.throws(() => convert({ lspServers: { broken: { command: "node" } } }), /extensionToLanguage/);
  for (const name of ["themes/default.json", "monitors/monitors.json", "settings.json", "bin/tool"]) assert.throws(() => convert({}, [treeFile(name, "{}")]), /unsupported/);
  for (const value of ["/", "../outside/", "./safe//", "./safe/../outside/", "C:/outside/"]) assert.throws(() => convert({ skills: value }), /paths/);
  assert.throws(() => convert({}, [], { strict: false, commands: "./commands" }), /conflicts/);
  assert.throws(() => convert({}, [], { strict: "false" }), /boolean/);
  assert.throws(() => convert({ skills: "./custom/" }, [treeFile("custom/SKILL.md", "Use ${CLAUDE_PLUGIN_DATA}/state")] ), /unsupported Claude/);
});

test("installed Claude MCP safe literal settings and explicit credentials reach only the trusted real process", async (t) => {
  const f = await fixture(t);
  const previous = process.env.HIVE_PLUGIN_CREDENTIAL_TEST; const unrelated = process.env.HIVE_PLUGIN_UNRELATED_TEST;
  process.env.HIVE_PLUGIN_CREDENTIAL_TEST = "opaque-plugin-test-credential"; process.env.HIVE_PLUGIN_UNRELATED_TEST = "must-not-reach-plugin";
  t.after(() => { if (previous === undefined) delete process.env.HIVE_PLUGIN_CREDENTIAL_TEST; else process.env.HIVE_PLUGIN_CREDENTIAL_TEST = previous; if (unrelated === undefined) delete process.env.HIVE_PLUGIN_UNRELATED_TEST; else process.env.HIVE_PLUGIN_UNRELATED_TEST = unrelated; });
  const marker = path.join(f.root, "started.txt");
  const script = `import readline from 'node:readline'; import { writeFileSync } from 'node:fs';
writeFileSync(process.env.RUN_MARKER,String(process.pid));
const send=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
readline.createInterface({input:process.stdin}).on('line',line=>{ const m=JSON.parse(line);
if(m.method==='initialize') send(m.id,{protocolVersion:'2025-11-25',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}});
if(m.method==='tools/list') send(m.id,{tools:[{name:'settings',inputSchema:{type:'object'}}]});
if(m.method==='tools/call') send(m.id,{content:[{type:'text',text:JSON.stringify({mode:process.env.NODE_ENV,root:process.env.BUNDLE_ROOT,key:process.env.API_KEY,unrelated:process.env.HIVE_PLUGIN_UNRELATED_TEST})}]});
}).on('close',()=>process.exit(0));`;
  const result = await f.publish({ commands: { guide: { source: "./commands/guide.md" } }, mcpServers: ["./config/mcp.json", { fixture: { command: process.execPath, args: ["${CLAUDE_PLUGIN_ROOT}/server.mjs"], env: { NODE_ENV: "production", BUNDLE_ROOT: "${CLAUDE_PLUGIN_ROOT}", RUN_MARKER: marker, API_KEY: "${HIVE_PLUGIN_CREDENTIAL_TEST}" } } }] }, [treeFile("server.mjs", script), treeFile("config/mcp.json", {}), treeFile("commands/guide.md", "Read ../docs/guide.md or ${CLAUDE_PLUGIN_ROOT}/docs/guide.md."), treeFile("docs/guide.md", "Managed plugin guide.")]);
  const installed = result.plugin.path;
  assert.deepEqual(result.warnings, []);
  let catalog = await discoverExtensions(f.root, f.options); assert.deepEqual(catalog.diagnostics, []);
  assert.deepEqual(catalog.servers[0].process.env, { NODE_ENV: "production", BUNDLE_ROOT: installed, RUN_MARKER: marker, CLAUDE_PLUGIN_ROOT: installed });
  assert.deepEqual(catalog.servers[0].process.envRefs, { API_KEY: "HIVE_PLUGIN_CREDENTIAL_TEST" });
  await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  await assert.rejects(connectMcp(f.root, "compatible.team.fixture", f.options), /untrusted/);
  await setExtensionState(f.root, result.plugin.id, "trust", f.options); await setExtensionState(f.root, result.plugin.id, "enable", f.options);
  assert.equal((await readSkillReference(f.root, "compatible.team.guide", path.join(installed, "docs/guide.md"), { ...f.options, scope: "plugin" })).content, "Managed plugin guide.");
  const connection = await connectMcp(f.root, "compatible.team.fixture", f.options);
  let pid;
  try {
    pid = Number(await fs.readFile(marker, "utf8"));
    assert.deepEqual((await connection.listTools()).map((tool) => tool.name), ["settings"]);
    assert.deepEqual(JSON.parse((await connection.callTool("settings", {})).content[0].text), { mode: "production", root: installed, key: "[REDACTED]" });
  } finally { await connection.close(); }
  assert.throws(() => process.kill(pid, 0));
  await fs.appendFile(path.join(installed, "server.mjs"), "\n// Source drift after verification.\n");
  catalog = await discoverExtensions(f.root, f.options); assert.equal(catalog.servers.length, 0); assert.match(catalog.diagnostics.join("\n"), /files changed after installation/);
});

test("literal secrets and conflicting references never register imported Claude MCP plugins", async (t) => {
  for (const env of [{ SECRET: "plaintext" }, { API_TOKEN: "opaque-token" }, { NODE_ENV: `sk-${"x".repeat(32)}` }, { DATABASE_URL: "postgresql://user:password@example.test/db" }, { ENDPOINT: "https://example.test/service?api_key=opaque-value" }]) {
    const f = await fixture(t);
    await assert.rejects(f.publish({ mcpServers: { fixture: { command: process.execPath, env } } }), /environment values|credential|secret/i);
    assert.equal((await discoverExtensions(f.root, f.options)).plugins.length, 0);
  }
  assert.throws(() => convert({ mcpServers: { fixture: { command: "node", env: { NODE_ENV: "production" }, envRefs: { NODE_ENV: "OTHER_ENV" } } } }), /cannot override/);
  assert.throws(() => convert({ mcpServers: { fixture: { command: "node", env: { ROOT: "${CLAUDE_PROJECT_DIR}" } } } }), /unsupported Claude/);
  assert.throws(() => convert({ mcpServers: { fixture: { command: "node", env: JSON.parse('{"__proto__":"production"}') } } }), /__proto__/);
});

test("pinned Git command and skill imports remain inert, usable after trust and invalid after source drift", async (t) => {
  const f = await fixture(t);
  await f.write(".claude-plugin/plugin.json", { name: "compatible", skills: "./extra/", commands: { explain: { source: "./prompts/explain.md" } } });
  await f.write("extra/audit/SKILL.md", "---\nname: audit\ndescription: Audit code\n---\nInspect ${CLAUDE_PLUGIN_ROOT}/guide.md\n");
  await f.write("prompts/explain.md", "Explain the changed source files. Read [Guide](../guide.md) and ${CLAUDE_PLUGIN_ROOT}/guide.md."); await f.write("guide.md", "Read all relevant callers.");
  const git = (...args) => { const result = spawnSync("git", args, { cwd: f.market, windowsHide: true, encoding: "utf8" }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  git("init", "--template=", "."); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "add", "--all"); git("-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", "commit", "-m", "Pinned compatible plugin");
  const commit = git("rev-parse", "HEAD");
  const snapshot = await readGitTree(path.join(f.temporary, "bare"), f.market, undefined, commit);
  assert.equal(snapshot.commit, commit);
  const destination = path.join(f.root, "plugin");
  const converted = compatibleManifest(snapshot.files, "compatible.team", destination, {}); await writeTree(destination, converted.files);
  const plugin = await installLocalPlugin(f.root, "compatible.team", destination, f.options);
  assert.equal(plugin.trusted, false); assert.equal(plugin.enabled, false);
  await assert.rejects(loadSkill(f.root, "compatible.team.explain", f.options), /untrusted/);
  await setExtensionState(f.root, plugin.id, "trust", f.options); await setExtensionState(f.root, plugin.id, "enable", f.options);
  assert.match((await loadSkill(f.root, "compatible.team.audit", f.options)).text, /Read|Inspect/);
  const command = await loadSkill(f.root, "compatible.team.explain", f.options);
  assert.match(command.text, /Explain the changed source/);
  assert.match(command.text, /original source "prompts\/explain.md"; resolve relative links from plugin-root directory "prompts"/);
  await assert.rejects(readSkillReference(f.root, command.id, "guide.md", f.options), /does not exist/);
  assert.equal((await readSkillReference(f.root, command.id, "guide.md", { ...f.options, scope: "plugin" })).content, "Read all relevant callers.");
  assert.equal((await readSkillReference(f.root, command.id, path.join(destination, "guide.md"), { ...f.options, scope: "plugin" })).content, "Read all relevant callers.");
  const outside = path.join(f.temporary, "outside.md"); await fs.writeFile(outside, "Other package instructions must stay outside this scope.");
  await assert.rejects(readSkillReference(f.root, command.id, outside, { ...f.options, scope: "plugin" }), /inside|outside|root|scope/iu);
  await assert.rejects(readSkillReference(f.root, command.id, "../outside.md", { ...f.options, scope: "plugin" }), /traversal|inside|root/iu);
  await fs.appendFile(path.join(destination, "extra/audit/SKILL.md"), "\nChanged instructions.");
  await assert.rejects(loadSkill(f.root, "compatible.team.audit", f.options), /untrusted/);
});
