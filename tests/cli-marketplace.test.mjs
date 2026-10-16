import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import https from "node:https";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { addMarketplace, installMarketplacePlugin, listMarketplaces, listMarketplacePlugins, marketplaceCommand, removeMarketplace, updateMarketplace } from "../dist/extensions/marketplace.js";
import { bundlePath, downloadManifest, gitAddressPin, readGitTree, readLocalTree, safeRemote, treeDigest, writeTree } from "../dist/extensions/marketplace-io.js";
import { discoverExtensions, loadSkill, setExtensionState } from "../dist/extensions/catalog.js";

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hive-marketplace-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "workspace"); const market = path.join(temporary, "market"); await fs.mkdir(root); await fs.mkdir(market);
  const options = { trustStateDir: path.join(temporary, "trust") };
  const write = async (file, content) => { const target = path.join(market, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, typeof content === "object" && !Buffer.isBuffer(content) ? JSON.stringify(content) : content); return target; };
  const manifest = (plugins = [{ name: "review", source: "./plugins/review", description: "Read changes" }]) => write(".claude-plugin/marketplace.json", { name: "team", owner: { name: "Local fixture" }, plugins });
  const bundle = async (name = "review") => {
    await write(`plugins/${name}/.claude-plugin/plugin.json`, { name, description: "Review helper", version: "1.0.0" });
    await write(`plugins/${name}/skills/check/SKILL.md`, "---\nname: check\ndescription: Check changed files\n---\nInspect the changed code and report problems.\n");
    await write(`plugins/${name}/commands/status.md`, "---\ndescription: Explain repository status\n---\nExplain the current repository status.\n");
    await write(`plugins/${name}/server.cjs`, "require('node:fs').writeFileSync('MUST_NOT_RUN', 'bad');\n");
    await write(`plugins/${name}/.mcp.json`, { review: { command: "node", args: ["${CLAUDE_PLUGIN_ROOT}/server.cjs"], env: { REMOTE_KEY: "${HIVE_TEST_MARKET_KEY}" } } });
  };
  return { temporary, root, market, options, write, manifest, bundle };
}

test("Claude marketplace install snapshots skills, commands and MCP without executing or trusting contributions", async (t) => {
  const f = await fixture(t); await f.manifest(); await f.bundle();
  const added = await addMarketplace(f.root, f.market, f.options);
  assert.equal(added.record.name, "team"); assert.match(added.record.treeHash, /^[a-f0-9]{64}$/);
  assert.deepEqual(added.diagnostics, []); assert.equal((await listMarketplaces(f.root, f.options)).length, 1);
  const result = await installMarketplacePlugin(f.root, "review@team", f.options);
  assert.equal(result.plugin.id, "plugin:review.team"); assert.equal(result.plugin.trusted, false); assert.equal(result.plugin.enabled, false);
  const catalog = await discoverExtensions(f.root, f.options); assert.deepEqual(catalog.diagnostics, []);
  assert.deepEqual(catalog.skills.map((entry) => entry.id).sort(), ["skill:review.team.check", "skill:review.team.status"]);
  assert.equal(path.resolve(catalog.servers[0].process.args[0]), path.join(result.plugin.path, "server.cjs"));
  assert.deepEqual(catalog.servers[0].process.envRefs, { REMOTE_KEY: "HIVE_TEST_MARKET_KEY" });
  for (const entry of [...catalog.plugins, ...catalog.skills, ...catalog.servers]) { assert.equal(entry.trusted, false); assert.equal(entry.enabled, false); }
  await assert.rejects(fs.stat(path.join(result.plugin.path, "MUST_NOT_RUN")), { code: "ENOENT" });
  const provenance = JSON.parse(await fs.readFile(path.join(result.plugin.path, "hive.marketplace.json"), "utf8")); assert.equal(provenance.selector, "review@team"); assert.equal(provenance.treeHash, result.treeHash);
  await setExtensionState(f.root, result.plugin.id, "trust", f.options); await setExtensionState(f.root, result.plugin.id, "enable", f.options);
  assert.match((await loadSkill(f.root, "review.team.status", f.options)).text, /Explain the current repository status/);
});

test("marketplace and plugin updates are explicit, revoke trust, preserve unrelated config and old snapshots", async (t) => {
  const f = await fixture(t); await f.manifest(); await f.bundle(); await addMarketplace(f.root, f.market, f.options);
  const initialMarketHash = (await listMarketplaces(f.root, f.options))[0].treeHash;
  const original = await installMarketplacePlugin(f.root, "review@team", f.options); await setExtensionState(f.root, original.plugin.id, "trust", f.options); await setExtensionState(f.root, original.plugin.id, "enable", f.options);
  const configPath = path.join(f.root, ".hive", "extensions.json"); const before = JSON.parse(await fs.readFile(configPath, "utf8"));
  before.mcpServers = { existing: { transport: "http", url: "https://example.test/mcp", enabled: false } }; await fs.writeFile(configPath, JSON.stringify(before));
  await f.write("plugins/review/skills/check/SKILL.md", "---\nname: check\ndescription: Updated\n---\nUpdated instructions.\n");
  const pinned = await installMarketplacePlugin(f.root, "review@team", { ...f.options, replace: true }); assert.equal(pinned.treeHash, original.treeHash);
  const changed = await updateMarketplace(f.root, "team", f.options); assert.notEqual(changed.record.treeHash, initialMarketHash);
  const updated = await installMarketplacePlugin(f.root, "review@team", { ...f.options, replace: true }); assert.notEqual(updated.treeHash, original.treeHash);
  assert.equal(updated.plugin.trusted, false); assert.equal(updated.plugin.enabled, false);
  assert.equal(JSON.parse(await fs.readFile(configPath, "utf8")).mcpServers.existing.url, "https://example.test/mcp");
  assert.match(await fs.readFile(path.join(original.plugin.path, "skills/check/SKILL.md"), "utf8"), /Inspect the changed code/);
  assert.match(await fs.readFile(path.join(updated.plugin.path, "skills/check/SKILL.md"), "utf8"), /Updated instructions/);
  await removeMarketplace(f.root, "team", f.options); assert.deepEqual(await listMarketplaces(f.root, f.options), []);
  assert.equal((await discoverExtensions(f.root, f.options)).plugins.length, 1);
  await assert.rejects(fs.stat(path.join(f.root, ".hive", "marketplaces", "operation.lock")), { code: "ENOENT" });
});

test("source drift, traversal, symlinks, hardlinks and unsupported execution sources fail before registration", async (t) => {
  const f = await fixture(t); await f.manifest([{ name: "escape", source: "./../outside" }, { name: "script", source: { source: "command", command: "node install.js" } }]);
  const added = await addMarketplace(f.root, f.market, f.options); assert.equal(added.plugins.length, 1); assert.equal(added.diagnostics.length, 2);
  await assert.rejects(installMarketplacePlugin(f.root, "script@team", f.options), /Unsupported marketplace plugin source/);
  const snapshot = path.join(f.root, ".hive", "marketplaces", added.record.snapshot, ".claude-plugin", "marketplace.json"); await fs.appendFile(snapshot, " ");
  await assert.rejects(listMarketplacePlugins(f.root, "team", f.options), /snapshot changed/);
  for (const input of ["../escape", "/absolute", "folder\\escape", "a:b", "a/../b", "CON.txt", "file. "]) assert.throws(() => bundlePath(input), /paths/);
  const second = await fixture(t); await second.manifest(); await second.bundle();
  const outside = path.join(second.temporary, "private.txt"); await fs.writeFile(outside, "private");
  await fs.link(outside, path.join(second.market, "linked.txt")); await assert.rejects(addMarketplace(second.root, second.market, second.options), /links/);
  await fs.unlink(path.join(second.market, "linked.txt"));
  try { await fs.symlink(outside, path.join(second.market, "symlink.txt")); } catch (error) { if (error.code === "EPERM") return; throw error; }
  await assert.rejects(addMarketplace(second.root, second.market, second.options), /links/);
});

test("HTTP manifest downloads are bounded, do not redirect and reject relative plugin installs", async (t) => {
  const f = await fixture(t); let route = "normal";
  const server = http.createServer((req, res) => {
    if (route === "redirect") { res.writeHead(302, { Location: "/other.json" }); res.end(); return; }
    res.writeHead(200, { "Content-Type": "application/json" });
    if (route === "oversize") { res.end(" ".repeat(512 * 1024 + 1)); return; }
    res.end(JSON.stringify({ name: "remote", plugins: [{ name: "relative", source: "./plugin" }] }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}/marketplace.json`; const options = { ...f.options, allowLoopback: true };
  await assert.rejects(addMarketplace(f.root, url, f.options), /HTTPS/);
  await addMarketplace(f.root, url, options); await assert.rejects(installMarketplacePlugin(f.root, "relative@remote", options), /URL-only/);
  route = "oversize"; await assert.rejects(updateMarketplace(f.root, "remote", options), /512 KiB/);
  route = "redirect"; await assert.rejects(updateMarketplace(f.root, "remote", options), /fetch failed|redirect/);
  assert.equal((await listMarketplaces(f.root, options)).length, 1);
  for (const address of ["https://user:pass@example.com/m.json", "https://example.com/m.json?token=oops", "https://127.0.0.1/m.json", "file:///secret", "https://169.254.169.254/"]) assert.throws(() => safeRemote(address), /Marketplace|marketplace/);
});

test("Git fetch pins objects and refuses symlinks and submodules without checking out or executing filters", async (t) => {
  const f = await fixture(t); await f.manifest(); await f.bundle();
  const command = (...args) => { const result = spawnSync("git", args, { cwd: f.market, encoding: "utf8", windowsHide: true }); assert.equal(result.status, 0, result.stderr); return result.stdout.trim(); };
  command("init", "--template=", "."); command("config", "user.name", "Fixture"); command("config", "user.email", "fixture@example.test");
  await f.write(".gitattributes", "*.md filter=mustnotrun\n"); command("add", "--all"); command("commit", "-m", "fixture"); const commit = command("rev-parse", "HEAD");
  const fetched = await readGitTree(path.join(f.temporary, "bare"), f.market, undefined, commit);
  assert.equal(fetched.commit, commit); assert.ok(fetched.files.some((file) => file.name === "plugins/review/skills/check/SKILL.md"));
  await assert.rejects(fs.stat(path.join(f.temporary, "bare", "plugins")), { code: "ENOENT" });
  await f.write("unrelated/.npmrc", "registry=https://registry.npmjs.org/\n"); command("add", "--all"); command("commit", "-m", "unrelated plugin configuration"); const scopedCommit = command("rev-parse", "HEAD");
  const metadata = await readGitTree(path.join(f.temporary, "bare-metadata"), f.market, undefined, scopedCommit, undefined, [".claude-plugin/marketplace.json", "marketplace.json"]); assert.deepEqual(metadata.files.map((file) => file.name), [".claude-plugin/marketplace.json"]);
  const scoped = await readGitTree(path.join(f.temporary, "bare-scoped"), f.market, undefined, scopedCommit, undefined, ["plugins/review"]); assert.equal(scoped.commit, scopedCommit); assert.ok(scoped.files.length > 0); assert.ok(scoped.files.every((file) => file.name.startsWith("plugins/review/")));
  await assert.rejects(readGitTree(path.join(f.temporary, "bare-full"), f.market, undefined, scopedCommit), /Credential file/);
  const oversized = path.join(f.temporary, "bare-oversized"); await fs.mkdir(oversized); const padding = await fs.open(path.join(oversized, "size-fixture"), "wx"); try { await padding.truncate(64 * 1024 * 1024 + 1); } finally { await padding.close(); }
  await assert.rejects(readGitTree(oversized, f.market, undefined, scopedCommit, undefined, [".claude-plugin/marketplace.json"]), /64 MiB/);
  command("update-index", "--add", "--cacheinfo", `160000,${commit},submodule`); command("commit", "-m", "submodule");
  await assert.rejects(readGitTree(path.join(f.temporary, "bare-second"), f.market, undefined, undefined), /submodule/);
});

test("unsupported hook types and inline credentials never register partial plugins", async (t) => {
  const f = await fixture(t); await f.manifest(); await f.bundle();
  await f.write("plugins/review/hooks/hooks.json", { hooks: { SessionStart: [{ hooks: [{ type: "prompt", prompt: "An unsupported model-backed hook" }] }] } });
  await addMarketplace(f.root, f.market, f.options);
  await assert.rejects(installMarketplacePlugin(f.root, "review@team", f.options), /SessionStart does not support Claude prompt hooks/);
  assert.equal((await discoverExtensions(f.root, f.options)).plugins.length, 0);
  const second = await fixture(t); await second.manifest(); await second.bundle(); await second.write("plugins/review/.mcp.json", { tool: { command: "node", args: ["server.cjs"], env: { SECRET: "plaintext" } } });
  await addMarketplace(second.root, second.market, second.options); await assert.rejects(installMarketplacePlugin(second.root, "review@team", second.options), /environment values/);
  assert.equal((await discoverExtensions(second.root, second.options)).plugins.length, 0);
});

test("marketplace command lists real entries and supports local HIVE bundles", async (t) => {
  const f = await fixture(t); await f.manifest([{ name: "native", source: "./native" }]); await f.write("native/hive.plugin.json", { version: 1, name: "native", description: "Native fixture", skills: [] });
  assert.match((await marketplaceCommand(f.root, `add "${f.market}"`, f.options)).join("\n"), /Marketplace team: 1 plugin/);
  assert.match((await marketplaceCommand(f.root, "list team", f.options)).join("\n"), /native@team/);
  assert.match((await marketplaceCommand(f.root, "list", f.options)).join("\n"), /team: directory/);
  const installed = await installMarketplacePlugin(f.root, "native@team", f.options); assert.equal(installed.plugin.name, "native.team");
  await assert.rejects(installMarketplacePlugin(f.root, "native@team", f.options), /already registered/);
  assert.match((await marketplaceCommand(f.root, "remove team", f.options)).join("\n"), /preserved/);
});

test("aborted operations and cooperative locks preserve existing registry and registrations", async (t) => {
  const f = await fixture(t); await f.manifest(); await f.bundle(); await addMarketplace(f.root, f.market, f.options);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(installMarketplacePlugin(f.root, "review@team", { ...f.options, signal: controller.signal }), { name: "AbortError" });
  assert.equal((await discoverExtensions(f.root, f.options)).plugins.length, 0);
  const lock = path.join(f.root, ".hive", "marketplaces", "operation.lock"); await fs.writeFile(lock, "external writer");
  await assert.rejects(removeMarketplace(f.root, "team", f.options), /Another marketplace operation/);
  assert.equal((await listMarketplaces(f.root, f.options)).length, 1); assert.equal(await fs.readFile(lock, "utf8"), "external writer");
});

test("installed source drift fails closed and recalculated provenance cannot retain old plugin trust", async (t) => {
  const f = await fixture(t); await f.manifest(); await f.bundle(); await addMarketplace(f.root, f.market, f.options);
  const installed = await installMarketplacePlugin(f.root, "review@team", f.options);
  await setExtensionState(f.root, installed.plugin.id, "trust", f.options); await setExtensionState(f.root, installed.plugin.id, "enable", f.options);
  await fs.appendFile(path.join(installed.plugin.path, "server.cjs"), "// new executable source\n");
  const changed = await discoverExtensions(f.root, f.options); assert.equal(changed.plugins.length, 0); assert.equal(changed.servers.length, 0); assert.match(changed.diagnostics.join("\n"), /files changed after installation/);
  const provenancePath = path.join(installed.plugin.path, "hive.marketplace.json"); const provenance = JSON.parse(await fs.readFile(provenancePath, "utf8"));
  provenance.installedTreeHash = treeDigest((await readLocalTree(installed.plugin.path)).filter((file) => file.name !== "hive.marketplace.json")); await fs.writeFile(provenancePath, JSON.stringify(provenance));
  const rewritten = await discoverExtensions(f.root, f.options); assert.deepEqual(rewritten.diagnostics, []); assert.equal(rewritten.plugins.length, 1); assert.equal(rewritten.plugins[0].trusted, false); assert.equal(rewritten.servers[0].trusted, false);
});

test("marketplace public endpoint validation rejects reserved IPv4 and IPv6 ranges", () => {
  for (const address of ["100.64.0.1", "198.18.0.1", "192.0.2.1", "198.51.100.1", "203.0.113.1", "[2001:db8::1]", "[2002:7f00:1::]", "[::ffff:127.0.0.1]"]) assert.throws(() => safeRemote(`https://${address}/marketplace.json`), /Marketplace/);
  assert.equal(gitAddressPin("https://github.com:8443/team/repo.git", "93.184.216.34"), "github.com:8443:93.184.216.34");
  assert.equal(gitAddressPin("https://github.com/team/repo.git", "2606:4700::1111"), "github.com:443:[2606:4700::1111]");
});

test("HTTPS marketplace requests pin numeric sockets with pool reuse disabled and preserve original TLS authority", async (t) => {
  const original = https.request; let seen;
  t.after(() => { https.request = original; });
  https.request = (url, options, callback) => {
    seen = { url: String(url), options };
    const request = new EventEmitter(); request.end = () => { const response = new PassThrough(); response.statusCode = 200; response.headers = {}; callback(response); response.end('{"name":"fixture","plugins":[]}'); }; return request;
  };
  const bytes = await downloadManifest("https://market.example:8443/marketplace.json", undefined, false, { resolveAddress: async () => [{ address: "93.184.216.34", family: 4 }] });
  assert.equal(JSON.parse(bytes).name, "fixture"); assert.equal(seen.options.hostname, "93.184.216.34"); assert.equal(seen.options.agent, false); assert.equal(seen.options.servername, "market.example"); assert.equal(seen.options.headers.host, "market.example:8443"); assert.equal(new URL(seen.url).port, "8443");
});

test("marketplace cancellation covers DNS before sockets and an absolute body deadline", async (t) => {
  let resolutions = 0; const controller = new AbortController(); controller.abort();
  await assert.rejects(downloadManifest("https://market.example/marketplace.json", controller.signal, false, { resolveAddress: async () => { resolutions += 1; return [{ address: "93.184.216.34", family: 4 }]; } }), { name: "AbortError" }); assert.equal(resolutions, 0);
  await assert.rejects(downloadManifest("https://market.example/marketplace.json", undefined, false, { timeoutMs: 30, resolveAddress: () => new Promise(() => {}) }), { name: "AbortError" });
  const server = http.createServer((_req, res) => { res.writeHead(200, { "Content-Type": "application/json" }); const interval = setInterval(() => res.write(" "), 5); res.once("close", () => clearInterval(interval)); });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => new Promise((resolve) => server.close(resolve)));
  const start = Date.now(); await assert.rejects(downloadManifest(`http://127.0.0.1:${server.address().port}/marketplace.json`, undefined, true, { timeoutMs: 50 }), /abort|cancel|interrupted/iu); assert.ok(Date.now() - start < 1000, "progress bytes cannot reset an absolute deadline");
});

test("case-colliding file and directory prefixes fail regardless of input order", async (t) => {
  const f = await fixture(t);
  for (const files of [[{ name: "a/b", bytes: Buffer.from("child"), executable: false }, { name: "A", bytes: Buffer.from("parent"), executable: false }], [{ name: "A", bytes: Buffer.from("parent"), executable: false }, { name: "a/b", bytes: Buffer.from("child"), executable: false }]]) await assert.rejects(writeTree(path.join(f.root, "collision"), files), /collid/);
  await assert.rejects(writeTree(path.join(f.root, "directory-collision"), [{ name: "A/one.js", bytes: Buffer.from("one"), executable: false }, { name: "a/two.js", bytes: Buffer.from("two"), executable: false }]), /case-colliding/);
});
