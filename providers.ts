import { requestUrl, RequestUrlParam } from "obsidian";

// ─── SSE Stream Parser ───────────────────────────────────────────────────────

/** The parts of OpenAI-compatible responses this plugin reads. */
interface ChatCompletionResponse {
  choices: { message: { content: string } }[];
}
interface ChatCompletionChunk {
  choices?: { delta?: { content?: string } }[];
}
interface EmbeddingResponse {
  data: { embedding: number[] }[];
}

async function* parseSSEStream(
  body: ReadableStream<Uint8Array>
): AsyncGenerator<string, void, unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith(":")) continue;
        if (!trimmed.startsWith("data: ")) continue;

        const data = trimmed.slice(6);
        if (data === "[DONE]") return;

        try {
          const parsed = JSON.parse(data) as ChatCompletionChunk;
          const content = parsed.choices?.[0]?.delta?.content;
          if (content) {
            yield content;
          }
        } catch {
          // Skip malformed JSON chunks
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProviderType = "local" | "gemini";

export interface LLMProviderConfig {
  endpoint: string;
  model: string;
  apiKey?: string;
}

export interface EmbeddingProviderConfig {
  endpoint: string;
  model: string;
  apiKey?: string;
}

export interface ProviderSettings {
  providerType: ProviderType;
  llmEndpoint: string;
  modelName: string;
  embeddingModel: string;
  geminiApiKey: string;
  geminiModel: string;
  geminiEmbeddingModel: string;
}

// ─── Interfaces ───────────────────────────────────────────────────────────────

export interface ILLMProvider {
  completion(
    messages: { role: string; content: string }[],
    config?: { temperature?: number; max_tokens?: number }
  ): Promise<string>;
  streamCompletion(
    messages: { role: string; content: string }[],
    config?: { temperature?: number; max_tokens?: number }
  ): AsyncGenerator<string, void, unknown>;
  updateConfig(config: LLMProviderConfig): void;
}

export interface IEmbeddingProvider {
  generateEmbedding(text: string): Promise<number[]>;
  updateConfig(config: EmbeddingProviderConfig): void;
}

// ─── Local Providers (OpenAI-Compatible) ──────────────────────────────────────

export class LocalLLMProvider implements ILLMProvider {
  private endpoint: string;
  private model: string;

  constructor(config: LLMProviderConfig) {
    this.endpoint = config.endpoint;
    this.model = config.model;
  }

  async completion(
    messages: { role: string; content: string }[],
    config?: { temperature?: number; max_tokens?: number }
  ): Promise<string> {
    const params: RequestUrlParam = {
      url: `${this.endpoint}/v1/chat/completions`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: config?.temperature ?? 0.7,
        max_tokens: config?.max_tokens ?? 2000,
      }),
    };

    const response = await requestUrl(params);
    return (response.json as ChatCompletionResponse).choices[0].message.content;
  }

  async *streamCompletion(
    messages: { role: string; content: string }[],
    config?: { temperature?: number; max_tokens?: number }
  ): AsyncGenerator<string, void, unknown> {
    const response = await fetch(`${this.endpoint}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: config?.temperature ?? 0.7,
        max_tokens: config?.max_tokens ?? 2000,
        stream: true,
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error(`Stream request failed: ${response.status}`);
    }

    yield* parseSSEStream(response.body);
  }

  updateConfig(config: LLMProviderConfig): void {
    this.endpoint = config.endpoint;
    this.model = config.model;
  }
}

export class LocalEmbeddingProvider implements IEmbeddingProvider {
  private endpoint: string;
  private model: string;

  constructor(config: EmbeddingProviderConfig) {
    this.endpoint = config.endpoint;
    this.model = config.model;
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const params: RequestUrlParam = {
      url: `${this.endpoint}/v1/embeddings`,
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: this.model,
        input: text,
      }),
    };

    const response = await requestUrl(params);
    return (response.json as EmbeddingResponse).data[0].embedding;
  }

  updateConfig(config: EmbeddingProviderConfig): void {
    this.endpoint = config.endpoint;
    this.model = config.model;
  }
}

// ─── Gemini Providers (OpenAI-Compatible Endpoint) ────────────────────────────

const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai";

export class GeminiLLMProvider implements ILLMProvider {
  private model: string;
  private apiKey: string;

  constructor(config: LLMProviderConfig) {
    this.model = config.model;
    this.apiKey = config.apiKey || "";
  }

  async completion(
    messages: { role: string; content: string }[],
    config?: { temperature?: number; max_tokens?: number }
  ): Promise<string> {
    const params: RequestUrlParam = {
      url: `${GEMINI_BASE_URL}/chat/completions`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: config?.temperature ?? 0.7,
        max_tokens: config?.max_tokens ?? 2000,
      }),
    };

    const response = await requestUrl(params);
    return (response.json as ChatCompletionResponse).choices[0].message.content;
  }

  async *streamCompletion(
    messages: { role: string; content: string }[],
    config?: { temperature?: number; max_tokens?: number }
  ): AsyncGenerator<string, void, unknown> {
    const response = await fetch(`${GEMINI_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: config?.temperature ?? 0.7,
        max_tokens: config?.max_tokens ?? 2000,
        stream: true,
      }),
    });

    if (!response.ok || !response.body) {
      throw new Error(`Stream request failed: ${response.status}`);
    }

    yield* parseSSEStream(response.body);
  }

  updateConfig(config: LLMProviderConfig): void {
    this.model = config.model;
    this.apiKey = config.apiKey || "";
  }
}

export class GeminiEmbeddingProvider implements IEmbeddingProvider {
  private model: string;
  private apiKey: string;

  constructor(config: EmbeddingProviderConfig) {
    this.model = config.model;
    this.apiKey = config.apiKey || "";
  }

  async generateEmbedding(text: string): Promise<number[]> {
    const params: RequestUrlParam = {
      url: `${GEMINI_BASE_URL}/embeddings`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        input: text,
      }),
    };

    const response = await requestUrl(params);
    return (response.json as EmbeddingResponse).data[0].embedding;
  }

  updateConfig(config: EmbeddingProviderConfig): void {
    this.model = config.model;
    this.apiKey = config.apiKey || "";
  }
}

// ─── Factory Functions ────────────────────────────────────────────────────────

export function createLLMProvider(settings: ProviderSettings): ILLMProvider {
  switch (settings.providerType) {
    case "gemini":
      return new GeminiLLMProvider({
        endpoint: GEMINI_BASE_URL,
        model: settings.geminiModel,
        apiKey: settings.geminiApiKey,
      });
    case "local":
    default:
      return new LocalLLMProvider({
        endpoint: settings.llmEndpoint,
        model: settings.modelName,
      });
  }
}

export function createEmbeddingProvider(settings: ProviderSettings): IEmbeddingProvider {
  switch (settings.providerType) {
    case "gemini":
      return new GeminiEmbeddingProvider({
        endpoint: GEMINI_BASE_URL,
        model: settings.geminiEmbeddingModel,
        apiKey: settings.geminiApiKey,
      });
    case "local":
    default:
      return new LocalEmbeddingProvider({
        endpoint: settings.llmEndpoint,
        model: settings.embeddingModel,
      });
  }
}
