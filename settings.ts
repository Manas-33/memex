import type { ProviderType } from "./providers";
import type { RetrievalMode } from "./rag_service";

/**
 * Plugin settings and their defaults. Kept free of Obsidian runtime imports so
 * the MCP server can read the same settings file outside Obsidian.
 */
export interface MemexSettings {
  // Provider settings
  providerType: ProviderType;
  // Local LLM settings
  llmEndpoint: string;
  modelName: string;
  embeddingModel: string;
  // Gemini settings
  geminiApiKey: string;
  geminiModel: string;
  geminiEmbeddingModel: string;
  // General settings
  weeklySummaryPath: string;
  personas: { name: string; prompt: string }[];
  defaultTemperature: number;
  defaultMaxTokens: number;
  // RAG Settings
  ragEnabled: boolean;
  chunkSize: number;
  chunkOverlap: number;
  topK: number;
  similarityThreshold: number;
  retrievalMode: RetrievalMode;
  autoIndexOnChange: boolean;
  excludedFolders: string[];
  chromaDbPath: string;
  vectorStoreType: "local" | "qdrant";
  qdrantUrl: string;
  qdrantApiKey: string;
  qdrantCollection: string;
  citationTrustMode: "off" | "relaxed" | "strict";
}

export const DEFAULT_SETTINGS: MemexSettings = {
  providerType: "local",
  // Local LLM settings
  llmEndpoint: "http://localhost:1234",
  modelName: "qwen/qwen3-vl-4b",
  embeddingModel: "text-embedding-nomic-embed-text-v1.5",
  // Gemini settings
  geminiApiKey: "",
  geminiModel: "gemini-2.5-flash",
  geminiEmbeddingModel: "gemini-embedding-001",
  // General
  weeklySummaryPath: "Weekly Summaries",
  personas: [
      { name: "Default", prompt: "You are a helpful AI assistant for a personal knowledge base." },
      { name: "Obsidian Architect", prompt: "You are an expert in Obsidian and Personal Knowledge Management (PKM). Help me organize notes, suggest links using [[WikiLinks]], and recommend tags. Format output in clean Markdown." },
      { name: "Zettelkasten Guide", prompt: "You are a Zettelkasten method expert. Help me break down complex ideas into atomic notes and find connections between them." },
      { name: "Daily Reflector", prompt: "You are a compassionate journaling companion. Help me reflect on my day, identify patterns, and set intentions. Use a warm, supportive tone." },
      { name: "Concise Summarizer", prompt: "You are a precise summarizer. Create concise summaries of the provided text, using bullet points and bold text for key insights." }
  ],
  defaultTemperature: 0.7,
  defaultMaxTokens: 2000,
  // RAG Settings
  ragEnabled: true,
  chunkSize: 200,
  chunkOverlap: 30,
  topK: 6,
  similarityThreshold: 0.58,
  retrievalMode: "hybrid",
  autoIndexOnChange: true,
  excludedFolders: ["Templates", ".obsidian"],
  chromaDbPath: ".obsidian/plugins/memex/chromadb",
  vectorStoreType: "local",
  qdrantUrl: "http://localhost:6333",
  qdrantApiKey: "",
  qdrantCollection: "memex",
  citationTrustMode: "relaxed",
};
