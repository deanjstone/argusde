import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import zlib from "node:zlib";
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
    // The real claude-agent-acp advertises `{ image: true, embeddedContext:
    // true }` (verified against v0.57.0), so the fixture does too — otherwise
    // the composer correctly hides its attach control and the attachment
    // tests below would be asserting against a surface that isn't there.
    process.env.ARGUSDE_FAKE_AGENT_PROMPT_CAPABILITIES = JSON.stringify({ image: true, embeddedContext: true });
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
    delete process.env.ARGUSDE_FAKE_AGENT_PROMPT_CAPABILITIES;
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

      await page.getByRole("button", { name: /type a path manually/i }).click();
      await page.getByLabel(/workspace path/i).fill(repoDir);
      await page.getByRole("button", { name: /^start$/i }).click();

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
    "completes first-run setup by browsing the server's real filesystem, not typing a path",
    async () => {
      // A real subfolder of the server's actual home directory — the
      // DirectoryBrowser's initial listing (no path given) is the server's
      // homedir, so this is created there specifically so the test can
      // click into it by name, proving a real navigate-into-a-subdirectory
      // round trip through the real fs.list-directory WS command, not a
      // mock. Uniquely named and always removed in `finally`.
      const browseDir = fs.mkdtempSync(path.join(os.homedir(), "argusde-web-smoke-browse-"));
      const browseTargetDir = path.join(browseDir, "target-project");
      fs.mkdirSync(browseTargetDir);
      execFileSync("git", ["init", "--initial-branch=main"], { cwd: browseTargetDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: browseTargetDir });
      execFileSync("git", ["config", "user.name", "ArgusDE Test"], { cwd: browseTargetDir });
      fs.writeFileSync(path.join(browseTargetDir, "file.txt"), "hello\n");
      execFileSync("git", ["add", "-A"], { cwd: browseTargetDir });
      execFileSync("git", ["commit", "-m", "initial commit"], { cwd: browseTargetDir });

      const browseDirName = path.basename(browseDir);
      const browsePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        await browsePage.goto(`http://127.0.0.1:${server.port}/`);

        // Default view is the browser (homedir listing), not a text input.
        await browsePage.getByRole("button", { name: browseDirName }).click();
        await browsePage.getByRole("button", { name: "target-project" }).click();

        // Nothing but files inside target-project — the browser still
        // lets you select the directory you're currently in.
        await browsePage.waitForSelector("text=/no subfolders here/i", { timeout: 10_000 });
        await browsePage.getByRole("button", { name: /select this folder/i }).click();

        await browsePage.waitForSelector('input[placeholder*="Message" i]', { timeout: 15_000 });

        const project = eventStore.getProjectByWorkspaceRoot(browseTargetDir);
        expect(project?.workspaceRoot).toBe(browseTargetDir);
      } finally {
        await browsePage.close();
        fs.rmSync(browseDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "is installable as a PWA — a valid manifest is linked and reachable, and the service worker actually activates",
    async () => {
      const manifestHref = await page.evaluate(
        () => document.querySelector<HTMLLinkElement>('link[rel="manifest"]')?.href,
      );
      expect(manifestHref).toBeTruthy();

      const manifestRes = await page.request.get(manifestHref!);
      expect(manifestRes.ok()).toBe(true);
      const manifest = await manifestRes.json();
      expect(manifest.name).toBe("ArgusDE");
      expect(manifest.display).toBe("standalone");
      expect(Array.isArray(manifest.icons)).toBe(true);
      expect(manifest.icons.length).toBeGreaterThan(0);

      // Confirms main.tsx's registration call not only resolved but the
      // worker actually reached the "active" state in a real browser
      // engine — not just that the API exists.
      const swActive = await page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        return registration.active?.state === "activated";
      });
      expect(swActive).toBe(true);
    },
    20_000,
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
    "reverts a real checkpoint via the UI, actually rewriting the file on disk",
    async () => {
      // Turn 1 predates the "and a second line" edit from the previous test
      // — reverting to it is a real, observable change, not a no-op.
      await page.getByRole("button", { name: "Turn 1" }).click();
      await page.waitForSelector("text=/revert/i", { timeout: 10_000 });

      await page.getByRole("button", { name: /revert to this checkpoint/i }).click();

      // handleRevertCheckpoint closes the whole diff panel (DiffView
      // unmounts) on success — waiting for its always-present Close button
      // to disappear (rather than a fixed sleep) proves the round trip
      // actually completed, not just that the click registered. Using its
      // aria-label ("Close diff") rather than a "revert" text match — the
      // checkpoint strip's own new "reverted to turn 1" badge (asserted
      // below) also contains "revert" and its parent button's accessible
      // name would otherwise match too, since it's nested text.
      await page.getByRole("button", { name: "Close diff" }).waitFor({ state: "detached", timeout: 15_000 });

      expect(fs.readFileSync(path.join(repoDir, "notes.txt"), "utf8")).toBe("hello from the web smoke test\n");

      // Two new checkpoints land from one revert: an unmarked safety
      // snapshot of whatever was about to be overwritten (Turn 3), then
      // the actual restored state (Turn 4, marked) — nothing is ever
      // silently discarded.
      await page.waitForSelector('button:has-text("Turn 4")', { timeout: 10_000 });
      const turn4Text = await page.getByRole("button", { name: /turn 4/i }).textContent();
      expect(turn4Text).toMatch(/reverted to turn 1/i);
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

      // The fixture agent's session.setMode handler sends no notification
      // (matching the real claude-agent-acp) — waiting for the select's own
      // value to update proves AcpSession's synthesized mode-changed
      // confirmation made the real WS round trip, not just an optimistic
      // client-side change with nothing behind it.
      await expect
        .poll(async () => modeSwitcher.inputValue(), { timeout: 10_000 })
        .toBe("plan");
    },
    20_000,
  );

  it(
    "promotes a fresh thread to a worktree and a real file edit lands there, not in the main repo",
    async () => {
      // A separate page + a separate repo — the shared page/repoDir above
      // already has two turns' worth of history by this point in the file,
      // and promotion is only available before the first message is sent.
      const worktreeTestRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-web-smoke-worktree-repo-"));
      execFileSync("git", ["init", "--initial-branch=main"], { cwd: worktreeTestRepoDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: worktreeTestRepoDir });
      execFileSync("git", ["config", "user.name", "ArgusDE Test"], { cwd: worktreeTestRepoDir });
      fs.writeFileSync(path.join(worktreeTestRepoDir, "notes.txt"), "original\n");
      execFileSync("git", ["add", "-A"], { cwd: worktreeTestRepoDir });
      execFileSync("git", ["commit", "-m", "initial commit"], { cwd: worktreeTestRepoDir });

      const worktreePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        await worktreePage.goto(`http://127.0.0.1:${server.port}/`);
        await worktreePage.getByRole("button", { name: /type a path manually/i }).click();
        await worktreePage.getByLabel(/workspace path/i).fill(worktreeTestRepoDir);
        await worktreePage.getByRole("button", { name: /start/i }).click();
        await worktreePage.waitForSelector('input[placeholder*="Message" i]', { timeout: 15_000 });

        await worktreePage.getByRole("button", { name: /promote to worktree/i }).click();
        await worktreePage.waitForSelector("text=/running in an isolated worktree/i", { timeout: 15_000 });

        const expectedWorktreeDir = fs.readdirSync(`${worktreeTestRepoDir}-worktrees`)[0];
        const worktreePath = path.join(`${worktreeTestRepoDir}-worktrees`, expectedWorktreeDir!);
        expect(fs.existsSync(worktreePath)).toBe(true);

        fs.writeFileSync(path.join(worktreePath, "notes.txt"), "edited by the agent in the worktree\n");
        await worktreePage.getByPlaceholder(/message/i).fill("go");
        await worktreePage.getByPlaceholder(/message/i).press("Enter");
        await worktreePage.waitForSelector("text=Hello from the web smoke test agent", { timeout: 15_000 });

        // The main repo checkout must stay untouched — only the worktree
        // reflects the edit.
        expect(fs.readFileSync(path.join(worktreeTestRepoDir, "notes.txt"), "utf8")).toBe("original\n");
        expect(fs.readFileSync(path.join(worktreePath, "notes.txt"), "utf8")).toBe("edited by the agent in the worktree\n");
      } finally {
        await worktreePage.close();
        // `git worktree remove` first (unregisters it from the main repo's
        // administrative area); if promotion never happened, there's
        // nothing to unregister and this is a harmless no-op failure.
        try {
          const worktreesDir = `${worktreeTestRepoDir}-worktrees`;
          const entry = fs.existsSync(worktreesDir) ? fs.readdirSync(worktreesDir)[0] : undefined;
          if (entry) execFileSync("git", ["worktree", "remove", "--force", path.join(worktreesDir, entry)], { cwd: worktreeTestRepoDir });
        } catch {
          // best-effort cleanup only
        }
        fs.rmSync(worktreeTestRepoDir, { recursive: true, force: true });
        fs.rmSync(`${worktreeTestRepoDir}-worktrees`, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "browses Projects→Threads, switches to an existing thread's real history, and never shows another thread's live content",
    async () => {
      const multiTestRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-web-smoke-multi-repo-"));
      execFileSync("git", ["init", "--initial-branch=main"], { cwd: multiTestRepoDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: multiTestRepoDir });
      execFileSync("git", ["config", "user.name", "ArgusDE Test"], { cwd: multiTestRepoDir });
      fs.writeFileSync(path.join(multiTestRepoDir, "notes.txt"), "hello\n");
      execFileSync("git", ["add", "-A"], { cwd: multiTestRepoDir });
      execFileSync("git", ["commit", "-m", "initial commit"], { cwd: multiTestRepoDir });

      const secondPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        // A fresh Project + Thread B, on its own page/WS connection.
        await secondPage.goto(`http://127.0.0.1:${server.port}/`);
        await secondPage.getByRole("button", { name: /type a path manually/i }).click();
        await secondPage.getByLabel(/workspace path/i).fill(multiTestRepoDir);
        await secondPage.getByRole("button", { name: /start/i }).click();
        await secondPage.waitForSelector('input[placeholder*="Message" i]', { timeout: 15_000 });

        await secondPage.getByPlaceholder(/message/i).fill("hello from thread B");
        await secondPage.getByPlaceholder(/message/i).press("Enter");
        await secondPage.waitForSelector("text=Hello from the web smoke test agent", { timeout: 15_000 });

        // Create a second Thread (C) in the same Project, from within the
        // drill-down itself — leaves it fresh/empty, currently active.
        await secondPage.getByRole("button", { name: "Threads" }).click();
        await secondPage.waitForSelector("text=Projects", { timeout: 10_000 });
        await secondPage.getByRole("button", { name: multiTestRepoDir, exact: true }).click();
        await secondPage.waitForSelector("text=/back/i", { timeout: 10_000 });
        await secondPage.getByRole("button", { name: /new thread/i }).click();
        await secondPage.getByPlaceholder(/title/i).fill("Thread C");
        await secondPage.getByRole("button", { name: /^create$/i }).click();
        await secondPage.waitForSelector('input[placeholder*="Message" i]', { timeout: 15_000 });

        // While secondPage is viewing the now-empty Thread C, the *original*
        // shared page (a different, unrelated Thread — call it A) sends a
        // real message live. Its content must never reach secondPage's DOM —
        // this is the cross-thread event-bleed fix, proven live, not by
        // code inspection.
        await page.getByPlaceholder(/message/i).fill("cross-thread isolation trigger");
        await page.getByPlaceholder(/message/i).press("Enter");
        await page.waitForSelector("text=cross-thread isolation trigger", { timeout: 15_000 });

        await secondPage.waitForTimeout(1000); // give a leaked broadcast time to land, if the fix were absent
        const threadCBody = await secondPage.textContent("body");
        expect(threadCBody).not.toContain("cross-thread isolation trigger");
        expect(threadCBody).not.toContain("hello from thread B");

        // Now switch back to Thread B (title == the workspace path, from
        // handleWorkspaceSubmit's own first-launch flow — distinct from
        // "Thread C"'s title) via the drill-down, and confirm its real,
        // correct history replays — not empty, not Thread C's, not Thread A's.
        await secondPage.getByRole("button", { name: "Threads" }).click();
        await secondPage.waitForSelector("text=Projects", { timeout: 10_000 });
        await secondPage.getByRole("button", { name: multiTestRepoDir, exact: true }).click();
        await secondPage.waitForSelector("text=/back/i", { timeout: 10_000 });
        // Thread row, not a Project row — see the closed-thread test below
        // for why these deliberately aren't exact.
        await secondPage.getByRole("button", { name: multiTestRepoDir }).click();
        await secondPage.waitForSelector("text=hello from thread B", { timeout: 15_000 });

        const threadBBody = await secondPage.textContent("body");
        expect(threadBBody).toContain("hello from thread B");
        expect(threadBBody).not.toContain("cross-thread isolation trigger");
      } finally {
        await secondPage.close();
        fs.rmSync(multiTestRepoDir, { recursive: true, force: true });
      }
    },
    45_000,
  );

  it(
    "closes a promoted thread via the UI — worktree actually removed from disk, message input disabled, lands on the Threads tab, history still browsable",
    async () => {
      // A separate page + repo — closing needs a promoted thread of its own,
      // same isolation rationale as the promote-to-worktree test above.
      const closeTestRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-web-smoke-close-repo-"));
      execFileSync("git", ["init", "--initial-branch=main"], { cwd: closeTestRepoDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: closeTestRepoDir });
      execFileSync("git", ["config", "user.name", "ArgusDE Test"], { cwd: closeTestRepoDir });
      fs.writeFileSync(path.join(closeTestRepoDir, "notes.txt"), "original\n");
      execFileSync("git", ["add", "-A"], { cwd: closeTestRepoDir });
      execFileSync("git", ["commit", "-m", "initial commit"], { cwd: closeTestRepoDir });

      const closePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        await closePage.goto(`http://127.0.0.1:${server.port}/`);
        await closePage.getByRole("button", { name: /type a path manually/i }).click();
        await closePage.getByLabel(/workspace path/i).fill(closeTestRepoDir);
        await closePage.getByRole("button", { name: /start/i }).click();
        await closePage.waitForSelector('input[placeholder*="Message" i]', { timeout: 15_000 });

        await closePage.getByRole("button", { name: /promote to worktree/i }).click();
        await closePage.waitForSelector("text=/running in an isolated worktree/i", { timeout: 15_000 });

        const worktreesDir = `${closeTestRepoDir}-worktrees`;
        const worktreeEntry = fs.readdirSync(worktreesDir)[0];
        const worktreePath = path.join(worktreesDir, worktreeEntry!);
        expect(fs.existsSync(worktreePath)).toBe(true);

        await closePage.getByPlaceholder(/message/i).fill("hello from the thread being closed");
        await closePage.getByPlaceholder(/message/i).press("Enter");
        await closePage.waitForSelector("text=Hello from the web smoke test agent", { timeout: 15_000 });

        // The reply text is the wrong thing to synchronise on before closing:
        // it arrives on a streaming message chunk, whereas the turn only
        // settles once its checkpoint capture has landed, and a close issued
        // in that window is rejected outright.
        //
        // Waiting for the control itself to become available is the honest
        // signal — the app now disables it for exactly that window
        // (argusde#110), so this asserts the guard works rather than merely
        // dodging the race the way waiting for the checkpoint strip did.
        const closeButton = closePage.getByRole("button", { name: /close thread/i });
        await expect.poll(() => closeButton.isDisabled(), { timeout: 15_000 }).toBe(false);

        await closeButton.click();

        // handleCloseThread nulls `thread` and switches to the Threads tab
        // on success — waiting for the Projects picker (not stuck on
        // WorkspaceSetup) proves the hasEverHadThread fix actually works,
        // not just that the click registered.
        await closePage.waitForSelector("text=Projects", { timeout: 15_000 });
        const bodyAfterClose = await closePage.textContent("body");
        expect(bodyAfterClose).not.toMatch(/workspace path/i);

        expect(fs.existsSync(worktreePath)).toBe(false);

        // History stays browsable: drill back into the closed thread.
        await closePage.getByRole("button", { name: closeTestRepoDir, exact: true }).click();
        await closePage.waitForSelector("text=/back/i", { timeout: 10_000 });
        await closePage.waitForSelector("text=/closed/i", { timeout: 10_000 });

        // Not `exact` — this is the Thread row, whose accessible name also
        // carries its "closed" badge. Only the Project rows above need exact
        // matching (to separate them from their own "Remove <path>" control).
        await closePage.getByRole("button", { name: closeTestRepoDir }).click();
        await closePage.waitForSelector("text=hello from the thread being closed", { timeout: 15_000 });

        expect(await closePage.getByPlaceholder(/message/i).isDisabled()).toBe(true);
        expect(await closePage.textContent("body")).toMatch(/this thread is closed/i);
      } finally {
        await closePage.close();
        fs.rmSync(closeTestRepoDir, { recursive: true, force: true });
        fs.rmSync(`${closeTestRepoDir}-worktrees`, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "resumes the most-recently-active Thread after a page reload, without redoing first-run setup",
    async () => {
      // A separate page + repo — `browser.newPage()` gives its own
      // isolated localStorage, so this doesn't collide with (or get
      // polluted by) any other test's remembered Thread.
      const reloadTestRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-web-smoke-reload-repo-"));
      execFileSync("git", ["init", "--initial-branch=main"], { cwd: reloadTestRepoDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: reloadTestRepoDir });
      execFileSync("git", ["config", "user.name", "ArgusDE Test"], { cwd: reloadTestRepoDir });
      fs.writeFileSync(path.join(reloadTestRepoDir, "notes.txt"), "hello\n");
      execFileSync("git", ["add", "-A"], { cwd: reloadTestRepoDir });
      execFileSync("git", ["commit", "-m", "initial commit"], { cwd: reloadTestRepoDir });

      const reloadPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        await reloadPage.goto(`http://127.0.0.1:${server.port}/`);
        await reloadPage.getByRole("button", { name: /type a path manually/i }).click();
        await reloadPage.getByLabel(/workspace path/i).fill(reloadTestRepoDir);
        await reloadPage.getByRole("button", { name: /start/i }).click();
        await reloadPage.waitForSelector('input[placeholder*="Message" i]', { timeout: 15_000 });

        await reloadPage.getByPlaceholder(/message/i).fill("remember me across reload");
        await reloadPage.getByPlaceholder(/message/i).press("Enter");
        await reloadPage.waitForSelector("text=Hello from the web smoke test agent", { timeout: 15_000 });

        await reloadPage.reload();

        // Must land directly back in Chat with history intact — never
        // WorkspaceSetup again, and no manual Threads-tab navigation needed.
        await reloadPage.waitForSelector("text=remember me across reload", { timeout: 15_000 });
        const bodyAfterReload = await reloadPage.textContent("body");
        expect(bodyAfterReload).not.toMatch(/workspace path/i);
        expect(bodyAfterReload).toContain("Hello from the web smoke test agent");
      } finally {
        await reloadPage.close();
        fs.rmSync(reloadTestRepoDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "replays a Thread's tool calls on the timeline after a reload — the whole point of durable activity",
    async () => {
      const activityRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-web-smoke-activity-repo-"));
      execFileSync("git", ["init", "--initial-branch=main"], { cwd: activityRepoDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: activityRepoDir });
      execFileSync("git", ["config", "user.name", "ArgusDE Test"], { cwd: activityRepoDir });
      fs.writeFileSync(path.join(activityRepoDir, "notes.txt"), "hello\n");
      execFileSync("git", ["add", "-A"], { cwd: activityRepoDir });
      execFileSync("git", ["commit", "-m", "initial commit"], { cwd: activityRepoDir });

      const previousSteps = process.env.ARGUSDE_FAKE_AGENT_STEPS;
      // Read when the server spawns this Thread's agent process, so it has
      // to be in place before the setup form is submitted, and restored
      // afterwards so the shared fixture stays as every other test expects.
      process.env.ARGUSDE_FAKE_AGENT_STEPS = JSON.stringify([
        { type: "message", text: "let me check the notes" },
        { type: "tool-call", toolCallId: "tc-smoke-1", title: "Read notes.txt", kind: "read", status: "pending" },
        {
          type: "tool-call-update",
          toolCallId: "tc-smoke-1",
          status: "completed",
          content: [{ type: "content", content: { type: "text", text: "hello" } }],
        },
      ]);

      // Mobile viewport deliberately: replaying activity on a phone is the
      // case this whole surface exists for.
      const activityPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        await activityPage.goto(`http://127.0.0.1:${server.port}/`);
        await activityPage.getByRole("button", { name: /type a path manually/i }).click();
        await activityPage.getByLabel(/workspace path/i).fill(activityRepoDir);
        await activityPage.getByRole("button", { name: /start/i }).click();
        await activityPage.waitForSelector('input[placeholder*="Message" i]', { timeout: 15_000 });

        await activityPage.getByPlaceholder(/message/i).fill("what's in the notes?");
        await activityPage.getByPlaceholder(/message/i).press("Enter");
        await activityPage.waitForSelector("text=Read notes.txt", { timeout: 15_000 });

        await activityPage.reload();

        // The tool call has to survive the reload — before this feature the
        // reloaded Thread showed the prose and nothing else, which is the
        // problem spec #93 opened with.
        await activityPage.waitForSelector("text=Read notes.txt", { timeout: 15_000 });
        const body = await activityPage.textContent("body");
        expect(body).toContain("let me check the notes");
        expect(body).toContain("Read notes.txt");
        expect(body).toContain("completed");
        // Never claim the Thread predates recording — it plainly doesn't.
        expect(body).not.toMatch(/predates activity recording/i);
      } finally {
        await activityPage.close();
        if (previousSteps === undefined) delete process.env.ARGUSDE_FAKE_AGENT_STEPS;
        else process.env.ARGUSDE_FAKE_AGENT_STEPS = previousSteps;
        fs.rmSync(activityRepoDir, { recursive: true, force: true });
      }
    },
    45_000,
  );

  it(
    "removes a Project through the UI — confirmed first, gone from the list, and the workspace folder left on disk",
    async () => {
      const deleteTestRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-web-smoke-delete-repo-"));
      execFileSync("git", ["init", "--initial-branch=main"], { cwd: deleteTestRepoDir });
      execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: deleteTestRepoDir });
      execFileSync("git", ["config", "user.name", "ArgusDE Test"], { cwd: deleteTestRepoDir });
      fs.writeFileSync(path.join(deleteTestRepoDir, "keep-me.txt"), "must survive\n");
      execFileSync("git", ["add", "-A"], { cwd: deleteTestRepoDir });
      execFileSync("git", ["commit", "-m", "initial commit"], { cwd: deleteTestRepoDir });

      const deletePage = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        await deletePage.goto(`http://127.0.0.1:${server.port}/`);
        await deletePage.getByRole("button", { name: /type a path manually/i }).click();
        await deletePage.getByLabel(/workspace path/i).fill(deleteTestRepoDir);
        await deletePage.getByRole("button", { name: /start/i }).click();
        await deletePage.waitForSelector('input[placeholder*="Message" i]', { timeout: 15_000 });

        await deletePage.getByRole("button", { name: "Threads" }).click();
        await deletePage.waitForSelector("text=Projects", { timeout: 10_000 });
        await deletePage.getByRole("button", { name: `Remove ${deleteTestRepoDir}` }).click();

        // Nothing is removed on the first click — the confirmation has to
        // appear, and it has to say the folder itself is safe.
        expect(await deletePage.textContent("body")).toMatch(/folder on disk is not deleted/i);
        expect(await deletePage.getByRole("button", { name: deleteTestRepoDir, exact: true }).count()).toBe(1);

        await deletePage.getByRole("button", { name: /^remove$/i }).click();

        await deletePage
          .locator("button", { hasText: deleteTestRepoDir })
          .first()
          .waitFor({ state: "detached", timeout: 10_000 });
        expect(await deletePage.getByRole("button", { name: deleteTestRepoDir, exact: true }).count()).toBe(0);

        // The whole point of the confirmation copy: records go, files stay.
        expect(fs.existsSync(deleteTestRepoDir)).toBe(true);
        expect(fs.existsSync(path.join(deleteTestRepoDir, "keep-me.txt"))).toBe(true);

        // The deleted Project owned the active Thread, so Chat must not
        // still be showing a conversation whose records no longer exist.
        await deletePage.getByRole("button", { name: "Chat" }).click();
        expect(await deletePage.textContent("body")).not.toMatch(/hello from the web smoke test agent/i);
      } finally {
        await deletePage.close();
        fs.rmSync(deleteTestRepoDir, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it(
    "falls back to first-run setup if the remembered Thread no longer resolves, instead of getting stuck restoring",
    async () => {
      const staleIdPage = await browser.newPage({ viewport: { width: 390, height: 844 } });
      try {
        await staleIdPage.goto(`http://127.0.0.1:${server.port}/`);
        // Simulates a stale localStorage entry (e.g. a wiped/replaced
        // database) — this key must match LAST_ACTIVE_THREAD_KEY in
        // src/web/App.tsx.
        await staleIdPage.evaluate(() => localStorage.setItem("argusde:lastActiveThreadId", "does-not-exist"));

        await staleIdPage.reload();

        await staleIdPage.waitForSelector("text=/choose a workspace folder/i", { timeout: 15_000 });
      } finally {
        await staleIdPage.close();
      }
    },
    20_000,
  );

  /**
   * Image attachments (spec #93 phase 7). This is the one place the real
   * encode path runs — createImageBitmap and a canvas, neither of which jsdom
   * has, so composer.test.tsx injects a fake encoder and this covers what it
   * cannot. Story 34's paste is only genuinely testable here too.
   */
  it(
    "downscales, attaches and sends a picked image, and shows it on the sent message",
    async () => {
      const attachPage = await browser.newPage({ viewport: { width: 900, height: 800 } });
      const imagePath = path.join(dbDir, "wide.png");
      // Deliberately past the 1568px bound, so the assertion below proves a
      // real downscale rather than a pass-through.
      fs.writeFileSync(imagePath, solidPng(2400, 1200, [0, 128, 255]));

      try {
        await attachPage.goto(`http://127.0.0.1:${server.port}/`);
        await attachPage.getByRole("button", { name: /type a path manually/i }).click();
        await attachPage.getByLabel(/workspace path/i).fill(repoDir);
        await attachPage.getByRole("button", { name: /^start$/i }).click();
        await attachPage.waitForSelector('input[placeholder*="Message" i]', { timeout: 15_000 });

        await attachPage.getByLabel(/attach an image/i).setInputFiles(imagePath);

        const thumbnail = attachPage.getByRole("img", { name: "wide.png" });
        await thumbnail.waitFor({ timeout: 15_000 });

        // Re-encoded to JPEG and scaled to the bound — the two things that
        // keep a phone screenshot from being persisted at full size and
        // replayed on every history load.
        const src = await thumbnail.getAttribute("src");
        expect(src?.startsWith("data:image/jpeg;base64,")).toBe(true);
        const naturalWidth = await thumbnail.evaluate((img) => (img as HTMLImageElement).naturalWidth);
        expect(naturalWidth).toBe(1568);

        await attachPage.getByPlaceholder(/message/i).fill("what is this?");
        await attachPage.getByPlaceholder(/message/i).press("Enter");

        // The image appears on the user's own message in the transcript
        // (story 37) — and the composer's own copy is gone, so this can only
        // be the sent one.
        await attachPage.waitForSelector("text=Hello from the web smoke test agent", { timeout: 15_000 });
        expect(await attachPage.getByRole("img", { name: "wide.png" }).count()).toBe(0);
        const sentImage = attachPage.locator('img[src^="data:image/jpeg;base64,"]').first();
        await sentImage.waitFor({ timeout: 15_000 });
        expect(await sentImage.getAttribute("src")).toBe(src);
      } finally {
        await attachPage.close();
        fs.rmSync(imagePath, { force: true });
      }
    },
    45_000,
  );

  it(
    "attaches an image pasted into the composer, so attaching is one gesture (story 34)",
    async () => {
      const pastePage = await browser.newPage({ viewport: { width: 900, height: 800 } });
      try {
        await pastePage.goto(`http://127.0.0.1:${server.port}/`);
        await pastePage.getByRole("button", { name: /type a path manually/i }).click();
        await pastePage.getByLabel(/workspace path/i).fill(repoDir);
        await pastePage.getByRole("button", { name: /^start$/i }).click();
        await pastePage.waitForSelector('input[placeholder*="Message" i]', { timeout: 15_000 });

        const pngBase64 = solidPng(200, 100, [255, 0, 255]).toString("base64");
        await pastePage.evaluate((base64) => {
          // Built from bytes rather than fetched from a data: URL — the app's
          // CSP is `connect-src 'self'`, so a fetch would be blocked.
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          const file = new File([bytes], "pasted.png", { type: "image/png" });
          const transfer = new DataTransfer();
          transfer.items.add(file);
          const input = document.querySelector('input[placeholder*="Message"]');
          input?.dispatchEvent(new ClipboardEvent("paste", { clipboardData: transfer, bubbles: true, cancelable: true }));
        }, pngBase64);

        await pastePage.getByRole("img", { name: "pasted.png" }).waitFor({ timeout: 15_000 });
      } finally {
        await pastePage.close();
      }
    },
    45_000,
  );
});

/**
 * A solid-colour PNG, built here rather than committed as a fixture: the
 * tests above need specific dimensions to prove a downscale happened, and a
 * binary blob in the repo is a thing nobody can review.
 */
function solidPng(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const row = y * (1 + width * 3);
    raw[row] = 0; // PNG per-scanline filter type: none
    for (let x = 0; x < width; x++) {
      raw[row + 1 + x * 3] = r;
      raw[row + 2 + x * 3] = g;
      raw[row + 3 + x * 3] = b;
    }
  }

  const chunk = (type: string, data: Buffer): Buffer => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([length, body, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour RGB
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
