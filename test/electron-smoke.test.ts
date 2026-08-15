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
 * loads whatever the configured server serves, and that a real chat
 * round trip works inside the real BrowserWindow/preload/contextIsolation
 * stack (not just that a page renders) — a plain-browser test can't catch
 * an Electron-specific regression (e.g. the connect-screen bridge leaking
 * onto the loaded page, or a contextIsolation-specific failure).
 *
 * Requires a display (real or Xvfb) — same requirement as the smoke test
 * this replaces.
 */
describe("electron smoke: loads the server-served shared UI", () => {
  let repoDir: string;
  let dbDir: string;
  let userDataDir: string;
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
    fs.writeFileSync(path.join(repoDir, "notes.txt"), "hello from the electron smoke test\n");
    execFileSync("git", ["add", "-A"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repoDir });

    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-electron-smoke-db-"));
    eventStore = new EventStore(path.join(dbDir, "argusde.sqlite"));
    checkpointStore = new CheckpointStore();

    process.env.ARGUSDE_FAKE_AGENT_STEPS = JSON.stringify([{ type: "message", text: "hello from the electron smoke test" }]);

    // Isolated from the real ~/.config/argusde — this test must never read
    // or write the developer's actual persisted server-URL config.
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-electron-smoke-userdata-"));

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
      args: [projectRoot, "--no-sandbox", "--disable-gpu", `--user-data-dir=${userDataDir}`],
      env: { ...process.env, ARGUSDE_SERVER_URL: `http://127.0.0.1:${server.port}/` },
    });
    window = await app.firstWindow();
  }, 30_000);

  afterAll(async () => {
    delete process.env.ARGUSDE_FAKE_AGENT_STEPS;
    await app?.close();
    await server?.close();
    eventStore?.close();
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }, 20_000);

  it(
    "does not expose the connect-screen's privileged bridge to the server-served page",
    async () => {
      await window.waitForSelector("text=/choose a workspace folder/i", { timeout: 15_000 });

      // window.argusdeConnect (getServerUrl/setServerUrl/retryConnect) must
      // only ever be defined on the locally-bundled connect screen — the
      // preload script attaches to every navigation in this window, so
      // without an explicit guard the remote page would get it too.
      const hasPrivilegedBridge = await window.evaluate(() => "argusdeConnect" in window);
      expect(hasPrivilegedBridge).toBe(false);
    },
    20_000,
  );

  it(
    "drives a real chat round trip inside the real Electron window",
    async () => {
      await window.getByRole("button", { name: /type a path manually/i }).click();
      await window.getByLabel(/workspace path/i).fill(repoDir);
      await window.getByRole("button", { name: /^start$/i }).click();

      await window.waitForSelector('input[placeholder*="Message" i]', { timeout: 15_000 });

      await window.getByPlaceholder(/message/i).fill("what's in notes.txt?");
      await window.getByPlaceholder(/message/i).press("Enter");

      await window.waitForSelector("text=hello from the electron smoke test", { timeout: 15_000 });

      const bodyText = await window.textContent("body");
      expect(bodyText).toContain("what's in notes.txt?");
      expect(bodyText).toContain("hello from the electron smoke test");
    },
    25_000,
  );
});
