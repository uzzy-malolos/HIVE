import assert from "node:assert/strict";
import test from "node:test";

import { runChatAgentTurn } from "../dist/chat/agent-turn.js";

function stubEngine(scripted) {
  let call = 0;
  return {
    async complete(request) {
      const output = scripted[call] ?? scripted[scripted.length - 1];
      call += 1;
      return { output, receipt: { role: "coding", providerId: "stub", model: "stub-1", degraded: false, promptTokens: 5, completionTokens: 7, totalTokens: 12 } };
    },
    async resolveRoute() { return { providerId: "stub", model: "stub-1", source: "test", degraded: false }; },
  };
}

test("runChatAgentTurn runs the loop, surfaces tool events, and returns the summary", async () => {
  const events = [];
  const engine = stubEngine([
    JSON.stringify({ done: false, toolCalls: [{ id: "c1", name: "read_file", arguments: { path: "README.md" } }] }),
    JSON.stringify({ done: true, summary: "Read the readme." }),
  ]);
  const result = await runChatAgentTurn(
    { cwd: process.cwd(), engine, role: "coding", message: "what does the readme say", history: [] },
    { onEvent: (event) => events.push(event) },
  );
  assert.equal(result.output, "Read the readme.");
  assert.equal(result.receipt.providerId, "stub");
  assert.ok(events.some((e) => e.type === "subagent.tool_call"));
  assert.ok(result.toolCalls >= 1);
});

test("runChatAgentTurn returns a degraded-free fallback receipt when the engine gives none", async () => {
  const engine = {
    async complete() { return { output: JSON.stringify({ done: true, summary: "done" }), receipt: { role: "coding", providerId: "", model: "" } }; },
    async resolveRoute() { return { providerId: "", model: "", source: "test", degraded: false }; },
  };
  const result = await runChatAgentTurn({ cwd: process.cwd(), engine, role: "coding", message: "hi", history: [] });
  assert.equal(result.output, "done");
  assert.equal(result.receipt.degraded, false);
});
