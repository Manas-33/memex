import { App, TFile, normalizePath } from "obsidian";

export interface CitationVerification {
  id: number;
  claim: string;
  supported: boolean;
  reason: string;
  sourceChunk: {
    noteTitle: string;
    filePath: string;
    chunkIndex: number;
    content: string;
  };
}

export interface Message {
  role: "system" | "user" | "assistant";
  content: string;
  timestamp: number;
  citations?: CitationVerification[];
}

export interface Conversation {
  id: string;
  title: string;
  messages: Message[];
  config?: {
      systemPrompt?: string;
      temperature?: number;
      maxTokens?: number;
      ragEnabled?: boolean;
      topK?: number;
      similarityThreshold?: number;
      citationTrustMode?: "off" | "relaxed" | "strict";
  };
  createdAt: number;
  updatedAt: number;
}

export class ConversationManager {
  private app: App;
  private conversationsPath: string;

  constructor(app: App) {
    this.app = app;
    this.conversationsPath = ".memex/conversations";
  }

  async initialize() {
    if (!(await this.app.vault.adapter.exists(this.conversationsPath))) {
      await this.app.vault.createFolder(this.conversationsPath);
    }
  }

  async createConversation(title: string = "New Chat"): Promise<Conversation> {
    const id = crypto.randomUUID();
    const conversation: Conversation = {
      id,
      title,
      messages: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };
    await this.saveConversation(conversation);
    return conversation;
  }

  async saveConversation(conversation: Conversation) {
    conversation.updatedAt = Date.now();
    const filePath = `${this.conversationsPath}/${conversation.id}.json`;
    const content = JSON.stringify(conversation, null, 2);

    if (await this.app.vault.adapter.exists(filePath)) {
      await this.app.vault.adapter.write(filePath, content);
    } else {
      await this.app.vault.create(filePath, content);
    }
  }

  async loadConversation(id: string): Promise<Conversation | null> {
    const filePath = `${this.conversationsPath}/${id}.json`;
    if (await this.app.vault.adapter.exists(filePath)) {
      const content = await this.app.vault.adapter.read(filePath);
      return JSON.parse(content);
    }
    return null;
  }

  async getConversations(): Promise<Conversation[]> {
    if (!(await this.app.vault.adapter.exists(this.conversationsPath))) {
      return [];
    }

    const files = await this.app.vault.adapter.list(this.conversationsPath);
    const conversations: Conversation[] = [];

    for (const filePath of files.files) {
      if (filePath.endsWith(".json")) {
        try {
          const content = await this.app.vault.adapter.read(filePath);
          const conversation = JSON.parse(content);
          conversations.push(conversation);
        } catch (e) {
          console.error(`Failed to load conversation ${filePath}`, e);
        }
      }
    }

    return conversations.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async deleteConversation(id: string) {
    const filePath = `${this.conversationsPath}/${id}.json`;
    if (await this.app.vault.adapter.exists(filePath)) {
      await this.app.vault.adapter.remove(filePath);
    }
  }

  async renameConversation(id: string, newTitle: string) {
    const conversation = await this.loadConversation(id);
    if (conversation) {
      conversation.title = newTitle;
      await this.saveConversation(conversation);
    }
  }
}
