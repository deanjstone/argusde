// Shared helpers for the AFK UI/UX audit regime (docs/testing/ui-ux-user-stories.md).
// Plain JS, not TS — this is a standalone operational tool, not part of the
// vitest/tsc pipeline, matching test/fixtures/fake-agent-cli.mjs's precedent.
import fs from "node:fs";
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

/** US-12.3: no horizontal scrollbar/clipped content at the current viewport. */
export async function checkNoHorizontalScroll(page, storyId) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  record(storyId, overflow <= 1 ? "pass" : "fail", overflow <= 1 ? "no horizontal overflow" : `scrollWidth exceeds clientWidth by ${overflow}px`);
}
