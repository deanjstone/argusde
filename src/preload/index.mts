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

contextBridge.exposeInMainWorld("argusdeConnect", api);

export type ArgusDeConnectApi = typeof api;
