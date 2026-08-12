import { app, BrowserWindow } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { IpcRelay } from "./ipc-relay.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// WSLg's Wayland/sandbox setup (ELECTRON_OZONE_PLATFORM_HINT, WAYLAND_DISPLAY,
// no-sandbox) has to be in the environment before Electron's native process
// starts — see bin/launch-linux.sh, which `pnpm start`/`pnpm package` invoke
// instead of the electron binary directly. Setting it here via process.env
// or app.commandLine is too late: Chromium's Ozone platform selection
// happens during early native init, before this file's top-level code runs.
// (Confirmed empirically: window registers and shows a first frame, but
// never repaints after — the wayland connection was already made against
// the wrong/no socket by the time process.env took effect.)

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
