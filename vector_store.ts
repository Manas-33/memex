import { App } from "obsidian";
import { LexicalIndex, hybridRank } from "./lexical_index";

export interface VectorDocument {
  id: string;
  content: string;
  embedding: number[];
  metadata: {
    filePath: string;
    chunkIndex: number;
    totalChunks: number;
    noteTitle: string;
    timestamp: number;
  };
}

export interface SearchResult {
  id: string;
  content: string;
  metadata: {
    filePath: string;
    chunkIndex: number;
    totalChunks: number;
    noteTitle: string;
    timestamp: number;
  };
  similarity: number;
}

/** What the RAG service needs from a vector store; implemented locally and by Qdrant. */
export interface IVectorStore {
  initialize(): Promise<void>;
  addDocuments(documents: VectorDocument[]): Promise<void>;
  deleteDocumentsByPath(filePath: string): Promise<void>;
  search(queryEmbedding: number[], topK?: number, similarityThreshold?: number): Promise<SearchResult[]>;
  searchHybrid(
    queryEmbedding: number[],
    queryText: string,
    topK?: number,
    similarityThreshold?: number,
    keywordWeight?: number
  ): Promise<SearchResult[]>;
  clearAll(): Promise<void>;
  getCount(): Promise<number>;
}

interface VectorStoreData {
  documents: VectorDocument[];
  version: string;
}

/**
 * Internal representation with Float32Array embedding and pre-computed norm
 * for fast cosine similarity. Float32Array provides ~2-3x speedup over
 * number[] for vector math due to contiguous memory and CPU optimizations.
 */
interface IndexedDocument {
  doc: VectorDocument;
  embedding: Float32Array; // Typed array copy for fast math
  norm: number;            // Pre-computed L2 norm
}

export class LocalVectorStore implements IVectorStore {
  private documents: Map<string, IndexedDocument> = new Map();
  /** Secondary index: filePath → Set of document IDs for O(1) path lookups */
  private pathIndex: Map<string, Set<string>> = new Map();
  private dbPath: string;
  private app: App;
  private saveTimeout: NodeJS.Timeout | null = null;
  private lexical = new LexicalIndex();
  /** Set whenever documents change; the keyword index is rebuilt lazily on the next hybrid search. */
  private lexicalDirty = true;

  constructor(app: App, dbPath: string) {
    this.app = app;
    this.dbPath = dbPath;
  }

  // ─── Lifecycle ──────────────────────────────────────────────────────────────

  /**
   * Initialize vector store and load from disk
   */
  async initialize(): Promise<void> {
    try {
      // Ensure directory exists
      const dirPath = this.dbPath.substring(0, this.dbPath.lastIndexOf("/"));
      if (!(await this.app.vault.adapter.exists(dirPath))) {
        await this.app.vault.adapter.mkdir(dirPath);
      }

      // Load existing data if available
      if (await this.app.vault.adapter.exists(this.dbPath)) {
        const data = await this.app.vault.adapter.read(this.dbPath);
        const storeData: VectorStoreData = JSON.parse(data);
        
        // Rebuild the maps from loaded documents
        this.documents.clear();
        this.pathIndex.clear();
        for (const doc of storeData.documents) {
          this.addToIndex(doc);
        }
        
        console.log(`Vector Store: Loaded ${this.documents.size} documents from disk`);
      } else {
        console.log("Vector Store: Initialized empty store");
      }
    } catch (error) {
      console.error("Failed to initialize Vector Store:", error);
      throw error;
    }
  }

  // ─── Internal Helpers ───────────────────────────────────────────────────────

  /**
   * Add a document to both the main store and the path index.
   * Converts embedding to Float32Array and pre-computes its norm.
   */
  private addToIndex(doc: VectorDocument): void {
    const embedding = new Float32Array(doc.embedding);
    const norm = this.computeNorm(embedding);
    this.documents.set(doc.id, { doc, embedding, norm });
    this.lexicalDirty = true;

    // Update path index
    if (!this.pathIndex.has(doc.metadata.filePath)) {
      this.pathIndex.set(doc.metadata.filePath, new Set());
    }
    this.pathIndex.get(doc.metadata.filePath)!.add(doc.id);
  }

  /**
   * Remove a document from both the main store and the path index.
   */
  private removeFromIndex(id: string): void {
    const indexed = this.documents.get(id);
    if (indexed) {
      const pathSet = this.pathIndex.get(indexed.doc.metadata.filePath);
      if (pathSet) {
        pathSet.delete(id);
        if (pathSet.size === 0) {
          this.pathIndex.delete(indexed.doc.metadata.filePath);
        }
      }
      this.documents.delete(id);
      this.lexicalDirty = true;
    }
  }

  /**
   * Compute the L2 norm of a Float32Array vector.
   */
  private computeNorm(v: Float32Array): number {
    let sum = 0;
    for (let i = 0; i < v.length; i++) {
      sum += v[i] * v[i];
    }
    return Math.sqrt(sum);
  }

  /**
   * Compute cosine similarity using Float32Array and pre-computed norms.
   * Float32Array enables V8 to use optimized SIMD-like paths for the
   * dot product loop, giving ~2-3x speedup over regular number[].
   */
  private cosineSimilarityWithNorms(
    a: Float32Array,
    normA: number,
    b: Float32Array,
    normB: number
  ): number {
    if (normA === 0 || normB === 0) {
      return 0;
    }

    let dotProduct = 0;
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i];
    }

    return dotProduct / (normA * normB);
  }

  // ─── Persistence ─────────────────────────────────────────────────────────────

  /**
   * Save the vector store to disk (debounced).
   * Uses compact JSON (no pretty-printing) to reduce file size ~40%.
   */
  private async saveToDisk(): Promise<void> {
    // Debounce saves to avoid excessive writes
    if (this.saveTimeout) {
      clearTimeout(this.saveTimeout);
    }

    this.saveTimeout = setTimeout(async () => {
      try {
        const docs: VectorDocument[] = [];
        for (const indexed of this.documents.values()) {
          docs.push(indexed.doc);
        }

        const storeData: VectorStoreData = {
          documents: docs,
          version: "1.0",
        };

        // Compact JSON — no pretty-printing (saves ~40% disk space for embedding arrays)
        const data = JSON.stringify(storeData);
        await this.app.vault.adapter.write(this.dbPath, data);
        console.log(`Vector Store: Saved ${this.documents.size} documents to disk`);
      } catch (error) {
        console.error("Failed to save Vector Store:", error);
      }
    }, 1000);
  }

  // ─── CRUD Operations ─────────────────────────────────────────────────────────

  /**
   * Add documents to the vector store
   */
  async addDocuments(documents: VectorDocument[]): Promise<void> {
    if (documents.length === 0) {
      return;
    }

    for (const doc of documents) {
      this.addToIndex(doc);
    }

    await this.saveToDisk();
    console.log(`Vector Store: Added ${documents.length} documents`);
  }

  /**
   * Update existing documents
   */
  async updateDocuments(documents: VectorDocument[]): Promise<void> {
    if (documents.length === 0) {
      return;
    }

    for (const doc of documents) {
      this.removeFromIndex(doc.id);
      this.addToIndex(doc);
    }

    await this.saveToDisk();
    console.log(`Vector Store: Updated ${documents.length} documents`);
  }

  /**
   * Delete documents by file path.
   * Uses the path index for O(1) lookup instead of scanning all documents.
   */
  async deleteDocumentsByPath(filePath: string): Promise<void> {
    const ids = this.pathIndex.get(filePath);
    if (!ids || ids.size === 0) {
      return;
    }

    const count = ids.size;
    // Copy the set since removeFromIndex mutates it
    const idsCopy = [...ids];
    for (const id of idsCopy) {
      this.removeFromIndex(id);
    }

    await this.saveToDisk();
    console.log(`Vector Store: Deleted ${count} documents for ${filePath}`);
  }

  // ─── Search ──────────────────────────────────────────────────────────────────

  /**
   * Search for similar documents using a min-heap to efficiently track top-K results.
   * - Pre-computed norms avoid redundant sqrt calculations per document.
   * - Query norm is computed only once.
   * - Min-heap avoids sorting the entire result set.
   */
  async search(
    queryEmbedding: number[],
    topK: number = 5,
    similarityThreshold: number = 0.7
  ): Promise<SearchResult[]> {
    // Convert query to Float32Array for fast typed-array math
    const queryVec = new Float32Array(queryEmbedding);
    const queryNorm = this.computeNorm(queryVec);
    if (queryNorm === 0) {
      return [];
    }

    // Use a simple min-heap (array) to track top-K results efficiently.
    // For typical vault sizes (< 10K docs) this avoids sorting the full array.
    const heap: Array<{ doc: VectorDocument; similarity: number }> = [];

    for (const indexed of this.documents.values()) {
      const similarity = this.cosineSimilarityWithNorms(
        queryVec,
        queryNorm,
        indexed.embedding,
        indexed.norm
      );

      if (similarity < similarityThreshold) {
        continue;
      }

      if (heap.length < topK) {
        heap.push({ doc: indexed.doc, similarity });
        // Bubble up to maintain min-heap (smallest similarity at index 0)
        this.heapBubbleUp(heap);
      } else if (similarity > heap[0].similarity) {
        // Replace the smallest element
        heap[0] = { doc: indexed.doc, similarity };
        this.heapBubbleDown(heap);
      }
    }

    // Sort final results descending by similarity
    heap.sort((a, b) => b.similarity - a.similarity || (a.doc.id < b.doc.id ? -1 : 1));

    return heap.map(({ doc, similarity }) => ({
      id: doc.id,
      content: doc.content,
      metadata: doc.metadata,
      similarity,
    }));
  }

  /**
   * Hybrid retrieval: the vector ranking fused with a BM25 keyword ranking via RRF.
   *
   * The similarity threshold is applied as a query-level gate on the best cosine
   * score rather than per chunk. Without the gate, BM25 matches ordinary words in
   * any question, so off-topic queries would always return something and the
   * no-context fallback could never fire.
   */
  async searchHybrid(
    queryEmbedding: number[],
    queryText: string,
    topK: number = 5,
    similarityThreshold: number = 0.7,
    keywordWeight: number = 1
  ): Promise<SearchResult[]> {
    const queryVec = new Float32Array(queryEmbedding);
    const queryNorm = this.computeNorm(queryVec);
    if (queryNorm === 0 || this.documents.size === 0) {
      return [];
    }

    const dense: { id: string; similarity: number }[] = [];
    for (const indexed of this.documents.values()) {
      dense.push({
        id: indexed.doc.id,
        similarity: this.cosineSimilarityWithNorms(queryVec, queryNorm, indexed.embedding, indexed.norm),
      });
    }

    if (this.lexicalDirty) {
      this.lexical.build([...this.documents.values()].map(({ doc }) => doc));
      this.lexicalDirty = false;
    }

    const similarityById = new Map(dense.map((d) => [d.id, d.similarity]));
    return hybridRank(dense, this.lexical, queryText, topK, similarityThreshold, keywordWeight).map((id) => {
      const { doc } = this.documents.get(id)!;
      return { id: doc.id, content: doc.content, metadata: doc.metadata, similarity: similarityById.get(id)! };
    });
  }

  /**
   * Min-heap bubble up: maintain heap property after insertion
   */
  private heapBubbleUp(
    heap: Array<{ similarity: number; [key: string]: any }>
  ): void {
    let i = heap.length - 1;
    while (i > 0) {
      const parent = Math.floor((i - 1) / 2);
      if (heap[i].similarity < heap[parent].similarity) {
        [heap[i], heap[parent]] = [heap[parent], heap[i]];
        i = parent;
      } else {
        break;
      }
    }
  }

  /**
   * Min-heap bubble down: maintain heap property after replacement at root
   */
  private heapBubbleDown(
    heap: Array<{ similarity: number; [key: string]: any }>
  ): void {
    let i = 0;
    const n = heap.length;
    while (true) {
      let smallest = i;
      const left = 2 * i + 1;
      const right = 2 * i + 2;

      if (left < n && heap[left].similarity < heap[smallest].similarity) {
        smallest = left;
      }
      if (right < n && heap[right].similarity < heap[smallest].similarity) {
        smallest = right;
      }

      if (smallest !== i) {
        [heap[i], heap[smallest]] = [heap[smallest], heap[i]];
        i = smallest;
      } else {
        break;
      }
    }
  }

  // ─── Queries ──────────────────────────────────────────────────────────────────

  /**
   * Get all document IDs for a specific file.
   * Uses the path index for O(1) lookup.
   */
  async getDocumentIdsByPath(filePath: string): Promise<string[]> {
    const ids = this.pathIndex.get(filePath);
    return ids ? [...ids] : [];
  }

  /**
   * Clear all documents from the collection
   */
  async clearAll(): Promise<void> {
    this.documents.clear();
    this.pathIndex.clear();
    this.lexicalDirty = true;
    await this.saveToDisk();
    console.log("Vector Store: Cleared all documents");
  }

  /** Every stored document, for moving the index to another store. */
  getAllDocuments(): VectorDocument[] {
    return [...this.documents.values()].map(({ doc }) => doc);
  }

  /**
   * Get total count of documents in the collection
   */
  async getCount(): Promise<number> {
    return this.documents.size;
  }
}
