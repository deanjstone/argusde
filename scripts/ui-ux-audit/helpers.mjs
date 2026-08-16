// Shared helpers for the AFK UI/UX audit regime (docs/testing/ui-ux-user-stories.md).
// Plain JS, not TS — this is a standalone operational tool, not part of the
// vitest/tsc pipeline, matching test/fixtures/fake-agent-cli.mjs's precedent.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PNG } from "pngjs";
import pixelmatch from "pixelmatch";
import AxeBuilder from "@axe-core/playwright";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ARTIFACT_DIR = path.join(__dirname, "artifacts");
export const BASELINE_DIR = path.join(ARTIFACT_DIR, "baselines");
export const SCREENSHOT_DIR = path.join(ARTIFACT_DIR, "screenshots");
export const DIFF_DIR = path.join(ARTIFACT_DIR, "diffs");

fs.mkdirSync(BASELINE_DIR, { recursive: true });
fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
fs.mkdirSync(DIFF_DIR, { recursive: true });

const results = [];

export function record(storyId, status, detail) {
  results.push({ storyId, status, detail: detail ?? "" });
  const marker = { pass: "✓", fail: "✗", skip: "○" }[status] ?? "?";
  console.log(`${marker} ${storyId}: ${status}${detail ? " — " + detail : ""}`);
}

export function getResults() {
  return results;
}

export function printSummary() {
  const pass = results.filter((r) => r.status === "pass").length;
  const fail = results.filter((r) => r.status === "fail").length;
  const skip = results.filter((r) => r.status === "skip").length;
  console.log(`\n=== Summary: ${pass} pass, ${fail} fail, ${skip} skip (${results.length} total) ===`);
  if (fail > 0) {
    console.log("\nFailures:");
    for (const r of results.filter((r) => r.status === "fail")) {
      console.log(`  ${r.storyId}: ${r.detail}`);
    }
  }
  return { pass, fail, skip, results };
}

/** Runs an axe-core scan and records US-13.x-style violations against storyId. Returns the violation list. */
export async function scanA11y(page, storyId) {
  const results = await new AxeBuilder({ page }).analyze();
  const violations = results.violations ?? [];
  if (violations.length === 0) {
    record(`${storyId}.a11y`, "pass", "no axe violations");
  } else {
    const summary = violations.map((v) => `${v.id} (${v.impact}, ${v.nodes.length} nodes)`).join("; ");
    record(`${storyId}.a11y`, "fail", summary);
  }
  return violations;
}

/**
 * Screenshots the page, compares against a saved baseline (creating one on
 * first run rather than failing), and records a visual-diff result. A
 * missing baseline is NOT a failure — it's how the first run establishes
 * ground truth for every subsequent run to diff against.
 */
export async function screenshotAndDiff(page, storyId, options = {}) {
  const filename = `${storyId}.png`;
  const currentPath = path.join(SCREENSHOT_DIR, filename);
  const baselinePath = path.join(BASELINE_DIR, filename);

  await page.screenshot({ path: currentPath, fullPage: options.fullPage ?? false });

  if (!fs.existsSync(baselinePath)) {
    fs.copyFileSync(currentPath, baselinePath);
    record(`${storyId}.visual`, "pass", "baseline created (first run)");
    return;
  }

  const current = PNG.sync.read(fs.readFileSync(currentPath));
  const baseline = PNG.sync.read(fs.readFileSync(baselinePath));

  if (current.width !== baseline.width || current.height !== baseline.height) {
    record(`${storyId}.visual`, "fail", `dimension mismatch: baseline ${baseline.width}x${baseline.height} vs current ${current.width}x${current.height}`);
    return;
  }

  const diff = new PNG({ width: current.width, height: current.height });
  const diffPixels = pixelmatch(baseline.data, current.data, diff.data, current.width, current.height, { threshold: 0.15 });
  const totalPixels = current.width * current.height;
  const diffRatio = diffPixels / totalPixels;

  if (diffRatio > 0.02) {
    fs.writeFileSync(path.join(DIFF_DIR, filename), PNG.sync.write(diff));
    record(`${storyId}.visual`, "fail", `${(diffRatio * 100).toFixed(2)}% pixels differ from baseline (diff saved)`);
  } else {
    record(`${storyId}.visual`, "pass", `${(diffRatio * 100).toFixed(3)}% pixels differ (within threshold)`);
  }
}

export async function waitForToast() {
  // placeholder no-op reserved for future use; keeps helper surface stable
}

/**
 * Boots a throwaway ArgusDE server backed by the controllable fake agent.
 *
 * A handful of stories can only be reached by doing something destructive to
 * the agent — making it prompt for permission, change mode on its own, or die
 * mid-turn. None of that is acceptable against the live server the user is
 * also working in, and the live agent runs in auto-permission mode anyway, so
 * it never prompts. This gives those checks their own server, database, port
 * and agent, disposed at the end.
 *
 * Imports the built server directly (dist/) rather than shelling out to the
 * CLI, because the CLI hard-codes ~/.argusde/argusde.sqlite — an isolated
 * instance must never touch the real database.
 */
export async function startIsolatedServer({ steps = [], modes } = {}) {
  const { EventStore } = await import("../../dist/server/persistence/event-store.js");
  const { CheckpointStore } = await import("../../dist/server/checkpoint/checkpoint-store.js");
  const { startWsServer } = await import("../../dist/server/ws/ws-server.js");
  const { AcpSession } = await import("../../dist/utility/acp-session.js");
  const { spawnAgentProcessTransport } = await import("../../dist/utility/spawn-agent-process.js");

  const repoRoot = path.resolve(__dirname, "../..");
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-audit-isolated-db-"));
  const eventStore = new EventStore(path.join(dbDir, "argusde.sqlite"));
  const checkpointStore = new CheckpointStore();

  const server = await startWsServer({
    host: "127.0.0.1",
    port: 0,
    eventStore,
    checkpointStore,
    webDistDir: path.join(repoRoot, "dist/web"),
    createSession: (_threadId, cwd) =>
      new AcpSession({
        name: "argusde-audit-isolated",
        cwd,
        createTransport: () =>
          spawnAgentProcessTransport({
            command: process.execPath,
            args: [path.join(repoRoot, "test/fixtures/fake-agent-cli.mjs")],
            cwd,
            env: {
              ...process.env,
              ARGUSDE_FAKE_AGENT_STEPS: JSON.stringify(steps),
              ...(modes ? { ARGUSDE_FAKE_AGENT_MODES: JSON.stringify(modes) } : {}),
            },
          }),
      }),
  });

  return {
    url: `http://127.0.0.1:${server.port}/`,
    async close() {
      await server.close();
      eventStore.close();
      fs.rmSync(dbDir, { recursive: true, force: true });
    },
  };
}

/** US-12.3: no horizontal scrollbar/clipped content at the current viewport. */
export async function checkNoHorizontalScroll(page, storyId) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  record(storyId, overflow <= 1 ? "pass" : "fail", overflow <= 1 ? "no horizontal overflow" : `scrollWidth exceeds clientWidth by ${overflow}px`);
}
