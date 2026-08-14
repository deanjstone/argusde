import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
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
 * The primary end-to-end seam per spec #33's testing decision: a real
 * server (real SQLite, real checkpoint git plumbing, real subprocess-
 * spawned agent transport) plus a real browser context — not an Electron
 * launch, since this UI has nothing to do with Electron (that's Phase 2b).
 * Requires `pnpm run build:web` to have already produced dist/web, and a
 * display (real or Xvfb) for the browser — same requirement as the
 * existing Electron smoke test.
 */
describe("web smoke: server + browser round trip", () => {
  let repoDir: string;
  let dbDir: string;
  let eventStore: EventStore;
  let checkpointStore: CheckpointStore;
  let server: WsServerHandle;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    if (!fs.existsSync(path.join(webDistDir, "index.html"))) {
      throw new Error(`dist/web/index.html not found — run 'pnpm run build:web' before this test (looked in ${webDistDir})`);
    }

    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-web-smoke-repo-"));
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "ArgusDE Test"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "notes.txt"), "hello from the web smoke test\n");
    execFileSync("git", ["add", "-A"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repoDir });

    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-web-smoke-db-"));
    eventStore = new EventStore(path.join(dbDir, "argusde.sqlite"));
    checkpointStore = new CheckpointStore();

    process.env.ARGUSDE_FAKE_AGENT_STEPS = JSON.stringify([{ type: "message", text: "Hello from the web smoke test agent" }]);
    process.env.ARGUSDE_FAKE_AGENT_MODES = JSON.stringify({
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Default" },
        { id: "plan", name: "Plan" },
      ],
    });

    server = await startWsServer({
      host: "127.0.0.1",
      port: 0,
      eventStore,
      checkpointStore,
      webDistDir,
      createSession: (_threadId, cwd) =>
        new AcpSession({
          name: "argusde-web-smoke",
          cwd,
          createTransport: () => spawnAgentProcessTransport({ command: process.execPath, args: [fixtureCliPath], cwd }),
        }),
    });

    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  }, 30_000);

  afterAll(async () => {
    delete process.env.ARGUSDE_FAKE_AGENT_STEPS;
    delete process.env.ARGUSDE_FAKE_AGENT_MODES;
    await browser?.close();
    await server?.close();
    eventStore?.close();
    fs.rmSync(repoDir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  }, 20_000);

  it(
    "loads the served UI, completes first-run setup, and shows a streamed reply from a real message round trip",
    async () => {
      await page.goto(`http://127.0.0.1:${server.port}/`);

      await page.getByLabel(/workspace path/i).fill(repoDir);
      await page.getByRole("button", { name: /start/i }).click();

      await page.waitForSelector('input[placeholder*="Message" i]', { timeout: 15_000 });

      await page.getByPlaceholder(/message/i).fill("what's in notes.txt?");
      await page.getByPlaceholder(/message/i).press("Enter");

      await page.waitForSelector("text=Hello from the web smoke test agent", { timeout: 15_000 });

      const bodyText = await page.textContent("body");
      expect(bodyText).toContain("what's in notes.txt?");
      expect(bodyText).toContain("Hello from the web smoke test agent");
    },
    30_000,
  );

  it(
    "shows a real checkpoint diff after a second turn changes a file on disk",
    async () => {
      // A real filesystem change between turns (not through the fixture
      // agent, which only streams text) — proves the diff panel renders a
      // real `git diff`, not a placeholder.
      fs.writeFileSync(path.join(repoDir, "notes.txt"), "hello from the web smoke test\nand a second line\n");

      await page.getByPlaceholder(/message/i).fill("anything else?");
      await page.getByPlaceholder(/message/i).press("Enter");

      await page.waitForSelector('button:has-text("Turn 2")', { timeout: 15_000 });
      await page.getByRole("button", { name: "Turn 2" }).click();

      await page.waitForSelector("text=and a second line", { timeout: 10_000 });
      const diffText = await page.textContent("body");
      expect(diffText).toContain("notes.txt");
      expect(diffText).toContain("and a second line");
    },
    30_000,
  );

  it(
    "shows the agent's mode catalog and switches modes via a real session/set_mode round trip",
    async () => {
      const modeSwitcher = page.getByRole("combobox", { name: /agent mode/i });
      await modeSwitcher.waitFor({ timeout: 10_000 });
      expect(await modeSwitcher.inputValue()).toBe("default");

      await modeSwitcher.selectOption("plan");

      // The fixture agent's session.setMode handler notifies a real
      // current_mode_update — waiting for the select's own value to update
      // proves that round trip actually happened, not just an optimistic UI change.
      await expect
        .poll(async () => modeSwitcher.inputValue(), { timeout: 10_000 })
        .toBe("plan");
    },
    20_000,
  );
});
