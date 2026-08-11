import type { AcpSessionEvent, PermissionOutcome } from "./acp-events.js";

/** Channel main uses to push normalized ACP session events to the renderer. */
export const IPC_SESSION_EVENT_CHANNEL = "argusde:session-event";

/** Channels the renderer invokes on main; main relays these to the utility process. */
export const IPC_SEND_MESSAGE_CHANNEL = "argusde:send-message";
export const IPC_RESPOND_PERMISSION_CHANNEL = "argusde:respond-to-permission";
export const IPC_RESTART_SESSION_CHANNEL = "argusde:restart-session";

/** Messages posted from the utility process to main (via utilityProcess postMessage / parentPort). */
export type UtilityToMainMessage = { type: "session-event"; event: AcpSessionEvent };

/** Messages posted from main to the utility process. */
export type MainToUtilityMessage =
  | { type: "send-message"; text: string }
  | { type: "respond-to-permission"; requestId: string; outcome: PermissionOutcome }
  | { type: "restart-session" };
