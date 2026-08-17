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

// The shared web UI is server-served (unlike src/connect-screen/index.html's
// file://-only meta-tag CSP) and reachable directly from a plain browser,
// including over Tailscale — argusde#39. `connect-src 'self'` covers the
// app's same-origin WebSocket connection (ws-client.ts always connects to
// `location.host`); the build has no inline scripts/styles (Vite emits
// linked <script>/<link> tags only), so neither directive needs
// 'unsafe-inline'.
//
// **What `style-src 'self'` costs the UI, stated here once.** It blocks inline
// `<style>` elements *and* inline `style` attributes, which rules out three
// things the web code would otherwise reach for, and which cost real time to
// rediscover (spec #93 phase 4):
//
//   1. shadcn/Radix's `scroll-area`, which injects a `<style>` element on
//      mount. Blocking it broke the whole app, since first-run renders the
//      directory browser. Use plain `overflow-y-auto` containers.
//   2. Per-token `style={{ color }}` for syntax highlighting. The server sends
//      a token's semantic *kind* and the stylesheet owns the colours.
//   3. Any computed `style={{ … }}` at all, e.g. a runtime grid-column count.
//
// This is not weakened to make styling easier: the server renders agent output
// and is reachable over Tailscale. Code that trips over it cites this comment
// rather than restating the reasoning.
const CONTENT_SECURITY_POLICY =
  "default-src 'self'; connect-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; font-src 'self'; object-src 'none'; base-uri 'self'";

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
    res.setHeader("Content-Security-Policy", CONTENT_SECURITY_POLICY);

    let requestPath: string;
    try {
      requestPath = decodeURIComponent((req.url ?? "/").split("?")[0] ?? "/");
    } catch {
      // decodeURIComponent throws URIError on a malformed percent-escape
      // (e.g. a bare "%"). Uncaught, this took down the whole server
      // process, not just the one request.
      res.writeHead(400).end("Bad request");
      return;
    }
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
