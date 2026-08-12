import { app, BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IpcRelay } from "./ipc-relay.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Under WSLg, Electron/Chromium's XWayland presentation path silently fails
// to hand composited frames to WSLg's RDP/RAIL compositor: the window
// registers (taskbar icon, correct geometry) and Chromium paints internally
// (confirmed via CDP screenshot) but nothing ever reaches the screen. Native
// Wayland doesn't hit this path. Detected via /mnt/wslg rather than
// WAYLAND_DISPLAY/WSL_DISTRO_NAME, since those don't reliably propagate
// through detached/non-interactive launches. Also requires DISPLAY to be
// unset or WSLg's own :0 — /mnt/wslg is a WSL2-wide mount present even
// under a headless xvfb-run session (DISPLAY=:99), which must keep using
// its own virtual X server, not WSLg's real Wayland socket.
const display = process.env.DISPLAY;
if (
  process.platform === "linux" &&
  (display === undefined || display === ":0") &&
  fs.existsSync("/mnt/wslg")
) {
  process.env.WAYLAND_DISPLAY ??= "wayland-0";
  process.env.XDG_RUNTIME_DIR ??= "/mnt/wslg/runtime-dir";
  app.commandLine.appendSwitch("ozone-platform", "wayland");
  // Required under WSL2 regardless of display backend: no CAP_SYS_ADMIN /
  // user namespaces for Electron's sandbox helper.
  app.commandLine.appendSwitch("no-sandbox");
}

let mainWindow: BrowserWindow | null = null;
const relay = new IpcRelay();

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1000,
    height: 720,
    webPreferences: {
      preload: path.join(__dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      // Electron's *sandboxed* preload loader doesn't support ES modules
      // (confirmed empirically: `sandbox: true` here fails to load an ESM
      // preload script even with the required .mjs extension). contextBridge
      // + contextIsolation is what actually keeps the renderer off Node/
      // Electron APIs directly — sandbox: false only affects the preload
      // script's own process privileges, not what it exposes to the page.
      sandbox: false,
    },
  });

  relay.start(mainWindow.webContents, {
    cwd: process.env.ARGUSDE_WORKSPACE_CWD ?? app.getPath("home"),
  });

  const devServerUrl = process.env.ARGUSDE_DEV_SERVER_URL;
  if (devServerUrl) {
    void mainWindow.loadURL(devServerUrl);
  } else {
    void mainWindow.loadFile(path.join(__dirname, "../renderer/index.html"));
  }

  mainWindow.on("closed", () => {
    relay.stop();
    mainWindow = null;
  });
}

void app.whenReady().then(() => {
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
