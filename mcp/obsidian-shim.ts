/**
 * Node stand-in for the one Obsidian API the retrieval code uses: `requestUrl`.
 * The MCP build redirects `import ... from "obsidian"` here, so providers.ts,
 * vector_store.ts and qdrant_store.ts run unchanged outside Obsidian.
 */

export interface RequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
  body?: string;
  headers?: Record<string, string>;
  throw?: boolean;
}

export async function requestUrl(request: RequestUrlParam | string) {
  const req = typeof request === "string" ? { url: request } : request;
  const headers: Record<string, string> = { ...(req.headers || {}) };
  if (req.contentType && !headers["Content-Type"]) {
    headers["Content-Type"] = req.contentType;
  }

  const res = await fetch(req.url, { method: req.method || "GET", headers, body: req.body });
  const text = await res.text();
  // Obsidian throws on error statuses unless asked not to
  if (res.status >= 400 && req.throw !== false) {
    throw new Error(`Request failed, status ${res.status}`);
  }
  return {
    status: res.status,
    text,
    get json(): unknown {
      return JSON.parse(text) as unknown;
    },
  };
}

/** Only used as a type by the retrieval code; exported so the import resolves. */
export class App {}
