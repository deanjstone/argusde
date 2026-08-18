import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import { WebSocketServer } from "ws";
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
import { API_VERSION, WS_PATH } from "../src/shared/ws-protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");
const fixtureCliPath = path.join(projectRoot, "test/fixtures/fake-agent-cli.mjs");
const webDistDir = path.join(projectRoot, "dist/web");

/**
 * The other half of Electron's cutover coverage (see electron-smoke.test.ts
 * for "loads a working server"): when no server is reachable, the app must
 * show the native connect screen (spec #33 decision #5) instead of a blank
 * or broken page. Points at a real closed TCP port (nothing listens on it
 * on a CI/dev box) rather than a mock — same "real over mocked" bias as
 * the rest of this repo's tests.
 *
 * Requires a display (real or Xvfb).
 */
describe("electron: shows the connect screen when no server is reachable", () => {
  let app: ElectronApplication;
  let window: Page;
  let userDataDir: string;

  beforeAll(async () => {
    userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-connect-screen-userdata-"));
    app = await electron.launch({
      args: [projectRoot, "--no-sandbox", "--disable-gpu", `--user-data-dir=${userDataDir}`],
      // Port 59999 is outside Chromium's restricted-ports list and nothing
      // in this test suite ever listens on it — a real connection refusal,
      // not a mock.
      env: { ...process.env, ARGUSDE_SERVER_URL: "http://127.0.0.1:59999/" },
    });
    window = await app.firstWindow();
  }, 20_000);

  afterAll(async () => {
    await app?.close();
    fs.rmSync(userDataDir, { recursive: true, force: true });
  }, 10_000);

  it(
    "renders the connect screen with a server-URL field and a Connect button",
    async () => {
      await window.waitForSelector("text=ArgusDE", { timeout: 15_000 });
      await window.waitForSelector("text=/not connected/i", { timeout: 15_000 });

      expect(window.url()).toContain("connect-screen");
      const urlInput = await window.$('input[name="server-url"]');
      expect(urlInput).not.toBeNull();
      await window.waitForSelector('button:has-text("Connect")', { timeout: 5_000 });

      // The field should already be prefilled with the URL that failed.
      const value = await urlInput?.inputValue();
      expect(value).toBe("http://127.0.0.1:59999/");
    },
    20_000,
  );

  it(
    "exposes the privileged bridge on the connect screen itself (the complement of electron-smoke's 'not exposed on the remote page' check)",
    async () => {
      const hasBridge = await window.evaluate(() => "argusdeConnect" in window);
      expect(hasBridge).toBe(true);
    },
    10_000,
  );

  it(
    "does not persist a server URL that failed to connect, only one that actually succeeded",
    async () => {
      expect(fs.existsSync(path.join(userDataDir, "config.json"))).toBe(false);

      // Still-unreachable — this Connect attempt must not persist anything.
      await window.fill('input[name="server-url"]', "http://127.0.0.1:59998/");
      await window.click('button:has-text("Connect")');
      await window.waitForTimeout(1000);
      expect(fs.existsSync(path.join(userDataDir, "config.json"))).toBe(false);

      // Now point it at a real, working server.
      const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-connect-screen-repo-"));
      execFileSync("git", ["init", "--initial-branch=main"], { cwd: repoDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
      execFileSync("git", ["config", "user.name", "ArgusDE Test"], { cwd: repoDir });

      const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-connect-screen-db-"));
      const eventStore = new EventStore(path.join(dbDir, "argusde.sqlite"));
      const checkpointStore = new CheckpointStore();
      let server: WsServerHandle | undefined;

      try {
        server = await startWsServer({
          host: "127.0.0.1",
          port: 0,
          eventStore,
          checkpointStore,
          webDistDir,
          createSession: (_threadId, cwd) =>
            new AcpSession({
              name: "argusde-connect-screen-test",
              cwd,
              createTransport: () => spawnAgentProcessTransport({ command: process.execPath, args: [fixtureCliPath], cwd }),
            }),
        });

        // Deliberately without a trailing slash: Chromium commits the
        // normalised "…:PORT/" form, so a raw string comparison against what
        // the user typed would refuse to persist a URL that plainly worked.
        const typedUrl = `http://127.0.0.1:${server.port}`;
        await window.fill('input[name="server-url"]', typedUrl);
        await window.click('button:has-text("Connect")');

        await window.waitForSelector("text=/choose a workspace folder/i", { timeout: 15_000 });
        expect(fs.existsSync(path.join(userDataDir, "config.json"))).toBe(true);
        const persisted = JSON.parse(fs.readFileSync(path.join(userDataDir, "config.json"), "utf8"));
        expect(persisted.serverUrl).toBe(typedUrl);
      } finally {
        await server?.close();
        eventStore.close();
        fs.rmSync(repoDir, { recursive: true, force: true });
        fs.rmSync(dbDir, { recursive: true, force: true });
      }
    },
    25_000,
  );

  it(
    "shows a version-incompatibility message, naming both versions, instead of loading a server whose API version doesn't match",
    async () => {
      // A dedicated app instance, pointed at the mismatched-version server
      // from Electron's own startup (ARGUSDE_SERVER_URL) — the shared
      // app/window from beforeAll has already moved past the connect
      // screen in an earlier test, so it can't be reused to re-drive the
      // connect form here.
      const mismatchedVersion = `${API_VERSION}-incompatible-test`;
      const wss = new WebSocketServer({ host: "127.0.0.1", port: 0, path: WS_PATH });
      await new Promise<void>((resolve) => wss.once("listening", resolve));
      wss.on("connection", (client) => {
        client.send(JSON.stringify({ type: "server.welcome", apiVersion: mismatchedVersion }));
      });

      const mismatchUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-version-mismatch-userdata-"));
      let mismatchApp: ElectronApplication | undefined;
      try {
        const address = wss.address();
        const port = typeof address === "string" ? 0 : address!.port;

        mismatchApp = await electron.launch({
          args: [projectRoot, "--no-sandbox", "--disable-gpu", `--user-data-dir=${mismatchUserDataDir}`],
          env: { ...process.env, ARGUSDE_SERVER_URL: `http://127.0.0.1:${port}/` },
        });
        const mismatchWindow = await mismatchApp.firstWindow();

        await mismatchWindow.waitForSelector(`text=${mismatchedVersion}`, { timeout: 15_000 });
        const bodyText = await mismatchWindow.textContent("body");
        expect(bodyText).toContain(API_VERSION);
        expect(bodyText).toContain(mismatchedVersion);
        expect(bodyText).toMatch(/update ArgusDE/i);
      } finally {
        await mismatchApp?.close();
        wss.close();
        fs.rmSync(mismatchUserDataDir, { recursive: true, force: true });
      }
    },
    25_000,
  );

  it(
    "names the URL that failed, including one Electron can't even parse",
    async () => {
      // Electron reports an empty validatedURL for a malformed address, so
      // interpolating it straight into the message produced "Couldn't reach
      // : ERR_INVALID_URL" — the one detail the user needs to spot their own
      // typo, missing.
      const malformedUserDataDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-malformed-url-userdata-"));
      let malformedApp: ElectronApplication | undefined;
      try {
        malformedApp = await electron.launch({
          args: [projectRoot, "--no-sandbox", "--disable-gpu", `--user-data-dir=${malformedUserDataDir}`],
          env: { ...process.env, ARGUSDE_SERVER_URL: "definitely-not-a-url" },
        });
        const malformedWindow = await malformedApp.firstWindow();

        await malformedWindow.waitForFunction(
          () => (document.querySelector("#error")?.textContent ?? "").trim().length > 0,
          undefined,
          { timeout: 15_000 },
        );
        const errorText = (await malformedWindow.textContent("#error"))?.trim() ?? "";

        expect(errorText).toContain("definitely-not-a-url");
        expect(errorText).not.toMatch(/reach\s*:/);
      } finally {
        await malformedApp?.close();
        fs.rmSync(malformedUserDataDir, { recursive: true, force: true });
      }
    },
    25_000,
  );
});
