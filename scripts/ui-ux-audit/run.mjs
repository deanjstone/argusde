// AFK UI/UX audit regime driver. Runs against a LIVE server (default
// http://127.0.0.1:4870/) per docs/testing/ui-ux-user-stories.md.
// Usage: node scripts/ui-ux-audit/run.mjs [--viewport=desktop|mobile] [--url=http://...]
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices, _electron as electron } from "playwright";
import { record, scanA11y, screenshotAndDiff, printSummary, checkNoHorizontalScroll, startIsolatedServer } from "./helpers.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const BASE_URL = args.url ?? "http://127.0.0.1:4870/";
const VIEWPORT = args.viewport ?? "desktop";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

function makeGitRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  execFileSync("git", ["init", "--initial-branch=main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "audit@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "ArgusDE Audit"], { cwd: dir });
  fs.writeFileSync(path.join(dir, "notes.txt"), "audit fixture\n");
  execFileSync("git", ["add", "-A"], { cwd: dir });
  execFileSync("git", ["commit", "-m", "audit fixture"], { cwd: dir });
  return dir;
}

/**
 * Deletes every Project this run created, over the same WS API the UI uses.
 *
 * The audit drives a LIVE server the user also uses day to day, so it must
 * not leave its throwaway /tmp fixtures sitting in their Projects list. This
 * runs unconditionally in `finally`, so a crashed or timed-out run cleans up
 * too — that's the whole point, since a failing run is exactly when junk
 * would otherwise pile up. Records only: the workspace folders are already
 * removed separately by the fixture teardown.
 */
async function deleteAuditProjects(workspaceRoots) {
  const wsUrl = new URL(BASE_URL);
  wsUrl.protocol = wsUrl.protocol === "https:" ? "wss:" : "ws:";
  wsUrl.pathname = "/ws";

  const socket = new WebSocket(wsUrl.toString());
  const pending = new Map();
  let commandCounter = 0;

  const send = (command) =>
    new Promise((resolve, reject) => {
      const commandId = `audit-cleanup-${commandCounter++}`;
      pending.set(commandId, { resolve, reject });
      socket.send(JSON.stringify({ ...command, commandId }));
    });

  try {
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", () => reject(new Error("cleanup socket failed to open")), { once: true });
    });

    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      // A protocol-error carries no commandId (the server couldn't parse the
      // command well enough to know one), so it can't be matched to a single
      // caller — fail everything in flight rather than hanging forever, which
      // is what an older server missing project.delete would otherwise cause.
      if (message.type === "protocol-error") {
        for (const [, entry] of pending) entry.reject(new Error(`protocol-error: ${message.message}`));
        pending.clear();
        return;
      }
      if (message.type !== "command.result") return;
      const entry = pending.get(message.commandId);
      if (!entry) return;
      pending.delete(message.commandId);
      if (message.ok) entry.resolve(message.result);
      else entry.reject(new Error(message.error));
    });

    const projects = await send({ type: "project.list" });
    const targets = projects.filter((p) => workspaceRoots.includes(p.workspaceRoot));
    for (const project of targets) {
      await send({ type: "project.delete", projectId: project.id });
    }
    record("US-cleanup", "pass", `removed ${targets.length} audit Project(s) from the live server`);
  } catch (error) {
    // Never mask the real audit result with a teardown failure — report it
    // as its own finding instead.
    record("US-cleanup", "fail", `could not remove audit Projects: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    socket.close();
  }
}

// Baselines are viewport-scoped — desktop and mobile render at completely
// different dimensions, so comparing a mobile screenshot against a
// same-named desktop baseline is a guaranteed false-positive dimension
// mismatch, not a real visual regression. Every screenshot call goes
// through this wrapper instead of calling screenshotAndDiff directly.
function shot(page, storyId, options) {
  return screenshotAndDiff(page, `${storyId}-${VIEWPORT}`, options);
}

async function main() {
  console.log(`\n=== ArgusDE UI/UX audit — ${VIEWPORT} viewport — ${BASE_URL} ===\n`);

  const browser = await chromium.launch();
  const contextOptions = VIEWPORT === "mobile" ? { ...devices["iPhone 13"] } : { viewport: { width: 1280, height: 800 } };
  const context = await browser.newContext(contextOptions);
  const page = await context.newPage();
  const consoleErrors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") consoleErrors.push(msg.text());
  });
  page.on("pageerror", (err) => consoleErrors.push(String(err)));

  const gitRepo = makeGitRepo("argusde-audit-git-");
  const nonGitRepo = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-audit-nongit-"));
  // Declared out here, not at its point of use, so the finally block can
  // still clean up after a crash partway through the worktree section.
  let worktreeRepo;
  // Fixtures created deeper in the run (the failure-matrix section) register
  // themselves here so teardown removes their Projects and directories too,
  // crash or not.
  const cleanupRepos = [];

  try {
    // ---- US-1: first-run / connection ----
    await page.goto(BASE_URL);
    await page.waitForSelector("text=/choose a workspace folder/i", { timeout: 15000 });
    record("US-1.1", "pass", "first-run screen shown on fresh load");
    await scanA11y(page, "US-1.1");
    await shot(page, "US-1.1-first-run");

    // ---- US-2: directory browsing ----
    const selectBtn = page.getByRole("button", { name: /select this folder/i });
    await selectBtn.waitFor({ state: "visible", timeout: 15000 });
    record("US-2.1", "pass", "directory browser shown by default, initial listing loaded");
    await scanA11y(page, "US-2.1");
    await shot(page, "US-2.1-directory-browser");

    const upBtn = page.getByRole("button", { name: /^up$/i });
    const upDisabledAtHome = await upBtn.isDisabled();
    record("US-2.2a", upDisabledAtHome ? "fail" : "pass", upDisabledAtHome ? "Up disabled at homedir (expected enabled, not filesystem root)" : "Up enabled at homedir as expected");

    // Navigate into a real subfolder (repos) if present, then back up.
    const reposEntry = page.getByRole("button", { name: "repos" });
    if (await reposEntry.count()) {
      await reposEntry.click();
      await page.waitForTimeout(500);
      record("US-2.2b", "pass", "navigated into a real subfolder");
      await upBtn.click();
      await page.waitForTimeout(500);
      const backAtHome = await page.getByRole("button", { name: "repos" }).count();
      record("US-2.2c", backAtHome ? "pass" : "fail", backAtHome ? "Up navigated back to parent correctly" : "Up did not return to expected parent listing");
    } else {
      record("US-2.2b", "skip", "no 'repos' folder found under homedir to navigate into");
    }

    // Dotfile exclusion: confirm no entry starting with "." is rendered.
    // Checked via evaluate() against real button text, not a CSS
    // :text-matches() regex — that pseudo-class's string-escaping semantics
    // produced a false-positive match against every button on the page
    // during the first audit run (recorded as feedback_playwright_text_matches_escaping).
    const dotEntries = await page.evaluate(() =>
      Array.from(document.querySelectorAll("button"))
        .map((b) => b.textContent.trim())
        .filter((t) => t.startsWith(".")),
    );
    record("US-2.3", dotEntries.length === 0 ? "pass" : "fail", dotEntries.length === 0 ? "no dotfile entries listed" : `dotfile-looking entries found: ${dotEntries.join(", ")}`);

    // Manual fallback still works.
    await page.getByRole("button", { name: /type a path manually/i }).click();
    const manualInput = page.getByLabel(/workspace path/i);
    await manualInput.waitFor({ state: "visible", timeout: 5000 });
    record("US-2.4", "pass", "manual path fallback revealed");
    await scanA11y(page, "US-2.4");

    // US-2.6: non-git folder fails visibly.
    await manualInput.fill(nonGitRepo);
    await page.getByRole("button", { name: /^start$/i }).click();
    const errorLocator = page.locator("text=/not a git repository/i");
    try {
      await errorLocator.waitFor({ timeout: 10000 });
      record("US-2.6", "pass", "non-git folder failure is visibly surfaced");
      await shot(page, "US-2.6-nongit-error");
    } catch {
      record("US-2.6", "fail", "non-git folder failure was NOT visibly surfaced within 10s");
    }

    // US-2.5: git folder succeeds. Already in manual mode from the US-2.6
    // failure above (the error kept the manual form open) — no need to
    // re-reveal it via "type a path manually" again.
    await manualInput.fill(gitRepo);
    await page.getByRole("button", { name: /^start$/i }).click();
    await page.waitForSelector('input[placeholder*="Message" i]', { timeout: 20000 });
    record("US-2.5", "pass", "git folder succeeds and lands on chat");
    await scanA11y(page, "US-2.5");
    await shot(page, "US-2.5-chat-empty");
    await checkNoHorizontalScroll(page, "US-12.3-chat-empty");

    // ---- US-5.1: on a thread with only the turn-0 baseline, the strip shows
    // a bare "Start" marker and no Turn buttons that would imply work already
    // happened ----
    const startMarkers = await page.locator("text=/^Start$/").count();
    const prematureTurnButtons = await page.getByRole("button", { name: /^turn \d/i }).count();
    record(
      "US-5.1",
      startMarkers === 1 && prematureTurnButtons === 0 ? "pass" : "fail",
      `fresh thread strip: ${startMarkers} Start marker(s), ${prematureTurnButtons} Turn button(s) (expected 1 and 0)`,
    );

    // ---- US-6.1: "Promote to worktree" is offered before anything is sent ----
    const promoteOfferedBeforeSend = await page.getByRole("button", { name: /promote to worktree/i }).count();
    record("US-6.1a", promoteOfferedBeforeSend > 0 ? "pass" : "fail", `promote control offered on a fresh, unmessaged thread: ${promoteOfferedBeforeSend > 0}`);

    // ---- US-12.1: the bottom tab bar is fully within the viewport ----
    // The h-dvh fix's automatable half — a fixed-viewport check can prove the
    // bar isn't pushed off-screen at rest, though NOT that it survives a real
    // mobile browser's collapsing toolbar (US-12.2, real-device-only).
    const tabBarBox = await page.getByRole("button", { name: "Chat" }).boundingBox();
    const viewportHeight = page.viewportSize()?.height ?? 0;
    const tabBarFullyVisible = tabBarBox !== null && tabBarBox.y >= 0 && tabBarBox.y + tabBarBox.height <= viewportHeight + 1;
    record(
      "US-12.1",
      tabBarFullyVisible ? "pass" : "fail",
      tabBarBox ? `tab bar bottom edge at ${Math.round(tabBarBox.y + tabBarBox.height)}px vs viewport ${viewportHeight}px` : "tab bar not found",
    );

    // ---- US-10: PWA installability (manifest + service worker) ----
    const manifestHref = await page.locator('link[rel="manifest"]').getAttribute("href");
    if (manifestHref) {
      const manifestResp = await page.request.get(new URL(manifestHref, BASE_URL).toString());
      if (manifestResp.ok()) {
        const manifest = await manifestResp.json();
        const hasIcons = Array.isArray(manifest.icons) && manifest.icons.length > 0;
        record("US-10.1", hasIcons ? "pass" : "fail", hasIcons ? `manifest fetchable with ${manifest.icons.length} icon(s)` : "manifest fetchable but has no icons");
      } else {
        record("US-10.1", "fail", `manifest.json returned HTTP ${manifestResp.status()}`);
      }
    } else {
      record("US-10.1", "fail", "no <link rel=\"manifest\"> found in document");
    }

    const swState = await page.evaluate(async () => {
      if (!("serviceWorker" in navigator)) return "unsupported";
      const reg = await navigator.serviceWorker.getRegistration();
      if (!reg) return "unregistered";
      await navigator.serviceWorker.ready;
      return reg.active ? "active" : "registered-not-active";
    });
    record("US-10.2", swState === "active" ? "pass" : "fail", `service worker state: ${swState}`);

    // ---- US-4: chat ----
    // A checkpoint captures whatever is on disk when the turn completes, so
    // the workspace is staged directly here rather than asking the agent to
    // write exact file contents. That makes the revert assertions below
    // depend on the checkpoint machinery alone, not on the agent choosing to
    // use a file-write tool — and costs no extra agent turns.
    const revertMarker = path.join(gitRepo, "revert-marker.txt");
    fs.writeFileSync(revertMarker, "ALPHA\n");

    const messageInput = page.getByPlaceholder(/message/i);
    await messageInput.fill("Reply with only the word OK, no tools, no explanation.");
    await messageInput.press("Enter");
    record("US-4.1", "pass", "message sent, input cleared");

    try {
      await page.waitForSelector('button:has-text("Turn 1")', { timeout: 60000 });
      record("US-4.2", "pass", "agent reply completed, turn 1 checkpoint captured");
    } catch {
      record("US-4.2", "fail", "agent reply / turn-complete did not land within 60s");
    }
    await scanA11y(page, "US-4.2");
    await shot(page, "US-4.2-chat-with-reply");

    // ---- US-6.1: the promote control is gone once a message has been sent ----
    const promoteOfferedAfterSend = await page.getByRole("button", { name: /promote to worktree/i }).count();
    record("US-6.1b", promoteOfferedAfterSend === 0 ? "pass" : "fail", promoteOfferedAfterSend === 0 ? "promote control correctly withdrawn after the first message" : "promote control still offered after a message was sent");

    // ---- US-14.3: rapid double-tap on Send never produces a duplicate message ----
    // handleSubmit clears `text` synchronously on the first submit, so a
    // same-tick second click sees an empty input and no-ops — this is
    // exactly the behavior US-14.3 requires, verified end-to-end rather
    // than just read out of the component.
    // Second distinct on-disk state, captured by turn 2 below — reverting to
    // turn 1 later must bring ALPHA back.
    fs.writeFileSync(revertMarker, "BETA\n");

    await messageInput.fill("PING-DEDUP-CHECK");
    const sendBtn = page.getByRole("button", { name: "Send" });
    await Promise.all([sendBtn.click(), sendBtn.click()]);
    await page.waitForTimeout(1000);
    const pingCount = await page.locator("text=/PING-DEDUP-CHECK/").count();
    record("US-14.3", pingCount === 1 ? "pass" : "fail", `rapid double-tap on Send produced ${pingCount} instance(s) of the message (expected 1)`);
    await page.waitForSelector('button:has-text("Turn 2")', { timeout: 60000 }).catch(() => {});

    // ---- US-5.2: turn numbering is 1:1 with real completed turns ----
    // Two messages have been sent, so exactly Turn 1 and Turn 2 must exist —
    // no gaps, no phantom extra turn. Note turn 1 changed no files by the
    // agent's own hand, which is the case US-5.2 specifically calls out.
    const turnLabels = await page.evaluate(() =>
      Array.from(document.querySelectorAll("button"))
        .map((b) => b.textContent.trim())
        .filter((t) => /^Turn \d/.test(t))
        .map((t) => t.split(/\s+/).slice(0, 2).join(" ")),
    );
    record(
      "US-5.2",
      turnLabels.join(",") === "Turn 1,Turn 2" ? "pass" : "fail",
      `after 2 completed turns the strip shows: ${turnLabels.join(", ") || "(none)"} (expected Turn 1, Turn 2)`,
    );

    // ---- US-5: checkpoints ----
    const turn1Btn = page.getByRole("button", { name: /^turn 1/i });
    if (await turn1Btn.count()) {
      await turn1Btn.click();
      await page.waitForTimeout(1500);
      const diffVisible = await page.locator("text=/diff|no changes|close diff/i").count();
      record("US-5.3", diffVisible ? "pass" : "fail", diffVisible ? "diff view opened for turn 1" : "diff view did not appear");
      await scanA11y(page, "US-5.3");
      await shot(page, "US-5.3-diff-view");

      // ---- US-5.4: a diff with real content is visibly distinct from "No changes." ----
      const diffPanelText = (await page.locator("text=/^Diff$/i").locator("xpath=..").locator("xpath=..").textContent().catch(() => "")) ?? "";
      const showsRealDiff = /revert-marker/.test(diffPanelText) && !/no changes/i.test(diffPanelText);
      record("US-5.4", showsRealDiff ? "pass" : "fail", showsRealDiff ? "a turn with real changes renders diff content, not the empty-state text" : `diff panel did not show the expected change (text: ${diffPanelText.slice(0, 120)})`);

      // ---- US-5.3b (spec #33 story 10): any two checkpoints can be compared ----
      // The strip's taps only ever produce turn N-1 -> N and 0 -> latest.
      // Comparing a non-adjacent pair is the case the story exists for, and
      // it's checked by content: turn 1 captured ALPHA and turn 2 BETA, so a
      // 1 -> 2 comparison must show that transition, not just any diff.
      const fromPicker = page.getByLabel(/compare from/i);
      if (await fromPicker.count()) {
        await fromPicker.selectOption("1");
        await page.getByLabel(/compare to/i).selectOption("2");
        await page.waitForTimeout(2000);
        const rangeDiff = (await page.textContent("body")) ?? "";
        const showsTransition = /-ALPHA/.test(rangeDiff) && /\+BETA/.test(rangeDiff);
        record(
          "US-5.3b",
          showsTransition ? "pass" : "fail",
          showsTransition ? "an arbitrary checkpoint pair (turn 1 vs turn 2) diffs to exactly that range's change" : "comparing turn 1 with turn 2 did not show the ALPHA -> BETA transition those checkpoints captured",
        );
        // Back to the turn-1 view the revert checks below expect.
        await page.getByLabel(/compare from/i).selectOption("0");
        await page.getByLabel(/compare to/i).selectOption("1");
        await page.waitForTimeout(1500);
      } else {
        record("US-5.3b", "fail", "no checkpoint-comparison pickers rendered — arbitrary pairs can't be reached from the UI");
      }

      // ---- US-5.5: reverting actually rewrites the working tree on disk ----
      // Turn 1 captured ALPHA, turn 2 captured BETA. Reverting to turn 1 must
      // put ALPHA back on disk — the whole point of the feature, and the one
      // thing no other check in this regime proves.
      const beforeRevert = fs.readFileSync(revertMarker, "utf8").trim();
      const turnsBeforeRevert = await page.getByRole("button", { name: /^turn \d/i }).count();
      const revertBtn = page.getByRole("button", { name: /revert to this checkpoint/i });
      if ((await revertBtn.count()) && beforeRevert === "BETA") {
        await revertBtn.click();
        await page.waitForTimeout(4000);

        const afterRevert = fs.readFileSync(revertMarker, "utf8").trim();
        record("US-5.5a", afterRevert === "ALPHA" ? "pass" : "fail", `on-disk content ${beforeRevert} -> ${afterRevert} after reverting to turn 1 (expected ALPHA)`);

        const diffStillOpen = await page.getByRole("button", { name: /revert to this checkpoint/i }).count();
        record("US-5.5b", diffStillOpen === 0 ? "pass" : "fail", diffStillOpen === 0 ? "diff panel closed on a successful revert" : "diff panel stayed open after reverting");

        // A safety snapshot of the pre-revert state, then the revert itself.
        const turnsAfterRevert = await page.getByRole("button", { name: /^turn \d/i }).count();
        record(
          "US-5.5c",
          turnsAfterRevert === turnsBeforeRevert + 2 ? "pass" : "fail",
          `turn count ${turnsBeforeRevert} -> ${turnsAfterRevert} (expected +2: an unmarked safety snapshot, then the marked revert)`,
        );

        const revertBadge = await page.locator("text=/reverted to turn 1/i").count();
        record("US-5.5d", revertBadge > 0 ? "pass" : "fail", revertBadge > 0 ? "the new checkpoint is visibly marked as a revert" : "no 'reverted to turn N' marker appeared in the strip");
        await shot(page, "US-5.5-after-revert");
      } else {
        record("US-5.5a", "skip", `preconditions not met (revert control present: ${(await revertBtn.count()) > 0}, on-disk state: ${beforeRevert})`);
      }

      const closeDiff = page.getByRole("button", { name: /close diff/i });
      if (await closeDiff.count()) await closeDiff.click();
      // ---- US-5.6: reverting while a turn is in flight is rejected ----
      // Deliberately not raced here. Winning the race needs the revert click
      // to land inside a live turn, and losing it produces a false failure
      // rather than a real finding — ws-server.test.ts asserts the rejection
      // directly against the handler instead.
      record("US-5.6", "skip", "in-flight revert rejection is covered directly by ws-server.test.ts; racing it through the UI would be flaky, not more truthful");
    } else {
      record("US-5.3", "skip", "no Turn 1 checkpoint button found");
    }

    // ---- US-7: mode switcher (presence-only; real agent may or may not advertise modes) ----
    const modeSelect = page.getByLabel(/agent mode/i);
    const modeCount = await modeSelect.count();
    record("US-7.1", "pass", modeCount ? "mode switcher present (agent advertises modes)" : "mode switcher absent (agent advertises no modes) — correct per US-7.1");

    // ---- US-7.2: changing mode round-trips to the agent and sticks ----
    if (modeCount) {
      const optionValues = await modeSelect.locator("option:not([disabled])").evaluateAll((els) => els.map((e) => e.value));
      const startingMode = await modeSelect.inputValue();
      const target = optionValues.find((v) => v !== startingMode);
      if (target) {
        await modeSelect.selectOption(target);
        await page.waitForTimeout(2500);
        const afterSwitch = await modeSelect.inputValue();
        record("US-7.2a", afterSwitch === target ? "pass" : "fail", `mode ${startingMode} -> ${afterSwitch} (requested ${target}); a value that silently reverted would mean the UI guessed instead of confirming`);

        // Leaving and returning re-reads the mode from the server, so this
        // separates a real round trip from an optimistic local update that
        // was never actually persisted.
        await page.getByRole("button", { name: "Settings" }).click();
        await page.waitForTimeout(300);
        await page.getByRole("button", { name: "Chat" }).click();
        await page.waitForTimeout(500);
        const afterReturn = await page.getByLabel(/agent mode/i).inputValue();
        record("US-7.2b", afterReturn === target ? "pass" : "fail", `mode after leaving and returning to Chat: ${afterReturn} (expected the confirmed ${target})`);

        await modeSelect.selectOption(startingMode);
        await page.waitForTimeout(1500);
      } else {
        record("US-7.2a", "skip", `agent advertises only one mode (${startingMode}) — nothing to switch to`);
      }
    } else {
      record("US-7.2a", "skip", "no mode switcher — agent advertises no modes");
    }

    // ---- US-7.3: an agent-driven mode change appearing live ----


    // ---- US-4.6: permission prompt ----
    // The audit's agent runs with --permission-mode auto, so it never asks —
    // provoking a real request would mean reconfiguring the live agent this
    // audit shares with the user.


    // ---- US-4.3: connection banner on a mid-use agent drop ----


    // ---- US-15: the Files tab reads the Thread's working tree (spec #93 phase 4) ----
    await page.getByRole("button", { name: "Files" }).click();
    await page.waitForTimeout(600);

    const treeEntries = (await page.locator('[data-slot="item-title"]').allTextContents()).map((t) => t.trim());
    record(
      "US-15.1",
      treeEntries.length > 0 ? "pass" : "fail",
      treeEntries.length > 0 ? `working tree listed: ${treeEntries.join(", ")}` : "Files tab listed nothing for an active Thread",
    );
    // .git is machinery, not content — it lists first alphabetically, so a
    // regression here puts loose objects at the top of the browser.
    record("US-15.2", treeEntries.includes(".git/") ? "fail" : "pass", ".git hidden from the working-tree browser");
    await scanA11y(page, "US-15.1");
    await shot(page, "US-15.1-file-browser");

    const readable = treeEntries.find((name) => name.endsWith(".txt") || name.endsWith(".md"));
    if (readable) {
      await page.getByRole("button", { name: readable }).click();
      await page.waitForSelector('[data-testid="preview-code"]', { timeout: 15000 }).catch(() => undefined);
      const previewShown = await page.locator('[data-testid="preview-code"]').count();
      record("US-15.3", previewShown ? "pass" : "fail", previewShown ? `previewed ${readable}` : `opening ${readable} rendered no preview`);
      await scanA11y(page, "US-15.3");
      await shot(page, "US-15.3-file-preview");

      // Story 15: on a phone the file takes the screen, so there has to be a
      // way back to the tree — and the tab bar must survive both states.
      const backCount = await page.getByRole("button", { name: /← Files/ }).count();
      const tabBarVisible = await page.getByRole("button", { name: "Settings" }).isVisible();
      record(
        "US-15.4",
        tabBarVisible && (VIEWPORT === "desktop" || backCount > 0) ? "pass" : "fail",
        `tab bar visible: ${tabBarVisible}, back-to-tree control: ${backCount > 0} (${VIEWPORT})`,
      );
      await checkNoHorizontalScroll(page, "US-15.5");
    } else {
      record("US-15.3", "skip", "no plainly readable file in the audit fixture's working tree");
    }

    try {
      // ---- US-16: workspace search (spec #93 phase 5) ----
      // At mobile width the Files tab is master-detail: an open file takes the
      // whole screen and the tree — which holds the search field — is hidden.
      // So return to the tree first, which is the same thing a user does, via
      // the control story 15 requires to exist.
      await page.getByRole("button", { name: /← Files/ }).click().catch(() => undefined);
      await page.waitForTimeout(200);

      const searchField = page.getByLabel(/search the working tree/i);
      if (await searchField.count()) {
        // A term the audit fixture's own working tree genuinely contains.
        await searchField.fill("audit", { timeout: 10000 });
        await page.getByRole("button", { name: "Search" }).click();
        const gotResults = await page
          .waitForSelector('[data-testid="search-results"], [data-testid="search-no-matches"]', { timeout: 20000 })
          .then(() => true)
          .catch(() => false);
        const hasHits = (await page.locator('[data-testid="search-results"]').count()) > 0;
        const noMatches = (await page.locator('[data-testid="search-no-matches"]').count()) > 0;
        // The audit fixture's working tree genuinely contains this term, so
        // "results appeared" is the assertion. Passing on either state would
        // have made this story unable to fail — and story 16.1's point is that
        // the two states are distinguishable, which means exactly one shows.
        record(
          "US-16.1",
          hasHits && !noMatches ? "pass" : "fail",
          gotResults
            ? `results: ${hasHits}, no-matches state: ${noMatches} (expected true/false)`
            : "search never settled within 20s",
        );
        await scanA11y(page, "US-16.1");
        await shot(page, "US-16.1-search-results");

        if (hasHits) {
          // Story 19: a result has to lead somewhere.
          const firstMatch = page.locator('[data-testid="search-results"] button').first();
          await firstMatch.click();
          const opened = await page
            .waitForSelector('[data-testid="preview-highlighted-line"]', { timeout: 15000 })
            .then(() => true)
            .catch(() => false);
          record("US-16.2", opened ? "pass" : "fail", opened ? "result opened the file at its matching line" : "result did not open at a marked line");
          await shot(page, "US-16.2-search-match-opened");
          if (VIEWPORT !== "desktop") await page.getByRole("button", { name: /← Files/ }).click().catch(() => undefined);
        } else {
          record("US-16.2", "skip", "no matches in the audit fixture, so there was no result to open");
        }

        await checkNoHorizontalScroll(page, "US-16.3");
        await page.getByRole("button", { name: /clear search/i }).click().catch(() => undefined);
      } else {
        record("US-16.1", "fail", "no search field on the Files tab");
      }
    } catch (error) {
      // Recorded rather than thrown: this is an operational tool, and letting
      // one story abort the pass loses every story after it. Recorded under a
      // distinct id so it can never overwrite US-16.1's own verdict, and so a
      // throw is visible rather than hidden behind a story that already
      // reported.
      record("US-16.throw", "fail", `workspace search story threw: ${error.message.split("\n")[0]}`);
    }

    // ---- US-17: changed files and per-file working-tree diffs (spec #93 phase 6) ----
    try {
      await page.getByRole("button", { name: /← Files/ }).click().catch(() => undefined);
      const changesTab = page.getByRole("button", { name: "Changes" });
      if (await changesTab.count()) {
        await changesTab.click();
        const settled = await page
          .waitForSelector('[data-testid="changed-files"]', { timeout: 20000 })
          .then(() => true)
          .catch(() => false);
        record("US-17.1", settled ? "pass" : "fail", settled ? "changed-files list rendered" : "changed files never settled within 20s");

        // Story 28: the branch has to be shown, and a detached worktree must
        // not be labelled with a branch called "HEAD".
        const named = await page.locator('[data-testid="branch-name"]').count();
        const detached = await page.locator('[data-testid="branch-detached"]').count();
        record("US-17.2", named + detached === 1 ? "pass" : "fail", `branch shown: named=${named}, detached=${detached} (exactly one expected)`);

        await scanA11y(page, "US-17.1");
        await shot(page, "US-17.1-changed-files");

        const firstChange = page.locator('[data-testid="changed-files"] button').first();
        if (await firstChange.count()) {
          await firstChange.click();
          const opened = await page
            .waitForSelector('[data-testid="wt-diff-lines"], [data-testid="wt-diff-binary"]', { timeout: 15000 })
            .then(() => true)
            .catch(() => false);
          record("US-17.3", opened ? "pass" : "fail", opened ? "per-file working-tree diff opened" : "selecting a changed file rendered no diff");
          await scanA11y(page, "US-17.3");
          await shot(page, "US-17.3-working-tree-diff");
        } else {
          record("US-17.3", "skip", "audit fixture's working tree had no changes to open");
        }

        await checkNoHorizontalScroll(page, "US-17.4");
      } else {
        record("US-17.1", "fail", "no Changes view on the Files tab");
      }
    } catch (error) {
      record("US-17.throw", "fail", `changed-files story threw: ${error.message.split("\n")[0]}`);
    }

    // ---- US-9: settings tab ----
    await page.getByRole("button", { name: "Settings" }).click();
    await page.waitForTimeout(300);
    const apiVersionVisible = await page.locator("text=/api version/i").count();
    record("US-9.1", apiVersionVisible ? "pass" : "fail", apiVersionVisible ? "settings shows API version" : "settings missing API version text");
    const threadIdVisible = await page.locator("text=/thread id/i").count();
    record("US-9.1b", threadIdVisible ? "pass" : "fail", threadIdVisible ? "settings shows active Thread ID" : "settings missing Thread ID while a thread is active");
    await scanA11y(page, "US-9.1");
    await shot(page, "US-9.1-settings");

    // ---- US-3.5: tab switching never loses the active Thread's state ----
    await page.getByRole("button", { name: "Chat" }).click();
    await page.waitForTimeout(300);
    const messageStillVisible = await page.locator("text=/Reply with only the word OK/").count();
    record("US-3.5", messageStillVisible ? "pass" : "fail", messageStillVisible ? "returning to Chat after Settings/Threads shows the same conversation" : "conversation was lost/reset after switching tabs");

    // ---- US-3: threads/projects navigation ----
    await page.getByRole("button", { name: "Threads" }).click();
    await page.waitForTimeout(500);
    const projectButtons = await page.locator('button').filter({ hasText: gitRepo }).count();
    record("US-3.1", projectButtons > 0 ? "pass" : "fail", projectButtons > 0 ? "created project appears in Threads list" : "created project missing from list");
    await scanA11y(page, "US-3.1");
    await shot(page, "US-3.1-threads-tab");
    await checkNoHorizontalScroll(page, "US-12.3-threads-tab");

    // ---- US-12.4: at a desktop viewport, content actually uses the width ----
    // The failure this guards against is a mobile-width column stranded in the
    // middle of a wide window. Checked on the project rows, which should track
    // the container rather than sitting at a fixed phone width.
    if (VIEWPORT === "desktop") {
      const rowBox = await page.locator("button", { hasText: gitRepo }).first().boundingBox();
      const viewportWidth = page.viewportSize()?.width ?? 0;
      const usesWidth = rowBox !== null && rowBox.width > viewportWidth * 0.5;
      record(
        "US-12.4",
        usesWidth ? "pass" : "fail",
        rowBox ? `project row is ${Math.round(rowBox.width)}px wide in a ${viewportWidth}px viewport (${Math.round((rowBox.width / viewportWidth) * 100)}%)` : "no project row found to measure",
      );
    } else {
      record("US-12.4", "skip", "desktop-layout story — not meaningful at a mobile viewport");
    }

    // ---- US-3.2: drilling into a Project's Thread list, then "Back", returns cleanly ----
    const gitRepoProjectBtn = page.locator("button", { hasText: gitRepo }).first();
    await gitRepoProjectBtn.click();
    await page.waitForTimeout(400);
    const onThreadListAfterDrillIn = await page.getByRole("button", { name: /\+ new thread/i }).count();
    record("US-3.2a", onThreadListAfterDrillIn ? "pass" : "fail", onThreadListAfterDrillIn ? "selecting a Project drilled into its Thread list" : "did not land on Thread list after selecting Project");

    const backToProjectsBtn = page.getByRole("button", { name: /back/i });
    await backToProjectsBtn.click();
    await page.waitForTimeout(400);
    const onProjectListAfterBack = await page.getByRole("button", { name: /\+ new project/i }).count();
    const projectStillListedAfterBack = await page.locator("button", { hasText: gitRepo }).count();
    record("US-3.2b", onProjectListAfterBack && projectStillListedAfterBack ? "pass" : "fail", `"Back" returned to Project list: ${!!onProjectListAfterBack}, project still listed: ${!!projectStillListedAfterBack}`);

    // ---- US-2.7: ProjectPicker's "+ New project" form has the same browse/manual parity as first-run ----
    await page.getByRole("button", { name: /\+ new project/i }).click();
    await page.waitForTimeout(300);
    const browseFormPresentInPicker = await page.getByRole("button", { name: /select this folder/i }).count();
    record("US-2.7", browseFormPresentInPicker ? "pass" : "fail", browseFormPresentInPicker ? "ProjectPicker's \"+ New project\" form defaults to the folder browser, same as first-run" : "ProjectPicker's create form did not show the folder browser by default");
    await page.getByRole("button", { name: /type a path manually/i }).click();
    const pickerManualInput = page.getByLabel(/workspace path/i);
    await pickerManualInput.waitFor({ state: "visible", timeout: 5000 });
    record("US-2.7b", "pass", "manual path fallback also present in ProjectPicker's create form");

    // ---- US-2.8: re-selecting an existing workspace root is idempotent (Project-level dedup) ----
    // Not exercised end-to-end here — actually submitting would spin up a
    // second real Claude Code agent session purely to re-derive what
    // src/server/ws/ws-server.test.ts's "project.create is idempotent by
    // workspaceRoot" test already covers directly against the protocol
    // handler, at zero extra live-agent cost.
    record("US-2.8", "skip", "server-side idempotency covered by ws-server.test.ts's dedicated unit test; not re-exercised here to avoid spinning up an unnecessary extra live agent session");
    // Back out of the create form without submitting.
    const cancelBrowseToggle = page.getByRole("button", { name: /or browse folders/i });
    if (await cancelBrowseToggle.count()) await cancelBrowseToggle.click();

    // ---- US-13: keyboard operability spot-check ----
    await page.getByRole("button", { name: "Chat" }).click();
    await page.waitForTimeout(300);
    await page.keyboard.press("Tab");
    const activeTag = await page.evaluate(() => document.activeElement?.tagName);
    record("US-13.3", activeTag ? "pass" : "fail", `first Tab focused a <${activeTag}> element`);

    // ---- US-13.4: focus order through the tab bar follows the tab bar ----
    // Derived from the rendered tabs rather than hardcoded, so adding a tab
    // (Files arrived with spec #93 phase 4) doesn't read as a regression.
    const tabLabels = (await page.locator("nav button").allTextContents()).map((t) => t.trim()).filter(Boolean);
    await page.getByRole("button", { name: tabLabels[0] }).focus();
    const focused = [];
    for (let i = 1; i < tabLabels.length; i++) {
      await page.keyboard.press("Tab");
      focused.push(await page.evaluate(() => document.activeElement?.textContent?.trim()));
    }
    const expected = tabLabels.slice(1);
    const focusOrderLogical = focused.join(" -> ") === expected.join(" -> ");
    record(
      "US-13.4",
      focusOrderLogical ? "pass" : "fail",
      `tab-bar focus order after ${tabLabels[0]}: ${focused.join(" -> ")} (expected ${expected.join(" -> ")})`,
    );

    // ---- US-8: closing a non-promoted Thread ----
    const closeBtn = page.getByRole("button", { name: /^close thread$/i });
    if (await closeBtn.count()) {
      await closeBtn.click();
      await page.waitForTimeout(1500);
      const landedOnThreads = await page.getByRole("button", { name: "Threads" }).getAttribute("aria-current");
      record("US-8.1a", landedOnThreads === "page" ? "pass" : "fail", `landed on Threads tab after close: ${landedOnThreads === "page"}`);
      // Re-select the just-closed thread from the list to confirm read-only
      // history + closed notice. Project title and Thread title are both
      // set to the workspaceRoot path in this flow, so the first matching
      // button could be either the Project (ProjectPicker) or the Thread
      // itself (ThreadList), depending on whether closing reset
      // selectedProjectId — click once, and if that didn't land on a
      // Thread (no closed-notice/message-input yet), click the
      // now-matching Thread button in the drilled-in list.
      const clickMatchingButton = async () => {
        const btn = page.locator("button", { hasText: gitRepo }).first();
        if (await btn.count()) await btn.click();
        await page.waitForTimeout(500);
      };
      await clickMatchingButton();
      let onThreadScreen = (await page.locator("text=/this thread is closed/i").count()) > 0;
      if (!onThreadScreen) {
        await clickMatchingButton();
        onThreadScreen = (await page.locator("text=/this thread is closed/i").count()) > 0;
      }
      record("US-8.3", onThreadScreen ? "pass" : "fail", onThreadScreen ? "closed Thread's history browsable with closed notice" : "closed notice never appeared after re-selecting the closed thread (up to 2 clicks through Project→Thread drill-down)");
      if (onThreadScreen) {
        await scanA11y(page, "US-8.3");
        await shot(page, "US-8.3-closed-thread");

        // ---- US-4.4: sending is disabled on a closed Thread ----
        const closedInput = page.getByPlaceholder(/message/i);
        const closedInputDisabled = (await closedInput.count()) === 0 || (await closedInput.isDisabled().catch(() => true));
        record("US-4.4", closedInputDisabled ? "pass" : "fail", `message input disabled on closed Thread: ${closedInputDisabled}`);

        // ---- US-3.4: the closed Thread's row in its Thread list shows a "closed" badge ----
        // Re-selecting the closed thread reset selectedProjectId to null (via
        // becomeActiveThread), so "Threads" alone lands back on the top-level
        // ProjectPicker, not the drilled-in ThreadList where row badges live —
        // drill into the Project explicitly first.
        await page.getByRole("button", { name: "Threads" }).click();
        await page.waitForTimeout(300);
        const gitRepoProjectBtnForBadge = page.locator("button", { hasText: gitRepo }).first();
        if (await gitRepoProjectBtnForBadge.count()) await gitRepoProjectBtnForBadge.click();
        await page.waitForTimeout(400);
        const closedBadgeInList = await page.locator("text=/^closed$/i").count();
        record("US-3.4", closedBadgeInList ? "pass" : "fail", closedBadgeInList ? "closed Thread row shows a visible \"closed\" badge in its Thread list" : "no \"closed\" badge found in Thread list row");
      }
    } else {
      record("US-8.1a", "fail", "Close thread button not found on an open, non-promoted thread");
    }

    // ---- US-6: worktree promotion (needs a FRESH thread — promotion is only allowed before any message is sent) ----
    worktreeRepo = makeGitRepo("argusde-audit-worktree-");
    await page.getByRole("button", { name: "Threads" }).click();
    await page.waitForTimeout(300);
    // Re-selecting the closed thread above left selectedProjectId set, so
    // the Threads tab now shows that Project's ThreadList, not the
    // top-level ProjectPicker — "← Back" returns to it, where "+ New
    // project" actually lives (ThreadList only offers "+ New thread").
    const backBtn = page.getByRole("button", { name: /back/i });
    if (await backBtn.count()) await backBtn.click();
    await page.waitForTimeout(300);
    await page.getByRole("button", { name: /\+ new project/i }).click();
    await page.getByRole("button", { name: /type a path manually/i }).click();
    await page.getByLabel(/workspace path/i).fill(worktreeRepo);
    await page.getByRole("button", { name: /^create$/i }).click();
    await page.waitForSelector('input[placeholder*="Message" i]', { timeout: 20000 });
    record("US-6.setup", "pass", "fresh thread created for worktree promotion test");

    const promoteBtn = page.getByRole("button", { name: /promote to worktree/i });
    if (await promoteBtn.count()) {
      await promoteBtn.click();
      try {
        await page.waitForSelector("text=/running in an isolated worktree/i", { timeout: 15000 });
        record("US-6.2", "pass", "promoted — amber worktree badge visible");
        await scanA11y(page, "US-6.2");
        await shot(page, "US-6.2-promoted");
      } catch {
        record("US-6.2", "fail", "worktree badge did not appear within 15s of promoting");
      }

      // US-6.4: promoting a second time must be rejected.
      const promoteAgain = page.getByRole("button", { name: /promote to worktree/i });
      const stillOffered = await promoteAgain.count();
      record("US-6.4", stillOffered === 0 ? "pass" : "fail", stillOffered === 0 ? "promote control correctly hidden after promotion" : "promote control still offered after already promoting");

      // ---- US-6.3: a real file edit lands in the worktree, not the Project's main workspace ----
      const wtMessageInput = page.getByPlaceholder(/message/i);
      const marker = "worktree-audit-marker.txt";
      await wtMessageInput.fill(`Create a file named ${marker} in the repo root containing exactly the text HELLO. Use your file-write tool directly, no explanation.`);
      await wtMessageInput.press("Enter");
      try {
        await page.waitForSelector('button:has-text("Turn 1")', { timeout: 90000 });
        record("US-6.3-setup", "pass", "turn 1 completed in promoted thread");
        const worktreesDirPreClose = `${worktreeRepo}-worktrees`;
        const markerInWorktree = fs.existsSync(worktreesDirPreClose)
          ? fs.readdirSync(worktreesDirPreClose).some((entry) => fs.existsSync(path.join(worktreesDirPreClose, entry, marker)))
          : false;
        const markerInMainRepo = fs.existsSync(path.join(worktreeRepo, marker));
        record("US-6.3", markerInWorktree && !markerInMainRepo ? "pass" : "fail", `marker file in worktree: ${markerInWorktree}, marker file leaked into main repo: ${markerInMainRepo}`);

        // ---- US-4.5: the tool call that wrote that file renders legibly ----
        // This turn provably used a file-write tool (the marker exists), so
        // the timeline must show it as a titled, status-bearing item rather
        // than a raw id or an undecoded blob.
        const toolItems = await page.evaluate(() => {
          // Tool-call items are the bordered non-message rows; message
          // bubbles are the rounded-2xl ones.
          return Array.from(document.querySelectorAll("div.rounded-lg.border"))
            .map((el) => {
              const title = el.querySelector("span.font-medium")?.textContent?.trim() ?? "";
              const status = el.querySelector("span.text-xs")?.textContent?.trim() ?? "";
              return { title, status };
            })
            .filter((x) => x.title.length > 0);
        });
        const looksLikeRawId = (t) => /^[0-9a-f]{8}-[0-9a-f]{4}-/i.test(t) || /^toolu_/i.test(t);
        const legible = toolItems.filter((t) => !looksLikeRawId(t.title));
        record(
          "US-4.5",
          legible.length > 0 ? "pass" : "fail",
          legible.length > 0
            ? `tool-call timeline item rendered with a legible title (e.g. "${legible[0].title}"${legible[0].status ? `, status "${legible[0].status}"` : ", no status shown"})`
            : `no legibly-titled tool-call item found despite a tool having run (items seen: ${JSON.stringify(toolItems).slice(0, 160)})`,
        );
        if (legible.length > 0) await shot(page, "US-4.5-tool-call");
      } catch {
        record("US-6.3-setup", "fail", "turn 1 did not complete in promoted thread within 90s");
        record("US-6.3", "skip", "could not verify file placement — turn never completed");
      }

      const wtCloseBtn = page.getByRole("button", { name: /^close thread$/i });
      if (await wtCloseBtn.count()) {
        await wtCloseBtn.click();
        await page.waitForTimeout(2000);
        // The worktree directory is a sibling of the project root, named
        // "<root>-worktrees/<threadId>" — the exact thread id isn't known
        // to this script, so check the sibling "-worktrees" dir itself is
        // either absent or empty after close, not a specific subpath.
        const worktreesDir = `${worktreeRepo}-worktrees`;
        const stillHasEntries = fs.existsSync(worktreesDir) && fs.readdirSync(worktreesDir).length > 0;
        record("US-8.2", !stillHasEntries ? "pass" : "fail", !stillHasEntries ? "worktree directory removed/emptied from disk after close" : `worktree dir still has entries: ${fs.readdirSync(worktreesDir).join(", ")}`);
        fs.rmSync(worktreesDir, { recursive: true, force: true });

        // ---- US-8.4: attempting to close an already-closed Thread is rejected cleanly ----
        const closeStillOffered = await page.getByRole("button", { name: /^close thread$/i }).count();
        record("US-8.4", closeStillOffered === 0 ? "pass" : "fail", closeStillOffered === 0 ? "Close control correctly hidden after closing — no way to double-close via the UI" : "Close control still offered on an already-closed Thread");
      } else {
        record("US-8.2", "fail", "Close thread button not found on the promoted thread");
      }
    } else {
      record("US-6.2", "fail", "Promote to worktree button not found on a fresh, unmessaged thread");
    }

    // ---- US-1.2 / US-1.3 / US-14.1: connection states, via real WebSocket
    // fault injection ----
    // These run on their own pages so the injected faults can't disturb the
    // main flow above. routeWebSocket intercepts the real socket rather than
    // stubbing the app, so what's exercised is the actual client behaviour.
    {
      // A separate context, not just a separate page: the main context has a
      // remembered last-active thread in localStorage by now, so a page there
      // would attempt a session restore instead of showing the first-run
      // screen these checks key off. Fresh context == the brand-new-install
      // state US-1.x actually describes.
      const faultContext = await browser.newContext(contextOptions);
      const connectingPage = await faultContext.newPage();
      try {
        await connectingPage.routeWebSocket(/\/ws$/, async (route) => {
          // Hold the handshake open long enough to observe the state the app
          // shows before server.welcome arrives.
          await new Promise((resolve) => setTimeout(resolve, 3000));
          route.connectToServer();
        });
        await connectingPage.goto(BASE_URL);
        const connectingVisible = await connectingPage
          .locator("text=/connecting/i")
          .first()
          .isVisible()
          .catch(() => false);
        record("US-1.2", connectingVisible ? "pass" : "fail", connectingVisible ? "a Connecting… state is shown while the socket is still connecting" : "no connecting state shown during the handshake window — blank or premature first-run form");

        // And it must not get stuck there once the socket does connect.
        const recovered = await connectingPage
          .waitForSelector("text=/choose a workspace folder/i", { timeout: 20000 })
          .then(() => true)
          .catch(() => false);
        record("US-1.2b", recovered ? "pass" : "fail", recovered ? "advances past Connecting… once the socket connects" : "stuck on Connecting… after the socket connected");
      } finally {
        await connectingPage.close();
      }

      const dropPage = await faultContext.newPage();
      try {
        let socketRoute;
        await dropPage.routeWebSocket(/\/ws$/, (route) => {
          socketRoute = route;
          route.connectToServer();
        });
        await dropPage.goto(BASE_URL);
        await dropPage.waitForSelector("text=/choose a workspace folder/i", { timeout: 20000 });

        // Drop the socket, then issue a command that can now never complete.
        socketRoute?.close();
        await dropPage.waitForTimeout(500);

        await dropPage.getByRole("button", { name: /type a path manually/i }).click();
        await dropPage.getByLabel(/workspace path/i).fill(gitRepo);
        await dropPage.getByRole("button", { name: /^start$/i }).click();

        // Asserts the *shape* of the outcome, not exact copy: the in-flight
        // spinner must clear and a connection failure must be named. Matching
        // the literal wording would make this a change-detector — an earlier
        // version did exactly that and failed the moment the message was
        // improved from a raw DOMException to something readable.
        const surfacedError = await dropPage
          .waitForFunction(
            () => {
              const text = document.body.innerText;
              const stillSubmitting = /Starting…/.test(text);
              const namesAConnectionFailure = /(lost|closed|dropped|failed|error|unavailable|not connected).{0,60}(connection|server)|connection.{0,60}(lost|closed|dropped|failed|error)/i.test(text);
              return !stillSubmitting && namesAConnectionFailure;
            },
            undefined,
            { timeout: 15000 },
          )
          .then(() => true)
          .catch(() => false);
        record("US-1.3", surfacedError ? "pass" : "fail", surfacedError ? "a command in flight when the socket drops fails visibly instead of hanging" : "no visible failure within 15s of a dropped socket — the action hangs silently");
        record("US-14.1a", surfacedError ? "pass" : "fail", surfacedError ? "project creation has a distinct visible failure state (transport failure)" : "project creation failure was not visibly distinguishable from success");
        if (surfacedError) await shot(dropPage, "US-1.3-socket-drop");
      } finally {
        await dropPage.close();
      }

      // ---- US-14.1: every async action has a distinct, visible failure UI ----
      // One page, one real thread, and a mutable set of command types to fail:
      // the route answers the targeted command with a real ok:false result
      // instead of forwarding it, so each action's own error path runs for
      // real. Reusing a single thread keeps this to one live agent session
      // rather than one per action.
      const matrixPage = await faultContext.newPage();
      try {
        const failing = new Set();
        const INJECTED = "INJECTED-AUDIT-FAILURE";
        await matrixPage.routeWebSocket(/\/ws$/, (route) => {
          const server = route.connectToServer();
          route.onMessage((message) => {
            try {
              const command = JSON.parse(message);
              if (failing.has(command.type)) {
                route.send(JSON.stringify({ type: "command.result", commandId: command.commandId, ok: false, error: `${INJECTED}: ${command.type}` }));
                return;
              }
            } catch {
              // Not a command we can parse — forward untouched.
            }
            server.send(message);
          });
        });

        // Asserts the banner names *this* command, not merely that some
        // injected error is on screen. Every one of these lands in the same
        // always-visible banner, and clearing it is a React state update
        // racing this poll — matching only the shared prefix would let a
        // stale "promote" message satisfy the "send" check.
        const failureVisible = async (commandType) =>
          matrixPage
            .waitForFunction((needle) => document.body.innerText.includes(needle), `${INJECTED}: ${commandType}`, { timeout: 8000 })
            .then(() => true)
            .catch(() => false);
        // Waits for the banner to actually be gone before the next check, so
        // no assertion can be satisfied by the previous one's message.
        const clearFailure = async () => {
          failing.clear();
          await matrixPage
            .waitForFunction((needle) => !document.body.innerText.includes(needle), INJECTED, { timeout: 8000 })
            .catch(() => undefined);
        };

        await matrixPage.goto(BASE_URL);
        await matrixPage.waitForSelector("text=/choose a workspace folder/i", { timeout: 20000 });

        // fs.list-directory — the folder browser's own failure path.
        failing.add("fs.list-directory");
        await matrixPage.getByRole("button", { name: /^up$/i }).click();
        record("US-14.1b", (await failureVisible("fs.list-directory")) ? "pass" : "fail", "directory listing failure is visibly surfaced");
        await clearFailure();

        // thread.create — reached via first-run, which creates a project then a thread.
        const matrixRepo = makeGitRepo("argusde-audit-matrix-");
        cleanupRepos.push(matrixRepo);
        failing.add("thread.create");
        await matrixPage.getByRole("button", { name: /type a path manually/i }).click();
        await matrixPage.getByLabel(/workspace path/i).fill(matrixRepo);
        await matrixPage.getByRole("button", { name: /^start$/i }).click();
        record("US-14.1c", (await failureVisible("thread.create")) ? "pass" : "fail", "thread creation failure is visibly surfaced");
        await clearFailure();

        // Now let a real thread through, and fail the thread-scoped actions on it.
        await matrixPage.getByRole("button", { name: /^start$/i }).click();
        await matrixPage.waitForSelector('input[placeholder*="Message" i]', { timeout: 25000 });

        failing.add("thread.set-mode");
        const matrixMode = matrixPage.getByLabel(/agent mode/i);
        if (await matrixMode.count()) {
          const values = await matrixMode.locator("option:not([disabled])").evaluateAll((els) => els.map((e) => e.value));
          const current = await matrixMode.inputValue();
          const other = values.find((v) => v !== current);
          if (other) {
            await matrixMode.selectOption(other);
            record("US-14.1d", (await failureVisible("thread.set-mode")) ? "pass" : "fail", "mode-switch failure is visibly surfaced");
          } else {
            record("US-14.1d", "skip", "agent advertises a single mode — nothing to switch to");
          }
        } else {
          record("US-14.1d", "skip", "no mode switcher — agent advertises no modes");
        }
        await clearFailure();

        failing.add("thread.promote-to-worktree");
        await matrixPage.getByRole("button", { name: /promote to worktree/i }).click();
        record("US-14.1e", (await failureVisible("thread.promote-to-worktree")) ? "pass" : "fail", "worktree-promotion failure is visibly surfaced");
        await clearFailure();

        failing.add("thread.send-message");
        const matrixInput = matrixPage.getByPlaceholder(/message/i);
        await matrixInput.fill("this send is going to fail");
        await matrixInput.press("Enter");
        record("US-14.1f", (await failureVisible("thread.send-message")) ? "pass" : "fail", "send-message failure is visibly surfaced");
        await clearFailure();

        // revert has its own distinct success path (closes the diff panel,
        // refreshes the strip), so its failure path is worth proving rather
        // than assuming the others cover it. It needs a real completed turn
        // to target — the send above was intercepted, so let one through.
        const realSend = matrixPage.getByPlaceholder(/message/i);
        await realSend.fill("Reply with only the word OK, no tools, no explanation.");
        await realSend.press("Enter");
        const gotTurn = await matrixPage
          .waitForSelector('button:has-text("Turn 1")', { timeout: 90000 })
          .then(() => true)
          .catch(() => false);
        if (gotTurn) {
          await matrixPage.getByRole("button", { name: /^turn 1/i }).click();
          await matrixPage.waitForSelector("text=/revert to this checkpoint/i", { timeout: 10000 });
          failing.add("thread.revert-checkpoint");
          await matrixPage.getByRole("button", { name: /revert to this checkpoint/i }).click();
          record("US-14.1h", (await failureVisible("thread.revert-checkpoint")) ? "pass" : "fail", "checkpoint-revert failure is visibly surfaced");
          await clearFailure();
        } else {
          record("US-14.1h", "skip", "no turn completed within 90s, so there was no checkpoint to attempt a revert against");
        }

        await scanA11y(matrixPage, "US-14.1");
        await shot(matrixPage, "US-14.1-action-failure");

        // Closing ends the thread, so it goes last — everything above needs
        // a live one.
        failing.add("thread.close");
        await matrixPage.getByRole("button", { name: /^close thread$/i }).click();
        record("US-14.1g", (await failureVisible("thread.close")) ? "pass" : "fail", "thread-close failure is visibly surfaced");
        await clearFailure();
      } finally {
        await matrixPage.close();
      }
      await faultContext.close();
    }

    // ---- US-1.4 / US-1.5: Electron's native connect screen ----
    // The Electron surface is the half of this regime the browser pages can't
    // reach at all. Runs once (not per viewport) — the connect screen is a
    // desktop-only chrome with no mobile variant.
    if (VIEWPORT !== "desktop") {
      record("US-1.4", "skip", "Electron connect screen is desktop-only chrome — checked on the desktop pass");
    } else if (!process.env.DISPLAY) {
      // Not silently skipped: this is the exact condition that made the
      // Electron suites look like flaky tests for a whole session.
      record("US-1.4", "skip", "no DISPLAY — Electron needs a display; re-run under `xvfb-run -a node scripts/ui-ux-audit/run.mjs`");
    } else {
      const electronUserData = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-audit-electron-"));
      let app;
      try {
        app = await electron.launch({
          args: [projectRoot, "--no-sandbox", "--disable-gpu", `--user-data-dir=${electronUserData}`],
          // A real closed port, not a mock — a genuine connection refusal.
          env: { ...process.env, ARGUSDE_SERVER_URL: "http://127.0.0.1:59999/" },
        });
        const win = await app.firstWindow();

        await win.waitForSelector('input[name="server-url"]', { timeout: 20000 });
        const onConnectScreen = win.url().includes("connect-screen");
        const hasConnectButton = (await win.$('button:has-text("Connect")')) !== null;
        record(
          "US-1.4a",
          onConnectScreen && hasConnectButton ? "pass" : "fail",
          `unreachable server falls back to the connect screen with a URL field and Connect button (screen: ${onConnectScreen}, button: ${hasConnectButton})`,
        );

        // Deliberately asserts #error, not the screen's static "Not
        // connected. Enter the address…" copy — that <p> is hardcoded in
        // index.html and renders unconditionally, so keying off it would pass
        // even if connect-failure reporting were entirely broken.
        const errorText = async () => (await win.textContent("#error").catch(() => ""))?.trim() ?? "";
        // Waits for the field to empty *then* refill, so an assertion can
        // never be satisfied by the previous attempt's message. The connect
        // screen clears synchronously on submit, but relying on that timing
        // is exactly the stale-read trap worth designing out.
        const awaitFreshError = async () => {
          await win
            .waitForFunction(() => (document.querySelector("#error")?.textContent ?? "").trim().length === 0, undefined, { timeout: 10000 })
            .catch(() => undefined);
          return win
            .waitForFunction(() => (document.querySelector("#error")?.textContent ?? "").trim().length > 0, undefined, { timeout: 20000 })
            .then(() => true)
            .catch(() => false);
        };

        await win.fill('input[name="server-url"]', "http://127.0.0.1:59998/");
        await win.click('button:has-text("Connect")');
        const reportedUnreachable = await awaitFreshError();
        record("US-1.4c", reportedUnreachable ? "pass" : "fail", reportedUnreachable ? `an unreachable server reports a real error: "${await errorText()}"` : "connecting to an unreachable server surfaced nothing in #error");

        // ---- US-14.2: a malformed URL resolves to a clear error, never a crash ----
        await win.fill('input[name="server-url"]', "not-a-url");
        await win.click('button:has-text("Connect")');
        const handledMalformed = await awaitFreshError();
        const windowSurvived = !win.isClosed() && win.url().includes("connect-screen");
        record(
          "US-14.2",
          handledMalformed && windowSurvived ? "pass" : "fail",
          handledMalformed && windowSurvived ? `a malformed URL is rejected with a visible error and the app stays up: "${await errorText()}"` : `malformed URL handling failed (error shown: ${handledMalformed}, still on connect screen: ${windowSurvived})`,
        );

        // Hands off to the shared web UI against the real live server — the
        // thing the hermetic Electron tests can't check, since they spin up
        // their own throwaway server.
        await win.fill('input[name="server-url"]', BASE_URL);
        await win.click('button:has-text("Connect")');
        const handedOff = await win
          .waitForSelector("text=/choose a workspace folder/i", { timeout: 25000 })
          .then(() => true)
          .catch(() => false);
        record("US-1.4b", handedOff ? "pass" : "fail", handedOff ? "a valid server URL hands off to the shared web UI" : "did not reach the shared web UI after connecting to the live server");
      } catch (error) {
        record("US-1.4", "fail", `Electron connect-screen check could not run: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await app?.close().catch(() => undefined);
        fs.rmSync(electronUserData, { recursive: true, force: true });
      }
    }

    // US-1.5 needs a server that deliberately reports a mismatched
    // API_VERSION. That's inherently synthetic — there's no live-server
    // signal to gain, which is the only thing this regime adds over the
    // hermetic suite, and that suite already asserts the message names both
    // versions. Recorded only on the desktop pass, matching US-1.4's gating:
    // both are Electron-only chrome.
    if (VIEWPORT === "desktop") {
      record("US-1.5", "skip", "version-mismatch needs a deliberately-wrong-version server, which gains nothing from running live; test/electron-connect-screen.test.ts asserts it directly");
    }

    // ---- US-4.3 / US-4.6 / US-7.3: stories that need a hostile agent ----
    // Each of these requires the agent to do something the live one never
    // will — prompt for permission, change mode unbidden, or die mid-turn.
    // They run against a throwaway server with its own database, port and
    // scripted agent, so nothing here can touch the user's instance.
    if (VIEWPORT !== "desktop") {
      record("US-4.6", "skip", "agent-behaviour stories run once, on the desktop pass");
    } else {
      let isolated;
      const isolatedRepo = makeGitRepo("argusde-audit-isolated-");
      const isolatedPage = await context.newPage();
      try {
        isolated = await startIsolatedServer({
          modes: { currentModeId: "default", availableModes: [{ id: "default", name: "Default" }, { id: "plan", name: "Plan" }] },
          steps: [
            { type: "permission-request", title: "Write config.json" },
            { type: "autonomous-mode-change", modeId: "plan" },
            { type: "message", text: "done" },
          ],
        });

        await isolatedPage.goto(isolated.url);
        await isolatedPage.getByRole("button", { name: /type a path manually/i }).click();
        await isolatedPage.getByLabel(/workspace path/i).fill(isolatedRepo);
        await isolatedPage.getByRole("button", { name: /^start$/i }).click();
        await isolatedPage.waitForSelector('input[placeholder*="Message" i]', { timeout: 20000 });

        const modeBefore = await isolatedPage.getByLabel(/agent mode/i).inputValue();

        const isolatedInput = isolatedPage.getByPlaceholder(/message/i);
        await isolatedInput.fill("do the thing");
        await isolatedInput.press("Enter");

        // ---- US-4.6: the prompt pauses the flow with distinct options ----
        const promptShown = await isolatedPage
          .waitForSelector("text=/Write config.json/i", { timeout: 20000 })
          .then(() => true)
          .catch(() => false);
        const allowBtn = isolatedPage.getByRole("button", { name: /^allow$/i });
        const rejectBtn = isolatedPage.getByRole("button", { name: /^reject$/i });
        const bothOptions = (await allowBtn.count()) > 0 && (await rejectBtn.count()) > 0;
        record("US-4.6a", promptShown && bothOptions ? "pass" : "fail", `permission request pauses with a titled prompt and distinct options (prompt: ${promptShown}, both options: ${bothOptions})`);
        if (promptShown) {
          await scanA11y(isolatedPage, "US-4.6");
          await shot(isolatedPage, "US-4.6-permission-prompt");
        }

        if (bothOptions) {
          await allowBtn.click();
          // The fixture echoes the outcome back, so this proves the *chosen*
          // option actually reached the agent — not merely that the prompt
          // went away.
          const outcomeReached = await isolatedPage
            .waitForFunction(() => /PERMISSION-OUTCOME:.*allow/.test(document.body.innerText), undefined, { timeout: 20000 })
            .then(() => true)
            .catch(() => false);
          const promptGone = (await isolatedPage.getByRole("button", { name: /^allow$/i }).count()) === 0;
          record("US-4.6b", outcomeReached && promptGone ? "pass" : "fail", `the selected option reaches the agent and the prompt resolves (outcome echoed: ${outcomeReached}, prompt cleared: ${promptGone})`);
        } else {
          record("US-4.6b", "skip", "no permission options rendered to choose from");
        }

        // ---- US-7.3: an agent-driven mode change lands live ----
        const modeSwitchedLive = await isolatedPage
          .waitForFunction(() => document.querySelector('select[aria-label="Agent mode"]')?.value === "plan", undefined, { timeout: 20000 })
          .then(() => true)
          .catch(() => false);
        const modeAfter = await isolatedPage.getByLabel(/agent mode/i).inputValue();
        record("US-7.3", modeSwitchedLive ? "pass" : "fail", `agent-driven mode change appeared without a refresh: ${modeBefore} -> ${modeAfter} (expected plan)`);
      } catch (error) {
        record("US-4.6a", "fail", `isolated-agent checks could not run: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await isolatedPage.close();
        await isolated?.close();
        fs.rmSync(isolatedRepo, { recursive: true, force: true });
      }

      // US-4.3 needs its own server: the agent must die, which ends that
      // server's usefulness for anything after it.
      let dropServer;
      const dropRepo = makeGitRepo("argusde-audit-agentdrop-");
      const agentDropPage = await context.newPage();
      try {
        dropServer = await startIsolatedServer({ steps: [{ type: "exit" }] });
        await agentDropPage.goto(dropServer.url);
        await agentDropPage.getByRole("button", { name: /type a path manually/i }).click();
        await agentDropPage.getByLabel(/workspace path/i).fill(dropRepo);
        await agentDropPage.getByRole("button", { name: /^start$/i }).click();
        await agentDropPage.waitForSelector('input[placeholder*="Message" i]', { timeout: 20000 });

        const dropInput = agentDropPage.getByPlaceholder(/message/i);
        await dropInput.fill("this kills the agent");
        await dropInput.press("Enter");

        // The connection banner must reflect the drop — the agent process is
        // gone, so the thread can no longer do anything, and saying nothing
        // would leave the user waiting on a reply that will never come.
        const bannerReflectsDrop = await agentDropPage
          .waitForFunction(() => /disconnected|error|closed|lost/i.test(document.body.innerText), undefined, { timeout: 25000 })
          .then(() => true)
          .catch(() => false);
        record("US-4.3", bannerReflectsDrop ? "pass" : "fail", bannerReflectsDrop ? "an agent that dies mid-turn is reflected in the connection banner" : "the agent died mid-turn and the UI said nothing");
        if (bannerReflectsDrop) await shot(agentDropPage, "US-4.3-agent-drop");
      } catch (error) {
        record("US-4.3", "fail", `agent-drop check could not run: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await agentDropPage.close();
        await dropServer?.close();
        fs.rmSync(dropRepo, { recursive: true, force: true });
      }
    }

    // ---- US-18: composer image attachments (spec #93 phase 7) ----
    // Needs an agent that actually advertises image support — the live agent's
    // real capability is whatever claude-agent-acp reports today, which this
    // audit has no business depending on. A dedicated fake-agent server is
    // started with ARGUSDE_FAKE_AGENT_PROMPT_CAPABILITIES set: the same
    // mechanism test/web-smoke.test.ts and test/electron-smoke.test.ts already
    // use for ARGUSDE_FAKE_AGENT_STEPS — startIsolatedServer's spawned agent
    // gets `...process.env` forwarded into it, so setting the var here before
    // calling in is enough; nothing in helpers.mjs or the fixture needs to
    // change. Runs at every viewport (unlike the desktop-only hostile-agent
    // block above) so the mobile no-horizontal-scroll check has something to
    // check.
    {
      const previousPromptCapabilities = process.env.ARGUSDE_FAKE_AGENT_PROMPT_CAPABILITIES;
      process.env.ARGUSDE_FAKE_AGENT_PROMPT_CAPABILITIES = JSON.stringify({ image: true });
      let attachServer;
      const attachRepo = makeGitRepo("argusde-audit-attach-");
      const attachPage = await context.newPage();
      const tmpAttachDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-audit-attach-files-"));
      try {
        attachServer = await startIsolatedServer({ steps: [{ type: "message", text: "got it" }] });
        await attachPage.goto(attachServer.url);
        await attachPage.getByRole("button", { name: /type a path manually/i }).click();
        await attachPage.getByLabel(/workspace path/i).fill(attachRepo);
        await attachPage.getByRole("button", { name: /^start$/i }).click();
        await attachPage.waitForSelector('input[placeholder*="Message" i]', { timeout: 20000 });

        const attachControl = attachPage.getByLabel(/attach an image/i);
        const controlOffered = await attachControl.count();
        record(
          "US-18.setup",
          controlOffered > 0 ? "pass" : "fail",
          `attach control rendered for an agent advertising image support: ${controlOffered > 0}`,
        );

        if (controlOffered > 0) {
          // A genuine, tiny, decodable PNG — createImageBitmap has to succeed
          // on it for the real attach path (the canvas re-encode) to run at
          // all, not just for the change event to fire.
          const pngPath = path.join(tmpAttachDir, "sample.png");
          fs.writeFileSync(
            pngPath,
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
              "base64",
            ),
          );

          // setInputFiles works on the sr-only file input directly — the
          // composer wraps it in a styled <label> exactly so a hidden-but-
          // focusable input keeps working for both pointer and keyboard, and
          // that's also what makes it reachable without ever making it
          // visible.
          await attachControl.setInputFiles(pngPath);
          const thumbnail = attachPage.locator('[data-slot="attachment-media"] img[alt="sample.png"]');
          const thumbnailShown = await thumbnail
            .waitFor({ state: "visible", timeout: 10000 })
            .then(() => true)
            .catch(() => false);
          record(
            "US-18.1",
            thumbnailShown ? "pass" : "fail",
            thumbnailShown ? "attaching a supported image shows a named thumbnail in the strip" : "no thumbnail appeared after attaching a supported image",
          );
          if (thumbnailShown) {
            await scanA11y(attachPage, "US-18.1");
            await shot(attachPage, "US-18.1-attached");
          }

          // ---- US-18.2: removing it clears the strip ----
          const removeBtn = attachPage.getByRole("button", { name: "Remove sample.png" });
          if (await removeBtn.count()) {
            await removeBtn.click();
            const strippedAway = await thumbnail
              .waitFor({ state: "detached", timeout: 5000 })
              .then(() => true)
              .catch(() => false);
            record(
              "US-18.2",
              strippedAway ? "pass" : "fail",
              strippedAway ? "\"Remove <filename>\" takes the attachment back out of the strip" : "thumbnail remained after clicking its Remove control",
            );
          } else {
            record("US-18.2", "fail", "no \"Remove sample.png\" control found next to the thumbnail");
          }

          // ---- US-18.3: an attachment the agent side will refuse shows the reason ----
          // A plain-text file fails the type check before capability or size
          // ever come into it — the simplest genuine refusal to provoke
          // without also having to synthesize an over-the-limit image.
          const badPath = path.join(tmpAttachDir, "not-an-image.txt");
          fs.writeFileSync(badPath, "not a picture\n");
          await attachControl.setInputFiles(badPath);
          const refusal = attachPage.getByRole("alert").filter({ hasText: /can't be attached/i });
          const refusalShown = await refusal
            .waitFor({ state: "visible", timeout: 10000 })
            .then(() => true)
            .catch(() => false);
          const refusalText = refusalShown ? (await refusal.first().textContent())?.trim() : undefined;
          record(
            "US-18.3",
            refusalShown ? "pass" : "fail",
            refusalShown ? `refused attachment shows its reason: "${refusalText}"` : "no role=alert refusal reason appeared for an unsupported file type",
          );
          if (refusalShown) {
            await scanA11y(attachPage, "US-18.3");
            await shot(attachPage, "US-18.3-refused");
          }

          await checkNoHorizontalScroll(attachPage, "US-18.4");
        } else {
          record("US-18.1", "skip", "attach control never rendered — could not attach an image to check");
          record("US-18.2", "skip", "attach control never rendered — nothing to remove");
          record("US-18.3", "skip", "attach control never rendered — could not trigger a refusal");
        }
      } catch (error) {
        record("US-18.throw", "fail", `composer attachment checks could not run: ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        await attachPage.close();
        await attachServer?.close();
        fs.rmSync(attachRepo, { recursive: true, force: true });
        fs.rmSync(tmpAttachDir, { recursive: true, force: true });
        if (previousPromptCapabilities === undefined) delete process.env.ARGUSDE_FAKE_AGENT_PROMPT_CAPABILITIES;
        else process.env.ARGUSDE_FAKE_AGENT_PROMPT_CAPABILITIES = previousPromptCapabilities;
      }
    }

    // ---- US-11: `argusde serve` startup output ----
    // Spawned on its own ephemeral port so it can't disturb the live server
    // this audit is running against.
    const probePort = 4900 + (process.pid % 90);
    const serveOutput = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["dist/server/cli.js", "serve", "--host", "0.0.0.0", "--port", String(probePort)], {
        cwd: projectRoot,
      });
      let out = "";
      const done = (value) => {
        child.kill("SIGTERM");
        resolve(value);
      };
      child.stdout.on("data", (chunk) => {
        out += String(chunk);
        if (/listening at/i.test(out)) setTimeout(() => done(out), 1200);
      });
      child.stderr.on("data", (chunk) => (out += String(chunk)));
      child.on("error", () => resolve(out));
      setTimeout(() => done(out), 15000);
    });

    const boundToRequestedHost = new RegExp(`listening at http://0\\.0\\.0\\.0:${probePort}/`, "i").test(serveOutput);
    record("US-11.2a", boundToRequestedHost ? "pass" : "fail", boundToRequestedHost ? "a non-default --host is honoured and reported in the startup line" : `startup line did not report the requested host/port (got: ${serveOutput.split("\n")[0] ?? ""})`);

    const skippedTailscale = !/Remote access via Tailscale/i.test(serveOutput);
    record("US-11.2b", skippedTailscale ? "pass" : "fail", skippedTailscale ? "Tailscale wiring skipped for a non-loopback --host, with no error" : "Tailscale wiring was attempted despite a non-loopback --host");

    // ---- US-11.1: startup prints a scannable QR code and the plain MagicDNS URL ----
    // Driven against a stub `tailscale` on PATH rather than the real one. The
    // machine's actual tailnet already has a mapping on the live port, so the
    // server would correctly take its skip-to-avoid-overwriting branch — and
    // provoking the real path would mean mutating the user's tailscale serve
    // config, which an audit has no business doing. The stub answers the three
    // queries cli.ts makes, so what's exercised is ArgusDE's own output logic.
    const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-audit-tsstub-"));
    try {
      const stubDnsName = "audit-stub-host.example-tailnet.ts.net";
      fs.writeFileSync(
        path.join(stubDir, "tailscale"),
        [
          "#!/bin/sh",
          'if [ "$1" = "status" ]; then',
          `  echo '{"BackendState":"Running","Self":{"DNSName":"${stubDnsName}."}}'`,
          "  exit 0",
          "fi",
          'if [ "$1" = "serve" ] && [ "$2" = "status" ]; then',
          `  echo '{"TCP":{}}'`,
          "  exit 0",
          "fi",
          "exit 0",
          "",
        ].join("\n"),
        { mode: 0o755 },
      );

      const qrPort = 4960 + (process.pid % 30);
      const tailscaleOutput = await new Promise((resolve) => {
        const child = spawn(process.execPath, ["dist/server/cli.js", "serve", "--port", String(qrPort)], {
          cwd: projectRoot,
          env: { ...process.env, PATH: `${stubDir}:${process.env.PATH ?? ""}` },
        });
        let out = "";
        const done = () => {
          child.kill("SIGTERM");
          resolve(out);
        };
        child.stdout.on("data", (chunk) => {
          out += String(chunk);
          if (/Remote access via Tailscale/i.test(out)) setTimeout(done, 1200);
        });
        child.stderr.on("data", (chunk) => (out += String(chunk)));
        child.on("error", () => resolve(out));
        setTimeout(done, 15000);
      });

      const expectedUrl = `https://${stubDnsName}:${qrPort}/`;
      const printedUrl = tailscaleOutput.includes(expectedUrl);
      // qrcode-terminal draws with half-block glyphs — their presence is what
      // makes the code scannable rather than just a URL echoed twice.
      const printedQr = /[\u2580-\u259F]/.test(tailscaleOutput);
      record(
        "US-11.1",
        printedUrl && printedQr ? "pass" : "fail",
        `startup prints the plain MagicDNS URL (${printedUrl}) and a rendered QR code (${printedQr})`,
      );
    } finally {
      fs.rmSync(stubDir, { recursive: true, force: true });
    }

    console.log("\nConsole errors observed during run:", consoleErrors.length);
    if (consoleErrors.length > 0) {
      record("US-console-errors", "fail", consoleErrors.slice(0, 5).join(" | "));
    } else {
      record("US-console-errors", "pass", "no console errors observed");
    }
  } finally {
    await browser.close();
    // Server-side records first, while the paths are still known, then the
    // fixture directories themselves.
    const allFixtures = [gitRepo, nonGitRepo, worktreeRepo, ...cleanupRepos].filter(Boolean);
    await deleteAuditProjects(allFixtures);
    for (const dir of allFixtures) {
      fs.rmSync(dir, { recursive: true, force: true });
      fs.rmSync(`${dir}-worktrees`, { recursive: true, force: true });
    }
  }

  const summary = printSummary();
  process.exitCode = summary.fail > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error("AUDIT SCRIPT CRASHED:", err);
  process.exit(1);
});
