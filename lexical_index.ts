/**
 * BM25 keyword index over chunk text, plus Reciprocal Rank Fusion.
 *
 * Embeddings are weak at matching rare exact tokens — names, identifiers,
 * acronyms — which is exactly what keyword scoring is good at. Kept free of
 * Obsidian imports so it can be exercised outside the app.
 */

const STOPWORDS = new Set(
  (
    "a an and are as at be but by can do does for from how i if in into is it its me my of on or " +
    "so that the their them then there these this to was what when where which who why will with " +
    "would you your did about have has had not no"
  ).split(" ")
);

export function tokenize(text: string): string[] {
  const words = text.toLowerCase().match(/[a-z0-9]+/g) || [];
  return words.filter((w) => !STOPWORDS.has(w));
}

export class LexicalIndex {
  /** term → positions of the documents containing it */
  private postings: Map<string, number[]> = new Map();
  private termFreqs: Map<string, number>[] = [];
  private docLengths: number[] = [];
  private ids: string[] = [];
  private avgDocLength = 0;

  constructor(private readonly k1 = 1.2, private readonly b = 0.75) {}

  build(docs: { id: string; content: string }[]): void {
    this.postings.clear();
    this.termFreqs = [];
    this.docLengths = [];
    this.ids = [];
    let totalLength = 0;

    docs.forEach((doc, i) => {
      const tokens = tokenize(doc.content);
      const tf = new Map<string, number>();
      for (const t of tokens) {
        tf.set(t, (tf.get(t) || 0) + 1);
      }
      for (const t of tf.keys()) {
        let list = this.postings.get(t);
        if (!list) {
          list = [];
          this.postings.set(t, list);
        }
        list.push(i);
      }
      this.ids.push(doc.id);
      this.termFreqs.push(tf);
      this.docLengths.push(tokens.length);
      totalLength += tokens.length;
    });

    this.avgDocLength = docs.length > 0 ? totalLength / docs.length : 0;
  }

  /** BM25 score for every document containing at least one query term. */
  score(query: string): Map<string, number> {
    const n = this.ids.length;
    const scores = new Map<string, number>();

    for (const term of new Set(tokenize(query))) {
      const list = this.postings.get(term);
      if (!list) continue;

      const idf = Math.log(1 + (n - list.length + 0.5) / (list.length + 0.5));
      for (const i of list) {
        const f = this.termFreqs[i].get(term)!;
        const lengthNorm = 1 - this.b + (this.b * this.docLengths[i]) / this.avgDocLength;
        const contribution = (idf * f * (this.k1 + 1)) / (f + this.k1 * lengthNorm);
        scores.set(this.ids[i], (scores.get(this.ids[i]) || 0) + contribution);
      }
    }

    return scores;
  }
}

/**
 * Reciprocal Rank Fusion: each ranking contributes weight / (k + rank) per id.
 * Fuses on rank rather than raw score, since cosine similarity and BM25 live on
 * unrelated scales and can't be meaningfully added together.
 */
export function reciprocalRankFusion(
  rankings: { ids: string[]; weight: number }[],
  k = 60
): string[] {
  const fused = new Map<string, { score: number; firstSeen: number }>();
  for (const { ids, weight } of rankings) {
    ids.forEach((id, i) => {
      const entry = fused.get(id) || { score: 0, firstSeen: fused.size };
      entry.score += weight / (k + i + 1);
      fused.set(id, entry);
    });
  }
  // Equal weights make exact ties common (ranks 2 & 5 score the same as 5 & 2);
  // those go to whichever the first ranking placed higher.
  return [...fused.entries()]
    .sort((a, b) => b[1].score - a[1].score || a[1].firstSeen - b[1].firstSeen)
    .map(([id]) => id);
}

/** Highest score first; exact ties broken by id so every store orders them identically. */
function byScoreThenId(a: [string, number], b: [string, number]): number {
  return b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
}

/**
 * Hybrid ranking shared by every vector store, so they return identical results.
 *
 * `dense` must cover every chunk (order doesn't matter). The threshold is a
 * query-level gate on the best cosine score rather than a per-chunk filter:
 * keyword matches on ordinary words would otherwise give every off-topic
 * question a result, and the no-context fallback could never fire.
 */
export function hybridRank(
  dense: { id: string; similarity: number }[],
  lexical: LexicalIndex,
  queryText: string,
  topK: number,
  similarityThreshold: number,
  keywordWeight = 1
): string[] {
  const denseRanking = dense
    .map((d): [string, number] => [d.id, d.similarity])
    .sort(byScoreThenId);
  if (denseRanking.length === 0 || denseRanking[0][1] < similarityThreshold) {
    return [];
  }

  // Only rank chunks that still exist; a store's keyword index can briefly hold
  // chunks another device has already deleted.
  const live = new Set(denseRanking.map(([id]) => id));
  const keywordRanking = [...lexical.score(queryText).entries()]
    .filter(([id]) => live.has(id))
    .sort(byScoreThenId);

  return reciprocalRankFusion([
    { ids: denseRanking.map(([id]) => id), weight: 1 },
    { ids: keywordRanking.map(([id]) => id), weight: keywordWeight },
  ]).slice(0, topK);
}
