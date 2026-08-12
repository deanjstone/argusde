import { contextBridge, ipcRenderer } from "electron";
import type { IpcRendererEvent } from "electron";
import {
  IPC_RESPOND_PERMISSION_CHANNEL,
  IPC_RESTART_SESSION_CHANNEL,
  IPC_SEND_MESSAGE_CHANNEL,
  IPC_SESSION_EVENT_CHANNEL,
} from "../shared/ipc-contract.js";
import type { AcpSessionEvent, PermissionOutcome } from "../shared/acp-events.js";

const api = {
  onSessionEvent(listener: (event: AcpSessionEvent) => void): () => void {
    const handler = (_event: IpcRendererEvent, payload: AcpSessionEvent): void => listener(payload);
    ipcRenderer.on(IPC_SESSION_EVENT_CHANNEL, handler);
    return () => ipcRenderer.removeListener(IPC_SESSION_EVENT_CHANNEL, handler);
  },
  sendMessage(text: string): Promise<void> {
    return ipcRenderer.invoke(IPC_SEND_MESSAGE_CHANNEL, text);
  },
  respondToPermission(requestId: string, outcome: PermissionOutcome): Promise<void> {
    return ipcRenderer.invoke(IPC_RESPOND_PERMISSION_CHANNEL, requestId, outcome);
  },
  restartSession(): Promise<void> {
    return ipcRenderer.invoke(IPC_RESTART_SESSION_CHANNEL);
  },
};

contextBridge.exposeInMainWorld("argusde", api);

export type ArgusDeApi = typeof api;
