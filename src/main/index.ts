import { app, BrowserWindow, ipcMain } from "electron";
import type { IpcMainEvent, IpcMainInvokeEvent } from "electron";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getServerUrl, setServerUrl } from "./server-config.js";
import { IPC_CONNECT_FAILED, IPC_GET_SERVER_URL, IPC_RETRY_CONNECT, IPC_SET_SERVER_URL } from "./connect-screen-ipc.js";

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

const CONNECT_SCREEN_PATH = path.join(__dirname, "../connect-screen/index.html");
const CONNECT_SCREEN_URL = pathToFileURL(CONNECT_SCREEN_PATH).href;
const ERR_ABORTED = -3;

let mainWindow: BrowserWindow | null = null;

/**
 * The server URL this session is currently pointed at. `ARGUSDE_SERVER_URL`
 * only seeds the *initial* value (dev/testing override, same pattern as
 * ARGUSDE_AGENT_COMMAND elsewhere in this codebase) — once the user sets a
 * URL via the connect screen, that becomes authoritative for the rest of
 * the session, not re-read from the env var on every retry. It's only
 * persisted to disk once a connection to it actually succeeds (see
 * did-finish-load below) — not eagerly when the user clicks Connect, so a
 * bad URL can never overwrite a previously-working persisted config.
 */
let currentServerUrl: string;

/**
 * The connect screen must only ever be driven by itself — the preload
 * script already refuses to expose `window.argusdeConnect` to any page
 * except the connect screen (see src/preload/index.mts), but these
 * ipcMain handlers are a second, independent line of defense: without it,
 * a forged IPC message claiming to come from the remote server-served page
 * could still reach these handlers directly.
 */
function isFromConnectScreen(event: IpcMainEvent | IpcMainInvokeEvent): boolean {
  return event.senderFrame?.url === CONNECT_SCREEN_URL;
}

function attemptConnect(window: BrowserWindow, url: string): void {
  // loadURL()'s own promise rejects on failure — a separate signal from the
  // did-fail-load event below, which is what actually drives showing the
  // connect screen. Without this catch, a bad URL produces an unhandled
  // promise rejection warning on every failed attempt.
  window.loadURL(url).catch(() => undefined);
}

async function showConnectScreen(window: BrowserWindow, failureMessage: string): Promise<void> {
  if (window.isDestroyed()) return;
  try {
    // Send the failure only after the connect screen has actually loaded
    // (not before navigating to it) — its onConnectFailed listener is
    // registered by that page's own script, not by whatever just failed.
    await window.loadFile(CONNECT_SCREEN_PATH);
    if (!window.isDestroyed()) window.webContents.send(IPC_CONNECT_FAILED, failureMessage);
  } catch {
    // The connect screen itself failed to load — e.g. a packaging issue, or
    // the window was closed mid-navigation (loadFile can also throw
    // synchronously in that case, which this try/catch covers too, not
    // just a rejected promise). Nothing more to do; the window is left on
    // whatever it last successfully rendered.
  }
}

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
  const window = mainWindow;

  window.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame) return; // a sub-resource failure, not the page itself
    if (errorCode === ERR_ABORTED) return; // a superseded/cancelled navigation, not a real connection failure
    if (validatedURL === CONNECT_SCREEN_URL) return; // the connect screen itself failed to load — don't loop back into it

    void showConnectScreen(window, `Couldn't reach ${validatedURL}: ${errorDescription}`);
  });

  window.webContents.on("did-finish-load", () => {
    const loadedUrl = window.webContents.getURL();
    if (loadedUrl !== CONNECT_SCREEN_URL && loadedUrl === currentServerUrl) {
      setServerUrl(app.getPath("userData"), currentServerUrl);
    }
  });

  attemptConnect(window, currentServerUrl);

  window.on("closed", () => {
    mainWindow = null;
  });
}

ipcMain.handle(IPC_GET_SERVER_URL, (event) => {
  if (!isFromConnectScreen(event)) return undefined;
  return currentServerUrl;
});

ipcMain.handle(IPC_SET_SERVER_URL, (event, url: string) => {
  if (!isFromConnectScreen(event)) return;
  currentServerUrl = url;
});

ipcMain.on(IPC_RETRY_CONNECT, (event) => {
  if (!isFromConnectScreen(event)) return;
  if (mainWindow) attemptConnect(mainWindow, currentServerUrl);
});

void app.whenReady().then(() => {
  currentServerUrl = process.env.ARGUSDE_SERVER_URL ?? getServerUrl(app.getPath("userData"));

  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
