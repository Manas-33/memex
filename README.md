<p align="center">
  <img src="assets/banner.png" alt="Memex — Your AI-powered knowledge companion for Obsidian" width="100%" />
</p>

<p align="center">
  <strong>Auto-tag notes · Summarise your week · Extract action items · Chat with your vault</strong>
</p>

<p align="center">
  <img src="https://img.shields.io/badge/version-1.0.0-blue?style=flat-square" alt="Version" />
  <img src="https://img.shields.io/badge/license-MIT-green?style=flat-square" alt="License" />
  <img src="https://img.shields.io/badge/AI-Local%20%7C%20Gemini-orange?style=flat-square" alt="AI Providers" />
</p>

---

## ⚡ Quick Start — up and running in 60 seconds

```bash
# 1️⃣  Build the plugin
npm install && npm run build

# 2️⃣  Install into your vault
mkdir -p <your-vault>/.obsidian/plugins/memex
cp main.js manifest.json <your-vault>/.obsidian/plugins/memex/

# 3️⃣  Enable in Obsidian
#     Settings → Community Plugins → Reload → Toggle "Memex" ON
#     Then set your AI provider (Local or Gemini) in Settings → Memex
```

> **Using Gemini?** Grab a free API key from [Google AI Studio](https://aistudio.google.com/apikey) — no local server needed.
>
> **Using a local LLM?** Start [LM Studio](https://lmstudio.ai) or [Ollama](https://ollama.com) and load a chat + embedding model.

---

## ✨ Features

### 💬 Chat with Your Vault
- **Streaming responses** — tokens appear in real-time as the LLM generates them, with automatic fallback to non-streaming if the server doesn't support it.
- **Multiple conversations** — create, rename, and delete chats; sidebar lists them sorted by last activity.
- **Resizable sidebar** — drag the divider or toggle the sidebar open/closed.
- **Message actions** (per-message `⋯` menu):
  - **Copy** any message to clipboard.
  - **Edit & re-submit** a user message (trims history and re-generates).
  - **Regenerate** an assistant response.
  - **Delete** a single message.
  - **Export to Note** — saves a message as a new Markdown file in your vault.
- **Per-conversation settings** — override temperature, max tokens, system prompt, RAG top-K, and similarity threshold on a per-chat basis via the ⚙️ button.
- **Personas** — switch the assistant's personality (e.g., *Zettelkasten Guide*, *Daily Reflector*, *Concise Summarizer*). Fully customisable in settings.
- **PDF export** — right-click a chat in the sidebar → *Export to PDF*. Renders full Markdown with styled headings, code blocks, and lists into an A4 PDF saved to `Memex/PDFs/`.

### 🔎 RAG (Retrieval-Augmented Generation)
- **Intelligent query rewriting** — follow-up questions are automatically rewritten into standalone search queries using the LLM, so context isn't lost across turns.
- **Content-hash indexing** — only re-embeds notes whose content has actually changed; hashes are persisted to disk across reloads, eliminating redundant API calls.
- **Idle-based auto-indexing** — dirty files are queued and re-indexed when you navigate away from a note (not on every keystroke).
- **Optimised vector store**:
  - `Float32Array` embeddings with pre-computed norms for ~2–3× faster cosine similarity.
  - Min-heap top-K search — avoids sorting the entire index.
  - Path index for O(1) document lookups and deletions.
  - Compact JSON serialisation (~40% smaller on disk).
- **Excluded folders** — keep `Templates`, `.obsidian`, or any other folders out of the index.
- **Manual & automatic** — index the full vault on demand, or let the watcher handle it.

### 🏷️ Note Processing Commands
- **Auto Tag Current Note** — LLM suggests 3–5 relevant tags and prepends them.
- **Extract Action Items** — finds TODOs/tasks and appends them as a checklist.
- **Generate Weekly Summary** — summarises all notes modified in the last 7 days and saves the result to `Weekly Summaries/{Year}/`.

### 🔌 Modular AI Provider System
Swap between providers at any time — no restart required:

| | Local (LM Studio / Ollama) | Google Gemini |
|---|---|---|
| **Chat model** | `qwen/qwen3-vl-4b` (default) | `gemini-2.5-flash` (default) |
| **Embedding model** | `text-embedding-nomic-embed-text-v1.5` | `gemini-embedding-001` |
| **Server** | Your local machine | Google Cloud (API key) |

Both providers implement the same `ILLMProvider` / `IEmbeddingProvider` interfaces using OpenAI-compatible endpoints, so any model that speaks that protocol works.

### 🤖 MCP Server — your notes inside Claude
A standalone [MCP](https://modelcontextprotocol.io) server gives Claude Desktop, Claude Code and other MCP clients **read-only** access to your vault, using the plugin's own index and search.

- **Tools** — `search_notes` (hybrid semantic + keyword search with the same results as the chat panel; returns `found: false` when nothing clears the relevance threshold), `read_note`, `list_notes`. Each declares input and output JSON Schemas.
- **Resources** — every note as `memex://note/{path}` (Markdown), plus `memex://index/stats` (JSON).
- **No extra config** — reads the plugin's own settings (provider, API key, threshold, local or Qdrant index) from your vault.
- **Read-only and sandboxed** — never writes, and refuses paths outside the vault, including symlinks, hidden folders and your excluded folders.

Index your vault in Obsidian first, then build the server once:

```bash
npm run build:mcp   # → mcp-server.js
```

**Claude Code:**

```bash
claude mcp add memex --scope user -- node /absolute/path/to/memex/mcp-server.js "/absolute/path/to/your/vault"
```

**Claude Desktop** — add to `~/Library/Application Support/Claude/claude_desktop_config.json` (macOS):

```json
{
  "mcpServers": {
    "memex": {
      "command": "/absolute/path/to/node",
      "args": ["/absolute/path/to/memex/mcp-server.js", "/absolute/path/to/your/vault"]
    }
  }
}
```

Use the full path from `which node`: Claude Desktop doesn't see version managers such as nvm.

---

## 🎮 Usage

### Commands
Open the Command Palette (`Cmd/Ctrl + P`) and search for **Memex**:

| Command | Description |
|---------|-------------|
| **Open Chat with Journal** | Opens the chat sidebar |
| **Auto Tag Current Note** | Analyses the note and prepends tags |
| **Extract Action Items** | Finds TODOs and appends a checklist |
| **Generate Weekly Summary** | Summarises the last 7 days of notes |
| **Index Vault for RAG** | Full vault embedding index (with progress) |
| **Clear RAG Index** | Wipes the index for a fresh rebuild |
| **View RAG Index Statistics** | Shows total indexed document chunks |
| **Debug RAG Retrieval** | Select text → retrieves matching chunks (logged to console) |

### Chat Interface
- Click the **💬 ribbon icon** or run the *Open Chat with Journal* command.
- Type a message and press **Enter** (or **Shift+Enter** for a new line).
- Use the **⚙️** button next to Send to adjust per-chat settings.
- Right-click a conversation in the sidebar for rename / export / delete options.

---

## ⚙️ Settings

Go to **Settings → Memex**.

### AI Provider
- **Provider**: Local (LM Studio / Ollama) or Google Gemini.

### Local LLM Settings
- **LLM Endpoint** — URL of your local server (default `http://localhost:1234`).
- **Chat Model** — model identifier for chat completions.
- **Embedding Model** — model identifier for embeddings.

### Google Gemini Settings
- **API Key** — your Gemini API key.
- **Chat Model** — Gemini model (default `gemini-2.5-flash`).
- **Embedding Model** — Gemini embedding model (default `gemini-embedding-001`).

### General
- **Weekly Summary Path** — folder for weekly summaries.
- **Default Temperature** — controls randomness (0.0–1.0).
- **Default Max Tokens** — maximum response length.

### RAG Settings
- **Enable RAG** — toggle retrieval features on/off.
- **Chunk Size** — words per chunk (default 200).
- **Chunk Overlap** — overlapping words between chunks (default 30).
- **Top K Results** — number of chunks to retrieve (default 6).
- **Similarity Threshold** — minimum relevance score (default 0.4).
- **Auto-Index on Change** — re-index notes on create/modify/delete.
- **Excluded Folders** — comma-separated list of folders to skip.

### Personas
- **Personas JSON** — edit the array of `{name, prompt}` objects to customise assistant behaviour.

---

## 🏗️ Architecture

```
main.ts                  → Plugin entry point, commands, settings UI
├── settings.ts          → Settings type + defaults (shared with the MCP server)
├── providers.ts         → LLM & Embedding provider interfaces + Local/Gemini implementations
├── llm_service.ts       → LLM service (completion + streaming)
├── embedding_service.ts → Chunking + batch embedding generation
├── vector_store.ts      → IVectorStore + local JSON store (Float32Array + min-heap search)
├── qdrant_store.ts      → Qdrant-backed store (plain REST), shared across devices
├── lexical_index.ts     → BM25 keyword index + Reciprocal Rank Fusion for hybrid search
├── rag_service.ts       → RAG orchestration (indexing, retrieval, query rewriting)
├── processor.ts         → Note processing (tags, action items, weekly summary)
├── conversation_manager.ts → Conversation CRUD (JSON files in .memex/)
└── chat_view.ts         → Chat UI (sidebar, messages, streaming, PDF export)

mcp/server.ts            → MCP server (stdio) reusing the retrieval code above
```

---

## 🗺️ Roadmap

- [ ] **Multi-modal notes** — image and PDF understanding via vision models
- [ ] **Graph-aware RAG** — leverage Obsidian's link graph to boost retrieval relevance
- [ ] **Ollama auto-detect** — automatically discover running models, no manual config
- [ ] **Mobile support** — optimise the chat UI and indexing for Obsidian Mobile
- [ ] **Semantic search command** — vault-wide natural language search from the command palette
- [ ] **Note generation** — create new notes from chat responses with backlinks
- [ ] **Scheduled summaries** — automatic daily/weekly/monthly summaries on a cron
- [ ] **Plugin marketplace** — submit to the Obsidian Community Plugins directory

Have an idea? [Open an issue](https://github.com/manas-33/memex/issues) — PRs welcome!

---

## 🤝 Contributing

Contributions are welcome — whether it's a bug fix, new feature, or documentation improvement.

1. **Fork** the repo and create a new branch:
   ```bash
   git checkout -b feature/my-feature
   ```
2. **Make your changes** — follow the existing code style and add comments where needed.
3. **Build & test** to make sure everything compiles:
   ```bash
   npm run build
   ```
4. **Submit a Pull Request** with a clear description of what you changed and why.

### Development Setup

```bash
git clone https://github.com/manas-33/memex.git
cd memex
npm install
npm run dev    # Watch mode — rebuilds on file changes
```

Then symlink or copy the built files into your vault's `.obsidian/plugins/memex/` folder and reload Obsidian.

---

## 📄 License

MIT — see [LICENSE](LICENSE) for details.
