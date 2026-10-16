import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { compatibleManifest } from "../dist/extensions/marketplace-compat.js";
import { parsePluginOutputStyle, pluginOutputStyleKey, renderPluginOutputStyle } from "../dist/extensions/plugin-output-styles.js";
import { markdownContent } from "../dist/extensions/marketplace-markdown.js";
import { discoverExtensions, loadTrustedPluginOutputStyle, setExtensionState } from "../dist/extensions/catalog.js";
import { addMarketplace, installMarketplacePlugin } from "../dist/extensions/marketplace.js";

const file = (name, content) => ({ name, bytes: Buffer.from(typeof content === "string" ? content : JSON.stringify(content)), executable: false });
const imported = (manifest = {}, files = [], entry = {}) => compatibleManifest([file(".claude-plugin/plugin.json", { name: "styles", ...manifest }), ...files], "styles.team", "C:/fixture/styles", entry);
const nativeManifest = (result) => JSON.parse(result.files.find((entry) => entry.name === "hive.plugin.json").bytes.toString());
const body = "Lead each answer with the observed result, then explain necessary evidence.\n";

test("output style Markdown has optional frontmatter and keeps display names separate from stable namespace keys", () => {
  const plain = parsePluginOutputStyle(body, "output-styles/concise.md");
  assert.equal(plain.name, "concise"); assert.equal(plain.key, "concise"); assert.equal(plain.instructions, body.trim());
  assert.equal(plain.keepCodingInstructions, false); assert.equal(plain.forceForPlugin, false);
  assert.match(plain.warnings.join("\n"), /HIVE keeps its core engineering/);
  const text = `---\nname: "Diagrams first"\ndescription: >\n  Explain the shape\n  before the details\nkeep-coding-instructions: true # retain engineering rules\nforce-for-plugin: false\n---\n${body}`;
  const named = parsePluginOutputStyle(text, "C:/installed/output-styles/team/diagram.md", "output-styles/team/diagram.md");
  assert.equal(named.name, "Diagrams first"); assert.equal(named.key, "team.diagram");
  assert.equal(named.description, "Explain the shape before the details"); assert.deepEqual(named.warnings, []);
  assert.equal(parsePluginOutputStyle(text.replace("Diagrams first", "Different display"), named.path, "output-styles/team/diagram.md").key, named.key);
  assert.equal(pluginOutputStyleKey("output-styles/diagram first.md"), pluginOutputStyleKey("output-styles/diagram first.md"));
  assert.notEqual(pluginOutputStyleKey("output-styles/diagram first.md"), pluginOutputStyleKey("output-styles/diagram-first.md"));
});

test("styles cannot auto-select or replace HIVE policies through metadata", () => {
  const parsed = parsePluginOutputStyle(`---\nforce-for-plugin: true\nkeep-coding-instructions: false\nfuture-field: inert\n---\n${body}`, "output-styles/force.md");
  assert.equal(parsed.forceForPlugin, true); assert.equal(parsed.keepCodingInstructions, false);
  assert.match(parsed.warnings.join("\n"), /explicit user selection is required/);
  assert.match(parsed.warnings.join("\n"), /unknown frontmatter field future-field is ignored/);
  const rendered = renderPluginOutputStyle({ ...parsed, id: "style:styles.team.force" });
  assert.match(rendered, /Explicitly selected plugin output style/); assert.match(rendered, /cannot grant capabilities/);
  assert.ok(rendered.endsWith(body.trim()));
});

test("output style frontmatter and instruction sizes are bounded and reject executable YAML", () => {
  for (const header of ["name: one\nname: two\n", "name: &alias value\n", "name: !<execute> value\n", "keep-coding-instructions: yes\n", 'keep-coding-instructions: "true"\n', "keep-coding-instructions: |\n  true\n", "force-for-plugin: []\n", "force-for-plugin: true\nforce-for-plugin: false\n", "name: [one, two]\n", 'name: "unterminated\n']) {
    assert.throws(() => parsePluginOutputStyle(`---\n${header}---\n${body}`, "output-styles/a.md"), /frontmatter|boolean|quoted/);
  }
  assert.throws(() => parsePluginOutputStyle("---\nname: incomplete", "output-styles/a.md"), /unterminated/);
  assert.throws(() => parsePluginOutputStyle(" ", "output-styles/a.md"), /nonempty/);
  assert.throws(() => parsePluginOutputStyle("x".repeat(65_537), "output-styles/a.md"), /exceeds/);
  assert.throws(() => parsePluginOutputStyle("answer\0", "output-styles/a.md"), /NUL/);
  assert.throws(() => pluginOutputStyleKey("../outside.md"), /traversal/);
  assert.throws(() => pluginOutputStyleKey("output-styles/a.js"), /Markdown/);
});

test("default Claude output-style files convert into inert native manifest contributions", () => {
  const result = imported({}, [file("output-styles/concise.md", body), file("output-styles/team/detailed.md", `---\nkeep-coding-instructions: true\n---\n${body}`)]);
  assert.deepEqual(nativeManifest(result).outputStyles, ["output-styles/concise.md", "output-styles/team/detailed.md"]);
  assert.equal(result.files.filter((entry) => entry.name.startsWith(".hive-imported/")).length, 0);
  assert.doesNotMatch(result.warnings.join("\n"), /no supported contributions/);
  assert.match(result.warnings.join("\n"), /HIVE keeps its core engineering/);
  const native = compatibleManifest([file("hive.plugin.json", nativeManifest(result)), ...result.files.filter((entry) => entry.name !== "hive.plugin.json")], "renamed", "C:/fixture/renamed", {});
  assert.equal(nativeManifest(native).name, "renamed"); assert.deepEqual(nativeManifest(native).outputStyles, nativeManifest(result).outputStyles);
});

test("declared Claude output-style files and directories replace defaults and merge marketplace declarations", () => {
  const files = [file("output-styles/default.md", body), file("custom/one.md", body), file("custom/nested/two.md", body), file("extra.md", body)];
  const result = imported({ outputStyles: ["./custom/"] }, files, { outputStyles: "./extra.md" });
  assert.deepEqual(nativeManifest(result).outputStyles, ["custom/one.md", "custom/nested/two.md", "extra.md"]);
  assert.deepEqual(nativeManifest(imported({ outputStyles: [] }, files)).outputStyles, []);
  assert.deepEqual(nativeManifest(imported({ outputStyles: ["./custom/one.md", "./custom/"] }, files)).outputStyles, ["custom/one.md", "custom/nested/two.md"]);
  assert.throws(() => imported({ outputStyles: "./missing/" }, files), /no Markdown files/);
  assert.throws(() => imported({ outputStyles: "../outside" }, files), /traversal/);
  assert.throws(() => imported({}, files, { strict: false, outputStyles: "./extra.md" }), /strict:false/);
  assert.throws(() => imported({}, [file("output-styles/a.b.md", body), file("output-styles/a/b.md", body)]), /Duplicate output style key/);
  assert.throws(() => imported({}, Array.from({ length: 129 }, (_, index) => file(`output-styles/style${index}.md`, body))), /128 files/);
});

test("plugin-root interpolation in styles is deterministic and never runs shell preprocessing", () => {
  const result = imported({}, [file("output-styles/reference.md", `---\nkeep-coding-instructions: true\n---\nRead \${CLAUDE_PLUGIN_ROOT}/guide.md if relevant. Literal !\`node never-run.mjs\` is reference text.`)]);
  assert.match(result.files.find((entry) => entry.name === "output-styles/reference.md").bytes.toString(), /C:\/fixture\/styles\/guide\.md/);
  assert.throws(() => imported({}, [file("output-styles/reference.md", "Read ${CLAUDE_PLUGIN_DATA}/guide.md")]), /unsupported Claude/);
});

test("converted commands preserve native invocation booleans and leave shell preprocessing visibly unsupported", () => {
  const text = "---\ndescription: A command\nuser-invocable: false\ndisable-model-invocation: true\n---\nReview $ARGUMENTS and $1; literal !`node never-run.mjs`.";
  const result = imported({}, [file("commands/review.md", text)]);
  const converted = result.files.find((entry) => entry.name === ".hive-imported/commands/review/SKILL.md").bytes.toString();
  assert.match(converted, /^user-invocable: false$/mu); assert.match(converted, /^disable-model-invocation: true$/mu);
  assert.match(result.warnings.join("\n"), /shell preprocessing is not executed/);
  assert.doesNotMatch(result.warnings.join("\n"), /argument placeholders.*not expanded|user-invocable.*metadata only|disable-model-invocation.*metadata only/);
  assert.equal(markdownContent(text, "review", new Set()).disableModelInvocation, true);
  for (const field of ["user-invocable", "disable-model-invocation"]) for (const value of ['"true"', "yes", "false\n" + field + ": true"]) assert.throws(() => markdownContent(`---\n${field}: ${value}\n---\nReview`, "review", new Set()), /unique boolean/);
});

test("converted commands preserve argument hints and reject unsupported named declarations before dropping metadata", () => {
  const frontmatterHint = imported({}, [file("commands/review.md", "---\nargument-hint: '[issue] [branch]'\n---\nReview $0 on $1.")]);
  assert.match(frontmatterHint.files.find((entry) => entry.name === ".hive-imported/commands/review/SKILL.md").bytes.toString(), /^argument-hint: "\[issue\] \[branch\]"$/mu);
  const inline = imported({ commands: { review: { content: body, argumentHint: "[target]" } } });
  assert.match(inline.files.find((entry) => entry.name === ".hive-imported/commands/review/SKILL.md").bytes.toString(), /^argument-hint: "\[target\]"$/mu);
  for (const declaration of ["issue branch", "[issue, branch]", "\n  - issue\n  - branch", "{name: issue}", "&alias names", "[issue, issue]", "[]", "\n  issue: nested", "[issue", "issue\narguments: branch"]) assert.throws(() => imported({}, [file("commands/review.md", `---\narguments: ${declaration}\n---\nReview`)]), /named skill arguments are unsupported/);
});

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hive-plugin-style-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "workspace with spaces"), market = path.join(temporary, "market");
  await fs.mkdir(root); await fs.mkdir(market);
  const options = { trustStateDir: path.join(temporary, "trust") };
  const write = async (name, data) => { const target = path.join(market, name); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, typeof data === "string" ? data : JSON.stringify(data)); };
  await write(".claude-plugin/marketplace.json", { name: "team", plugins: [{ name: "styles", source: "./plugin" }] });
  await write("plugin/.claude-plugin/plugin.json", { name: "styles" });
  return { root, market, options, write };
}

test("real marketplace output styles install inertly and require both plugin and style trust", async (t) => {
  const f = await fixture(t);
  await f.write("plugin/output-styles/concise.md", `---\nname: Concise result\nforce-for-plugin: true\nkeep-coding-instructions: true\n---\n${body}`);
  await f.write("plugin/never-run.mjs", "throw Error('Discovery must not execute plugin source');\n");
  await addMarketplace(f.root, f.market, f.options);
  const result = await installMarketplacePlugin(f.root, "styles@team", f.options);
  let catalog = await discoverExtensions(f.root, f.options);
  assert.equal(catalog.diagnostics.length, 0); assert.equal(catalog.outputStyles.length, 1);
  const style = catalog.outputStyles[0];
  assert.equal(style.id, `style:${result.plugin.name}.concise`); assert.equal(style.name, "Concise result");
  assert.equal(style.trusted, false); assert.equal(style.enabled, false);
  await assert.rejects(loadTrustedPluginOutputStyle(f.root, style.id, f.options), /trusted|enabled/);
  await setExtensionState(f.root, result.plugin.id, "trust", f.options); await setExtensionState(f.root, result.plugin.id, "enable", f.options);
  catalog = await discoverExtensions(f.root, f.options);
  assert.equal(catalog.outputStyles[0].trusted, true); assert.equal(catalog.outputStyles[0].enabled, true);
  const loaded = await loadTrustedPluginOutputStyle(f.root, style.id, f.options);
  assert.equal(loaded.instructions, body.trim()); assert.equal(loaded.forceForPlugin, true);
  const config = JSON.parse(await fs.readFile(path.join(f.root, ".hive", "extensions.json"), "utf8"));
  assert.equal(config.outputStyle, undefined, "force-for-plugin cannot silently choose a user setting");
  await setExtensionState(f.root, style.id, "untrust", f.options);
  await assert.rejects(loadTrustedPluginOutputStyle(f.root, style.id, f.options), /trusted|untrusted/);
});

test("changed style bodies and revoked plugin trust prevent reuse of an earlier selected descriptor", async (t) => {
  const f = await fixture(t);
  await f.write("plugin/output-styles/concise.md", body);
  await addMarketplace(f.root, f.market, f.options);
  const result = await installMarketplacePlugin(f.root, "styles@team", f.options);
  await setExtensionState(f.root, result.plugin.id, "trust", f.options); await setExtensionState(f.root, result.plugin.id, "enable", f.options);
  const style = (await discoverExtensions(f.root, f.options)).outputStyles[0];
  await loadTrustedPluginOutputStyle(f.root, style.id, f.options);
  await setExtensionState(f.root, result.plugin.id, "untrust", f.options);
  await assert.rejects(loadTrustedPluginOutputStyle(f.root, style.id, f.options), /trusted|untrusted/);
  await setExtensionState(f.root, result.plugin.id, "trust", f.options);
  await fs.writeFile(style.path, body + "Change the response after selection.\n");
  await assert.rejects(loadTrustedPluginOutputStyle(f.root, style.id, f.options), /changed|integrity|Unknown|not found|discovered/i);
});
