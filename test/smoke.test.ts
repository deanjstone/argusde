import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

/**
 * Exercises main + the utility process + the renderer together for one
 * minimal round trip, per the spec's testing decision: the IPC relay isn't
 * unit-tested at the seam level (it's thin glue), so this smoke test is its
 * only coverage. Launches the real built app (dist/) with the utility
 * process's agent command pointed at a fixture ACP agent over real stdio
 * instead of the real Claude Code CLI, so it has no external dependency.
 *
 * Requires a display (a real one, or Xvfb on Linux) — run under `xvfb-run`
 * in headless environments.
 */
describe("smoke: main + utility process + renderer round trip", () => {
  let app: ElectronApplication;
  let window: Page;

  beforeAll(async () => {
    app = await electron.launch({
      args: [projectRoot, "--no-sandbox", "--disable-gpu"],
      env: {
        ...process.env,
        ARGUSDE_AGENT_COMMAND: process.execPath,
        ARGUSDE_AGENT_ARGS: JSON.stringify([path.join(projectRoot, "test/fixtures/fake-agent-cli.mjs")]),
        ARGUSDE_FAKE_AGENT_STEPS: JSON.stringify([{ type: "message", text: "Hello from the smoke test agent" }]),
      },
    });
    window = await app.firstWindow();
  }, 30_000);

  afterAll(async () => {
    await app?.close();
  });

  it("sends a message and sees the agent's reply rendered in the chat UI", async () => {
    await window.waitForSelector(".chat-input input", { state: "visible" });
    // Wait for the ACP session to actually connect before sending — the
    // connection-status banner unmounts once `connectionState` reaches
    // "connected" (see ConnectionStatus.tsx).
    await window.waitForSelector(".connection-status", { state: "detached", timeout: 15_000 });

    await window.fill(".chat-input input", "hi there");
    await window.click(".chat-input button[type=submit]");

    await window.waitForSelector("text=Hello from the smoke test agent", { timeout: 15_000 });

    const timelineText = await window.textContent(".message-list");
    expect(timelineText).toContain("hi there");
    expect(timelineText).toContain("Hello from the smoke test agent");
  }, 30_000);
});
