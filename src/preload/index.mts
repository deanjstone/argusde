/// <reference lib="dom" />
// Preload scripts run in a page-like context with real window/document/
// location globals, even though this file is compiled under
// tsconfig.node.json (no DOM lib, since main/server/utility genuinely are
// Node-only) — pull in just the DOM lib for this one file rather than
// changing that shared tsconfig.
import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import {
  IPC_CONNECT_FAILED,
  IPC_GET_SERVER_URL,
  IPC_RETRY_CONNECT,
  IPC_SET_SERVER_URL,
} from "../main/connect-screen-ipc.js";

/**
 * A much smaller bridge than the MVP's — the shared web UI (src/web/) talks
 * straight to the server over its own WebSocket (WsClient), no Electron API
 * involved. This preload backs only the connect screen (src/connect-screen/),
 * which is the one piece of UI that isn't server-served.
 */
const api = {
  getServerUrl(): Promise<string> {
    return ipcRenderer.invoke(IPC_GET_SERVER_URL);
  },
  setServerUrl(url: string): Promise<void> {
    return ipcRenderer.invoke(IPC_SET_SERVER_URL, url);
  },
  retryConnect(): void {
    ipcRenderer.send(IPC_RETRY_CONNECT);
  },
  onConnectFailed(listener: (message: string) => void): () => void {
    const handler = (_event: IpcRendererEvent, message: string): void => listener(message);
    ipcRenderer.on(IPC_CONNECT_FAILED, handler);
    return () => ipcRenderer.removeListener(IPC_CONNECT_FAILED, handler);
  },
};

// This preload attaches to every navigation in the window — both the
// locally-bundled connect screen (file://) and whatever the configured
// server serves (typically http://, possibly over a plain Tailscale
// connection). Only expose the bridge on the connect screen itself: the
// remote page has no legitimate use for setServerUrl/retryConnect, and
// without this guard a malicious or compromised server could silently
// repoint and persist the app's own connection config.
if (location.protocol === "file:") {
  contextBridge.exposeInMainWorld("argusdeConnect", api);
}

export type ArgusDeConnectApi = typeof api;
