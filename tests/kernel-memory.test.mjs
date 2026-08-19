import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { BM25Index } from "../dist/context/bm25.js";
import { MemoryStore } from "../dist/context/memory-store.js";

test("Kernel BM25 index: tokenization and term weighting", () => {
  const docs = [
    { id: "1", text: "React Server Components run on the server and stream UI." },
    { id: "2", text: "Electron IPC patterns for sandboxed desktop windows." },
    { id: "3", text: "DeepSeek V4 Flash provides fast reasoning and tool calling." },
  ];

  const index = new BM25Index(docs);
  const results = index.search("server components streaming", 2);

  assert.ok(results.length > 0);
  assert.equal(results[0].id, "1");
  assert.ok(results[0].score > 0);
});

test("Kernel memory store: add fact and recall by relevance", async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "hive-mem-test-"));
  try {
    const store = new MemoryStore(tmpDir);
    await store.init();

    await store.addFact("Architecture", "HIVE uses two surfaces in one window sharing one kernel.");
    await store.addFact("Security", "API keys are stored in DPAPI encrypted vault and never sent to renderer.");
    await store.addFact("Styling", "Dark matte theme uses #0d0d12 background and violet accents.");

    const recalled = store.recall("encryption vault secrets", 1);
    assert.equal(recalled.length, 1);
    assert.equal(recalled[0].category, "Security");
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
