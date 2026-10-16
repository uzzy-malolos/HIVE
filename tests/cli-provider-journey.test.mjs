import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import { once } from "node:events";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { ProviderRegistry } from "../dist/providers/registry.js";
import { ConfigStore } from "../dist/config.js";
import { CliConversationStore } from "../dist/tui/conversations.js";
import { CodingSessionStore } from "../dist/coding/session-store.js";

const execute = promisify(execFile);
const bin = path.resolve("bin/hive.mjs");
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

test("real CLI structured failure envelopes stay on stdout with nonzero exit codes", async () => {
  for (const format of ["json", "streaming-json"]) {
    await assert.rejects(execute(process.execPath, [bin, "-p", "--output-format", format]), (error) => {
      assert.equal(error.code, 1);
      assert.equal(error.stderr, "");
      assert.equal(JSON.parse(error.stdout).status, "failed");
      return true;
    });
  }
});

test("real CLI processes code, restart, follow up, transport images and review against a local HTTP model fixture", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "hive-cli-provider-journey-"));
  const requests = [];
  let planningTurn = 0;
  let builderStep = 0;
  let fixtureFailure;
  const server = http.createServer(async (request, response) => {
    try {
      if (request.method === "GET") { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ data: [{ id: "fixture-model" }] })); return; }
      let raw = "";
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);
      const system = body.messages.find((message) => message.role === "system")?.content ?? "";
      const user = body.messages.find((message) => message.role === "user")?.content;
      const prompt = typeof user === "string" ? user : user.find((part) => part.type === "text").text;
      let result = { done: true, summary: "Fixture role completed with visible evidence", data: { status: "passed", findings: [] } };
      if (system.includes("HIVE Planner")) {
        planningTurn += 1; builderStep = 0;
        if (planningTurn === 2) {
          assert.match(prompt, /Create the first fixture implementation/);
          assert.match(prompt, /Now update the existing implementation/);
        }
        result = { summary: planningTurn === 1 ? "Create the fixture implementation" : "Update the same implementation", architecture: "One file", risks: [],
          acceptanceCriteria: ["The requested turn is represented"], validationCommands: ["node --version"],
          tasks: [{ key: "file", role: "builder", title: "Write the implementation", objective: "Write the current requested turn",
            dependencies: [], fileScope: ["src/journey.txt"], expectedOutput: "Correct file", completionCriteria: ["Correct content"], validationCommands: [] }] };
      } else if (system.includes("HIVE builder subagent") && builderStep++ === 0) {
        result = { done: false, activity: "Writing the fixture implementation", toolCalls: [{ name: planningTurn === 1 ? "create_file" : "write_file",
          arguments: { path: "src/journey.txt", content: planningTurn === 1 ? "first turn\n" : planningTurn === 2 ? "second turn\n" : "fork turn\n" } }] };
      }
      const output = JSON.stringify(result);
      if (body.stream) {
        response.writeHead(200, { "content-type": "text/event-stream" });
        for (let offset = 0; offset < output.length; offset += 17) response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: output.slice(offset, offset + 17) } }] })}\n\n`);
        response.end("data: [DONE]\n\n");
      } else { response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ choices: [{ message: { content: output } }] })); }
    } catch (error) { fixtureFailure = error; response.writeHead(500); response.end(JSON.stringify({ error: { message: error.message } })); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); server.close(); await fs.rm(root, { recursive: true, force: true }); });
  await execute("git", ["init", "-b", "main"], { cwd: root });
  await execute("git", ["config", "user.email", "hive@example.test"], { cwd: root });
  await execute("git", ["config", "user.name", "HIVE Test"], { cwd: root });
  await fs.writeFile(path.join(root, "README.md"), "fixture\n");
  await execute("git", ["add", "README.md"], { cwd: root });
  await execute("git", ["commit", "-m", "fixture"], { cwd: root });
  await fs.writeFile(path.join(root, "pixel.png"), Buffer.from(png, "base64"));
  const run = async (args, cwd = root) => {
    const result = await execute(process.execPath, [bin, ...args], { cwd, timeout: 30000, maxBuffer: 2 * 1024 * 1024 });
    assert.equal(result.stderr, "");
    if (fixtureFailure) throw fixtureFailure;
    return JSON.parse(result.stdout);
  };
  const nested = path.join(root, "nested"); await fs.mkdir(nested);
  const added = await run(["providers", "add", "--id", "fixture", "--preset", "local", "--base-url", `http://127.0.0.1:${server.address().port}/v1`, "--model", "fixture-model", "--json"], nested);
  assert.equal(added.approved, false);
  assert.equal(added.configRoot, root);
  const available = await run(["providers", "models", "fixture", "--json"], nested);
  assert.deepEqual(available.models, ["fixture-model"]);
  assert.equal((await run(["providers", "test", "fixture", "--json"], nested)).ok, true);
  assert.equal((await run(["providers", "approve", "fixture", "--json"], nested)).success, true);
  const registry = new ProviderRegistry(root);
  assert.equal((await registry.get("fixture")).authType, "none");
  assert.deepEqual(await registry.getRoles(), {}, "explicit model selection must work without rewriting or manually seeding role defaults");
  await assert.rejects(fs.access(path.join(nested, ".hive/providers.json")), { code: "ENOENT" });
  await new ConfigStore(root).setMode("standard");
  const first = await run(["-p", "Create the first fixture implementation", "--json", "--model", "fixture/fixture-model", "--image", "pixel.png"]);
  assert.equal(first.status, "completed", first.text);
  const firstRun = await new CodingSessionStore(root).load(first.sessionId);
  assert.equal(firstRun.verdict, "ACCEPTED", JSON.stringify(firstRun.finalReport));
  const workspace = firstRun.repository.worktreePath;
  assert.equal(await fs.readFile(path.join(workspace, "src/journey.txt"), "utf8"), "first turn\n");
  const second = await run(["-p", "Now update the existing implementation", "--continue", "--json"]);
  assert.equal(second.status, "completed", second.text);
  assert.equal(second.conversationId, first.conversationId);
  assert.equal(second.sessionId, first.sessionId);
  const secondRun = await new CodingSessionStore(root).load(second.sessionId);
  assert.equal(secondRun.repository.worktreePath, workspace);
  assert.equal(secondRun.turnHistory.length, 1);
  assert.equal(await fs.readFile(path.join(workspace, "src/journey.txt"), "utf8"), "second turn\n");
  await assert.rejects(fs.access(path.join(root, "src/journey.txt")), { code: "ENOENT" });
  const forked = await run(["-p", "Explore the forked implementation", "--resume", first.conversationId, "--fork-session", "--json"]);
  assert.equal(forked.status, "completed", forked.text);
  assert.notEqual(forked.conversationId, first.conversationId);
  assert.notEqual(forked.sessionId, first.sessionId);
  const forkRun = await new CodingSessionStore(root).load(forked.sessionId);
  assert.equal(forkRun.forkedFrom, first.sessionId);
  assert.notEqual(forkRun.repository.worktreePath, workspace);
  assert.equal(await fs.readFile(path.join(forkRun.repository.worktreePath, "src/journey.txt"), "utf8"), "fork turn\n");
  assert.equal(await fs.readFile(path.join(workspace, "src/journey.txt"), "utf8"), "second turn\n");
  const reviewed = await run(["--review", "Check the current implementation", "--resume", first.conversationId, "--json"]);
  assert.equal(reviewed.status, "completed", reviewed.text);
  assert.equal(await fs.readFile(path.join(workspace, "src/journey.txt"), "utf8"), "second turn\n");
  assert.equal(planningTurn, 3);
  assert.ok(requests.length >= 8);
  assert.ok(requests.every((body) => body.model === "fixture-model"));
  assert.ok(requests.every((body) => body.messages.find((message) => message.role === "user").content.some((part) => part.type === "image_url" && part.image_url.url.endsWith(png))));
  const conversation = await new CliConversationStore(root).load(first.conversationId);
  assert.equal(conversation.messages.filter((message) => message.role === "user").length, 3);
  const persisted = JSON.stringify([conversation, forkRun, await new CodingSessionStore(root).load(first.sessionId)]);
  assert.equal(persisted.includes(png), false);
});
