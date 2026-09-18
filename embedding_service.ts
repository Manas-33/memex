import { IEmbeddingProvider } from "./providers";

export interface EmbeddingResult {
  embedding: number[];
  text: string;
}

export interface DocumentChunk {
  content: string;
  metadata: {
    filePath: string;
    chunkIndex: number;
    totalChunks: number;
    noteTitle: string;
  };
}

export class EmbeddingService {
  private provider: IEmbeddingProvider;
  private chunkSize: number;
  private chunkOverlap: number;

  constructor(
    provider: IEmbeddingProvider,
    chunkSize: number = 512,
    chunkOverlap: number = 50
  ) {
    this.provider = provider;
    this.chunkSize = chunkSize;
    this.chunkOverlap = chunkOverlap;
  }

  updateProvider(provider: IEmbeddingProvider) {
    this.provider = provider;
  }

  updateChunkSettings(chunkSize: number, chunkOverlap: number) {
    this.chunkSize = chunkSize;
    this.chunkOverlap = chunkOverlap;
  }

  /**
   * Generate embedding for a single text
   */
  async generateEmbedding(text: string): Promise<number[]> {
    return this.provider.generateEmbedding(text);
  }

  /**
   * Generate embeddings for multiple texts in batch
   */
  async generateEmbeddings(texts: string[]): Promise<EmbeddingResult[]> {
    const results: EmbeddingResult[] = [];

    // Process in batches to avoid overwhelming the server
    const batchSize = 10;
    for (let i = 0; i < texts.length; i += batchSize) {
      const batch = texts.slice(i, i + batchSize);
      const batchPromises = batch.map(async (text) => {
        const embedding = await this.generateEmbedding(text);
        return { embedding, text };
      });

      const batchResults = await Promise.all(batchPromises);
      results.push(...batchResults);

      // Small delay between batches to avoid rate limiting
      if (i + batchSize < texts.length) {
        await new Promise((resolve) => window.setTimeout(resolve, 100));
      }
    }

    return results;
  }

  /**
   * Chunk a document into smaller pieces with overlap
   */
  chunkDocument(
    content: string,
    filePath: string,
    noteTitle: string
  ): DocumentChunk[] {
    // Simple word-based chunking
    const words = content.split(/\s+/);
    const chunks: DocumentChunk[] = [];

    if (words.length === 0) {
      return chunks;
    }

    let currentIndex = 0;
    let chunkIndex = 0;

    while (currentIndex < words.length) {
      const chunkWords = words.slice(
        currentIndex,
        currentIndex + this.chunkSize
      );
      const chunkContent = chunkWords.join(" ");

      chunks.push({
        content: chunkContent,
        metadata: {
          filePath,
          chunkIndex,
          totalChunks: 0, // Will be updated after all chunks are created
          noteTitle,
        },
      });

      chunkIndex++;
      currentIndex += this.chunkSize - this.chunkOverlap;

      // Prevent infinite loop if chunkSize <= chunkOverlap
      if (this.chunkSize <= this.chunkOverlap) {
        currentIndex = words.length;
      }
    }

    // Update total chunks count
    chunks.forEach((chunk) => {
      chunk.metadata.totalChunks = chunks.length;
    });

    return chunks;
  }

  /**
   * Process a document: chunk it and generate embeddings
   */
  async processDocument(
    content: string,
    filePath: string,
    noteTitle: string
  ): Promise<{ chunks: DocumentChunk[]; embeddings: number[][] }> {
    const chunks = this.chunkDocument(content, filePath, noteTitle);

    if (chunks.length === 0) {
      return { chunks: [], embeddings: [] };
    }

    const texts = chunks.map((chunk) => chunk.content);
    const embeddingResults = await this.generateEmbeddings(texts);
    const embeddings = embeddingResults.map((result) => result.embedding);

    return { chunks, embeddings };
  }
}
