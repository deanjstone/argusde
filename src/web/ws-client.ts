import type { ClientCommand, ServerPush } from "../shared/ws-protocol.js";

export interface WsClientOptions {
  url: string;
}

// Plain `Omit<ClientCommand, "commandId">` doesn't distribute over the
// union — it collapses to only the properties common to every command
// variant. This distributes Omit over each member first.
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type OutgoingCommand = DistributiveOmit<ClientCommand, "commandId">;

interface PendingCommand {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

/**
 * Surfaced directly to the user by App.tsx's error paths, so it says what
 * happened *and* what to do — the underlying failures are a raw
 * DOMException or (in Node) no error at all.
 */
const CONNECTION_LOST_MESSAGE = "Lost the connection to the ArgusDE server. Check it's still running, then reload.";

/**
 * Browser-side counterpart to the server's WS API (src/server/ws/ws-server.ts).
 * Runs against the standard global `WebSocket` (available natively in
 * browsers and in Node 22+, which is what this module's own tests run
 * under) — no dependency needed. This is the new-protocol equivalent of
 * what `window.argusde` (Electron's preload bridge) does for the old IPC
 * path, but talking real WebSocket.
 */
export class WsClient {
  private readonly socket: WebSocket;
  private readonly listeners = new Set<(push: ServerPush) => void>();
  private readonly pending = new Map<string, PendingCommand>();
  private commandCounter = 0;

  constructor(options: WsClientOptions) {
    this.socket = new WebSocket(options.url);
    this.socket.addEventListener("message", (event: MessageEvent) => this.handleMessage(event));
    // A close/error after the connection was ever established (server
    // restart, network drop) must reject any command still waiting on a
    // reply — otherwise that sendCommand() promise hangs forever, since
    // nothing else will ever settle it.
    this.socket.addEventListener("close", () => this.rejectAllPending(new Error("WebSocket connection closed")));
    this.socket.addEventListener("error", () => this.rejectAllPending(new Error("WebSocket connection error")));
  }

  private rejectAllPending(error: Error): void {
    for (const pendingCommand of this.pending.values()) pendingCommand.reject(error);
    this.pending.clear();
  }

  waitUntilOpen(): Promise<void> {
    if (this.socket.readyState === WebSocket.OPEN) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.socket.addEventListener("open", () => resolve(), { once: true });
      this.socket.addEventListener("error", () => reject(new Error("WebSocket connection failed")), { once: true });
    });
  }

  /** Subscribes to every pushed message (server.welcome, session.event, command.result, protocol-error). Returns an unsubscribe function. */
  onPush(listener: (push: ServerPush) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  sendCommand<T = unknown>(command: OutgoingCommand): Promise<T> {
    const commandId = `cmd-${++this.commandCounter}-${Date.now()}`;
    return new Promise<T>((resolve, reject) => {
      // Sending on a dead socket has to be rejected here, before anything is
      // registered as pending. The two runtimes fail differently and both
      // are bad: browsers throw a raw DOMException ("WebSocket is already in
      // CLOSING or CLOSED state"), which App.tsx renders verbatim to the
      // user; Node's WebSocket doesn't throw at all, so the command simply
      // never settles and the UI sits on its in-flight spinner forever.
      if (this.socket.readyState !== WebSocket.OPEN) {
        reject(new Error(CONNECTION_LOST_MESSAGE));
        return;
      }

      this.pending.set(commandId, { resolve: resolve as (result: unknown) => void, reject });
      try {
        this.socket.send(JSON.stringify({ ...command, commandId }));
      } catch {
        // The socket can close between the readyState check above and the
        // send itself. Drop the entry rather than leaving one that nothing
        // will ever settle — a later close sweep would reject an
        // already-rejected promise.
        this.pending.delete(commandId);
        reject(new Error(CONNECTION_LOST_MESSAGE));
      }
    });
  }

  close(): void {
    this.socket.close();
  }

  private handleMessage(event: MessageEvent): void {
    const push = JSON.parse(event.data as string) as ServerPush;

    if (push.type === "command.result") {
      const pendingCommand = this.pending.get(push.commandId);
      if (pendingCommand) {
        this.pending.delete(push.commandId);
        if (push.ok) {
          pendingCommand.resolve(push.result);
        } else {
          pendingCommand.reject(new Error(push.error));
        }
      }
    }

    for (const listener of this.listeners) listener(push);
  }
}
