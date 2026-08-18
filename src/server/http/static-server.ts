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
// **What `style-src` costs the UI, stated here once — measured, not reasoned
// about.** The boundary is not "inline styles"; it is *how* the style reaches
// the element. Probed in a real browser under this exact policy (argusde#124,
// correcting a wrong account written during argusde#113):
//
//   | Mechanism                                    | Under `style-src 'self'` |
//   |----------------------------------------------|--------------------------|
//   | React's `style={{ … }}` prop (CSSOM)          | allowed                  |
//   | `element.style.foo = …` (CSSOM)               | allowed                  |
//   | `element.setAttribute("style", …)`            | **blocked**              |
//   | a `style="…"` attribute parsed from markup    | **blocked**              |
//   | a `<style>` element with no nonce             | **blocked**              |
//   | a `<style>` element carrying this nonce       | allowed                  |
//
// The nonce is what makes the last row work, and it is why Radix's overlays
// function at all: they lock body scroll through `react-remove-scroll`, which
// stamps the nonce onto the element it injects. Without it a dialog *opens*
// but leaves the page scrolling behind it, plus a console violation the
// audit's zero-console-errors gate fails on.
//
// What this does and does not rule out:
//
//   * `scroll-area` is blocked **by default**, but not inherently: Radix
//     renders a `<style>` element for it and accepts a `nonce` prop to stamp,
//     which it simply isn't given today. The plain `overflow-y-auto`
//     containers elsewhere in this app predate that understanding and are
//     kept because they work, not because a nonce could not fix them.
//   * Computed `style={{ … }}` from React is **fine**. The syntax highlighter
//     still sends semantic token *kinds* rather than colours, but for the
//     reason stated in CLAUDE.md — colour belongs in the theme's variables —
//     and not because the CSP forbids it.
//   * Anything that reaches for `setAttribute("style", …)`, or that injects
//     markup carrying a style attribute, is genuinely out.
//
// A nonce is only worth anything if it is unguessable and per-response, which
// is why it is generated here per request rather than baked into the built
// HTML, and why HTML is served `no-store`: a cached document would carry a
// nonce that no later response header matches, and its overlays would break in
// exactly the way this exists to prevent.
//
// This is not weakened to 'unsafe-inline': the server renders agent output and
// is reachable over Tailscale. Code that trips over it cites this comment
// rather than restating the reasoning.
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
