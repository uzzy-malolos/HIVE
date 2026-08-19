import fs from "node:fs/promises";
import path from "node:path";
import { BM25Index, type BM25Document } from "./bm25.js";

export interface MemoryFact {
  id: string;
  category: string;
  fact: string;
  createdAt: string;
}

export class MemoryStore {
  private filePath: string;
  private facts: MemoryFact[] = [];
  private index: BM25Index;

  constructor(storageDir: string) {
    this.filePath = path.join(storageDir, "memory_facts.json");
    this.index = new BM25Index();
  }

  public async init(): Promise<void> {
    try {
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      const raw = await fs.readFile(this.filePath, "utf-8");
      this.facts = JSON.parse(raw) as MemoryFact[];
    } catch {
      this.facts = [];
    }
    this.reindex();
  }

  private reindex(): void {
    const docs: BM25Document[] = this.facts.map((f) => ({
      id: f.id,
      text: `${f.category}: ${f.fact}`,
      metadata: { category: f.category },
    }));
    this.index.build(docs);
  }

  public async addFact(category: string, fact: string): Promise<MemoryFact> {
    const record: MemoryFact = {
      id: `mem_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      category,
      fact,
      createdAt: new Date().toISOString(),
    };
    this.facts.push(record);
    await fs.writeFile(this.filePath, JSON.stringify(this.facts, null, 2), "utf-8");
    this.reindex();
    return record;
  }

  public recall(query: string, limit = 5): MemoryFact[] {
    const results = this.index.search(query, limit);
    return results.map((r) => this.facts.find((f) => f.id === r.id)!).filter(Boolean);
  }

  public getFacts(): MemoryFact[] {
    return [...this.facts];
  }
}
