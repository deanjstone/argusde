import type { ClientCommand, ServerPush } from "../shared/ws-protocol.js";

export interface WsClientOptions {
  url: string;
}

export interface SendCommandOptions {
  /**
   * How long to wait for the server's answer before giving up.
   *
   * Omitted means wait indefinitely, which is what `thread.send-message`
   * needs — an agent turn legitimately takes minutes and there is no honest
   * upper bound to pick for one. Pass a timeout for any command whose answer
   * is a round trip, so that a socket which has stopped carrying traffic
   * without closing surfaces as an error rather than a promise nothing will
   * ever settle (argusde#133).
   */
  timeoutMs?: number;
}

export interface HeartbeatOptions {
  intervalMs?: number;
  timeoutMs?: number;
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
 * The harder failure, and the one argusde#133 turned out to be about: the
 * socket still reads as OPEN, `send()` succeeds, and the answer never comes.
 * Says "looks open" out loud because otherwise the message contradicts what
 * the rest of the UI is showing.
 */
const NO_ANSWER_MESSAGE =
  "The ArgusDE server stopped answering — the connection still looks open but nothing is getting through. Check it's still running, then reload.";

/** Roughly a phone's idle-timeout granularity: often enough to notice a dead socket while it still matters, rare enough to be free. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 20_000;
/** Generous for a tailnet round trip, so a slow link is never mistaken for a dead one. */
const DEFAULT_HEARTBEAT_TIMEOUT_MS = 10_000;

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
  private readonly connectionLostListeners = new Set<(message: string) => void>();
  private readonly pending = new Map<string, PendingCommand>();
  private commandCounter = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  /** Latched: a connection is lost once, not repeatedly, however many commands were in flight when it went. */
  private connectionLostMessage: string | null = null;

  constructor(options: WsClientOptions) {
    this.socket = new WebSocket(options.url);
    this.socket.addEventListener("message", (event: MessageEvent) => this.handleMessage(event));
    // A close/error after the connection was ever established (server
    // restart, network drop) must reject any command still waiting on a
    // reply — otherwise that sendCommand() promise hangs forever, since
    // nothing else will ever settle it.
    this.socket.addEventListener("close", () => this.declareConnectionLost(CONNECTION_LOST_MESSAGE));
    this.socket.addEventListener("error", () => this.declareConnectionLost(CONNECTION_LOST_MESSAGE));
  }

  private rejectAllPending(error: Error): void {
    for (const pendingCommand of this.pending.values()) pendingCommand.reject(error);
    this.pending.clear();
  }

  /**
   * The one place a connection is written off. Rejects everything still
   * waiting — nothing else is going to settle those — stops the heartbeat,
   * and tells whoever is showing the UI, exactly once.
   */
  private declareConnectionLost(message: string): void {
    this.stopHeartbeat();
    this.rejectAllPending(new Error(message));
    if (this.connectionLostMessage !== null) return;
    this.connectionLostMessage = message;
    for (const listener of this.connectionLostListeners) listener(message);
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

  /**
   * Fires once, when this client has written the connection off — a close,
   * a socket error, or a command that went unanswered. Returns an
   * unsubscribe function; a listener added after the fact is told
   * immediately rather than never, so the order of wiring cannot lose the
   * one notification there is.
   */
  onConnectionLost(listener: (message: string) => void): () => void {
    if (this.connectionLostMessage !== null) {
      listener(this.connectionLostMessage);
      return () => undefined;
    }
    this.connectionLostListeners.add(listener);
    return () => {
      this.connectionLostListeners.delete(listener);
    };
  }

  /**
   * A periodic round trip whose only job is to notice a socket that has
   * stopped carrying traffic without ever closing. iOS produces exactly
   * that after a background, a screen lock or a network change:
   * `readyState` stays OPEN, sends succeed into nothing, and no close event
   * ever arrives (argusde#133).
   *
   * Application-level `ping` rather than a WebSocket ping frame, because
   * JavaScript cannot send a ping frame — and a server-sent one would only
   * ever tell the *server* that a client had gone, which is not who needs
   * to know here.
   */
  startHeartbeat(options: HeartbeatOptions = {}): void {
    const intervalMs = options.intervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
    const timeoutMs = options.timeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      // The rejection is the signal, and sendCommand has already raised it
      // through declareConnectionLost by the time this lands.
      void this.sendCommand({ type: "ping" }, { timeoutMs }).catch(() => undefined);
    }, intervalMs);
  }

  stopHeartbeat(): void {
    if (this.heartbeatTimer === null) return;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = null;
  }

  sendCommand<T = unknown>(command: OutgoingCommand, options: SendCommandOptions = {}): Promise<T> {
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

      let timer: ReturnType<typeof setTimeout> | undefined;
      const clearTimer = (): void => {
        if (timer !== undefined) clearTimeout(timer);
      };

      this.pending.set(commandId, {
        resolve: (result: unknown) => {
          clearTimer();
          resolve(result as T);
        },
        reject: (error: Error) => {
          clearTimer();
          reject(error);
        },
      });

      if (options.timeoutMs !== undefined) {
        timer = setTimeout(() => {
          // Nothing else is coming: the socket still reads as OPEN, so there
          // will be no close event and no command.result. Drop the entry
          // ourselves rather than leave one that can never settle, then
          // write the whole connection off — an unanswered command on an
          // apparently-healthy socket *is* the half-open case.
          if (!this.pending.delete(commandId)) return;
          reject(new Error(NO_ANSWER_MESSAGE));
          this.declareConnectionLost(NO_ANSWER_MESSAGE);
        }, options.timeoutMs);
      }

      try {
        this.socket.send(JSON.stringify({ ...command, commandId }));
      } catch {
        // The socket can close between the readyState check above and the
        // send itself. Drop the entry rather than leaving one that nothing
        // will ever settle — a later close sweep would reject an
        // already-rejected promise.
        clearTimer();
        this.pending.delete(commandId);
        reject(new Error(CONNECTION_LOST_MESSAGE));
      }
    });
  }

  close(): void {
    this.stopHeartbeat();
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
