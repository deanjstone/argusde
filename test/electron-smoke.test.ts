import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { EventStore } from "../src/server/persistence/event-store.js";
import { CheckpointStore } from "../src/server/checkpoint/checkpoint-store.js";
import { AcpSession } from "../src/utility/acp-session.js";
import { spawnAgentProcessTransport } from "../src/utility/spawn-agent-process.js";
import { startWsServer, type WsServerHandle } from "../src/server/ws/ws-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const fixtureCliPath = path.join(projectRoot, "test/fixtures/fake-agent-cli.mjs");
const webDistDir = path.join(projectRoot, "dist/web");

/**
 * Electron's own smoke coverage, post-cutover: prove the app correctly
 * loads whatever the configured server serves. It deliberately does NOT
 * re-drive a full chat round trip — that's already covered by
 * test/web-smoke.test.ts against a plain browser, and this UI has nothing
 * Electron-specific about it (it's the same page either way). This test's
 * job is narrower: does Electron's BrowserWindow actually show the shared
 * UI, not a blank page or the old bundled renderer.
 *
 * Requires a display (real or Xvfb) — same requirement as the smoke test
 * this replaces.
 */
describe("electron smoke: loads the server-served shared UI", () => {
  let repoDir: string;
  let dbDir: string;
  let eventStore: EventStore;
  let checkpointStore: CheckpointStore;
  let server: WsServerHandle;
  let app: ElectronApplication;
  let window: Page;

  beforeAll(async () => {
    if (!fs.existsSync(path.join(webDistDir, "index.html"))) {
      throw new Error(`dist/web/index.html not found — run 'pnpm run build' before this test (looked in ${webDistDir})`);
    }

    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-electron-smoke-repo-"));
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "ArgusDE Test"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "file.txt"), "hello\n");
    execFileSync("git", ["add", "-A"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repoDir });

    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-electron-smoke-db-"));
    eventStore = new EventStore(path.join(dbDir, "argusde.sqlite"));
    checkpointStore = new CheckpointStore();

    server = await startWsServer({
      host: "127.0.0.1",
      port: 0,
      eventStore,
      checkpointStore,
      webDistDir,
      createSession: (_threadId, cwd) =>
        new AcpSession({
          name: "argusde-electron-smoke",
          cwd,
          createTransport: () => spawnAgentProcessTransport({ command: process.execPath, args: [fixtureCliPath], cwd }),
        }),
    });

    app = await electron.launch({
      args: [projectRoot, "--no-sandbox", "--disable-gpu"],
      env: { ...process.env, ARGUSDE_SERVER_URL: `http://127.0.0.1:${server.port}/` },
    });
    window = await app.firstWindow();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
    await server?.close();
    eventStore?.close();
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  }, 20_000);

  it(
    "shows the shared web UI's setup screen, not a blank page or the old renderer",
    async () => {
      await window.waitForSelector("text=ArgusDE", { timeout: 15_000 });
      await window.waitForSelector('text=/workspace path/i', { timeout: 15_000 });

      expect(window.url()).toContain(`127.0.0.1:${server.port}`);
      const bodyText = await window.textContent("body");
      expect(bodyText).toContain("Enter a workspace path to start chatting.");
    },
    20_000,
  );
});
