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
  fs.writeFileSync(path.join(rootDir, "index.html"), "<!doctype html><html><body>hi</body></html>");
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
