import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage, ServerResponse } from "node:http";

const MIME_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};
const DEFAULT_MIME_TYPE = "application/octet-stream";

/**
 * Hand-rolled static file server (no dependency — this repo's Phase 1 chose
 * `ws` over `socket.io` and `better-sqlite3` over an ORM for the same
 * reason). Serves `rootDir`, defaulting `/` to `index.html`. No SPA
 * fallback routing — the web UI has no URL-addressed routes, only
 * client-side tab state.
 */
export function createStaticFileServer(rootDir: string): (req: IncomingMessage, res: ServerResponse) => void {
  const resolvedRoot = path.resolve(rootDir);

  return function handleRequest(req: IncomingMessage, res: ServerResponse): void {
    const requestPath = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
    const relativePath = requestPath === "/" ? "index.html" : requestPath.replace(/^\/+/, "");
    const resolvedPath = path.resolve(resolvedRoot, relativePath);

    const isInsideRoot =
      resolvedPath === resolvedRoot || resolvedPath.startsWith(resolvedRoot + path.sep);
    if (!isInsideRoot) {
      res.writeHead(403).end("Forbidden");
      return;
    }

    fs.readFile(resolvedPath, (err, data) => {
      if (err) {
        res.writeHead(404).end("Not found");
        return;
      }
      const contentType = MIME_TYPES[path.extname(resolvedPath)] ?? DEFAULT_MIME_TYPE;
      res.writeHead(200, { "Content-Type": contentType }).end(data);
    });
  };
}
