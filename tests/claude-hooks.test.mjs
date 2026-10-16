import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { discoverExtensions, runHooks, setExtensionState } from "../dist/extensions/index.js";
import { importClaudeHooks, matchesClaudeHook, parseClaudeHookConfiguration } from "../dist/extensions/claude-hooks.js";

const file = (name, value) => ({ name, bytes: Buffer.from(JSON.stringify(value)), executable: false });
const commandHook = (command, args, extra = {}) => ({ type: "command", command, args, ...extra });

async function fixture(run) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hive-claude-hooks-"));
  const root = path.join(temporary, "workspace"); const options = { trustStateDir: path.join(temporary, "trust") };
  await fs.mkdir(path.join(root, ".hive"), { recursive: true });
  const write = async (name, text) => { const destination = path.join(root, name); await fs.mkdir(path.dirname(destination), { recursive: true }); await fs.writeFile(destination, text); return destination; };
  const config = (hooks) => write(".hive/extensions.json", JSON.stringify({ version: 1, hooks }));
  const activate = async () => { for (const hook of (await discoverExtensions(root, options)).hooks) { await setExtensionState(root, hook.id, "trust", options); await setExtensionState(root, hook.id, "enable", options); } };
  try { await run({ root, options, temporary, write, config, activate }); }
  finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

async function readyHookPid(marker, running) {
  let settled = false;
  void running.then(() => { settled = true; }, () => { settled = true; });
  const deadline = Date.now() + 15_000;
  while (true) {
    try {
      const text = (await fs.readFile(marker, "utf8")).trim();
      const pid = Number(text);
      if (/^[1-9]\d*$/u.test(text) && Number.isSafeInteger(pid) && pid <= 0xffffffff) return pid;
    } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (settled) throw new Error("Hook settled before its live child PID marker became ready");
    if (Date.now() >= deadline) throw new Error("Hook fixture did not publish a valid positive PID within 15000ms");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function awaitHookCleanup(running) {
  try { await running; }
  catch (error) { if (!(error instanceof Error && error.name === "AbortError")) throw error; } // Cancellation is expected during fixture cleanup.
}

test("Claude hook import merges default, file, inline and mixed sources without executing", () => {
  const executable = commandHook("node", ["${CLAUDE_PLUGIN_ROOT}/hook.mjs"]);
  const files = [file("hooks/hooks.json", { description: "fixture", hooks: { SessionStart: [{ matcher: "startup|resume", hooks: [executable] }] } }), file("other.json", { hooks: { PreToolUse: [{ matcher: "Write, Edit", hooks: [executable] }] } })];
  const imported = importClaudeHooks(files, "C:/plugin with spaces", [["hooks/hooks.json", "other.json", { SessionEnd: [{ hooks: [executable] }] }]]);
  assert.equal(Object.keys(imported).length, 3);
  assert.equal(imported["claude-SessionStart-1"].command, "node");
  assert.deepEqual(imported["claude-SessionStart-1"].args, ["C:/plugin with spaces/hook.mjs"]);
  assert.equal(imported["claude-PreToolUse-2"].event, "before_tool");
  assert.equal(imported["claude-SessionEnd-3"].claude.event, "SessionEnd");
});

test("Claude hook import rejects unsupported executable semantics and unsafe matcher programs", () => {
  const make = (hook, matcher) => importClaudeHooks([], "/plugin", [{ hooks: { PreToolUse: [{ ...(matcher === undefined ? {} : { matcher }), hooks: [hook] }] } }]);
  assert.throws(() => make({ type: "unsupported", prompt: "do stuff" }), /Unsupported Claude hook handler type/);
  assert.throws(() => make(commandHook("node", [], { async: true })), /Background/);
  assert.throws(() => make(commandHook("node", [], { if: "Bash(rm *)" })), /unsupported field/);
  assert.throws(() => make(commandHook("node", []), "(a+)+$"), /matcher/);
  assert.throws(() => make(commandHook("node", [], { timeout: 121 })), /timeout/);
  assert.throws(() => make(commandHook("${CLAUDE_PLUGIN_DATA}/script", [])), /interpolation/);
  assert.throws(() => importClaudeHooks([], "/plugin", [{ UnknownLifecycle: [] }]), /Unsupported Claude hook event/);
  assert.throws(() => parseClaudeHookConfiguration({ event: "SessionStart" }, "before_tool"), /does not match/);
});

test("Claude hook matcher implements exact alternatives and bounded literal glob expressions", () => {
  for (const [pattern, tool, expected] of [["Write|Edit", "Write", true], ["Write, Edit", "Edit", true], ["Write", "NotebookWrite", false], ["^mcp__memory__.*$", "mcp__memory__save", true], ["^Read$", "Read", true], ["^Read$", "ReadExtra", false], ["Read.*File$", "PrefixReadFile", true], ["a.*b.*c$", "a-b-c-tail", false], ["^a.*a$", "a", false]]) {
    assert.equal(matchesClaudeHook(parseClaudeHookConfiguration({ event: "PreToolUse", matcher: pattern }, "before_tool"), { tool_name: tool }), expected, pattern);
  }
});

test("trusted real Claude hooks receive event-specific input and inject context; discovery stays inert", async () => fixture(async ({ root, options, write, config, activate }) => {
  const events = { SessionStart: "session_start", UserPromptSubmit: "prompt_submit", PreToolUse: "before_tool", PostToolUse: "after_tool", SessionEnd: "session_end" };
  const script = await write("hook.mjs", `import {appendFileSync} from 'node:fs';let data='';process.stdin.on('data',chunk=>data+=chunk).on('end',()=>{const value=JSON.parse(data);appendFileSync(process.argv[2],JSON.stringify(value)+'\\n');process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:value.hook_event_name,additionalContext:'fixture context'}}));});`);
  const marker = path.join(root, "input.jsonl");
  const hooks = Object.fromEntries(Object.entries(events).map(([event, native]) => [event, { event: native, command: process.execPath, args: [script, marker], claude: { event } }]));
  await config(hooks); await discoverExtensions(root, options);
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
  assert.deepEqual(await runHooks(root, "session_start", {}, options), []);
  await activate();
  const input = { sessionId: "session-fixture", transcriptPath: path.join(root, "transcript.jsonl"), permissionMode: "auto", source: "resume", reason: "other", prompt: "fresh user prompt", workspace: root, taskId: "task-fixture", toolUseId: "call-fixture", tool: "edit_file", input: { path: "src/file.ts", search: "before", replacement: "after" }, result: { ok: true, output: "edited" } };
  for (const event of Object.values(events)) {
    const result = await runHooks(root, event, input, options);
    assert.equal(result.length, 1); assert.equal(result[0].ok, true); assert.equal(result[0].additionalContext, event === "session_end" ? undefined : "fixture context");
  }
  const values = (await fs.readFile(marker, "utf8")).trim().split("\n").map(JSON.parse);
  assert.deepEqual(values.map((value) => value.hook_event_name), Object.keys(events));
  for (const value of values) { assert.equal(value.session_id, input.sessionId); assert.equal(value.cwd, root); assert.equal(value.transcript_path, input.transcriptPath); }
  assert.equal(values[0].source, "resume"); assert.equal(values[1].prompt, input.prompt);
  assert.equal(values[2].tool_name, "Edit"); assert.equal(values[2].tool_use_id, "call-fixture");
  assert.equal(values[2].tool_input.file_path, path.join(root, "src", "file.ts"));
  assert.equal(values[2].tool_input.old_string, "before"); assert.equal(values[2].tool_input.new_string, "after");
  assert.deepEqual(values[3].tool_response, input.result); assert.equal(values[4].reason, "other");
}));

test("tool matcher aliases filter actual subprocess execution", async () => fixture(async ({ root, options, write, config, activate }) => {
  const marker = path.join(root, "ran.txt");
  const script = await write("hook.mjs", `import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],'ran');`);
  await config({ gate: { event: "before_tool", command: process.execPath, args: [script, marker], claude: { event: "PreToolUse", matcher: "Write|Edit" } } });
  await activate();
  assert.deepEqual(await runHooks(root, "before_tool", { tool: "read_file" }, options), []);
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
  assert.equal((await runHooks(root, "before_tool", { tool: "create_file" }, options))[0].ok, true);
  assert.equal(await fs.readFile(marker, "utf8"), "ran");
}));

test("Claude exit and JSON decisions preserve blocks without granting or rewriting approved tools", async () => fixture(async ({ root, options, write, config, activate }) => {
  const emit = await write("emit.mjs", `process.stdout.write(process.argv[2]);process.stderr.write('stderr reason');process.exitCode=Number(process.argv[3]);`);
  const run = async (output, exitCode = 0, extra = {}) => {
    await config({ gate: { event: "before_tool", command: process.execPath, args: [emit, JSON.stringify(output), String(exitCode)], claude: { event: "PreToolUse", ...extra } } }); await activate();
    return (await runHooks(root, "before_tool", { tool: "write_file", input: { path: "safe.txt", content: "unchanged" } }, options))[0];
  };
  const denied = await run({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "policy denied" } });
  assert.equal(denied.ok, true); assert.equal(denied.blocked, true); assert.deepEqual(denied.diagnostics, ["policy denied"]);
  assert.equal((await run({}, 2)).blocked, true);
  assert.equal((await run({}, 7)).blocked, false);
  assert.equal((await run({}, 7, { onFailure: "block" })).blocked, true);
  const stopped = await run({ continue: false, stopReason: "Owner requested stop" }); assert.equal(stopped.stop, true); assert.equal(stopped.blocked, true);
  for (const output of [{ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" } }, { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask" } }, { hookSpecificOutput: { hookEventName: "PreToolUse", updatedInput: { path: "elsewhere" } } }, { model: "different" }]) {
    const result = await run(output); assert.equal(result.ok, false); assert.equal(result.blocked, true); assert.match(result.output, /cannot approve|unsupported field/);
  }
  await assert.rejects(fs.access(path.join(root, "safe.txt")), { code: "ENOENT" });
}));

test("hook stdout is parsed separately from stderr and opaque explicit secrets are redacted", async () => fixture(async ({ root, options, write, config, activate }) => {
  const envName = "HIVE_CLAUDE_HOOK_FIXTURE_SECRET"; const previous = process.env[envName];
  process.env[envName] = 'opaque-quoted-"-slash\\-value';
  try {
    const script = await write("hook.mjs", `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:process.env.MAPPED}}));process.stderr.write('stderr diagnostic '+encodeURIComponent(process.env.MAPPED));`);
    await config({ gate: { event: "prompt_submit", command: process.execPath, args: [script], envRefs: { MAPPED: envName }, claude: { event: "UserPromptSubmit" } } }); await activate();
    const result = (await runHooks(root, "prompt_submit", { prompt: "hello" }, options))[0];
    assert.equal(result.ok, true); assert.equal(result.additionalContext, "[REDACTED]");
    for (const value of [process.env[envName], JSON.stringify(process.env[envName]).slice(1, -1), encodeURIComponent(process.env[envName])]) assert.equal(result.output.includes(value), false);
    assert.match(result.output, /stderr diagnostic \[REDACTED\]/);
    const longScript = await write("long-hook.mjs", `process.stdout.write(JSON.stringify({hookSpecificOutput:{hookEventName:'UserPromptSubmit',additionalContext:'x'.repeat(9995)+process.env.MAPPED}}));`);
    await config({ gate: { event: "prompt_submit", command: process.execPath, args: [longScript], envRefs: { MAPPED: envName }, claude: { event: "UserPromptSubmit" } } }); await activate();
    const bounded = (await runHooks(root, "prompt_submit", {}, options))[0].additionalContext;
    assert.equal(bounded.length, 10_000); assert.equal(bounded.includes("opaque"), false);
  } finally { if (previous === undefined) delete process.env[envName]; else process.env[envName] = previous; }
}));

test("explicit PowerShell shell hooks use runtime environment placeholders without path source injection", async () => fixture(async ({ root, options, write, config, activate }) => {
  if (process.platform !== "win32") return; // This fixture verifies the Windows host's real installed PowerShell.
  const command = "$data = [Console]::In.ReadToEnd() | ConvertFrom-Json; @{ hookSpecificOutput = @{ hookEventName = $data.hook_event_name; additionalContext = \"${CLAUDE_PLUGIN_ROOT}|${CLAUDE_PROJECT_DIR}\" } } | ConvertTo-Json -Compress";
  const imported = importClaudeHooks([], root, [{ UserPromptSubmit: [{ hooks: [{ type: "command", command, shell: "powershell" }] }] }]);
  await config(imported); await activate();
  const result = (await runHooks(root, "prompt_submit", { prompt: "hello", workspace: root }, options))[0];
  assert.equal(result.ok, true, result.output); assert.equal(result.additionalContext, `${root}|${root}`);
}));

test("hook cancellation and total deadlines terminate owned processes", async () => fixture(async ({ root, options, write, config, activate }) => {
  const marker = path.join(root, "pid.txt");
  const script = await write("hang.mjs", `import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);`);
  await config({ gate: { event: "before_tool", command: process.execPath, args: [script, marker], timeoutMs: 20_000, claude: { event: "PreToolUse", onFailure: "block" } } }); await activate();
  const abort = new AbortController(); const running = runHooks(root, "before_tool", {}, { ...options, signal: abort.signal });
  try {
    const pid = await readyHookPid(marker, running); assert.doesNotThrow(() => process.kill(pid, 0)); abort.abort();
    await assert.rejects(running, { name: "AbortError" }); assert.throws(() => process.kill(pid, 0));
  } finally { abort.abort(); await awaitHookCleanup(running); }
  const result = (await runHooks(root, "before_tool", {}, { ...options, timeoutMs: 120 }))[0];
  assert.equal(result.ok, false); assert.equal(result.blocked, true); assert.match(result.output, /total deadline|timed out/);
}));

test("cancelling a live shell hook terminates its child without touching another process", async () => fixture(async ({ root, options, write, config, activate }) => {
  if (process.platform !== "win32") return;
  const { spawn } = await import("node:child_process");
  const marker = path.join(root, "shell-child.txt");
  const script = await write("shell-child.mjs", `import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],String(process.pid));setInterval(()=>{},1000);`);
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  await config({ gate: { event: "before_tool", command: `& ${quote(process.execPath)} ${quote(script)} ${quote(marker)}`, args: [], timeoutMs: 20_000, claude: { event: "PreToolUse", shell: "powershell" } } }); await activate();
  const unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { windowsHide: true, stdio: "ignore" });
  const unrelatedClosed = new Promise((resolve) => unrelated.once("close", resolve));
  let unrelatedError; unrelated.once("error", (error) => { unrelatedError = error; });
  const abort = new AbortController(); const running = runHooks(root, "before_tool", {}, { ...options, signal: abort.signal });
  try {
    const childPid = await readyHookPid(marker, running); assert.doesNotThrow(() => process.kill(childPid, 0));
    if (unrelatedError) throw unrelatedError;
    assert.ok(Number.isSafeInteger(unrelated.pid) && unrelated.pid > 0); abort.abort();
    await assert.rejects(running, { name: "AbortError" });
    assert.throws(() => process.kill(childPid, 0)); assert.doesNotThrow(() => process.kill(unrelated.pid, 0));
  } finally {
    abort.abort();
    try { await awaitHookCleanup(running); }
    finally { if (unrelated.exitCode === null && unrelated.signalCode === null) unrelated.kill(); await unrelatedClosed; }
  }
}));

test("revocation by an earlier hook prevents a later previously discovered hook from launching", async () => fixture(async ({ root, options, write, config, activate }) => {
  const marker = path.join(root, "second-ran.txt");
  const revoke = await write("revoke.mjs", `import {readdirSync,readFileSync,writeFileSync} from 'node:fs';import path from 'node:path';for(const name of readdirSync(process.argv[2])){const file=path.join(process.argv[2],name);const state=JSON.parse(readFileSync(file,'utf8'));delete state['hook:second'];writeFileSync(file,JSON.stringify(state));}`);
  const second = await write("second.mjs", `import {writeFileSync} from 'node:fs';writeFileSync(process.argv[2],'ran');`);
  await config({ first: { event: "before_tool", command: process.execPath, args: [revoke, options.trustStateDir], claude: { event: "PreToolUse" } }, second: { event: "before_tool", command: process.execPath, args: [second, marker], claude: { event: "PreToolUse" } } }); await activate();
  const results = await runHooks(root, "before_tool", { tool: "write_file" }, options);
  assert.equal(results.length, 2); assert.equal(results[0].ok, true); assert.equal(results[1].ok, false); assert.equal(results[1].blocked, true); assert.match(results[1].output, /trust or configuration changed/);
  await assert.rejects(fs.access(marker), { code: "ENOENT" });
}));
