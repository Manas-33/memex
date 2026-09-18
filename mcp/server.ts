/**
 * Memex MCP server: read-only access to an Obsidian vault for MCP clients such as
 * Claude Desktop and Claude Code.
 *
 * It reuses the plugin's own retrieval code (embeddings, hybrid search, the relevance
 * threshold) and reads the plugin's settings file, so an assistant gets the same
 * results as the in-app chat, including "nothing found" when the notes don't cover it.
 *
 * Usage: node mcp-server.js /path/to/vault
 */
import "./stdout-guard";
import * as fs from "fs";
import * as path from "path";
import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { DEFAULT_SETTINGS, MemexSettings } from "../settings";
import { createEmbeddingProvider } from "../providers";
import { IVectorStore, LocalVectorStore, SearchResult } from "../vector_store";
import { HttpRequest, QdrantVectorStore } from "../qdrant_store";

const VERSION = "1.0.0";

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

const vaultArg = process.argv[2] || process.env.MEMEX_VAULT;
if (!vaultArg) {
  fail("Usage: node mcp-server.js /path/to/obsidian/vault");
}
const VAULT = path.resolve(vaultArg);
if (!fs.existsSync(VAULT) || !fs.statSync(VAULT).isDirectory()) {
  fail(`Vault folder not found: ${VAULT}`);
}
const VAULT_REAL = fs.realpathSync(VAULT);

/** Read on every call, so changes made in the plugin's settings apply without a restart. */
function loadSettings(): MemexSettings {
  const file = path.join(VAULT, ".obsidian", "plugins", "memex", "data.json");
  const saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  return { ...DEFAULT_SETTINGS, ...saved };
}

// ─── Vault files ───────────────────────────────────────────────────────────────

const toPosix = (p: string) => p.split(path.sep).join("/");

/** Hidden folders (.obsidian, .trash, …) and the plugin's excluded folders are off limits. */
function isExcluded(relPath: string, settings: MemexSettings): boolean {
  if (relPath.split("/").some((part) => part.startsWith("."))) return true;
  return settings.excludedFolders.some((folder) => folder && relPath.startsWith(folder));
}

/**
 * Resolves a vault-relative note path, refusing anything outside the vault (including
 * via symlinks) or anything that isn't a Markdown note, so a prompt can't use the
 * server to read other files.
 */
function resolveNote(relPath: string, settings: MemexSettings): { abs: string; rel: string } {
  const outside = new Error(`"${relPath}" is outside the vault`);
  const escapes = (from: string, to: string) => {
    const rel = path.relative(from, to);
    return rel.startsWith("..") || path.isAbsolute(rel);
  };

  // Every check that can be made from the path alone runs before touching the disk,
  // so nothing outside the vault can be probed for whether it exists
  const abs = path.resolve(VAULT, relPath);
  if (escapes(VAULT, abs)) throw outside;
  const rel = toPosix(path.relative(VAULT, abs));
  if (!rel.endsWith(".md")) throw new Error(`"${relPath}" is not a Markdown note`);
  if (isExcluded(rel, settings)) throw new Error(`"${relPath}" is in an excluded folder`);
  if (!fs.existsSync(abs)) throw new Error(`Note not found: ${relPath}`);

  // A symlink inside the vault can still point outside it
  const real = fs.realpathSync(abs);
  if (escapes(VAULT_REAL, real)) throw outside;
  return { abs: real, rel };
}

interface NoteInfo {
  path: string;
  title: string;
  modified: number;
}

async function listNotes(settings: MemexSettings): Promise<NoteInfo[]> {
  const notes: NoteInfo[] = [];
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      const rel = toPosix(path.relative(VAULT, abs));
      // Symlinks are skipped: they could point outside the vault or loop
      if (isExcluded(rel, settings) || entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await walk(abs);
      } else if (entry.name.endsWith(".md")) {
        notes.push({ path: rel, title: entry.name.slice(0, -3), modified: (await fs.promises.stat(abs)).mtimeMs });
      }
    }
  };
  await walk(VAULT);
  return notes.sort((a, b) => b.modified - a.modified);
}

const noteUri = (relPath: string) => `memex://note/${encodeURI(relPath)}`;

// ─── Search index ──────────────────────────────────────────────────────────────

/** fetch-based HTTP for the Qdrant store (the plugin passes Obsidian's requestUrl instead). */
const fetchHttp: HttpRequest = async ({ url, method, headers, body }) => {
  const res = await fetch(url, { method, headers, body });
  let json: any = null;
  try {
    json = await res.json();
  } catch {
    // Non-JSON body
  }
  return { status: res.status, json };
};

/** The local store's view of the vault: reads from disk, never writes. */
const readOnlyVault = {
  vault: {
    adapter: {
      exists: async (p: string) => fs.existsSync(path.join(VAULT, p)),
      read: async (p: string) => fs.promises.readFile(path.join(VAULT, p), "utf8"),
      mkdir: async () => {},
      write: async () => {
        throw new Error("The Memex MCP server is read-only");
      },
    },
  },
} as any;

let store: IVectorStore | null = null;
let storeKey = "";
let loadedIndexMtime = -1;
let loading: Promise<void> | null = null;

/** The index the plugin built, reloaded whenever the plugin rewrites it. */
async function getStore(settings: MemexSettings): Promise<IVectorStore> {
  const key = settings.vectorStoreType === "qdrant"
    ? `qdrant|${settings.qdrantUrl}|${settings.qdrantCollection}`
    : `local|${settings.chromaDbPath}`;
  if (!store || key !== storeKey) {
    store = settings.vectorStoreType === "qdrant"
      ? new QdrantVectorStore(fetchHttp, settings.qdrantUrl, settings.qdrantApiKey, settings.qdrantCollection)
      : new LocalVectorStore(readOnlyVault, `${settings.chromaDbPath}/vectors.json`);
    storeKey = key;
    loadedIndexMtime = -1;
  }

  // Qdrant is always current; the local index is a file the plugin rewrites as notes change
  let mtime = 0;
  if (settings.vectorStoreType !== "qdrant") {
    const file = path.join(VAULT, settings.chromaDbPath, "vectors.json");
    mtime = fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0;
  }
  if (mtime !== loadedIndexMtime) {
    const current = store;
    loading = loading || current.initialize().then(() => {
      loadedIndexMtime = mtime;
    }).finally(() => {
      loading = null;
    });
    await loading;
  }
  return store;
}

// ─── Server ────────────────────────────────────────────────────────────────────

const server = new McpServer(
  { name: "memex", version: VERSION },
  {
    instructions:
      "Read-only access to the user's Obsidian notes. Use search_notes to find information in them, " +
      "then read_note for a full note. Cite note titles in answers. When search_notes returns " +
      "found: false, tell the user their notes don't cover it instead of guessing.",
  }
);

const readOnly = { readOnlyHint: true, openWorldHint: false };

server.registerTool(
  "search_notes",
  {
    title: "Search notes",
    description:
      "Search the user's Obsidian notes by meaning and exact keywords, and return the most relevant " +
      "passages with the note each came from. If `found` is false, no note matched closely enough: " +
      "the notes don't cover this.",
    inputSchema: {
      query: z.string().min(1).describe("What to look for, phrased as a question or topic"),
      limit: z.number().int().min(1).max(20).optional().describe("Maximum passages to return (default: the plugin's Top K)"),
    },
    outputSchema: {
      found: z.boolean().describe("False when no note cleared the relevance threshold"),
      results: z.array(
        z.object({
          note: z.string().describe("Note title"),
          path: z.string().describe("Vault-relative path, usable with read_note"),
          uri: z.string().describe("memex://note/ resource URI"),
          chunk: z.number().int().describe("Position of this passage within the note"),
          similarity: z.number().describe("Cosine similarity to the query, 0-1"),
          text: z.string(),
        })
      ),
    },
    annotations: readOnly,
  },
  async ({ query, limit }) => {
    const settings = loadSettings();
    const index = await getStore(settings);
    if ((await index.getCount()) === 0) {
      return {
        content: [{ type: "text", text: "The search index is empty. Run \"Index Vault for RAG\" in Obsidian first." }],
        structuredContent: { found: false, results: [] },
      };
    }
    const embedding = await createEmbeddingProvider(settings).generateEmbedding(query);
    const topK = limit ?? settings.topK;
    const hits: SearchResult[] = settings.retrievalMode === "hybrid"
      ? await index.searchHybrid(embedding, query, topK, settings.similarityThreshold)
      : await index.search(embedding, topK, settings.similarityThreshold);

    const results = hits.map((h) => ({
      note: h.metadata.noteTitle,
      path: h.metadata.filePath,
      uri: noteUri(h.metadata.filePath),
      chunk: h.metadata.chunkIndex,
      similarity: Math.round(h.similarity * 10000) / 10000,
      text: h.content,
    }));
    const text = results.length === 0
      ? `No note matched "${query}" closely enough (relevance threshold ${settings.similarityThreshold}). The notes don't appear to cover this.`
      : results.map((r, i) => `[${i + 1}] ${r.note} (${r.path}, similarity ${r.similarity})\n${r.text}`).join("\n\n");

    return { content: [{ type: "text", text }], structuredContent: { found: results.length > 0, results } };
  }
);

server.registerTool(
  "read_note",
  {
    title: "Read note",
    description: "Read the full Markdown of one note. `path` is vault-relative, as returned by search_notes or list_notes.",
    inputSchema: {
      path: z.string().min(1).describe("Vault-relative path, e.g. Projects/Go.md"),
    },
    outputSchema: {
      path: z.string(),
      title: z.string(),
      modified: z.string().describe("ISO 8601 timestamp"),
      content: z.string(),
    },
    annotations: readOnly,
  },
  async ({ path: requested }) => {
    const { abs, rel } = resolveNote(requested, loadSettings());
    const content = await fs.promises.readFile(abs, "utf8");
    const modified = new Date((await fs.promises.stat(abs)).mtimeMs).toISOString();
    const title = path.basename(rel, ".md");
    return {
      content: [{ type: "text", text: content }],
      structuredContent: { path: rel, title, modified, content },
    };
  }
);

server.registerTool(
  "list_notes",
  {
    title: "List notes",
    description: "List notes in the vault, most recently modified first, optionally within one folder.",
    inputSchema: {
      folder: z.string().optional().describe("Only notes under this folder, e.g. Projects"),
      limit: z.number().int().min(1).max(1000).optional().describe("Maximum notes to return (default 100)"),
    },
    outputSchema: {
      total: z.number().int().describe("Notes matching, before the limit"),
      notes: z.array(z.object({ path: z.string(), title: z.string(), modified: z.string() })),
    },
    annotations: readOnly,
  },
  async ({ folder, limit }) => {
    const prefix = folder ? `${folder.replace(/^\/+|\/+$/g, "")}/` : "";
    const matching = (await listNotes(loadSettings())).filter((n) => n.path.startsWith(prefix));
    const notes = matching.slice(0, limit ?? 100).map((n) => ({
      path: n.path,
      title: n.title,
      modified: new Date(n.modified).toISOString(),
    }));
    const text = notes.map((n) => `${n.path}  (${n.modified.slice(0, 10)})`).join("\n") || "No notes found.";
    return { content: [{ type: "text", text }], structuredContent: { total: matching.length, notes } };
  }
);

server.registerResource(
  "note",
  new ResourceTemplate("memex://note/{+path}", {
    list: async () => ({
      resources: (await listNotes(loadSettings())).map((n) => ({
        uri: noteUri(n.path),
        name: n.title,
        description: n.path,
        mimeType: "text/markdown",
      })),
    }),
  }),
  { title: "Obsidian note", description: "A note from the vault, as Markdown", mimeType: "text/markdown" },
  async (uri, variables) => {
    const raw = Array.isArray(variables.path) ? variables.path.join("/") : variables.path;
    const { abs } = resolveNote(decodeURI(raw), loadSettings());
    return { contents: [{ uri: uri.href, mimeType: "text/markdown", text: await fs.promises.readFile(abs, "utf8") }] };
  }
);

server.registerResource(
  "index-stats",
  "memex://index/stats",
  {
    title: "Index stats",
    description: "What the search index holds and how search is configured",
    mimeType: "application/json",
  },
  async (uri) => {
    const settings = loadSettings();
    const stats = {
      vault: path.basename(VAULT),
      notes: (await listNotes(settings)).length,
      indexedChunks: await (await getStore(settings)).getCount(),
      vectorStore: settings.vectorStoreType,
      embeddingModel: settings.providerType === "gemini" ? settings.geminiEmbeddingModel : settings.embeddingModel,
      retrievalMode: settings.retrievalMode,
      similarityThreshold: settings.similarityThreshold,
      topK: settings.topK,
    };
    return { contents: [{ uri: uri.href, mimeType: "application/json", text: JSON.stringify(stats, null, 2) }] };
  }
);

async function main(): Promise<void> {
  await server.connect(new StdioServerTransport());
  console.error(`Memex MCP server ready (vault: ${VAULT})`);
}

main().catch((error) => fail(`Memex MCP server failed: ${error?.stack || error}`));
