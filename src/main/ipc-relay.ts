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
  private utilityAlive = false;
  private webContents: WebContents | undefined;
  private startOptions: IpcRelayStartOptions | undefined;
  private handlersRegistered = false;

  start(webContents: WebContents, options: IpcRelayStartOptions): void {
    this.webContents = webContents;
    this.startOptions = options;
    this.spawnUtility();
    this.registerRendererHandlers();
  }

  private spawnUtility(): void {
    if (!this.startOptions) {
      throw new Error("IpcRelay.start() must be called before spawning the utility process");
    }

    this.utility = utilityProcess.fork(path.join(__dirname, "../utility/index.js"), [], {
      env: { ...process.env, ARGUSDE_SESSION_CWD: this.startOptions.cwd },
      stdio: ["ignore", "pipe", "pipe"],
    });
    this.utilityAlive = true;

    this.utility.stdout?.on("data", (chunk: Buffer) => process.stdout.write(`[argusde:utility] ${chunk}`));
    this.utility.stderr?.on("data", (chunk: Buffer) => process.stderr.write(`[argusde:utility] ${chunk}`));

    this.utility.on("message", (message: UtilityToMainMessage) => {
      if (message.type === "session-event") {
        this.webContents?.send(IPC_SESSION_EVENT_CHANNEL, message.event);
      }
    });

    // The utility process dying outright (not just its ACP connection
    // erroring) is a distinct failure mode from anything AcpSession itself
    // can report — surface it the same way so the UI doesn't just go silent,
    // and let restart() know a full respawn is needed rather than trying to
    // postMessage a dead process.
    this.utility.on("exit", (code) => {
      this.utilityAlive = false;
      this.webContents?.send(IPC_SESSION_EVENT_CHANNEL, {
        kind: "connection-state",
        state: "error",
        error: `ArgusDE's agent process exited unexpectedly (code ${code}).`,
      });
    });
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
      this.restart();
    });
  }

  /**
   * Two distinct recovery paths, both reachable from the same "Restart
   * session" action: if the utility process is still alive, restarting is
   * just AcpSession reconnecting inside it (cheap). If the utility process
   * itself died, there's nothing alive to message — respawn it outright.
   */
  private restart(): void {
    if (this.utilityAlive) {
      this.postToUtility({ type: "restart-session" });
    } else {
      this.spawnUtility();
    }
  }

  private postToUtility(message: MainToUtilityMessage): void {
    this.utility?.postMessage(message);
  }

  stop(): void {
    this.utility?.kill();
    this.utility = undefined;
    this.utilityAlive = false;
    this.webContents = undefined;
  }
}
