import test from "node:test";
import assert from "node:assert/strict";
import { evaluateToolPermission } from "../dist/kernel/permissions.js";

test("Kernel permissions: Chat surface prohibits all mutating tools", () => {
  const readTool = { name: "read_file", description: "", parameters: {}, readOnly: true };
  const writeTool = { name: "write_file", description: "", parameters: {}, readOnly: false };

  const evalRead = evaluateToolPermission(readTool, "chat", "auto");
  assert.equal(evalRead.allowed, true);
  assert.equal(evalRead.requiresApproval, false);

  const evalWrite = evaluateToolPermission(writeTool, "chat", "yolo");
  assert.equal(evalWrite.allowed, false);
  assert.equal(evalWrite.requiresApproval, false);
  assert.ok(evalWrite.reason?.includes("prohibited on the Chat surface"));
});

test("Kernel permissions: Codex surface honors Ask, Auto, and YOLO postures", () => {
  const writeTool = { name: "write_file", description: "", parameters: {}, readOnly: false };
  const bashTool = { name: "bash", description: "", parameters: {}, readOnly: false };

  // Ask posture: all mutating tools require approval
  const evalAsk = evaluateToolPermission(writeTool, "codex", "ask");
  assert.equal(evalAsk.allowed, true);
  assert.equal(evalAsk.requiresApproval, true);

  // Auto posture: file writes allowed; bash requires approval
  const evalAutoWrite = evaluateToolPermission(writeTool, "codex", "auto");
  assert.equal(evalAutoWrite.allowed, true);
  assert.equal(evalAutoWrite.requiresApproval, false);

  const evalAutoBash = evaluateToolPermission(bashTool, "codex", "auto");
  assert.equal(evalAutoBash.allowed, true);
  assert.equal(evalAutoBash.requiresApproval, true);

  // YOLO posture: all tools allowed without approval
  const evalYolo = evaluateToolPermission(bashTool, "codex", "yolo");
  assert.equal(evalYolo.allowed, true);
  assert.equal(evalYolo.requiresApproval, false);
});
