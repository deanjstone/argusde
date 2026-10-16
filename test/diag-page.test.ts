import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, devices, type Browser, type BrowserContext, type Page } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import WebSocket from "ws";
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
 * The terminal diagnostics page (argusde#146) the owner opens on the iPhone
 * for the #133 device pass. It has to tell apart the three failures #133
 * names, so each one is reproduced here by dropping the relevant frames in
 * the browser's WebSocket rather than asserted from reading the page's code.
 * The phone itself is the owner's step; this is iPhone emulation in Chromium.
 */
describe("diag.html: terminal diagnostics page", () => {
  let repoDir: string;
  let dbDir: string;
  let eventStore: EventStore;
  let server: WsServerHandle;
  let browser: Browser;

  async function seedProjectAndThread(): Promise<void> {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
    await new Promise((resolve, reject) => {
      socket.once("open", resolve);
      socket.once("error", reject);
    });
    const send = (command: Record<string, unknown>) =>
      new Promise<Record<string, unknown>>((resolve) => {
        const onMessage = (raw: WebSocket.RawData) => {
          const push = JSON.parse(raw.toString());
          if (push.type === "command.result" && push.commandId === command.commandId) {
            socket.off("message", onMessage);
            resolve(push);
          }
        };
        socket.on("message", onMessage);
        socket.send(JSON.stringify(command));
      });
    const project = await send({ type: "project.create", commandId: "seed-1", workspaceRoot: repoDir, title: "Diag Project" });
    const projectId = (project.result as { projectId: string }).projectId;
    await send({ type: "thread.create", commandId: "seed-2", projectId, title: "Diag Thread" });
    socket.close();
  }

  async function openDiag(context: BrowserContext, query = ""): Promise<{ page: Page; consoleErrors: string[] }> {
    const page = await context.newPage();
    const consoleErrors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => consoleErrors.push(`pageerror: ${error.message}`));
    await page.goto(`http://127.0.0.1:${server.port}/diag.html${query}`);
    await expect.poll(() => page.textContent("#summary"), { timeout: 10_000 }).toMatch(/connected — apiVersion \d+\.\d+\.\d+/);
    return { page, consoleErrors };
  }

  async function runCheck(page: Page): Promise<{ verdict: string | null; log: string }> {
    await page.getByRole("button", { name: "Run terminal check" }).tap();
    await page.waitForSelector("#verdict[data-verdict]:not([data-verdict=''])", { timeout: 20_000 });
    return {
      verdict: await page.getAttribute("#verdict", "data-verdict"),
      log: (await page.textContent("#log")) ?? "",
    };
  }

  const iPhone = () => browser.newContext({ ...devices["iPhone 13"] });

  beforeAll(async () => {
    if (!fs.existsSync(path.join(webDistDir, "diag.html"))) {
      throw new Error(`dist/web/diag.html not found — run 'pnpm run build:web' before this test (looked in ${webDistDir})`);
    }

    repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-diag-repo-"));
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: repoDir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir });
    execFileSync("git", ["config", "user.name", "ArgusDE Test"], { cwd: repoDir });
    fs.writeFileSync(path.join(repoDir, "notes.txt"), "hello\n");
    execFileSync("git", ["add", "-A"], { cwd: repoDir });
    execFileSync("git", ["commit", "-m", "initial commit"], { cwd: repoDir });

    dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-diag-db-"));
    eventStore = new EventStore(path.join(dbDir, "argusde.sqlite"));

    server = await startWsServer({
      host: "127.0.0.1",
      port: 0,
      eventStore,
      checkpointStore: new CheckpointStore(),
      webDistDir,
      createSession: (_threadId, cwd) =>
        new AcpSession({
          name: "argusde-diag",
          cwd,
          createTransport: () => spawnAgentProcessTransport({ command: process.execPath, args: [fixtureCliPath], cwd }),
        }),
    });
    await seedProjectAndThread();

    browser = await chromium.launch();
  }, 30_000);

  afterAll(async () => {
    await browser?.close();
    await server?.close();
    eventStore?.close();
    if (repoDir) fs.rmSync(repoDir, { recursive: true, force: true });
    if (dbDir) fs.rmSync(dbDir, { recursive: true, force: true });
  }, 20_000);

  it(
    "loads under the app's CSP with no console errors and reports the device it is running on",
    async () => {
      const context = await iPhone();
      try {
        const response = await context.request.get(`http://127.0.0.1:${server.port}/diag.html`);
        expect(response.ok()).toBe(true);
        expect(response.headers()["content-security-policy"]).toContain("script-src 'self'");
        const html = await response.text();
        expect(html).not.toMatch(/<script(?![^>]*\ssrc=)[^>]*>/);
        expect(html).not.toMatch(/\sstyle=/);

        const { page, consoleErrors } = await openDiag(context);
        const log = (await page.textContent("#log")) ?? "";
        expect(log).toContain("iPhone");
        expect(log).toMatch(/maxTouchPoints=[1-9]/);
        expect(consoleErrors).toEqual([]);
      } finally {
        await context.close();
      }
    },
    30_000,
  );

  it(
    "walks project.list → thread.list → terminal.open → terminal.input and reports output coming back",
    async () => {
      const context = await iPhone();
      try {
        const { page, consoleErrors } = await openDiag(context);
        const { verdict, log } = await runCheck(page);

        expect(log).toMatch(/projects: 1/);
        expect(log).toMatch(/using thread [0-9a-f]{8} in Diag Project/);
        expect(log).toMatch(/terminal\.open OK/);
        expect(log).toMatch(/terminal\.input OK/);
        expect(log).toMatch(/PUSH terminal\.output .*DIAG_FROM_PHONE/);
        expect(verdict).toBe("ok");
        expect(await page.textContent("#verdict")).toMatch(/output came back/);
        expect(consoleErrors).toEqual([]);
      } finally {
        await context.close();
      }
    },
    40_000,
  );

  it(
    "says the input never got an answer when terminal.input does not reach the server (#133 case 1)",
    async () => {
      const context = await iPhone();
      try {
        await context.routeWebSocket(/\/ws$/, (ws) => {
          const upstream = ws.connectToServer();
          ws.onMessage((message) => {
            if (typeof message === "string" && message.includes('"terminal.input"')) return;
            upstream.send(message);
          });
        });
        const { page } = await openDiag(context, "?timeoutMs=1500");
        const { verdict } = await runCheck(page);

        expect(verdict).toBe("input-unanswered");
        expect(await page.textContent("#verdict")).toMatch(/terminal\.input got no reply/);
      } finally {
        await context.close();
      }
    },
    40_000,
  );

  it(
    "says the shell ran the input but the output push never arrived (#133 case 3)",
    async () => {
      const context = await iPhone();
      try {
        await context.routeWebSocket(/\/ws$/, (ws) => {
          const upstream = ws.connectToServer();
          upstream.onMessage((message) => {
            if (typeof message === "string" && message.includes('"terminal.output"')) return;
            ws.send(message);
          });
        });
        const { page } = await openDiag(context);
        const { verdict, log } = await runCheck(page);

        expect(log).not.toMatch(/PUSH terminal\.output/);
        expect(verdict).toBe("output-not-pushed");
        expect(await page.textContent("#verdict")).toMatch(/push never arrived/);
      } finally {
        await context.close();
      }
    },
    40_000,
  );

  it(
    "records what the soft keyboard sends in the keyboard probe",
    async () => {
      const context = await iPhone();
      try {
        const { page } = await openDiag(context);
        await page.locator("#probe").tap();
        await page.keyboard.type("abc");
        const summary = (await page.textContent("#keysummary")) ?? "";
        expect(summary).toContain('insertText:"a"');
        expect(summary).toContain('insertText:"c"');
        expect(summary).toMatch(/keydown codes: \[65,66,67\]/);
      } finally {
        await context.close();
      }
    },
    30_000,
  );
});
