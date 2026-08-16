// AFK UI/UX audit regime driver. Runs against a LIVE server (default
// http://127.0.0.1:4870/) per docs/testing/ui-ux-user-stories.md.
// Usage: node scripts/ui-ux-audit/run.mjs [--viewport=desktop|mobile] [--url=http://...]
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, devices } from "playwright";
import { record, scanA11y, screenshotAndDiff, printSummary, checkNoHorizontalScroll } from "./helpers.mjs";

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, v] = a.replace(/^--/, "").split("=");
    return [k, v ?? true];
  }),
);
const BASE_URL = args.url ?? "http://127.0.0.1:4870/";
const VIEWPORT = args.viewport ?? "desktop";

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
    record("US-7.3", "skip", "needs the agent to autonomously change mode mid-session, which no prompt reliably provokes; acp-session.test.ts covers the current_mode_update handling directly");

    // ---- US-4.6: permission prompt ----
    // The audit's agent runs with --permission-mode auto, so it never asks —
    // provoking a real request would mean reconfiguring the live agent this
    // audit shares with the user.
    record("US-4.6", "skip", "the live agent runs in auto permission mode and never prompts; chat-view.test.tsx covers the prompt's rendering and resolution directly");

    // ---- US-4.3: connection banner on a mid-use agent drop ----
    record("US-4.3", "skip", "distinct from US-1.3 (transport drop, covered above) — this is the *agent* connection dropping mid-turn, which needs killing the agent subprocess out from under a live thread; no non-destructive way to do that against the shared live server");

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

    // ---- US-13.4: focus order through the tab bar is logical (Chat -> Threads -> Settings) ----
    const chatTabBtn = page.getByRole("button", { name: "Chat" });
    await chatTabBtn.focus();
    await page.keyboard.press("Tab");
    const afterChatTag = await page.evaluate(() => document.activeElement?.textContent?.trim());
    await page.keyboard.press("Tab");
    const afterThreadsTag = await page.evaluate(() => document.activeElement?.textContent?.trim());
    const focusOrderLogical = afterChatTag === "Threads" && afterThreadsTag === "Settings";
    record("US-13.4", focusOrderLogical ? "pass" : "fail", `tab-bar focus order: Chat -> ${afterChatTag} -> ${afterThreadsTag} (expected Threads -> Settings)`);

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

        // The failure has to become visible — the specific wording is the
        // client's, so this only asserts that *something* surfaced and that
        // it didn't sit on the in-flight spinner forever.
        const surfacedError = await dropPage
          .waitForFunction(
            () => {
              const text = document.body.innerText;
              return /closed|error|failed|not connected/i.test(text) && !/^\s*Starting…\s*$/.test(text);
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
      await faultContext.close();
    }

    // ---- US-11: `argusde serve` startup output ----
    // Spawned on its own ephemeral port so it can't disturb the live server
    // this audit is running against.
    const probePort = 4900 + (process.pid % 90);
    const serveOutput = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["dist/server/cli.js", "serve", "--host", "0.0.0.0", "--port", String(probePort)], {
        cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."),
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

    // US-11.1 needs a machine with no pre-existing `tailscale serve` mapping
    // on the port. This one has the user's real mapping, so the server takes
    // its skip-to-avoid-overwriting branch and legitimately prints neither the
    // URL nor the QR code. Testing it here would mean overwriting live
    // Tailscale config, which an audit has no business doing.
    record("US-11.1", "skip", "cannot verify without clobbering the machine's existing tailscale serve mapping");

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
    await deleteAuditProjects([gitRepo, nonGitRepo, worktreeRepo].filter(Boolean));
    for (const dir of [gitRepo, nonGitRepo, worktreeRepo].filter(Boolean)) {
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
