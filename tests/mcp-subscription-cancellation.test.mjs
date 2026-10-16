import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { connectMcp, setExtensionState } from "../dist/extensions/index.js";

const prefix = "io.modelcontextprotocol/";
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function deadline(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Expected subscription cancellation stage was not reached")), 5000); })]); }
  finally { clearTimeout(timer); }
}
async function fixture(run) {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "hive-subscription-cancellation-")), root = path.join(temporary, "project");
  const options = { trustStateDir: path.join(temporary, "trust") }, requests = [], streams = new Set(); let connection, fixtureFailure;
  const server = http.createServer(async (request, response) => {
    try {
      assert.equal(request.method, "POST"); let body = ""; for await (const chunk of request) body += chunk;
      const message = JSON.parse(body); requests.push(message);
      if (message.method === "subscriptions/listen") {
        response.writeHead(200, { "content-type": "text/event-stream" }); response.flushHeaders(); streams.add(response); response.on("close", () => streams.delete(response));
        response.write(`data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/subscriptions/acknowledged", params: { _meta: { [`${prefix}subscriptionId`]: message.id }, notifications: message.params.notifications } })}\n\n`); return;
      }
      const result = { resultType: "complete", supportedVersions: ["2026-07-28"], capabilities: { tools: {}, extensions: { [`${prefix}tasks`]: {} } } };
      assert.equal(message.method, "server/discover"); response.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    } catch (error) { fixtureFailure = error; if (!response.headersSent) response.writeHead(500); response.end(); }
  });
  try {
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    await fs.mkdir(path.join(root, ".hive"), { recursive: true });
    await fs.writeFile(path.join(root, ".hive", "extensions.json"), JSON.stringify({ version: 1, mcpServers: { fixture: { transport: "http", url: `http://127.0.0.1:${server.address().port}/mcp`, timeoutMs: 5000 } } }));
    await setExtensionState(root, "mcp:fixture", "trust", options); await setExtensionState(root, "mcp:fixture", "enable", options);
    connection = await connectMcp(root, "fixture", options);
    await run({ root, connection, requests, streams }); if (fixtureFailure) throw fixtureFailure;
  } finally {
    await connection?.close(); for (const stream of streams) stream.end(); server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    assert.equal(path.dirname(path.resolve(temporary)), path.resolve(os.tmpdir())); assert.ok(path.basename(temporary).startsWith("hive-subscription-cancellation-")); await fs.rm(temporary, { recursive: true, force: true });
  }
}

test("public background stop during the initial trust check prevents a later subscription send", async (t) => fixture(async ({ root, connection, requests }) => {
  const entered = deferred(), release = deferred(), realpath = fs.realpath; let armed = true;
  t.mock.method(fs, "realpath", async (...args) => {
    if (armed && args[0] === root) { armed = false; entered.resolve(); await release.promise; }
    return realpath(...args);
  });
  const outcome = connection.startBackground().then(() => undefined, (error) => error);
  try {
    await deadline(entered.promise); await connection.stopBackground(); release.resolve();
    const error = await deadline(outcome); assert.equal(error?.name, "AbortError"); assert.equal(requests.some((request) => request.method === "subscriptions/listen"), false);
  } finally { release.resolve(); await outcome; }
}));

test("public stop while filter refresh aborts its old stream prevents an automatic reopen", async (t) => fixture(async ({ connection, requests }) => {
  const nativeFetch = globalThis.fetch, stopped = deferred(); let armed = true, stopPromise;
  t.mock.method(globalThis, "fetch", (url, options) => {
    const message = JSON.parse(options.body);
    if (message.method === "subscriptions/listen") options.signal.addEventListener("abort", () => {
      if (!armed) return; armed = false; stopPromise = connection.stopBackground(); stopped.resolve();
    }, { once: true });
    return nativeFetch(url, options);
  });
  await connection.startBackground(); assert.equal(requests.filter((request) => request.method === "subscriptions/listen").length, 1);
  const outcome = connection.subscribeTask("fixture-task-to-watch").then(() => undefined, (error) => error);
  await deadline(stopped.promise); await deadline(stopPromise);
  const error = await deadline(outcome); assert.equal(error?.name, "AbortError"); assert.equal(requests.filter((request) => request.method === "subscriptions/listen").length, 1);
}));
