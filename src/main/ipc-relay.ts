import { ipcMain, utilityProcess, type UtilityProcess } from "electron";
import type { WebContents } from "electron";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  IPC_RESPOND_PERMISSION_CHANNEL,
  IPC_RESTART_SESSION_CHANNEL,
  IPC_SEND_MESSAGE_CHANNEL,
  IPC_SESSION_EVENT_CHANNEL,
} from "../shared/ipc-contract.js";
import type { MainToUtilityMessage, UtilityToMainMessage } from "../shared/ipc-contract.js";
import type { PermissionOutcome } from "../shared/acp-events.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface IpcRelayStartOptions {
  cwd: string;
}

/**
 * Owns the utility process running `AcpSession` and relays traffic in both
 * directions: utility-process session events forwarded to the renderer over
 * `webContents.send`, and renderer-invoked actions forwarded to the utility
 * process's message port. No direct channel between utility and renderer;
 * this module is the single relay point per the locked IPC architecture
 * decision (argusde#6).
 */
export class IpcRelay {
  private utility: UtilityProcess | undefined;
  private webContents: WebContents | undefined;
  private handlersRegistered = false;

  start(webContents: WebContents, options: IpcRelayStartOptions): void {
    this.webContents = webContents;
    this.utility = utilityProcess.fork(path.join(__dirname, "../utility/index.js"), [], {
      env: { ...process.env, ARGUSDE_SESSION_CWD: options.cwd },
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.utility.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[argusde:utility] ${chunk}`));
    this.utility.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[argusde:utility] ${chunk}`));

    this.utility.on("message", (message: UtilityToMainMessage) => {
      if (message.type === "session-event") {
        this.webContents?.send(IPC_SESSION_EVENT_CHANNEL, message.event);
      }
    });

    this.registerRendererHandlers();
  }

  private registerRendererHandlers(): void {
    if (this.handlersRegistered) return;
    this.handlersRegistered = true;

    ipcMain.handle(IPC_SEND_MESSAGE_CHANNEL, (_event, text: string) => {
      this.postToUtility({ type: "send-message", text });
    });
    ipcMain.handle(IPC_RESPOND_PERMISSION_CHANNEL, (_event, requestId: string, outcome: PermissionOutcome) => {
      this.postToUtility({ type: "respond-to-permission", requestId, outcome });
    });
    ipcMain.handle(IPC_RESTART_SESSION_CHANNEL, () => {
      this.postToUtility({ type: "restart-session" });
    });
  }

  private postToUtility(message: MainToUtilityMessage): void {
    this.utility?.postMessage(message);
  }

  stop(): void {
    this.utility?.kill();
    this.utility = undefined;
    this.webContents = undefined;
  }
}
