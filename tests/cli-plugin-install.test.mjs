import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverExtensions, extensionCommand, setExtensionState } from "../dist/extensions/index.js";
import { installLocalPlugin, uninstallLocalPlugin } from "../dist/extensions/catalog.js";

async function fixture(t) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hive-plugin-install-"));
  t.after(() => fs.rm(temporary, { recursive: true, force: true }));
  const root = path.join(temporary, "workspace");
  await fs.mkdir(root);
  const options = { trustStateDir: path.join(temporary, "trust") };
  const configPath = path.join(root, ".hive", "extensions.json");
  const write = async (file, text) => { const target = path.join(root, file); await fs.mkdir(path.dirname(target), { recursive: true }); await fs.writeFile(target, text); return target; };
  const configure = (config) => write(".hive/extensions.json", JSON.stringify({ version: 1, ...config }, null, 2));
  const bundle = async (name = "team", directory = "plugins/team tools", changes = {}) => {
    await write(`${directory}/skills/review/SKILL.md`, "---\nname: review\ndescription: A local review skill\n---\nReview the changed code.\n");
    await write(`${directory}/sentinel.cjs`, "require('node:fs').writeFileSync('executed.txt', 'must not run during install');\n");
    const manifest = { version: 1, name, description: "Local fixture", skills: ["skills/review/SKILL.md"],
      mcpServers: { checks: { transport: "stdio", command: "node", args: ["sentinel.cjs"], enabled: true } },
      hooks: { finish: { event: "session_end", command: "node", args: ["sentinel.cjs"], enabled: true } }, ...changes };
    await write(`${directory}/hive.plugin.json`, JSON.stringify(manifest));
    return path.join(root, directory);
  };
  return { temporary, root, options, configPath, write, configure, bundle };
}

test("install validates a local bundle without executing it and starts every contribution disabled and untrusted", async (t) => {
  const { root, options, configPath, bundle } = await fixture(t);
  const directory = await bundle();
  const output = await extensionCommand(root, "plugins", 'install team "plugins/team tools"', options);
  assert.match(output.join("\n"), /registered disabled and untrusted/);
  assert.deepEqual(JSON.parse(await fs.readFile(configPath, "utf8")), { version: 1, plugins: { team: { path: "plugins/team tools", enabled: false } } });
  const catalog = await discoverExtensions(root, options);
  assert.deepEqual(catalog.diagnostics, []);
  assert.deepEqual(catalog.plugins.map((entry) => entry.id), ["plugin:team"]);
  assert.deepEqual(catalog.servers.map((entry) => entry.id), ["mcp:team.checks"]);
  assert.deepEqual(catalog.hooks.map((entry) => entry.id), ["hook:team.finish"]);
  assert.deepEqual(catalog.skills.map((entry) => entry.id), ["skill:team.review"]);
  for (const entry of [...catalog.plugins, ...catalog.servers, ...catalog.hooks, ...catalog.skills]) {
    assert.equal(entry.enabled, false, entry.id);
    assert.equal(entry.trusted, false, entry.id);
  }
  await assert.rejects(fs.stat(path.join(directory, "executed.txt")), { code: "ENOENT" });
  await assert.rejects(fs.stat(path.join(root, ".hive", "extensions.lock")), { code: "ENOENT" });
});

test("install preserves existing configuration and never replaces a registration", async (t) => {
  const { root, options, configPath, configure, bundle } = await fixture(t);
  await bundle();
  await configure({ mcpServers: { existing: { transport: "http", url: "https://example.test/mcp", enabled: false } }, skillDirectories: [] });
  await installLocalPlugin(root, "team", "plugins/team tools", options);
  const before = await fs.readFile(configPath, "utf8");
  assert.equal(JSON.parse(before).mcpServers.existing.url, "https://example.test/mcp");
  await assert.rejects(installLocalPlugin(root, "team", "plugins/team tools", options), /already registered/);
  assert.equal(await fs.readFile(configPath, "utf8"), before);
});

test("every contribution is validated before config changes, including required skills", async (t) => {
  const { root, options, configPath, configure, bundle } = await fixture(t);
  await configure({});
  const before = await fs.readFile(configPath, "utf8");
  for (const changes of [
    { version: 2 }, { name: "different" }, { unknown: true }, { skills: ["missing/SKILL.md"] },
    { skills: ["sentinel.cjs"] }, { mcpServers: { bad: { transport: "http", url: "http://external.example.test/mcp" } } },
    { hooks: { bad: { event: "invented", command: "node" } } },
  ]) {
    await bundle("team", "plugins/team tools", changes);
    await assert.rejects(installLocalPlugin(root, "team", "plugins/team tools", options));
    assert.equal(await fs.readFile(configPath, "utf8"), before);
  }
});

test("malformed or oversized existing config is preserved rather than replaced", async (t) => {
  const { root, options, configPath, write, bundle } = await fixture(t);
  await bundle();
  for (const original of ["not JSON", '{"version":2}', '{"version":1,"typo":{}}', '{"version":1,"hooks":{"bad":{"event":"invented","command":"node"}}}', " ".repeat(128 * 1024 + 1)]) {
    await write(".hive/extensions.json", original);
    await assert.rejects(installLocalPlugin(root, "team", "plugins/team tools", options));
    assert.equal(await fs.readFile(configPath, "utf8"), original);
  }
});

test("an install cannot introduce a namespace collision with conventional workspace skills", async (t) => {
  const { root, options, configPath, write, configure, bundle } = await fixture(t);
  await bundle();
  await configure({});
  await write("skills/standalone/SKILL.md", "---\nname: team.review\n---\nExisting standalone skill.\n");
  const before = await fs.readFile(configPath, "utf8");
  await assert.rejects(installLocalPlugin(root, "team", "plugins/team tools", options), /Duplicate skill id/);
  assert.equal(await fs.readFile(configPath, "utf8"), before);
});

test("uninstall revokes bundle trust while preserving source and unrelated settings", async (t) => {
  const { root, options, configPath, configure, bundle } = await fixture(t);
  const directory = await bundle();
  await configure({ mcpServers: { existing: { transport: "http", url: "https://example.test/mcp" } } });
  await installLocalPlugin(root, "team", "plugins/team tools", options);
  await setExtensionState(root, "plugin:team", "trust", options);
  await setExtensionState(root, "plugin:team", "enable", options);
  assert.equal((await discoverExtensions(root, options)).plugins[0].trusted, true);
  const manifest = await fs.readFile(path.join(directory, "hive.plugin.json"), "utf8");
  const output = await extensionCommand(root, "plugins", "uninstall plugin:team", options);
  assert.match(output.join("\n"), /trust revoked.*source files were preserved/i);
  assert.equal(await fs.readFile(path.join(directory, "hive.plugin.json"), "utf8"), manifest);
  assert.match(await fs.readFile(path.join(directory, "skills/review/SKILL.md"), "utf8"), /Review the changed code/);
  const config = JSON.parse(await fs.readFile(configPath, "utf8"));
  assert.deepEqual(config.plugins, {});
  assert.ok(config.mcpServers.existing);
  const files = (await fs.readdir(options.trustStateDir)).filter((file) => !file.startsWith("."));
  assert.equal(files.length, 1);
  const saved = JSON.parse(await fs.readFile(path.join(options.trustStateDir, files[0]), "utf8"));
  for (const id of ["plugin:team", "mcp:team.checks", "skill:team.review", "hook:team.finish"]) assert.equal(Object.hasOwn(saved, id), false, id);
  await installLocalPlugin(root, "team", "plugins/team tools", options);
  for (const entry of (await discoverExtensions(root, options)).plugins) assert.equal(entry.trusted || entry.enabled, false);
});

test("install clears stale trust and enabled overrides left by manual unregistration", async (t) => {
  const { root, options, configure, bundle } = await fixture(t);
  await bundle();
  await installLocalPlugin(root, "team", "plugins/team tools", options);
  await setExtensionState(root, "plugin:team", "trust", options);
  await setExtensionState(root, "plugin:team", "enable", options);
  await configure({});
  await installLocalPlugin(root, "team", "plugins/team tools", options);
  const catalog = await discoverExtensions(root, options);
  for (const entry of [...catalog.plugins, ...catalog.servers, ...catalog.skills, ...catalog.hooks]) assert.equal(entry.trusted || entry.enabled, false, entry.id);
  const [file] = (await fs.readdir(options.trustStateDir)).filter((entry) => !entry.startsWith("."));
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(options.trustStateDir, file), "utf8")), {});
});

test("outside directories and plugin directory aliases cannot be installed", async (t) => {
  const { temporary, root, options, bundle } = await fixture(t);
  const directory = await bundle();
  const outside = path.join(temporary, "outside");
  await fs.mkdir(outside);
  await assert.rejects(installLocalPlugin(root, "team", outside, options), /inside the workspace/);
  await fs.symlink(directory, path.join(root, "alias"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(installLocalPlugin(root, "team", "alias", options), /plain directories/);
  await assert.rejects(fs.stat(path.join(root, ".hive", "extensions.json")), { code: "ENOENT" });
});

test("symlink configuration, storage directories, and manifest files are rejected", async (t) => {
  const { temporary, root, options, configPath, bundle, write } = await fixture(t);
  const directory = await bundle();
  const outside = path.join(temporary, "outside");
  await fs.mkdir(outside);
  await fs.symlink(outside, path.join(root, ".hive"), process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(installLocalPlugin(root, "team", "plugins/team tools", options), /plain directories/);
  assert.deepEqual(await fs.readdir(outside), []);
  await fs.unlink(path.join(root, ".hive"));
  await fs.mkdir(path.join(root, ".hive"));
  const target = await write("config-source.json", '{"version":1}');
  await fs.symlink(target, configPath, "file");
  await assert.rejects(installLocalPlugin(root, "team", "plugins/team tools", options), /plain single-link file/);
  assert.equal(await fs.readFile(target, "utf8"), '{"version":1}');
  await fs.unlink(configPath);
  const manifest = path.join(directory, "hive.plugin.json");
  const source = path.join(directory, "manifest-source.json");
  await fs.rename(manifest, source);
  await fs.symlink(source, manifest, "file");
  await assert.rejects(installLocalPlugin(root, "team", "plugins/team tools", options), /plain single-link file/);
});

test("a preexisting lock is retained and concurrent installers cannot clobber registration", async (t) => {
  const { root, options, configure, bundle } = await fixture(t);
  await bundle();
  await configure({});
  const lock = path.join(root, ".hive", "extensions.lock");
  await fs.writeFile(lock, "another writer owns this");
  await assert.rejects(installLocalPlugin(root, "team", "plugins/team tools", options), /holds .*extensions.lock/);
  assert.equal(await fs.readFile(lock, "utf8"), "another writer owns this");
  await fs.unlink(lock);
  const results = await Promise.allSettled([installLocalPlugin(root, "team", "plugins/team tools", options), installLocalPlugin(root, "team", "plugins/team tools", options)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await discoverExtensions(root, options)).plugins.length, 1);
});

test("an external config edit during atomic write is detected and preserved", async (t) => {
  const { root, options, configPath, configure, bundle } = await fixture(t);
  await bundle();
  await configure({});
  const external = JSON.stringify({ version: 1, skillDirectories: [], plugins: {} });
  const originalOpen = fs.open;
  let edited = false;
  fs.open = async function (file, ...args) {
    if (!edited && String(file).includes(".extensions.json.") && String(file).endsWith(".tmp")) {
      edited = true;
      await fs.writeFile(configPath, external);
    }
    return originalOpen.call(this, file, ...args);
  };
  try { await assert.rejects(installLocalPlugin(root, "team", "plugins/team tools", options), /changed during the update/); }
  finally { fs.open = originalOpen; }
  assert.equal(edited, true);
  assert.equal(await fs.readFile(configPath, "utf8"), external);
  assert.deepEqual((await fs.readdir(path.dirname(configPath))).sort(), ["extensions.json"]);
});

test("uninstall can unregister a broken or deleted bundle without reading its contributions", async (t) => {
  const { root, options, configPath, configure, bundle } = await fixture(t);
  await configure({ mcpServers: { existing: { transport: "http", url: "https://example.test/mcp" } } });
  for (const damage of ["missing-skill", "broken-manifest", "missing-directory"]) {
    const directory = await bundle();
    await installLocalPlugin(root, "team", "plugins/team tools", options);
    await setExtensionState(root, "plugin:team", "trust", options);
    await setExtensionState(root, "plugin:team", "enable", options);
    if (damage === "missing-skill") await fs.unlink(path.join(directory, "skills/review/SKILL.md"));
    else if (damage === "broken-manifest") await fs.writeFile(path.join(directory, "hive.plugin.json"), "broken local manifest");
    else await fs.rm(directory, { recursive: true, force: true });
    await uninstallLocalPlugin(root, "team", options);
    const config = JSON.parse(await fs.readFile(configPath, "utf8"));
    assert.deepEqual(config.plugins, {});
    assert.equal(config.mcpServers.existing.url, "https://example.test/mcp");
    const [stateFile] = (await fs.readdir(options.trustStateDir)).filter((entry) => !entry.startsWith("."));
    const state = JSON.parse(await fs.readFile(path.join(options.trustStateDir, stateFile), "utf8"));
    for (const id of ["plugin:team", "mcp:team.checks", "skill:team.review", "hook:team.finish"]) assert.equal(Object.hasOwn(state, id), false, `${damage}: ${id}`);
    if (damage !== "missing-directory") assert.ok(await fs.stat(directory));
  }
});

test("uninstall still validates the remaining configuration before changing anything", async (t) => {
  const { root, options, configPath, configure, bundle } = await fixture(t);
  await bundle();
  await configure({ plugins: { team: { path: "plugins/team tools", enabled: false }, broken: { path: "missing-plugin" } } });
  const before = await fs.readFile(configPath);
  await assert.rejects(uninstallLocalPlugin(root, "team", options), { code: "ENOENT" });
  assert.deepEqual(await fs.readFile(configPath), before);
});

async function backupFiles(file) {
  return (await fs.readdir(path.dirname(file))).filter((entry) => entry.startsWith(`.${path.basename(file)}.`) && entry.endsWith(".backup")).map((entry) => path.join(path.dirname(file), entry));
}

test("an external edit in the final displacement boundary is retained and reported with its backup", async (t) => {
  const { root, options, configPath, configure, bundle } = await fixture(t);
  await bundle(); await configure({});
  const external = JSON.stringify({ version: 1, skillDirectories: [], plugins: {} });
  const originalRename = fs.rename;
  let edited = false;
  fs.rename = async function (source, target) {
    if (!edited && String(source) === configPath && String(target).endsWith(".backup")) {
      edited = true;
      await fs.writeFile(source, external);
    }
    return originalRename.call(this, source, target);
  };
  try { await assert.rejects(installLocalPlugin(root, "team", "plugins/team tools", options), /conflicted.*recoverable backup:/); }
  finally { fs.rename = originalRename; }
  assert.equal(edited, true);
  assert.equal(await fs.readFile(configPath, "utf8"), external);
  const [backup] = await backupFiles(configPath);
  assert.equal(await fs.readFile(backup, "utf8"), external);
  assert.equal((await fs.lstat(configPath)).nlink, 1);
  assert.equal((await fs.lstat(backup)).nlink, 1);
});

test("an externally recreated destination wins over final no-clobber publication", async (t) => {
  const { root, options, configPath, configure, bundle } = await fixture(t);
  await bundle(); await configure({});
  const original = await fs.readFile(configPath);
  const external = JSON.stringify({ version: 1, skillDirectories: [] });
  const originalRename = fs.rename;
  let edited = false;
  fs.rename = async function (source, target) {
    const result = await originalRename.call(this, source, target);
    if (!edited && String(source) === configPath && String(target).endsWith(".backup")) {
      edited = true; await fs.writeFile(source, external, { flag: "wx" });
    }
    return result;
  };
  try { await assert.rejects(installLocalPlugin(root, "team", "plugins/team tools", options), /conflicted.*recoverable backup:/); }
  finally { fs.rename = originalRename; }
  assert.equal(edited, true);
  assert.equal(await fs.readFile(configPath, "utf8"), external);
  const [backup] = await backupFiles(configPath);
  assert.deepEqual(await fs.readFile(backup), original);
});

test("initially absent configuration is published exclusively", async (t) => {
  const { root, options, configPath, bundle } = await fixture(t);
  await bundle();
  const external = JSON.stringify({ version: 1, skillDirectories: [] });
  const originalLink = fs.link;
  let edited = false;
  fs.link = async function (source, target) {
    if (!edited && String(target) === configPath) { edited = true; await fs.writeFile(target, external, { flag: "wx" }); }
    return originalLink.call(this, source, target);
  };
  try { await assert.rejects(installLocalPlugin(root, "team", "plugins/team tools", options), /conflicted.*externally created active file was preserved/); }
  finally { fs.link = originalLink; }
  assert.equal(edited, true);
  assert.equal(await fs.readFile(configPath, "utf8"), external);
  assert.deepEqual(await backupFiles(configPath), []);
});

test("writes through a displaced open handle remain recoverable", async (t) => {
  const { root, options, configPath, configure, bundle } = await fixture(t);
  await bundle(); await configure({});
  const external = JSON.stringify({ version: 1, skillDirectories: [] });
  const oldHandle = await fs.open(configPath, "r+");
  const originalLink = fs.link;
  let edited = false;
  fs.link = async function (source, target) {
    if (!edited && String(target) === configPath) {
      edited = true; await oldHandle.truncate(0); await oldHandle.write(external, 0, "utf8"); await oldHandle.sync();
    }
    return originalLink.call(this, source, target);
  };
  try { await assert.rejects(installLocalPlugin(root, "team", "plugins/team tools", options), /conflicted.*recoverable backup:/); }
  finally { fs.link = originalLink; await oldHandle.close(); }
  assert.equal(edited, true);
  const [backup] = await backupFiles(configPath);
  assert.equal(await fs.readFile(backup, "utf8"), external);
  assert.equal((await fs.lstat(configPath)).nlink, 1);
  assert.equal((await fs.lstat(backup)).nlink, 1);
});

test("trust-state publication also preserves conflicting external state without exposing its contents", async (t) => {
  const { root, options, bundle } = await fixture(t);
  await bundle(); await installLocalPlugin(root, "team", "plugins/team tools", options);
  await setExtensionState(root, "plugin:team", "trust", options);
  const [name] = (await fs.readdir(options.trustStateDir)).filter((entry) => !entry.startsWith("."));
  const stateFile = path.join(options.trustStateDir, name);
  const privateMarker = "private-external-state-marker";
  const external = JSON.stringify({ [privateMarker]: { fingerprint: "a".repeat(64) } });
  const originalRename = fs.rename;
  let edited = false;
  fs.rename = async function (source, target) {
    if (!edited && String(source) === stateFile && String(target).endsWith(".backup")) { edited = true; await fs.writeFile(source, external); }
    return originalRename.call(this, source, target);
  };
  try {
    await assert.rejects(setExtensionState(root, "plugin:team", "enable", options), (error) => {
      assert.match(error.message, /conflicted.*recoverable backup:/);
      assert.equal(error.message.includes(privateMarker), false);
      return true;
    });
  } finally { fs.rename = originalRename; }
  assert.equal(edited, true);
  assert.equal(await fs.readFile(stateFile, "utf8"), external);
  const backups = await backupFiles(stateFile);
  assert.equal(await fs.readFile(backups.at(-1), "utf8"), external);
});

test("successful updates preserve UTF-8 BOM, CRLF and file permissions with a single-link active file", async (t) => {
  const { root, options, configPath, write, bundle } = await fixture(t);
  await bundle();
  await write(".hive/extensions.json", "\uFEFF{\r\n  \"version\": 1\r\n}\r\n");
  await fs.chmod(configPath, 0o600);
  const mode = (await fs.lstat(configPath)).mode & 0o777;
  await installLocalPlugin(root, "team", "plugins/team tools", options);
  const bytes = await fs.readFile(configPath);
  assert.deepEqual(bytes.subarray(0, 3), Buffer.from([0xef, 0xbb, 0xbf]));
  assert.equal(/(?<!\r)\n/u.test(bytes.toString("utf8")), false);
  assert.equal((await fs.lstat(configPath)).mode & 0o777, mode);
  assert.equal((await fs.lstat(configPath)).nlink, 1);
  assert.equal((await backupFiles(configPath)).length, 1);
  await setExtensionState(root, "plugin:team", "trust", options);
  await setExtensionState(root, "plugin:team", "enable", options);
  assert.equal((await discoverExtensions(root, options)).plugins[0].enabled, true);
});

test("plugin commands describe local registration and reject missing or excess arguments", async (t) => {
  const { root, options } = await fixture(t);
  assert.match((await extensionCommand(root, "plugins", "help", options)).join("\n"), /install <name> <workspace-directory>.*source files are preserved/);
  await assert.rejects(extensionCommand(root, "plugins", "install team", options), /requires a name/);
  await assert.rejects(extensionCommand(root, "plugins", "uninstall team extra", options), /exactly one/);
  await assert.rejects(uninstallLocalPlugin(root, "missing", options), /Unknown plugin/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(extensionCommand(root, "plugins", "install team plugins/team", { ...options, signal: controller.signal }), { name: "AbortError" });
});
