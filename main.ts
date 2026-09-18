import { App, Plugin, PluginSettingTab, Setting, WorkspaceLeaf, Notice, MarkdownView, Editor, requestUrl, normalizePath } from "obsidian";
import { LLMService } from "./llm_service";
import { Processor } from "./processor";
import { ChatView, VIEW_TYPE_CHAT } from "./chat_view";
import { ConversationManager } from "./conversation_manager";
import { EmbeddingService } from "./embedding_service";
import { IVectorStore, LocalVectorStore } from "./vector_store";
import { HttpRequest, QdrantVectorStore } from "./qdrant_store";
import { RAGService, RetrievalMode } from "./rag_service";
import { ProviderType, createLLMProvider, createEmbeddingProvider } from "./providers";
import { MemexSettings, DEFAULT_SETTINGS } from "./settings";
import { confirmAction } from "./confirm_modal";

function isPersona(value: unknown): value is MemexSettings["personas"][number] {
  const p = value as { name?: unknown; prompt?: unknown } | null;
  return typeof p?.name === "string" && typeof p?.prompt === "string";
}

export default class MemexPlugin extends Plugin {
  settings: MemexSettings;
  llmService: LLMService;
  processor: Processor;
  conversationManager: ConversationManager;
  embeddingService: EmbeddingService;
  vectorStore: IVectorStore;
  ragService: RAGService;

  async onload() {
    await this.loadSettings();

    const llmProvider = createLLMProvider(this.settings);
    this.llmService = new LLMService(llmProvider);
    this.processor = new Processor(this.llmService);
    this.conversationManager = new ConversationManager(this.app);
    await this.conversationManager.initialize();

    // Initialize RAG services if enabled
    if (this.settings.ragEnabled) {
      try {
        const embeddingProvider = createEmbeddingProvider(this.settings);
        this.embeddingService = new EmbeddingService(
          embeddingProvider,
          this.settings.chunkSize,
          this.settings.chunkOverlap
        );

        const vectorStorePath = `${this.indexDir}/vectors.json`;
        const contentHashesPath = `${this.indexDir}/content_hashes.json`;
        this.vectorStore = this.settings.vectorStoreType === "qdrant"
          ? this.createQdrantStore()
          : new LocalVectorStore(this.app, vectorStorePath);

        this.ragService = new RAGService(
          this.app,
          this.embeddingService,
          this.vectorStore,
          contentHashesPath,
          this.settings.excludedFolders,
          this.settings.autoIndexOnChange
        );

        // As a child, its watchers are removed and pending writes flushed when the plugin unloads
        this.addChild(this.ragService);
        await this.ragService.initialize();
        new Notice("RAG service initialized");
      } catch (error) {
        console.error("Failed to initialize RAG:", error);
        new Notice("Failed to initialize RAG. Check console for details.");
      }
    }

    this.registerView(
      VIEW_TYPE_CHAT,
      (leaf) => new ChatView(
        leaf,
        this.llmService,
        this.conversationManager,
        this.settings,
        this.settings.ragEnabled ? this.ragService : undefined
      )
    );
    this.addRibbonIcon("message-square", "Chat with journal", () => {
      void this.activateView();
    });

    // Command: Auto Tag Current Note
    this.addCommand({
      id: "auto-tag-note",
      name: "Auto-tag current note",
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        const content = editor.getValue();
        new Notice("Generating tags...");
        try {
          const tags = await this.processor.generateTags(content);
          const tagsString = `\n\nTags: ${tags
            .map((t) => `#${t}`)
            .join(" ")}\n\n`;
          editor.replaceRange(tagsString, { line: 0, ch: 0 });
          new Notice("Tags added!");
        } catch (error) {
          new Notice("Error generating tags. Check console.");
          console.error(error);
        }
      },
    });

    // Command: Extract Action Items
    this.addCommand({
      id: "extract-action-items",
      name: "Extract action items",
      editorCallback: async (editor: Editor, view: MarkdownView) => {
        const content = editor.getValue();
        new Notice("Extracting action items...");
        try {
          const items = await this.processor.extractActionItems(content);
          if (items.length > 0) {
            const itemsString = `\n\n## Action Items\n${items.join("\n")}`;
            editor.replaceRange(itemsString, {
              line: editor.lineCount(),
              ch: 0,
            });
            new Notice("Action items added!");
          } else {
            new Notice("No action items found.");
          }
        } catch (error) {
          new Notice("Error extracting action items. Check console.");
          console.error(error);
        }
      },
    });

    // Command: Weekly Summary
    this.addCommand({
      id: "weekly-summary",
      name: "Generate weekly summary",
      callback: async () => {
        new Notice("Generating weekly summary...");
        try {
          const now = new Date();
          const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);

          const files = this.app.vault.getMarkdownFiles();
          const recentFiles = files.filter(
            (file) => file.stat.mtime >= oneWeekAgo.getTime()
          );

          if (recentFiles.length === 0) {
            new Notice("No notes found from the last week.");
            return;
          }

          const notesContent = await Promise.all(
            recentFiles.map((file) => this.app.vault.read(file))
          );
          const summary = await this.processor.summarizeWeekly(notesContent);

          // Folder structure: {weekly summary path}/{year}
          const year = now.getFullYear().toString();
          const baseFolder = normalizePath(this.settings.weeklySummaryPath);
          const folderPath = normalizePath(`${baseFolder}/${year}`);

          if (!this.app.vault.getAbstractFileByPath(baseFolder)) {
            await this.app.vault.createFolder(baseFolder);
          }
          if (!this.app.vault.getAbstractFileByPath(folderPath)) {
            await this.app.vault.createFolder(folderPath);
          }

          // Filename: Week-{WeekNum}-{DateRange}
          // Simple date formatting
          const dateStr = now.toISOString().split("T")[0];
          const fileName = `Week-Summary-${dateStr}.md`;
          const filePath = `${folderPath}/${fileName}`;

          // Check if file exists
          if (this.app.vault.getAbstractFileByPath(filePath)) {
            new Notice(`Summary for this week already exists: ${filePath}`);
            return;
          }

          await this.app.vault.create(
            filePath,
            `# Weekly Summary (${dateStr})\n\n${summary}`
          );

          new Notice(`Weekly Summary saved to ${filePath}`);
        } catch (error) {
          new Notice("Error generating summary. Check console.");
          console.error(error);
        }
      },
    });

    // Command: Open Chat
    this.addCommand({
      id: "open-chat",
      name: "Open chat with journal",
      callback: () => {
        void this.activateView();
      },
    });

    // RAG Commands
    if (this.settings.ragEnabled && this.ragService) {
      this.addCommand({
        id: "upload-index-to-qdrant",
        name: "Upload local index to Qdrant",
        callback: async () => {
          const local = new LocalVectorStore(this.app, `${this.indexDir}/vectors.json`);
          const qdrant = this.createQdrantStore();
          try {
            await local.initialize();
            const docs = local.getAllDocuments();
            if (docs.length === 0) {
              new Notice("The local index is empty. Index your vault first.");
              return;
            }
            // Reuses the stored embeddings, so this makes no embedding API calls
            new Notice(`Uploading ${docs.length} chunks to Qdrant...`);
            await qdrant.initialize();
            await qdrant.addDocuments(docs);
            new Notice(`Uploaded ${docs.length} chunks to Qdrant.`);
            if (this.settings.vectorStoreType === "qdrant") {
              await this.vectorStore.initialize();
            }
          } catch (error) {
            console.error("Qdrant upload failed:", error);
            new Notice("Upload to Qdrant failed. Check the Qdrant URL and API key in settings.");
          }
        },
      });

      this.addCommand({
        id: "index-vault-rag",
        name: "Index vault for RAG",
        callback: async () => {
          new Notice("Indexing vault... This may take a while.");
          try {
            let total = 0;
            await this.ragService.indexVault((current, totalFiles) => {
              total = totalFiles;
              if (current % 10 === 0 || current === totalFiles) {
                new Notice(`Indexed ${current}/${totalFiles} files`);
              }
            });
            new Notice(`Indexing complete! Indexed ${total} files.`);
          } catch (error) {
            console.error("Indexing error:", error);
            new Notice("Error indexing vault. Check console.");
          }
        },
      });

      this.addCommand({
        id: "clear-rag-index",
        name: "Clear RAG index",
        callback: async () => {
          const target = this.settings.vectorStoreType === "qdrant"
            ? "the shared Qdrant index for ALL your devices"
            : "the RAG index";
          if (await confirmAction(this.app, `Clear ${target}? This cannot be undone.`, "Clear index")) {
            try {
              await this.ragService.clearIndex();
              new Notice("RAG index cleared");
            } catch (error) {
              console.error("Clear index error:", error);
              new Notice("Error clearing index. Check console.");
            }
          }
        },
      });

      this.addCommand({
        id: "rag-index-stats",
        name: "View RAG index statistics",
        callback: async () => {
          try {
            const stats = await this.ragService.getIndexStats();
            new Notice(`RAG Index: ${stats.totalDocuments} document chunks indexed`);
          } catch (error) {
            console.error("Stats error:", error);
            new Notice("Error getting stats. Check console.");
          }
        },
      });

      this.addCommand({
        id: "debug-rag-retrieval",
        name: "Debug RAG retrieval",
        // Shows which notes the retriever returns for the selected text
        editorCallback: async (editor) => {
          const selection = editor.getSelection();
          if (!selection) {
            new Notice("Select some text to test retrieval");
            return;
          }
          try {
            const results = await this.ragService.retrieveContext(selection, 10, 0);
            const lines = results.retrievedChunks.map(
              (chunk, i) => `${i + 1}. ${chunk.metadata.noteTitle} (${chunk.similarity.toFixed(3)})`
            );
            new Notice(`Top ${lines.length} matches:\n${lines.join("\n")}`, 10000);
          } catch (error) {
            console.error("Debug retrieval failed:", error);
            new Notice("Error during debug retrieval");
          }
        },
      });
    }

    this.addSettingTab(new MemexSettingTab(this.app, this));
  }

  async activateView() {
    const { workspace } = this.app;

    let leaf: WorkspaceLeaf | null = null;
    const leaves = workspace.getLeavesOfType(VIEW_TYPE_CHAT);

    if (leaves.length > 0) {
      // A leaf with our view already exists, use that
      leaf = leaves[0];
    } else {
      // Our view could not be found in the workspace, create a new leaf
      // in the right sidebar for it
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({ type: VIEW_TYPE_CHAT, active: true });
      }
    }

    // "Reveal" the leaf in case it is in a collapsed sidebar
    if (leaf) {
      await workspace.revealLeaf(leaf);
    }
  }

  onunload() {}

  /** Folder holding the local index: the configured path, or this plugin's own folder. */
  get indexDir(): string {
    const pluginDir = this.manifest.dir ?? `${this.app.vault.configDir}/plugins/${this.manifest.id}`;
    return normalizePath(this.settings.chromaDbPath || `${pluginDir}/chromadb`);
  }

  /** Qdrant store over Obsidian's requestUrl, which works on desktop and mobile without CORS issues. */
  createQdrantStore(): QdrantVectorStore {
    const http: HttpRequest = async ({ url, method, headers, body }) => {
      const res = await requestUrl({ url, method, headers, body, throw: false });
      let json: unknown = null;
      try {
        json = res.json;
      } catch {
        // Non-JSON body
      }
      return { status: res.status, json };
    };
    return new QdrantVectorStore(
      http,
      this.settings.qdrantUrl,
      this.settings.qdrantApiKey,
      this.settings.qdrantCollection
    );
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, (await this.loadData()) as Partial<MemexSettings> | null);
  }

  async saveSettings() {
    await this.saveData(this.settings);
    // Recreate providers with new settings
    const llmProvider = createLLMProvider(this.settings);
    this.llmService.updateProvider(llmProvider);
    if (this.embeddingService) {
      const embeddingProvider = createEmbeddingProvider(this.settings);
      this.embeddingService.updateProvider(embeddingProvider);
      this.embeddingService.updateChunkSettings(
        this.settings.chunkSize,
        this.settings.chunkOverlap
      );
    }
  }
}

class MemexSettingTab extends PluginSettingTab {
  plugin: MemexPlugin;

  constructor(app: App, plugin: MemexPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;

    containerEl.empty();


    // ── Provider Selection ──────────────────────────────────────────────
    new Setting(containerEl)
      .setName("AI provider")
      .setDesc("Choose between a local LLM server or Google Gemini API")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("local", "Local (LM Studio / Ollama)")
          .addOption("gemini", "Google Gemini")
          .setValue(this.plugin.settings.providerType)
          .onChange(async (value) => {
            this.plugin.settings.providerType = value as ProviderType;
            await this.plugin.saveSettings();
            // Re-render settings to show/hide provider-specific fields
            this.display();
          })
      );

    // ── Local Provider Settings ─────────────────────────────────────────
    if (this.plugin.settings.providerType === "local") {
      new Setting(containerEl).setName("Local LLM").setHeading();

      new Setting(containerEl)
        .setName("LLM endpoint")
        .setDesc("The URL of your local LLM server (e.g., http://localhost:1234)")
        .addText((text) =>
          text
            .setPlaceholder("http://localhost:1234")
            .setValue(this.plugin.settings.llmEndpoint)
            .onChange(async (value) => {
              this.plugin.settings.llmEndpoint = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Chat model")
        .setDesc("The name of the chat model (e.g., qwen/qwen3-vl-4b)")
        .addText((text) =>
          text
            .setPlaceholder("qwen/qwen3-vl-4b")
            .setValue(this.plugin.settings.modelName)
            .onChange(async (value) => {
              this.plugin.settings.modelName = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Embedding model")
        .setDesc("The name of the embedding model for RAG")
        .addText((text) =>
          text
            .setValue(this.plugin.settings.embeddingModel)
            .setPlaceholder("text-embedding-nomic-embed-text-v1.5")
            .onChange(async (value) => {
              this.plugin.settings.embeddingModel = value;
              await this.plugin.saveSettings();
            })
        );
    }

    // ── Gemini Provider Settings ────────────────────────────────────────
    if (this.plugin.settings.providerType === "gemini") {
      new Setting(containerEl).setName("Google Gemini").setHeading();

      new Setting(containerEl)
        .setName("API key")
        .setDesc("Your Gemini API key from Google AI Studio (aistudio.google.com/apikey)")
        .addText((text) =>
          text
            .setPlaceholder("Enter your Gemini API key")
            .setValue(this.plugin.settings.geminiApiKey)
            .onChange(async (value) => {
              this.plugin.settings.geminiApiKey = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Chat model")
        .setDesc("Gemini model for chat (e.g., gemini-2.0-flash, gemini-2.5-pro)")
        .addText((text) =>
          text
            .setPlaceholder("gemini-2.5-flash")
            .setValue(this.plugin.settings.geminiModel)
            .onChange(async (value) => {
              this.plugin.settings.geminiModel = value;
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Embedding model")
        .setDesc("Gemini model for embeddings (e.g., gemini-embedding-001)")
        .addText((text) =>
          text
            .setPlaceholder("gemini-embedding-001")
            .setValue(this.plugin.settings.geminiEmbeddingModel)
            .onChange(async (value) => {
              this.plugin.settings.geminiEmbeddingModel = value;
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName("Weekly summary path")
      .setDesc("Folder to save weekly summaries")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.weeklySummaryPath)
          .setValue(this.plugin.settings.weeklySummaryPath)
          .onChange(async (value) => {
            this.plugin.settings.weeklySummaryPath = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
        .setName("Default temperature")
        .setDesc("Controls randomness (0.0 - 1.0)")
        .addSlider(slider => slider
            .setLimits(0, 1, 0.05)
            .setValue(this.plugin.settings.defaultTemperature)
            .onChange(async (value) => {
                this.plugin.settings.defaultTemperature = value;
                await this.plugin.saveSettings();
            }));

    new Setting(containerEl)
        .setName("Default max tokens")
        .setDesc("Maximum length of response")
        .addText(text => text
            .setValue(String(this.plugin.settings.defaultMaxTokens))
            .onChange(async (value) => {
                const num = parseInt(value);
                if (!isNaN(num)) {
                    this.plugin.settings.defaultMaxTokens = num;
                    await this.plugin.saveSettings();
                }
            }));

    // RAG Settings Section
    new Setting(containerEl).setName("Retrieval (RAG)").setHeading();

    new Setting(containerEl)
        .setName("Enable RAG")
        .setDesc("Enable retrieval-augmented generation to use your vault notes as context")
        .addToggle(toggle => toggle
            .setValue(this.plugin.settings.ragEnabled)
            .onChange(async (value) => {
                this.plugin.settings.ragEnabled = value;
                await this.plugin.saveSettings();
                new Notice("Please reload Obsidian for RAG changes to take effect");
            }));

    new Setting(containerEl)
        .setName("Chunk size")
        .setDesc("Number of words per chunk (default: 512)")
        .addText(text => text
            .setValue(String(this.plugin.settings.chunkSize))
            .onChange(async (value) => {
                const num = parseInt(value);
                if (!isNaN(num) && num > 0) {
                    this.plugin.settings.chunkSize = num;
                    await this.plugin.saveSettings();
                }
            }));

    new Setting(containerEl)
        .setName("Chunk overlap")
        .setDesc("Number of overlapping words between chunks (default: 50)")
        .addText(text => text
            .setValue(String(this.plugin.settings.chunkOverlap))
            .onChange(async (value) => {
                const num = parseInt(value);
                if (!isNaN(num) && num >= 0) {
                    this.plugin.settings.chunkOverlap = num;
                    await this.plugin.saveSettings();
                }
            }));

    new Setting(containerEl)
        .setName("Number of results")
        .setDesc("Number of most relevant chunks to retrieve (default: 5)")
        .addSlider(slider => slider
            .setLimits(1, 20, 1)
            .setValue(this.plugin.settings.topK)
            .onChange(async (value) => {
                this.plugin.settings.topK = value;
                await this.plugin.saveSettings();
            }));

    new Setting(containerEl)
        .setName("Similarity threshold")
        .setDesc("If no note scores at least this well, the question is treated as not covered by your vault (0.0 - 1.0, default: 0.58)")
        .addSlider(slider => slider
            .setLimits(0, 1, 0.01)
            .setValue(this.plugin.settings.similarityThreshold)
            .onChange(async (value) => {
                this.plugin.settings.similarityThreshold = value;
                await this.plugin.saveSettings();
            }));

    new Setting(containerEl)
        .setName("Retrieval mode")
        .setDesc("Hybrid adds keyword matching to semantic search, which finds exact names, terms and identifiers that semantic search alone often misses.")
        .addDropdown(dropdown => dropdown
            .addOption("hybrid", "Hybrid (semantic + keyword)")
            .addOption("vector", "Semantic only")
            .setValue(this.plugin.settings.retrievalMode)
            .onChange(async (value) => {
                this.plugin.settings.retrievalMode = value as RetrievalMode;
                await this.plugin.saveSettings();
            }));

    new Setting(containerEl)
        .setName("Vector store")
        .setDesc("Local keeps the index in this vault. Qdrant keeps one shared index that all your devices use. Reload the plugin after changing this.")
        .addDropdown(dropdown => dropdown
            .addOption("local", "Local (this vault)")
            .addOption("qdrant", "Qdrant (shared)")
            .setValue(this.plugin.settings.vectorStoreType)
            .onChange(async (value) => {
                this.plugin.settings.vectorStoreType = value as "local" | "qdrant";
                await this.plugin.saveSettings();
                new Notice("Reload the plugin to switch vector stores.");
            }));

    new Setting(containerEl)
        .setName("Qdrant URL")
        .setDesc("Used when vector store is Qdrant, e.g. https://your-cluster.cloud.qdrant.io:6333")
        .addText(text => text
            .setPlaceholder("http://localhost:6333")
            .setValue(this.plugin.settings.qdrantUrl)
            .onChange(async (value) => {
                this.plugin.settings.qdrantUrl = value.trim();
                await this.plugin.saveSettings();
            }));

    new Setting(containerEl)
        .setName("Qdrant API key")
        .setDesc("Leave empty for a local Qdrant without authentication")
        .addText(text => {
            text.inputEl.type = "password";
            text.setValue(this.plugin.settings.qdrantApiKey)
                .onChange(async (value) => {
                    this.plugin.settings.qdrantApiKey = value.trim();
                    await this.plugin.saveSettings();
                });
        });

    new Setting(containerEl)
        .setName("Qdrant collection")
        .setDesc("Every device pointing at the same collection shares one index")
        .addText(text => text
            .setValue(this.plugin.settings.qdrantCollection)
            .onChange(async (value) => {
                this.plugin.settings.qdrantCollection = value.trim() || "memex";
                await this.plugin.saveSettings();
            }));

    new Setting(containerEl)
        .setName("Auto-index on change")
        .setDesc("Automatically update the index when notes are created, modified, or deleted")
        .addToggle(toggle => toggle
            .setValue(this.plugin.settings.autoIndexOnChange)
            .onChange(async (value) => {
                this.plugin.settings.autoIndexOnChange = value;
                await this.plugin.saveSettings();
                if (this.plugin.ragService) {
                    this.plugin.ragService.updateSettings(
                        this.plugin.settings.excludedFolders,
                        value
                    );
                }
            }));

    new Setting(containerEl)
        .setName("Citation trust mode")
        .setDesc("Off: no citations. Relaxed: cites and verifies but shows answer with warnings. Strict: refuses to answer if citations fail verification.")
        .addDropdown(dropdown => dropdown
            .addOption("off", "Off")
            .addOption("relaxed", "Relaxed")
            .addOption("strict", "Strict")
            .setValue(this.plugin.settings.citationTrustMode)
            .onChange(async (value) => {
                this.plugin.settings.citationTrustMode = value as "off" | "relaxed" | "strict";
                await this.plugin.saveSettings();
            }));

    new Setting(containerEl)
        .setName("Excluded folders")
        .setDesc("Comma-separated list of folder paths to exclude from indexing")
        .addTextArea(text => text
            .setValue(this.plugin.settings.excludedFolders.join(", "))
            .setPlaceholder(DEFAULT_SETTINGS.excludedFolders.join(", "))
            .onChange(async (value) => {
                this.plugin.settings.excludedFolders = value
                    .split(",")
                    .map(f => f.trim())
                    .filter(f => f.length > 0);
                await this.plugin.saveSettings();
                if (this.plugin.ragService) {
                    this.plugin.ragService.updateSettings(
                        this.plugin.settings.excludedFolders,
                        this.plugin.settings.autoIndexOnChange
                    );
                }
            }));

    new Setting(containerEl).setName("Personas").setHeading();
    
    // Simple JSON editor for personas for now to avoid complex UI
    new Setting(containerEl)
        .setName("Personas JSON")
        .setDesc("Edit personas as JSON array of {name, prompt}")
        .addTextArea(text => text
            .setValue(JSON.stringify(this.plugin.settings.personas, null, 2))
            .setPlaceholder("[]")
            .onChange(async (value) => {
                try {
                    const parsed: unknown = JSON.parse(value);
                    if (Array.isArray(parsed) && parsed.every(isPersona)) {
                        this.plugin.settings.personas = parsed;
                        await this.plugin.saveSettings();
                    }
                } catch {
                    // Invalid JSON, ignore
                }
            }));
  }
}

