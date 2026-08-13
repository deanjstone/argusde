import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { _electron as electron, type ElectronApplication, type Page } from "playwright";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, "..");

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

  beforeAll(async () => {
    app = await electron.launch({
      args: [projectRoot, "--no-sandbox", "--disable-gpu"],
      // Port 59999 is outside Chromium's restricted-ports list and nothing
      // in this test suite ever listens on it — a real connection refusal,
      // not a mock.
      env: { ...process.env, ARGUSDE_SERVER_URL: "http://127.0.0.1:59999/" },
    });
    window = await app.firstWindow();
  }, 20_000);

  afterAll(async () => {
    await app?.close();
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
});
