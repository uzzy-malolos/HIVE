export interface BM25Document {
  id: string;
  text: string;
  metadata?: Record<string, unknown>;
}

export interface BM25ScoreResult {
  id: string;
  score: number;
  document: BM25Document;
}

export class BM25Index {
  private k1: number;
  private b: number;
  private docs: BM25Document[] = [];
  private docTokens: string[][] = [];
  private docLengths: number[] = [];
  private avgDocLength: number = 0;
  private docFreqs: Map<string, number> = new Map();

  constructor(docs: BM25Document[] = [], k1 = 1.2, b = 0.75) {
    this.k1 = k1;
    this.b = b;
    if (docs.length > 0) {
      this.build(docs);
    }
  }

  public static tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s_-]/gu, " ")
      .split(/\s+/)
      .filter((t) => t.length > 1);
  }

  public build(docs: BM25Document[]): void {
    this.docs = docs;
    this.docTokens = [];
    this.docLengths = [];
    this.docFreqs.clear();

    let totalLength = 0;

    for (const doc of docs) {
      const tokens = BM25Index.tokenize(doc.text);
      this.docTokens.push(tokens);
      this.docLengths.push(tokens.length);
      totalLength += tokens.length;

      const uniqueTokens = new Set(tokens);
      for (const token of uniqueTokens) {
        this.docFreqs.set(token, (this.docFreqs.get(token) || 0) + 1);
      }
    }

    this.avgDocLength = docs.length > 0 ? totalLength / docs.length : 0;
  }

  public search(query: string, topK: number = 5): BM25ScoreResult[] {
    const queryTokens = BM25Index.tokenize(query);
    if (queryTokens.length === 0 || this.docs.length === 0) return [];

    const scores: { id: string; score: number; document: BM25Document }[] = [];
    const N = this.docs.length;

    for (let i = 0; i < this.docs.length; i++) {
      const doc = this.docs[i];
      const tokens = this.docTokens[i];
      const docLength = this.docLengths[i];
      let score = 0;

      const tokenCounts = new Map<string, number>();
      for (const t of tokens) {
        tokenCounts.set(t, (tokenCounts.get(t) || 0) + 1);
      }

      for (const qToken of queryTokens) {
        const df = this.docFreqs.get(qToken) || 0;
        if (df === 0) continue;

        // IDF calculation
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

        // Term frequency in document
        const tf = tokenCounts.get(qToken) || 0;

        // BM25 term weighting
        const numerator = tf * (this.k1 + 1);
        const denominator = tf + this.k1 * (1 - this.b + this.b * (docLength / (this.avgDocLength || 1)));

        score += idf * (numerator / denominator);
      }

      if (score > 0) {
        scores.push({ id: doc.id, score, document: doc });
      }
    }

    scores.sort((a, b) => b.score - a.score);
    return scores.slice(0, topK);
  }
}
