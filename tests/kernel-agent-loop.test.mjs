import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { AgentLoop } from "../dist/kernel/agent-loop.js";
import { KernelSessionStore } from "../dist/kernel/session-store.js";

test("Kernel agent loop: multi-turn tool execution with receipts", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hive-loop-test-"));
  try {
    const store = new KernelSessionStore(tmpDir);
    await store.init();

    const session = await store.createSession({
      surface: "codex",
      workspaceRoot: tmpDir,
      posture: "auto",
      model: "deepseek-v4-flash",
    });

    let turnCount = 0;
    const mockProvider = async (options, onDelta) => {
      turnCount++;
      if (turnCount === 1) {
        // Step 1: Agent calls write_file tool
        return {
          content: "I will create a file.",
          toolCalls: [
            {
              id: "call_1",
              name: "write_file",
              arguments: JSON.stringify({ path: "hello.txt", content: "Hello HIVE" }),
            },
          ],
          usage: { promptTokens: 50, completionTokens: 20, totalTokens: 70 },
        };
      } else {
        // Step 2: Agent responds after reading tool result
        onDelta({ content: "File created successfully!" });
        return {
          content: "File created successfully!",
          usage: { promptTokens: 80, completionTokens: 15, totalTokens: 95 },
        };
      }
    };

    const streamDeltas = [];
    const toolStarts = [];
    const toolFinishes = [];

    const result = await AgentLoop.executeTurn(
      session,
      "Please create hello.txt",
      mockProvider,
      {
        onChunk: (chunk) => streamDeltas.push(chunk),
        onToolStart: (tc) => toolStarts.push(tc),
        onToolFinish: (res) => toolFinishes.push(res),
      }
    );

    assert.equal(result.userMessage.content, "Please create hello.txt");
    assert.equal(result.assistantMessage.content, "File created successfully!");
    assert.ok(result.assistantMessage.receipt);
    assert.equal(result.assistantMessage.receipt.totalTokens, 165);

    // Verify tool execution on disk
    const createdContent = await fs.readFile(path.join(tmpDir, "hello.txt"), "utf-8");
    assert.equal(createdContent, "Hello HIVE");

    // Verify session checkpoint was created
    assert.equal(session.checkpoints.length, 1);
    assert.equal(session.checkpoints[0].files[0].relativePath, "hello.txt");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
