import { describe, it, expect, beforeEach, afterEach } from "vitest";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createStaticFileServer } from "./static-server.js";

let rootDir: string;
let server: http.Server;
let baseUrl: string;

beforeEach(async () => {
  rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-static-server-"));
  fs.writeFileSync(
    rootDir + "/index.html",
    '<!doctype html><html><head><meta name="csp-nonce" content="__CSP_NONCE__" /></head><body>hi</body></html>',
  );
  fs.mkdirSync(path.join(rootDir, "assets"));
  fs.writeFileSync(path.join(rootDir, "assets", "app.js"), "console.log('hi');");
  fs.writeFileSync(path.join(rootDir, "assets", "app.css"), "body { color: red; }");

  // A secret file OUTSIDE rootDir, sibling to it — the path-traversal test
  // tries to reach this via "..".
  fs.writeFileSync(path.join(rootDir, "..", "argusde-static-server-secret.txt"), "should never be served");

  const handler = createStaticFileServer(rootDir);
  server = http.createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("expected a bound AddressInfo");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

afterEach(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  fs.rmSync(rootDir, { recursive: true, force: true });
  fs.rmSync(path.join(rootDir, "..", "argusde-static-server-secret.txt"), { force: true });
});

describe("createStaticFileServer", () => {
  it("serves index.html for the root path with the correct content type", async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(await res.text()).toContain("<body>hi</body>");
  });

  /**
   * CSP nonce plumbing (argusde#113). Radix overlays lock body scroll by
   * injecting a <style> element, which `style-src 'self'` blocks outright —
   * measured, not assumed: a real alert-dialog under the old policy opened
   * but left `document.body` at `overflow: visible`, i.e. the page still
   * scrolled behind the dialog, and logged a CSP violation that the audit's
   * zero-console-errors gate would fail on.
   */
  describe("CSP nonce", () => {
    function nonceFrom(html: string): string | undefined {
      return /<meta name="csp-nonce" content="([^"]*)"/.exec(html)?.[1];
    }

    function headerNonce(res: Response): string | undefined {
      return /'nonce-([^']+)'/.exec(res.headers.get("content-security-policy") ?? "")?.[1];
    }

    it("serves an HTML nonce that matches the one in its own CSP header", async () => {
      const res = await fetch(`${baseUrl}/`);
      const html = await res.text();

      const inDocument = nonceFrom(html);
      expect(inDocument).toBeDefined();
      expect(inDocument).not.toBe("__CSP_NONCE__");
      // The whole mechanism is these two agreeing. A mismatch fails silently
      // in the browser — the style is blocked exactly as if there were no
      // nonce at all — so it is asserted here rather than left to be noticed.
      expect(headerNonce(res)).toBe(inDocument);
    });

    it("issues a different nonce on every response — a fixed one is no better than 'unsafe-inline'", async () => {
      const [first, second] = await Promise.all([fetch(`${baseUrl}/`), fetch(`${baseUrl}/`)]);
      const firstNonce = nonceFrom(await first.text());
      const secondNonce = nonceFrom(await second.text());

      expect(firstNonce).toBeDefined();
      expect(secondNonce).toBeDefined();
      expect(firstNonce).not.toBe(secondNonce);
    });

    it("keeps 'self' alongside the nonce, so the app's own linked stylesheet still loads", async () => {
      const res = await fetch(`${baseUrl}/`);
      const policy = res.headers.get("content-security-policy") ?? "";
      expect(policy).toMatch(/style-src 'self' 'nonce-[^']+'/);
    });

    it("never weakens the policy to 'unsafe-inline'", async () => {
      const res = await fetch(`${baseUrl}/`);
      expect(res.headers.get("content-security-policy")).not.toContain("unsafe-inline");
    });

    it("tells caches not to store the HTML — a cached page would carry a nonce its response header no longer matches", async () => {
      const res = await fetch(`${baseUrl}/`);
      expect(res.headers.get("cache-control")).toMatch(/no-store/);
    });

    it("leaves non-HTML responses alone, placeholder or not", async () => {
      fs.writeFileSync(path.join(rootDir, "assets", "literal.js"), 'const marker = "__CSP_NONCE__";');

      const res = await fetch(`${baseUrl}/assets/literal.js`);
      // A JS asset that merely contains the placeholder text must not be
      // rewritten: only the served document carries the nonce.
      expect(await res.text()).toContain("__CSP_NONCE__");
    });

    it("still carries a CSP header on a response that has no document to put a nonce in", async () => {
      const res = await fetch(`${baseUrl}/assets/app.js`);
      expect(res.headers.get("content-security-policy")).toContain("script-src 'self'");
    });
  });

  it("serves a nested asset with the correct content type", async () => {
    const jsRes = await fetch(`${baseUrl}/assets/app.js`);
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get("content-type")).toMatch(/javascript/);
    expect(await jsRes.text()).toBe("console.log('hi');");

    const cssRes = await fetch(`${baseUrl}/assets/app.css`);
    expect(cssRes.status).toBe(200);
    expect(cssRes.headers.get("content-type")).toMatch(/text\/css/);
  });

  it("serves manifest.json and sw.js with the content types a PWA install/registration check expects", async () => {
    fs.writeFileSync(path.join(rootDir, "manifest.json"), JSON.stringify({ name: "ArgusDE" }));
    fs.writeFileSync(path.join(rootDir, "sw.js"), "self.addEventListener('fetch', () => {});");

    const manifestRes = await fetch(`${baseUrl}/manifest.json`);
    expect(manifestRes.status).toBe(200);
    expect(manifestRes.headers.get("content-type")).toMatch(/application\/json/);

    const swRes = await fetch(`${baseUrl}/sw.js`);
    expect(swRes.status).toBe(200);
    expect(swRes.headers.get("content-type")).toMatch(/javascript/);
  });

  it("sends a Content-Security-Policy header on served content", async () => {
    const res = await fetch(`${baseUrl}/`);
    const csp = res.headers.get("content-security-policy");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self'");
  });

  it("sends the Content-Security-Policy header on error responses too", async () => {
    const res = await fetch(`${baseUrl}/does-not-exist.js`);
    expect(res.status).toBe(404);
    expect(res.headers.get("content-security-policy")).toContain("default-src 'self'");
  });

  it("returns 404 for a missing file", async () => {
    const res = await fetch(`${baseUrl}/does-not-exist.js`);
    expect(res.status).toBe(404);
  });

  it("refuses to serve a file outside the root directory via path traversal", async () => {
    const res = await fetch(`${baseUrl}/../argusde-static-server-secret.txt`);
    // fetch normalizes ".." itself before the request is even sent in most
    // environments, so also try a raw request the client can't normalize.
    expect([403, 404]).toContain(res.status);

    const raw = await new Promise<number>((resolve, reject) => {
      const req = http.request(
        { host: "127.0.0.1", port: new URL(baseUrl).port, path: "/%2e%2e/argusde-static-server-secret.txt" },
        (r) => {
          r.resume();
          resolve(r.statusCode ?? 0);
        },
      );
      req.on("error", reject);
      req.end();
    });
    expect([403, 404]).toContain(raw);
  });

  it("responds 400 instead of crashing the server on a malformed percent-encoded URL", async () => {
    const raw = await new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port: new URL(baseUrl).port, path: "/%" }, (r) => {
        r.resume();
        resolve(r.statusCode ?? 0);
      });
      req.on("error", reject);
      req.end();
    });
    expect(raw).toBe(400);

    // The server itself must still be alive and responsive afterward.
    const followUp = await fetch(`${baseUrl}/`);
    expect(followUp.status).toBe(200);
  });
});
