import { WebSocket } from "ws";
import { WS_PATH, type ServerPush } from "../shared/ws-protocol.js";

export type VersionCheckResult =
  | { status: "compatible" }
  | { status: "incompatible"; serverVersion: string; expectedVersion: string }
  /** Connection failed, timed out, or the response was malformed — deliberately not an error the caller has to catch: let the normal loadURL attempt proceed and explain its own failure. */
  | { status: "unknown" };

function toWsUrl(serverUrl: string): string {
  const url = new URL(serverUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = WS_PATH;
  return url.href;
}

/**
 * A short-lived, throwaway WS connection purely to read the server's
 * server.welcome push and compare its apiVersion against Electron's own
 * compiled-in expected version — never rejects, since a real connection
 * failure here isn't this function's job to explain (the caller's normal
 * loadURL attempt will surface that on its own).
 *
 * The default timeout is deliberately short (not the 5s+ that would be
 * reasonable for a real user action) — this check runs *before* the
 * caller's own loadURL attempt, so its timeout adds directly to how long a
 * genuinely unreachable server takes to report a failure (the ordinary
 * ECONNREFUSED case resolves near-instantly via the socket's own error
 * event and never waits out this timeout at all). ArgusDE's servers are
 * local/tailnet by design, so round trips are normally well under 100ms.
 */
export async function checkApiVersion(serverUrl: string, expectedVersion: string, timeoutMs = 2500): Promise<VersionCheckResult> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (result: VersionCheckResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.close();
      resolve(result);
    };

    const timer = setTimeout(() => settle({ status: "unknown" }), timeoutMs);

    let socket: WebSocket;
    try {
      socket = new WebSocket(toWsUrl(serverUrl));
    } catch {
      clearTimeout(timer);
      resolve({ status: "unknown" });
      return;
    }

    socket.once("error", () => settle({ status: "unknown" }));
    socket.once("message", (data) => {
      try {
        const push = JSON.parse(data.toString()) as ServerPush;
        if (push.type !== "server.welcome") {
          settle({ status: "unknown" });
          return;
        }
        settle(
          push.apiVersion === expectedVersion
            ? { status: "compatible" }
            : { status: "incompatible", serverVersion: push.apiVersion, expectedVersion },
        );
      } catch {
        settle({ status: "unknown" });
      }
    });
  });
}
