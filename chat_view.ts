import {
  ItemView,
  WorkspaceLeaf,
  Notice,
  ButtonComponent,
  TextAreaComponent,
  MarkdownRenderer,
  Component,
  setIcon,
  Menu,
  Modal,
  Setting,
  App,
} from "obsidian";
import { LLMService } from "./llm_service";
import { ConversationManager, Conversation, ConversationConfig, Message, CitationVerification, isDefaultChatTitle } from "./conversation_manager";
import { RAGContext, RAGService } from "./rag_service";
import { SearchResult } from "./vector_store";
import { MemexSettings } from "./settings";
import { confirmAction } from "./confirm_modal";
import html2pdf from "html2pdf.js";

/** Where "Export to note" saves messages. */
const EXPORT_FOLDER = "Memex/Exports";

type PdfOptions = Parameters<InstanceType<typeof html2pdf.Worker>["set"]>[0];

/** The attribution checker's JSON reply. */
interface AttributionReply {
  sources?: { id?: unknown; used?: boolean; supported?: boolean; claim?: string; reason?: string }[];
}

export const VIEW_TYPE_CHAT = "memex-chat-view";

export class ChatView extends ItemView {
  private llmService: LLMService;
  private conversationManager: ConversationManager;
  private component: Component;
  private currentConversation: Conversation | null = null;
  private messagesContainer: HTMLElement;
  private sidebarContainer: HTMLElement;
  private ragService?: RAGService;

  constructor(
    leaf: WorkspaceLeaf,
    llmService: LLMService,
    conversationManager: ConversationManager,
    private settings: MemexSettings,
    ragService?: RAGService
  ) {
    super(leaf);
    this.llmService = llmService;
    this.conversationManager = conversationManager;
    this.component = new Component();
    this.ragService = ragService;
  }

  getViewType() {
    return VIEW_TYPE_CHAT;
  }

  getDisplayText() {
    return "Chat with journal";
  }

  async onOpen() {
    this.containerEl.empty();
    this.containerEl.addClass("memex-chat-view");

    // Main Layout: Sidebar + Chat Area
    const mainLayout = this.containerEl.createDiv({
      cls: "memex-main-layout",
    });

    // Sidebar
    this.sidebarContainer = mainLayout.createDiv({
      cls: "memex-sidebar",
    });

    // Resizer
    const resizer = mainLayout.createDiv({ cls: "memex-resizer" });
    let isResizing = false;

    resizer.addEventListener("mousedown", () => {
      isResizing = true;
      document.body.addClass("memex-is-resizing");
      resizer.addClass("is-resizing");
    });

    // Registered on the view so they're removed when it closes
    this.registerDomEvent(document, "mousemove", (e) => {
      if (!isResizing) return;
      const newWidth = e.clientX - this.containerEl.getBoundingClientRect().left;
      if (newWidth > 150 && newWidth < 500) {
        this.sidebarContainer.style.width = `${newWidth}px`;
      }
    });

    this.registerDomEvent(document, "mouseup", () => {
      if (isResizing) {
        isResizing = false;
        document.body.removeClass("memex-is-resizing");
        resizer.removeClass("is-resizing");
      }
    });

    // Chat Area
    const chatArea = mainLayout.createDiv({
      cls: "memex-chat-area",
    });

    // Toggle Button (Floating)
    const toggleBtn = chatArea.createEl("button", { cls: "memex-sidebar-toggle" });
    setIcon(toggleBtn, "panel-left");

    let isCollapsed = false;
    let draggedWidth = "";

    toggleBtn.onClickEvent(() => {
        isCollapsed = !isCollapsed;
        if (isCollapsed) {
            // A dragged width is set inline and would override the collapsed class
            draggedWidth = this.sidebarContainer.style.width;
            this.sidebarContainer.style.removeProperty("width");
        } else if (draggedWidth) {
            this.sidebarContainer.style.width = draggedWidth;
        }
        this.sidebarContainer.toggleClass("is-collapsed", isCollapsed);
        resizer.toggleClass("is-hidden", isCollapsed);
    });

    await this.renderSidebar();
    this.renderChatArea(chatArea);

    // Load most recent conversation or create new one
    const conversations = await this.conversationManager.getConversations();
    if (conversations.length > 0) {
      await this.loadConversation(conversations[0].id);
    } else {
      await this.createNewConversation();
    }
  }

  async renderSidebar() {
    this.sidebarContainer.empty();

    // Header with New Chat button
    const header = this.sidebarContainer.createDiv({
      cls: "memex-sidebar-header",
    });
    header.createEl("h3", { text: "Chats", cls: "memex-sidebar-title" });

    const newChatBtn = new ButtonComponent(header);
    newChatBtn.setIcon("plus");
    newChatBtn.setTooltip("New chat");
    newChatBtn.onClick(async () => {
      await this.createNewConversation();
    });

    // Conversation List
    const listContainer = this.sidebarContainer.createDiv({
      cls: "memex-conversation-list",
    });

    const conversations = await this.conversationManager.getConversations();

    for (const conv of conversations) {
      const item = listContainer.createDiv({
        cls: "memex-conversation-item",
      });
      item.toggleClass("is-active", this.currentConversation?.id === conv.id);

      const titleSpan = item.createSpan({ text: conv.title, cls: "memex-conversation-title" });

      titleSpan.addEventListener("click", () => void this.loadConversation(conv.id));

      // Context Menu for Rename/Delete
      const menuBtn = item.createDiv({ cls: "memex-conversation-menu" });
      setIcon(menuBtn, "more-vertical");
      
      menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const menu = new Menu();
        
        menu.addItem((item) =>
          item
            .setTitle("Rename")
            .setIcon("pencil")
            .onClick(async () => {
               new RenameModal(this.app, conv.title, async (newTitle) => {
                   await this.conversationManager.renameConversation(conv.id, newTitle);
                   await this.renderSidebar();
               }).open();
            })
        );

        menu.addItem((item) =>
            item
              .setTitle("Export to PDF")
              .setIcon("file-text")
              .onClick(async () => {
                  await this.exportConversationToPDF(conv);
              })
          );

        menu.addItem((item) =>
          item
            .setTitle("Delete")
            .setIcon("trash")
            .setWarning(true)
            .onClick(async () => {
               if (await confirmAction(this.app, "Delete this chat? This cannot be undone.", "Delete")) {
                   await this.conversationManager.deleteConversation(conv.id);
                   if (this.currentConversation?.id === conv.id) {
                       this.currentConversation = null;
                       this.messagesContainer.empty();
                       // Try to load another one
                       const remaining = await this.conversationManager.getConversations();
                       if (remaining.length > 0) {
                           await this.loadConversation(remaining[0].id);
                       } else {
                           await this.createNewConversation();
                       }
                   } else {
                       await this.renderSidebar();
                   }
               }
            })
        );

        menu.showAtMouseEvent(e);
      });
    }
  }

  async exportConversationToPDF(conversation: Conversation) {
      new Notice("Generating PDF...");
      
      // Create a temporary container for rendering
      // We use a visible overlay to ensure html2canvas captures it correctly.
      // This also acts as a "loading" indicator of sorts.
      const tempContainer = document.body.createDiv({ cls: "memex-pdf-export" });

      // Content Container (centered A4-ish look)
      const contentContainer = tempContainer.createDiv({ cls: "memex-pdf-page" });

      // Header
      contentContainer.createEl("h1", { text: conversation.title, cls: "memex-pdf-title" });
      contentContainer.createEl("p", { text: `Exported on ${new Date().toLocaleDateString()}`, cls: "memex-pdf-date" });
      contentContainer.createEl("hr", { cls: "memex-pdf-rule" });

      // Messages; the rendered Markdown inside is styled by .memex-pdf-message-body in styles.css
      for (const msg of conversation.messages) {
          const msgDiv = contentContainer.createDiv({ cls: "memex-pdf-message" });

          const role = msg.role === "user" ? "You" : "Journal";
          const time = new Date(msg.timestamp).toLocaleTimeString();
          msgDiv.createDiv({
            cls: ["memex-pdf-message-header", msg.role === "user" ? "is-user" : "is-assistant"],
            text: `${role} (${time})`,
          });

          const content = msgDiv.createDiv({ cls: "memex-pdf-message-body" });
          await MarkdownRenderer.render(this.app, msg.content, content, "", this.component);
      }

    // Wait a moment for images/rendering to settle
    await new Promise(resolve => window.setTimeout(resolve, 1000));

      try {
          const opt: PdfOptions = {
            margin: 10,
            filename: `${conversation.title}.pdf`,
            image: { type: 'jpeg', quality: 0.98 },
            html2canvas: { 
                scale: 2,
                useCORS: true,
                logging: false,
                windowWidth: 1200 // Force a desktop width
            },
            jsPDF: { unit: 'mm', format: 'a4', orientation: 'portrait' }
          };

          // Capture the contentContainer, not the full overlay
          const pdfData = (await html2pdf().from(contentContainer).set(opt).output("arraybuffer")) as ArrayBuffer;
          
          const folderPath = "Memex/PDFs";
          if (!await this.app.vault.adapter.exists(folderPath)) {
              await this.app.vault.createFolder(folderPath);
          }

          const fileName = `${conversation.title.replace(/[^a-z0-9]/gi, '_')}.pdf`;
          const filePath = `${folderPath}/${fileName}`;
          
          // Check if exists
          if (await this.app.vault.adapter.exists(filePath)) {
              // Append timestamp
              const newName = `${conversation.title.replace(/[^a-z0-9]/gi, '_')}_${Date.now()}.pdf`;
              await this.app.vault.createBinary(`${folderPath}/${newName}`, pdfData);
              new Notice(`PDF saved to ${folderPath}/${newName}`);
          } else {
              await this.app.vault.createBinary(filePath, pdfData);
              new Notice(`PDF saved to ${filePath}`);
          }

      } catch (e) {
          console.error("PDF Export Error", e);
          new Notice("Failed to generate PDF");
      } finally {
          tempContainer.remove();
      }
  }

  renderChatArea(container: HTMLElement) {
    // Messages Area
    this.messagesContainer = container.createDiv({ cls: "memex-messages" });

    // Input Area
    const inputContainer = container.createDiv({
      cls: "memex-input-area",
    });

    const inputEl = new TextAreaComponent(inputContainer);
    inputEl.setPlaceholder("Ask your journal a question...");
    inputEl.inputEl.addClass("memex-input");

    const buttonContainer = inputContainer.createDiv({ cls: "memex-input-buttons" });

    // Settings Button
    const settingsBtn = new ButtonComponent(buttonContainer);
    settingsBtn.setIcon("settings");
    settingsBtn.setTooltip("Chat settings");
    settingsBtn.onClick(() => {
        if (this.currentConversation) {
            new ConversationSettingsModal(
                this.app, 
                this.currentConversation, 
                this.settings,
                async (newConfig) => {
                    // Merge, so overrides this dialog doesn't edit are kept
                    this.currentConversation!.config = { ...this.currentConversation!.config, ...newConfig };
                    await this.conversationManager.saveConversation(this.currentConversation!);
                }
            ).open();
        }
    });

    const sendBtn = new ButtonComponent(buttonContainer);
    sendBtn.setButtonText("Send");
    sendBtn.setCta();

    sendBtn.onClick(async () => {
        const content = inputEl.getValue();
        if (!content.trim()) return;
        inputEl.setValue("");
        await this.processUserMessage(content);
    });

    inputEl.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        const content = inputEl.getValue();
        if (!content.trim()) return;
        inputEl.setValue("");
        void this.processUserMessage(content);
      }
    });
  }

  async processUserMessage(content: string) {
      if (!this.currentConversation) {
        await this.createNewConversation();
      }

      // Add User Message
      const userMsg: Message = {
        role: "user",
        content: content,
        timestamp: Date.now(),
      };
      this.currentConversation!.messages.push(userMsg);
      await this.conversationManager.saveConversation(this.currentConversation!);
      this.appendMessage(userMsg);

      // Name the chat after its first message
      if (this.currentConversation!.messages.length === 1 && isDefaultChatTitle(this.currentConversation!.title)) {
          const newTitle = content.substring(0, 30) + (content.length > 30 ? "..." : "");
          this.currentConversation!.title = newTitle;
          await this.conversationManager.saveConversation(this.currentConversation!);
          await this.renderSidebar();
      }

      await this.generateAssistantResponse();
  }

  async generateAssistantResponse() {
      const indicator = this.showTypingIndicator();
      try {
        // Prepare context
        const systemPrompt = this.currentConversation!.config?.systemPrompt || 
                             this.settings.personas[0]?.prompt || 
                             "You are a helpful assistant for a personal journal.";
                             
        let contextMessages = [
            { role: "system", content: systemPrompt }
        ];

        // Add RAG context if enabled and available
        let ragContext: RAGContext | null = null;
        const ragEnabled = this.currentConversation!.config?.ragEnabled ?? this.settings.ragEnabled;
        if (this.ragService && ragEnabled) {
          try {
            const lastUserMessage = this.currentConversation!.messages
              .filter(m => m.role === "user")
              .slice(-1)[0];
            
            if (lastUserMessage) {
              let ragQuery = lastUserMessage.content;

              const allMessages = this.currentConversation!.messages;
              if (allMessages.length > 1) {
                try {
                  const recentHistory = allMessages.slice(0, -1).slice(-6);
                  const historyText = recentHistory
                    .map(m => `${m.role === "user" ? "User" : "Assistant"}: ${m.content}`)
                    .join("\n");

                  const rewriteMessages = [
                    {
                      role: "system",
                      content: "You are a query rewriter. Given a conversation history and a follow-up question, rewrite the follow-up into a standalone search query that captures the full intent. Output ONLY the rewritten query, nothing else. Keep it concise."
                    },
                    {
                      role: "user",
                      content: `Conversation history:\n${historyText}\n\nFollow-up question: ${lastUserMessage.content}\n\nRewrite as a standalone search query:`
                    }
                  ];

                  ragQuery = await this.llmService.completion(rewriteMessages, {
                    temperature: 0,
                    max_tokens: 150
                  });
                  ragQuery = ragQuery.trim();
                } catch (rewriteError) {
                  console.error("Query rewrite failed, using original query:", rewriteError);
                }
              }

              const topK = this.currentConversation!.config?.topK ?? this.settings.topK;
              const similarityThreshold = this.currentConversation!.config?.similarityThreshold ?? this.settings.similarityThreshold;
              
              ragContext = await this.ragService.retrieveContext(
                ragQuery,
                topK,
                similarityThreshold,
                this.settings.retrievalMode
              );

              if (ragContext && ragContext.formattedContext) {
                contextMessages.push({
                  role: "system",
                  content: ragContext.formattedContext
                });

              }
            }
          } catch (error) {
            console.error("RAG retrieval error:", error);
          }
        }

        // Add conversation history
        contextMessages.push(...this.currentConversation!.messages.map(m => ({
            role: m.role,
            content: m.content
        })));

        const config = {
            temperature: this.currentConversation!.config?.temperature ?? this.settings.defaultTemperature,
            max_tokens: this.currentConversation!.config?.maxTokens ?? this.settings.defaultMaxTokens
        };

        // Create the assistant message bubble immediately for streaming
        indicator.remove();
        const assistantMsg: Message = {
          role: "assistant",
          content: "",
          timestamp: Date.now(),
        };
        this.currentConversation!.messages.push(assistantMsg);
        this.appendMessage(assistantMsg);

        // Get the content element of the last appended message for live updates
        const allMsgDivs = this.messagesContainer.querySelectorAll(".chat-message");
        const lastMsgDiv = allMsgDivs[allMsgDivs.length - 1];
        const contentEl = lastMsgDiv?.querySelector(".message-content") as HTMLElement;

        let fullContent = "";
        let lastRenderTime = 0;
        let painted = false;

        // Keep something in the bubble while we wait: reasoning models can go
        // several seconds before emitting their first delta.
        if (contentEl) {
          contentEl.createSpan({ text: "Journal is thinking...", cls: "memex-pending" });
        }

        const renderStream = async () => {
          if (!contentEl) return;
          contentEl.empty();
          await MarkdownRenderer.render(this.app, fullContent, contentEl, "", this.component);
          this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
        };

        try {
          for await (const chunk of this.llmService.streamCompletion(contextMessages, config)) {
            fullContent += chunk;

            // Chunk sizes vary enormously between providers — Gemini can deliver a
            // whole answer in one or two deltas — so throttle on elapsed time
            // rather than chunk count, and always paint the first one.
            const now = Date.now();
            if (!painted || now - lastRenderTime >= 60) {
              painted = true;
              lastRenderTime = now;
              await renderStream();
            }
          }
        } catch (streamError) {
          // Keep whatever arrived before the failure
          console.error("Streaming error:", streamError);
        }

        // A stream that dies before its first delta, or yields nothing at all,
        // would leave the bubble blank — fall back to a single request.
        if (!fullContent) {
          fullContent = await this.llmService.completion(contextMessages, config);
        }
        await renderStream();

        assistantMsg.content = fullContent;

        // RAG ran but nothing cleared the threshold. Record it on the message so
        // the warning survives a reload, not just this render.
        if (ragContext && ragContext.retrievedChunks.length === 0) {
          assistantMsg.noContextFound = true;
        }

        const trustMode = this.currentConversation!.config?.citationTrustMode ?? this.settings.citationTrustMode;

        if (trustMode !== "off" && ragContext?.chunkMap && ragContext.chunkMap.size > 0) {
          // Build baseline sources from all retrieved chunks
          const allChunkIds = [...ragContext.chunkMap.keys()];
          assistantMsg.citations = allChunkIds.map(id => {
            const chunk = ragContext.chunkMap.get(id)!;
            return {
              id,
              claim: "",
              supported: true,
              reason: "",
              sourceChunk: {
                noteTitle: chunk.metadata.noteTitle,
                filePath: chunk.metadata.filePath,
                chunkIndex: chunk.metadata.chunkIndex,
                content: chunk.content,
              }
            };
          });

          // Post-hoc attribution: check which sources support the answer
          const verifyIndicator = this.messagesContainer.createDiv({ cls: "verify-indicator", text: "Checking sources..." });
          this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;

          const replaceAnswer = async (text: string) => {
            fullContent = text;
            assistantMsg.content = text;
            if (contentEl) {
              contentEl.empty();
              await MarkdownRenderer.render(this.app, text, contentEl, "", this.component);
            }
          };

          let verified = false;
          try {
            const attribution = await this.attributeSources(fullContent, ragContext.chunkMap);
            if (attribution.length > 0) {
              verified = true;
              const attrMap = new Map(attribution.map(a => [a.id, a]));
              assistantMsg.citations = assistantMsg.citations.map(c =>
                attrMap.has(c.id) ? attrMap.get(c.id)! : c
              );

              if (trustMode === "strict") {
                const usedSources = attribution.filter(a => a.reason !== "");
                const unsupported = usedSources.filter(a => !a.supported);
                if (unsupported.length > 0) {
                  await replaceAnswer("I cannot provide a verified answer. The following claims could not be confirmed by sources:\n\n"
                    + unsupported.map(c => `- ${c.claim}: ${c.reason}`).join("\n"));
                }
              }
            }
          } catch (attrError) {
            console.error("Source attribution failed:", attrError);
          } finally {
            verifyIndicator.remove();
          }

          // Strict mode promises nothing unverified is shown, so a check that
          // couldn't run (API error, unparseable reply) has to count as a failure
          if (trustMode === "strict" && !verified) {
            await replaceAnswer("I couldn't verify this answer against your notes, so strict mode is hiding it. Try asking again, or switch Citation Trust Mode to Relaxed.");
          }

          // Style any [N] markers the model produced as badges
          if (contentEl) {
            const hasInlineCitations = /\[\d+\]/.test(fullContent);
            if (hasInlineCitations) {
              this.renderCitationBadges(contentEl, assistantMsg.citations);
            }
          }

          // Always show the sources panel
          if (contentEl) {
            this.renderCitationsPanel(contentEl.parentElement!, assistantMsg.citations);
          }
        }

        if (assistantMsg.noContextFound && contentEl) {
          this.renderNoContextBanner(contentEl.parentElement!);
        }

        await this.conversationManager.saveConversation(this.currentConversation!);
        await this.renderSidebar();

      } catch (error) {
        indicator.remove();
        new Notice("Error generating response");
        console.error(error);
        const errorMsg: Message = {
            role: "system",
            content: `Error: ${error instanceof Error ? error.message : "Unknown error"}`,
            timestamp: Date.now()
        };
        this.appendMessage(errorMsg);
      }
  }

  async createNewConversation() {
    this.currentConversation = await this.conversationManager.createConversation();
    this.messagesContainer.empty();
    await this.renderSidebar();
  }

  async loadConversation(id: string) {
    const conversation = await this.conversationManager.loadConversation(id);
    if (conversation) {
      this.currentConversation = conversation;
      this.messagesContainer.empty();
      for (const msg of conversation.messages) {
        this.appendMessage(msg);
      }
      await this.renderSidebar(); // Update active state
    }
  }

  appendMessage(message: Message) {
    const msgDiv = this.messagesContainer.createDiv({ cls: "chat-message" });
    msgDiv.addClass(`message-${message.role}`);

    const header = msgDiv.createDiv({ cls: "message-header" });
    
    header.createSpan({ text: message.role === "user" ? "You" : "Journal" });

    // Timestamp
    const date = new Date(message.timestamp);
    const timeStr = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    header.createSpan({ text: timeStr, cls: "message-timestamp" });

    const actionsDiv = header.createDiv({ cls: "message-actions" });

    // Menu Button
    const menuBtn = actionsDiv.createDiv({ cls: "message-action-btn" });
    setIcon(menuBtn, "more-horizontal");
    menuBtn.title = "Message actions";

    menuBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const menu = new Menu();

        // Copy
        menu.addItem((item) => 
            item
                .setTitle("Copy")
                .setIcon("copy")
                .onClick(async () => {
                    await navigator.clipboard.writeText(message.content);
                    new Notice("Copied to clipboard");
                })
        );

        // Edit (User only)
        if (message.role === "user") {
            menu.addItem((item) => 
                item
                    .setTitle("Edit")
                    .setIcon("pencil")
                    .onClick(() => {
                        this.editMessage(message, msgDiv, content);
                    })
            );
        }

        // Regenerate (Assistant only)
        if (message.role === "assistant") {
            menu.addItem((item) => 
                item
                    .setTitle("Regenerate")
                    .setIcon("refresh-cw")
                    .onClick(async () => {
                        await this.regenerateMessage(message);
                    })
            );
        }

        // Delete
        menu.addItem((item) => 
            item
                .setTitle("Delete")
                .setIcon("trash")
                .setWarning(true)
                .onClick(async () => {
                    await this.deleteMessage(message);
                })
        );

        // Export to Note
        menu.addItem((item) => 
            item
                .setTitle("Export to note")
                .setIcon("file-plus")
                .onClick(async () => {
                    await this.exportMessageToNote(message);
                })
        );

        menu.showAtMouseEvent(e);
    });

    const content = msgDiv.createDiv({ cls: "message-content" });
    
    if (message.role === "assistant" || message.role === "system") {
        void this.renderAssistantMessage(message, msgDiv, content);
    } else {
        content.innerText = message.content;
    }

    this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
  }

  /** Renders the Markdown first: citation badges rewrite the rendered text, so they must wait for it. */
  private async renderAssistantMessage(message: Message, msgDiv: HTMLElement, content: HTMLElement): Promise<void> {
    await MarkdownRenderer.render(this.app, message.content, content, "", this.component);
    if (message.citations && message.citations.length > 0) {
      this.renderCitationBadges(content, message.citations);
      this.renderCitationsPanel(msgDiv, message.citations);
    }
    if (message.noContextFound) {
      this.renderNoContextBanner(msgDiv);
    }
  }

  editMessage(message: Message, msgDiv: HTMLElement, contentEl: HTMLElement) {
      contentEl.empty();
      const editArea = new TextAreaComponent(contentEl);
      editArea.setValue(message.content);
      editArea.inputEl.addClass("memex-edit-input");

      const btnContainer = contentEl.createDiv({ cls: "memex-edit-buttons" });

      const saveBtn = new ButtonComponent(btnContainer);
      saveBtn.setButtonText("Save & submit");
      saveBtn.setCta();
      
      const cancelBtn = new ButtonComponent(btnContainer);
      cancelBtn.setButtonText("Cancel");

      cancelBtn.onClick(() => {
          contentEl.empty();
          contentEl.innerText = message.content;
      });

      saveBtn.onClick(async () => {
          const newContent = editArea.getValue();
          if (!newContent.trim() || newContent === message.content) {
              contentEl.empty();
              contentEl.innerText = message.content;
              return;
          }

          const index = this.currentConversation!.messages.indexOf(message);
          if (index !== -1) {
              this.currentConversation!.messages = this.currentConversation!.messages.slice(0, index);
              await this.conversationManager.saveConversation(this.currentConversation!);
              
              this.messagesContainer.empty();
              for (const msg of this.currentConversation!.messages) {
                  this.appendMessage(msg);
              }
              
              await this.processUserMessage(newContent);
          }
      });
  }

  async regenerateMessage(message: Message) {
      const index = this.currentConversation!.messages.indexOf(message);
      if (index !== -1) {
          this.currentConversation!.messages.splice(index, 1);
          await this.conversationManager.saveConversation(this.currentConversation!);
          
          this.messagesContainer.empty();
          for (const msg of this.currentConversation!.messages) {
              this.appendMessage(msg);
          }

          await this.generateAssistantResponse();
      }
  }

  async deleteMessage(message: Message) {
      const index = this.currentConversation!.messages.indexOf(message);
      if (index !== -1) {
          this.currentConversation!.messages.splice(index, 1);
          await this.conversationManager.saveConversation(this.currentConversation!);
          
          this.messagesContainer.empty();
          for (const msg of this.currentConversation!.messages) {
              this.appendMessage(msg);
          }
      }
  }

  async exportMessageToNote(message: Message) {
      const defaultName = `Chat Export ${new Date().toISOString().replace(/[:.]/g, "-")}`;
      new ExportModal(this.app, defaultName, async (fileName) => {
          const folderPath = EXPORT_FOLDER;
          if (!await this.app.vault.adapter.exists(folderPath)) {
              await this.app.vault.createFolder(folderPath);
          }
          
          const fullPath = `${folderPath}/${fileName}.md`;
          await this.app.vault.create(fullPath, message.content);
          new Notice(`Exported to ${fullPath}`);
      }).open();
  }

  showTypingIndicator() {
      const indicator = this.messagesContainer.createDiv({ cls: "typing-indicator", text: "Journal is thinking..." });
      this.messagesContainer.scrollTop = this.messagesContainer.scrollHeight;
      return indicator;
  }

  async attributeSources(
    answer: string,
    chunkMap: Map<number, SearchResult>
  ): Promise<CitationVerification[]> {
    let passagesText = "";
    for (const [id, chunk] of chunkMap) {
      passagesText += `[${id}] (From: ${chunk.metadata.noteTitle})\n${chunk.content}\n\n`;
    }

    const messages = [
      {
        role: "system",
        content: `You are a source attribution checker. Given an answer and numbered source passages, determine which passages were used to produce the answer.

For each source passage, check if the answer contains information that came from that passage. Mark it as "used": true if the passage supports any part of the answer, or "used": false if the passage was not relevant to the answer.

Return ONLY valid JSON in this exact format, no other text:
{"sources": [{"id": 1, "used": true, "claim": "what part of the answer it supports", "supported": true, "reason": "brief explanation"}]}

For unused sources, set claim to "" and reason to "".
If a source was used but the answer misrepresents it, set "used": true but "supported": false.`
      },
      {
        role: "user",
        content: `Answer:\n${answer}\n\nSource Passages:\n${passagesText}`
      }
    ];

    const response = await this.llmService.completion(messages, {
      temperature: 0,
      max_tokens: 1500
    });

    try {
      let cleaned = response.replace(/```(?:json)?\s*/gi, "").replace(/```\s*/g, "").trim();
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) return [];
      const parsed = JSON.parse(jsonMatch[0]) as AttributionReply;

      const results: CitationVerification[] = [];
      for (const s of (parsed.sources || [])) {
        const id = Number(s.id);
        const chunk = chunkMap.get(id);
        if (!chunk) continue;

        results.push({
          id,
          claim: s.claim || "",
          supported: s.used ? !!s.supported : true,
          reason: s.used ? (s.reason || (s.supported ? "Supports the answer" : "No reason given")) : "",
          sourceChunk: {
            noteTitle: chunk.metadata.noteTitle,
            filePath: chunk.metadata.filePath,
            chunkIndex: chunk.metadata.chunkIndex,
            content: chunk.content,
          }
        });
      }
      return results;
    } catch (e) {
      console.error("Failed to parse attribution response:", e, response);
      return [];
    }
  }

  renderCitationBadges(contentEl: HTMLElement, citations: CitationVerification[]) {
    const verificationMap = new Map<number, CitationVerification>();
    for (const c of citations) {
      verificationMap.set(c.id, c);
    }

    // "[1]" inside code (e.g. arr[1]) is an index, not a citation
    const walker = document.createTreeWalker(contentEl, NodeFilter.SHOW_TEXT, {
      acceptNode: (node) =>
        node.parentElement?.closest("code, pre") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
    });
    const replacements: { node: Text; fragments: DocumentFragment }[] = [];

    while (walker.nextNode()) {
      const textNode = walker.currentNode as Text;
      const text = textNode.textContent || "";
      if (!/\[\d+\]/.test(text)) continue;

      const fragment = createFragment();
      let lastIndex = 0;
      const regex = /\[(\d+)\]/g;
      let match: RegExpExecArray | null;

      while ((match = regex.exec(text)) !== null) {
        if (match.index > lastIndex) {
          fragment.appendText(text.slice(lastIndex, match.index));
        }

        const citationId = parseInt(match[1]);
        const verification = verificationMap.get(citationId);
        const [status, title]: [string, string] = !verification
          ? ["is-unverified", "Unverified citation"]
          : verification.supported
            ? ["is-supported", `Verified: ${verification.reason}`]
            : ["is-unsupported", `Not supported: ${verification.reason}`];

        const badge = fragment.createSpan({
          cls: ["memex-citation-badge", status],
          text: `[${citationId}]`,
          attr: { "data-citation-id": String(citationId), title },
        });

        badge.addEventListener("click", () => {
          const msgDiv = contentEl.parentElement;
          // The source list starts collapsed; open it so there's something to scroll to
          const panel = msgDiv?.querySelector<HTMLElement>(".memex-citations-panel");
          if (panel && !panel.hasClass("is-expanded")) {
            panel.querySelector<HTMLElement>(".citations-toggle")?.click();
          }
          const detail = msgDiv?.querySelector<HTMLElement>(`.memex-citation-detail[data-citation-id="${citationId}"]`);
          if (detail) {
            // A cited passage the checker didn't count as used sits under "Also searched"
            detail.closest<HTMLElement>(".citations-more")?.addClass("is-expanded");
            detail.scrollIntoView({ behavior: "smooth", block: "nearest" });
            detail.addClass("is-highlighted");
            window.setTimeout(() => detail.removeClass("is-highlighted"), 1500);
          }
        });

        lastIndex = match.index + match[0].length;
      }

      if (lastIndex < text.length) {
        fragment.appendText(text.slice(lastIndex));
      }

      replacements.push({ node: textNode, fragments: fragment });
    }

    for (const { node, fragments } of replacements) {
      node.parentNode?.replaceChild(fragments, node);
    }
  }

  renderCitationsPanel(msgDiv: HTMLElement, citations: CitationVerification[]) {
    const existingPanel = msgDiv.querySelector(".memex-citations-panel");
    if (existingPanel) existingPanel.remove();

    if (citations.length === 0) return;

    const panel = msgDiv.createDiv({ cls: "memex-citations-panel" });

    const verifiedCitations = citations.filter(c => c.reason && c.reason !== "");
    const verifiedCount = verifiedCitations.filter(c => c.supported).length;
    const totalVerified = verifiedCitations.length;

    const toggle = panel.createDiv({ cls: "citations-toggle" });
    const overall = totalVerified === 0
      ? "is-unchecked"
      : verifiedCount === totalVerified ? "is-all-verified" : "is-partly-verified";
    toggle.createSpan({ cls: ["citations-status-dot", overall] });

    const labelText = totalVerified > 0
      ? `Sources (${verifiedCount}/${totalVerified} verified)`
      : `Sources (${citations.length})`;
    toggle.createSpan({ text: labelText });
    toggle.createSpan({ cls: "citations-arrow", text: " \u25BC" });

    const list = panel.createDiv({ cls: "citations-list" });

    toggle.addEventListener("click", () => {
      panel.toggleClass("is-expanded", !panel.hasClass("is-expanded"));
    });

    // Search always returns Top K passages, so most may be unrelated to the answer.
    // List the ones the checker found the answer used; tuck the rest away. Without
    // verdicts (checker failed or didn't run) there's no telling, so list them all.
    const others = totalVerified > 0 ? citations.filter(c => !verifiedCitations.includes(c)) : [];
    for (const citation of totalVerified > 0 ? verifiedCitations : citations) {
      this.renderCitationDetail(list, citation);
    }

    if (others.length > 0) {
      const more = list.createDiv({ cls: "citations-more" });
      const moreToggle = more.createDiv({ cls: "citations-more-toggle", text: `Also searched (${others.length})` });
      const moreList = more.createDiv({ cls: "citations-more-list" });
      moreToggle.addEventListener("click", () => {
        more.toggleClass("is-expanded", !more.hasClass("is-expanded"));
      });
      for (const citation of others) {
        this.renderCitationDetail(moreList, citation);
      }
    }
  }

  private renderCitationDetail(parent: HTMLElement, citation: CitationVerification) {
    const isVerified = citation.reason && citation.reason !== "";
    const status = !isVerified ? "is-unchecked" : citation.supported ? "is-supported" : "is-unsupported";
    const item = parent.createDiv({
      cls: ["memex-citation-detail", status],
      attr: { "data-citation-id": String(citation.id) },
    });

    const header = item.createDiv({ cls: "citation-detail-header" });
    header.createSpan({
      text: `[${citation.id}] From: ${citation.sourceChunk.noteTitle}`
    });
    header.createSpan({
      cls: ["citation-status", status],
      text: !isVerified ? "Source" : citation.supported ? "Verified" : "Not supported",
    });

    item.createDiv({ cls: "citation-passage", text: citation.sourceChunk.content });

    if (!citation.supported) {
      item.createDiv({ cls: "citation-reason", text: citation.reason });
    }
  }

  renderNoContextBanner(msgDiv: HTMLElement) {
    if (msgDiv.querySelector(".memex-no-context")) return;

    msgDiv.createDiv({
      cls: "memex-no-context",
      text: "No notes cleared the similarity threshold for this question — this answer is not grounded in your vault.",
    });
  }

  async onClose() {
    this.component.unload();
  }
}

export class RenameModal extends Modal {
  private currentName: string;
  private onSubmit: (newName: string) => Promise<void>;

  constructor(app: App, currentName: string, onSubmit: (newName: string) => Promise<void>) {
    super(app);
    this.currentName = currentName;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Rename chat" });

    let newName = this.currentName;

    new Setting(contentEl)
      .setName("Name")
      .addText((text) =>
        text
          .setValue(this.currentName)
          .onChange((value) => {
            newName = value;
          })
      );

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Save")
        .setCta()
        .onClick(() => {
          this.close();
          void this.onSubmit(newName);
        })
    );
    
    // Focus input on open
    const input = contentEl.querySelector("input");
    if (input) {
        input.focus();
        input.select();
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                this.close();
                void this.onSubmit(newName);
            }
        });
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

export class ExportModal extends Modal {
  private defaultName: string;
  private onSubmit: (fileName: string) => Promise<void>;

  constructor(app: App, defaultName: string, onSubmit: (fileName: string) => Promise<void>) {
    super(app);
    this.defaultName = defaultName;
    this.onSubmit = onSubmit;
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Export to note" });
    contentEl.createEl("p", { text: `File will be saved in '${EXPORT_FOLDER}'` });

    let fileName = this.defaultName;

    new Setting(contentEl)
      .setName("Note name")
      .addText((text) =>
        text
          .setValue(this.defaultName)
          .onChange((value) => {
            fileName = value;
          })
      );

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Export")
        .setCta()
        .onClick(() => {
          this.close();
          void this.onSubmit(fileName);
        })
    );
    
    // Focus input on open
    const input = contentEl.querySelector("input");
    if (input) {
        input.focus();
        input.select();
        input.addEventListener("keydown", (e) => {
            if (e.key === "Enter") {
                this.close();
                void this.onSubmit(fileName);
            }
        });
    }
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}

/** The per-chat settings this dialog edits. */
type EditableConfig = Required<Pick<ConversationConfig, "systemPrompt" | "temperature" | "maxTokens" | "citationTrustMode">>;

export class ConversationSettingsModal extends Modal {
  private conversation: Conversation;
  private settings: MemexSettings;
  private onSave: (config: ConversationConfig) => Promise<void>;
  private tempConfig: EditableConfig;

  constructor(app: App, conversation: Conversation, settings: MemexSettings, onSave: (config: ConversationConfig) => Promise<void>) {
    super(app);
    this.conversation = conversation;
    this.settings = settings;
    this.onSave = onSave;
    
    this.tempConfig = {
        systemPrompt: conversation.config?.systemPrompt || settings.personas[0]?.prompt || "",
        temperature: conversation.config?.temperature ?? settings.defaultTemperature,
        maxTokens: conversation.config?.maxTokens ?? settings.defaultMaxTokens,
        citationTrustMode: conversation.config?.citationTrustMode ?? settings.citationTrustMode
    };
  }

  onOpen() {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Chat settings" });

    // Persona Selector
    new Setting(contentEl)
        .setName("Persona")
        .setDesc("Select a preset persona")
        .addDropdown(dropdown => {
            this.settings.personas.forEach((p) => {
                dropdown.addOption(p.name, p.name);
            });
            dropdown.setValue("Custom"); // Default to showing current prompt
            dropdown.onChange((value) => {
                const persona = this.settings.personas.find((p) => p.name === value);
                if (persona) {
                    this.tempConfig.systemPrompt = persona.prompt;
                    // Update the text area below
                    const textArea = contentEl.querySelector("textarea");
                    if (textArea) textArea.value = persona.prompt;
                }
            });
        });

    // System Prompt
    new Setting(contentEl)
        .setName("System prompt")
        .setDesc("Customize the behavior of the assistant")
        .addTextArea(text => text
            .setValue(this.tempConfig.systemPrompt)
            .setPlaceholder("You are a helpful assistant...")
            .onChange((value) => {
                this.tempConfig.systemPrompt = value;
            }));

    // Temperature
    new Setting(contentEl)
        .setName("Temperature")
        .setDesc("Controls randomness (0.0 - 1.0)")
        .addSlider(slider => slider
            .setLimits(0, 1, 0.05)
            .setValue(this.tempConfig.temperature)
            .onChange((value) => {
                this.tempConfig.temperature = value;
            }));

    // Max Tokens
    new Setting(contentEl)
        .setName("Max tokens")
        .setDesc("Maximum length of response")
        .addText(text => text
            .setValue(String(this.tempConfig.maxTokens))
            .onChange((value) => {
                const num = parseInt(value);
                if (!isNaN(num)) {
                    this.tempConfig.maxTokens = num;
                }
            }));

    // Citation Trust Mode
    new Setting(contentEl)
        .setName("Citation trust mode")
        .setDesc("Controls citation verification for this chat")
        .addDropdown(dropdown => dropdown
            .addOption("off", "Off")
            .addOption("relaxed", "Relaxed")
            .addOption("strict", "Strict")
            .setValue(this.tempConfig.citationTrustMode)
            .onChange((value) => {
                this.tempConfig.citationTrustMode = value as EditableConfig["citationTrustMode"];
            }));

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Save")
        .setCta()
        .onClick(() => {
          void this.onSave(this.tempConfig);
          this.close();
        })
    );
  }

  onClose() {
    const { contentEl } = this;
    contentEl.empty();
  }
}
