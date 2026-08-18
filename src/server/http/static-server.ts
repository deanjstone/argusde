import { randomBytes } from "node:crypto";
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
// **What `style-src` costs the UI, stated here once.** The distinction that
// matters, and that cost real time to establish (spec #93 phase 4, then
// argusde#113 — both measured in a real browser, not reasoned about):
//
//   * An injected `<style>` **element** can carry a nonce, and does. This is
//     how Radix's overlays lock body scroll (`react-remove-scroll` →
//     `react-style-singleton`), so dialog, alert-dialog, popover, select,
//     dropdown-menu, tooltip, drawer and sheet all work. Without the nonce
//     they *degrade rather than fail*: the dialog opens, but `document.body`
//     stays at `overflow: visible` so the page scrolls behind it, plus a
//     console violation the audit's zero-console-errors gate fails on.
//
//   * An inline `style` **attribute** cannot. A nonce applies to elements,
//     never to attributes — only 'unsafe-inline' (or 'unsafe-hashes') would
//     cover one, and neither is on the table. So these stay ruled out:
//
//       1. shadcn/Radix's `scroll-area`, which styles its viewport through a
//          style attribute. Re-tested under the nonce and **still blocked** —
//          it is not an overlay and does not benefit. Blocking it broke the
//          whole app in phase 4, since first-run renders the directory
//          browser. Use plain `overflow-y-auto` containers.
//       2. Per-token `style={{ color }}` for syntax highlighting. The server
//          sends a token's semantic *kind* and the stylesheet owns the colours.
//       3. Any computed `style={{ … }}` at all, e.g. a runtime grid-column
//          count.
//
// A nonce is only worth anything if it is unguessable and per-response, which
// is why it is generated here per request rather than baked into the built
// HTML, and why HTML is served `no-store`: a cached document would carry a
// nonce that no later response header matches, and its overlays would break in
// exactly the way this exists to prevent.
//
// This is not weakened to 'unsafe-inline' to make styling easier: the server
// renders agent output and is reachable over Tailscale. Code that trips over
// it cites this comment rather than restating the reasoning.
//
// The placeholder below lives in src/web/index.html and is replaced on the way
// out. Vite copies it through the build untouched.
const NONCE_PLACEHOLDER = "__CSP_NONCE__";

function contentSecurityPolicy(nonce: string): string {
  return [
    "default-src 'self'",
    "connect-src 'self'",
    "img-src 'self' data:",
    // 'self' stays: a nonce does not invalidate host sources for styles the
    // way 'strict-dynamic' does for scripts, and the app's own built
    // stylesheet is a plain <link>.
    `style-src 'self' 'nonce-${nonce}'`,
    "script-src 'self'",
    "font-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
  ].join("; ");
}

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
    // 128 bits, base64 — the CSP spec's own floor is 128 bits of entropy.
    const nonce = randomBytes(16).toString("base64");
    res.setHeader("Content-Security-Policy", contentSecurityPolicy(nonce));

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

      // Only the document gets the nonce written into it. A script or a
      // stylesheet that happens to contain the placeholder text is left
      // exactly as it is — rewriting an asset would be a content-injection
      // path, not a feature.
      if (path.extname(resolvedPath) === ".html") {
        const html = data.toString("utf8").split(NONCE_PLACEHOLDER).join(nonce);
        res
          .writeHead(200, {
            "Content-Type": contentType,
            // Per-response nonce: a stored copy would carry one that no
            // later response header matches.
            "Cache-Control": "no-store",
          })
          .end(html);
        return;
      }

      res.writeHead(200, { "Content-Type": contentType }).end(data);
    });
  };
}
