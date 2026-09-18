import { IVectorStore, SearchResult, VectorDocument } from "./vector_store";
import { LexicalIndex, hybridRank } from "./lexical_index";

/**
 * Minimal HTTP hook. The plugin passes Obsidian's `requestUrl` (works on desktop
 * and mobile, no CORS); tests pass `fetch`. No Qdrant SDK — SDKs that bundle
 * Node built-ins or native code don't run inside Obsidian.
 */
export type HttpRequest = (req: {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}) => Promise<{ status: number; json: any }>;

/** What's stored alongside each vector: the chunk, minus its embedding. */
interface ChunkPayload {
  docId: string;
  content: string;
  filePath: string;
  chunkIndex: number;
  totalChunks: number;
  noteTitle: string;
  timestamp: number;
}

/** Qdrant answered 404: the collection is gone, e.g. another device cleared the index. */
class CollectionMissingError extends Error {}

/** ~2 MB of JSON per request with 3072-dim vectors. */
const UPSERT_BATCH = 32;
/** Hybrid ranking fuses over every chunk; exact for vaults up to this many chunks. */
const MAX_CANDIDATES = 10000;

/**
 * Vector store backed by a Qdrant collection, shared by every device that points at it.
 *
 * Qdrant holds the vectors and runs the semantic search. Keyword search stays in the
 * plugin, over a local copy of the chunk text (not the vectors), so hybrid results
 * match the local store exactly.
 */
export class QdrantVectorStore implements IVectorStore {
  /** Chunk text keyed by docId, for keyword search and for building results. */
  private chunks: Map<string, ChunkPayload> = new Map();
  /** Qdrant point id → docId */
  private docIdByPoint: Map<string, string> = new Map();
  private lexical = new LexicalIndex();
  private lexicalDirty = true;
  private collectionExists = false;

  constructor(
    private readonly http: HttpRequest,
    private readonly baseUrl: string,
    private readonly apiKey: string,
    private readonly collection: string
  ) {}

  // ─── HTTP ────────────────────────────────────────────────────────────────────

  private async request(method: string, path: string, body?: unknown) {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) {
      headers["api-key"] = this.apiKey;
    }
    return this.http({
      url: `${this.baseUrl.replace(/\/+$/, "")}${path}`,
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }

  /** Like `request`, but throws on an error status and returns the `result` field. */
  private async call(method: string, path: string, body?: unknown): Promise<any> {
    const res = await this.request(method, path, body);
    if (res.status === 404) {
      this.forgetCollection();
      throw new CollectionMissingError(`Qdrant collection "${this.collection}" does not exist`);
    }
    if (res.status >= 400) {
      const detail = res.json?.status?.error ?? JSON.stringify(res.json);
      throw new Error(`Qdrant ${method} ${path} failed (${res.status}): ${detail}`);
    }
    return res.json?.result;
  }

  private get collectionPath(): string {
    return `/collections/${encodeURIComponent(this.collection)}`;
  }

  // ─── Lifecycle ───────────────────────────────────────────────────────────────

  async initialize(): Promise<void> {
    this.chunks.clear();
    this.docIdByPoint.clear();
    this.lexicalDirty = true;
    await this.refreshCollectionState();
    console.log(`Qdrant Store: ${this.collectionExists ? `loaded ${this.chunks.size} chunks` : "collection not created yet"}`);
  }

  /** Re-checks whether the collection exists (another device may have created it) and loads its text. */
  private async refreshCollectionState(): Promise<boolean> {
    const res = await this.request("GET", this.collectionPath);
    if (res.status === 404) {
      this.collectionExists = false;
      return false;
    }
    if (res.status >= 400) {
      throw new Error(`Qdrant GET ${this.collectionPath} failed (${res.status}): ${JSON.stringify(res.json)}`);
    }
    this.collectionExists = true;
    try {
      await this.loadChunks();
    } catch (error) {
      if (error instanceof CollectionMissingError) return false;
      throw error;
    }
    return true;
  }

  private forgetCollection(): void {
    this.collectionExists = false;
    this.chunks.clear();
    this.docIdByPoint.clear();
    this.lexicalDirty = true;
  }

  /** Runs a read, treating a collection that doesn't exist (yet, or any more) as empty. */
  private async orEmpty<T>(empty: T, read: () => Promise<T>): Promise<T> {
    if (!this.collectionExists && !(await this.refreshCollectionState())) return empty;
    try {
      return await read();
    } catch (error) {
      if (error instanceof CollectionMissingError) return empty;
      throw error;
    }
  }

  /** Created on first write, once the embedding size is known. */
  private async ensureCollection(dimensions: number): Promise<void> {
    if (this.collectionExists) return;
    try {
      await this.call("PUT", this.collectionPath, { vectors: { size: dimensions, distance: "Cosine" } });
      // Lets delete-by-file filter on filePath without scanning every point
      await this.call("PUT", `${this.collectionPath}/index`, { field_name: "filePath", field_schema: "keyword" });
    } catch (error) {
      // Another device may have created it first
      if (!(await this.refreshCollectionState())) throw error;
    }
    this.collectionExists = true;
  }

  /** Pulls every chunk's text (no vectors) so keyword search can run locally. */
  private async loadChunks(): Promise<void> {
    this.chunks.clear();
    this.docIdByPoint.clear();
    let offset: unknown = null;
    do {
      const result = await this.call("POST", `${this.collectionPath}/points/scroll`, {
        limit: 256,
        with_payload: true,
        with_vector: false,
        ...(offset !== null ? { offset } : {}),
      });
      for (const point of result.points) {
        this.remember(String(point.id), point.payload as ChunkPayload);
      }
      offset = result.next_page_offset ?? null;
    } while (offset !== null);
    this.lexicalDirty = true;
  }

  private remember(pointId: string, payload: ChunkPayload): void {
    this.chunks.set(payload.docId, payload);
    this.docIdByPoint.set(pointId, payload.docId);
  }

  // ─── Writes ──────────────────────────────────────────────────────────────────

  async addDocuments(documents: VectorDocument[]): Promise<void> {
    if (documents.length === 0) return;
    try {
      await this.upsert(documents);
    } catch (error) {
      if (!(error instanceof CollectionMissingError)) throw error;
      // Another device deleted the collection mid-write; recreate it and write everything again
      await this.upsert(documents);
    }
  }

  private async upsert(documents: VectorDocument[]): Promise<void> {
    await this.ensureCollection(documents[0].embedding.length);

    for (let i = 0; i < documents.length; i += UPSERT_BATCH) {
      const batch = documents.slice(i, i + UPSERT_BATCH);
      const points = await Promise.all(
        batch.map(async (doc) => ({ id: await pointId(doc.id), vector: doc.embedding, payload: toPayload(doc) }))
      );
      await this.call("PUT", `${this.collectionPath}/points?wait=true`, { points });
      for (const point of points) {
        this.remember(point.id, point.payload);
      }
    }
    this.lexicalDirty = true;
  }

  async deleteDocumentsByPath(filePath: string): Promise<void> {
    if (!this.collectionExists) return;
    try {
      await this.call("POST", `${this.collectionPath}/points/delete?wait=true`, {
        filter: { must: [{ key: "filePath", match: { value: filePath } }] },
      });
    } catch (error) {
      if (error instanceof CollectionMissingError) return;
      throw error;
    }
    for (const [point, docId] of this.docIdByPoint) {
      if (this.chunks.get(docId)?.filePath === filePath) {
        this.chunks.delete(docId);
        this.docIdByPoint.delete(point);
      }
    }
    this.lexicalDirty = true;
  }

  async clearAll(): Promise<void> {
    if (this.collectionExists) {
      try {
        await this.call("DELETE", this.collectionPath);
      } catch (error) {
        if (!(error instanceof CollectionMissingError)) throw error;
      }
    }
    this.forgetCollection();
  }

  // ─── Search ──────────────────────────────────────────────────────────────────

  async search(
    queryEmbedding: number[],
    topK: number = 5,
    similarityThreshold: number = 0.7
  ): Promise<SearchResult[]> {
    return this.orEmpty<SearchResult[]>([], async () => {
      const result = await this.call("POST", `${this.collectionPath}/points/query`, {
        query: queryEmbedding,
        limit: topK,
        score_threshold: similarityThreshold,
        with_payload: true,
      });
      return result.points
        .map((p: any) => toResult(p.payload as ChunkPayload, p.score))
        .sort((a: SearchResult, b: SearchResult) => b.similarity - a.similarity || (a.id < b.id ? -1 : 1));
    });
  }

  async searchHybrid(
    queryEmbedding: number[],
    queryText: string,
    topK: number = 5,
    similarityThreshold: number = 0.7,
    keywordWeight: number = 1
  ): Promise<SearchResult[]> {
    return this.orEmpty<SearchResult[]>([], () =>
      this.rankHybrid(queryEmbedding, queryText, topK, similarityThreshold, keywordWeight)
    );
  }

  private async rankHybrid(
    queryEmbedding: number[],
    queryText: string,
    topK: number,
    similarityThreshold: number,
    keywordWeight: number
  ): Promise<SearchResult[]> {
    // Scores for every chunk, ids only — the text comes from the local copy
    let points = await this.denseScores(queryEmbedding);
    if (points.some((p) => !this.docIdByPoint.has(p.id))) {
      // Another device indexed notes since we loaded; pick up their text first
      await this.loadChunks();
      points = points.filter((p) => this.docIdByPoint.has(p.id));
    }

    if (this.lexicalDirty) {
      this.lexical.build([...this.chunks.values()].map((c) => ({ id: c.docId, content: c.content })));
      this.lexicalDirty = false;
    }

    const dense = points.map((p) => ({ id: this.docIdByPoint.get(p.id)!, similarity: p.score }));
    const similarityById = new Map(dense.map((d) => [d.id, d.similarity]));
    return hybridRank(dense, this.lexical, queryText, topK, similarityThreshold, keywordWeight).map((id) =>
      toResult(this.chunks.get(id)!, similarityById.get(id)!)
    );
  }

  private async denseScores(queryEmbedding: number[]): Promise<{ id: string; score: number }[]> {
    const result = await this.call("POST", `${this.collectionPath}/points/query`, {
      query: queryEmbedding,
      limit: MAX_CANDIDATES,
      with_payload: false,
    });
    return result.points.map((p: any) => ({ id: String(p.id), score: p.score }));
  }

  async getCount(): Promise<number> {
    return this.orEmpty(0, async () => {
      const result = await this.call("POST", `${this.collectionPath}/points/count`, { exact: true });
      return result.count as number;
    });
  }
}

function toPayload(doc: VectorDocument): ChunkPayload {
  return { docId: doc.id, content: doc.content, ...doc.metadata };
}

function toResult(payload: ChunkPayload, similarity: number): SearchResult {
  const { docId, content, filePath, chunkIndex, totalChunks, noteTitle, timestamp } = payload;
  return { id: docId, content, metadata: { filePath, chunkIndex, totalChunks, noteTitle, timestamp }, similarity };
}

/**
 * Qdrant ids must be integers or UUIDs, and chunk ids are strings like
 * "Notes/Go.md::chunk::3". A hash-derived UUID keeps them deterministic, so a
 * re-index on any device overwrites the same points instead of duplicating them.
 */
async function pointId(docId: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-1", new TextEncoder().encode(`memex:${docId}`));
  const bytes = new Uint8Array(digest).slice(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5 (name-based, SHA-1)
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
