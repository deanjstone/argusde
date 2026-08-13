import { z } from "zod";
import type { AcpSessionEvent } from "./acp-events.js";

/**
 * Wire format for ArgusDE's standalone server WebSocket API (spec #33).
 * Every client (Electron, PWA) speaks this same protocol — it's the
 * highest, and only, integration seam between clients and the server.
 */

/** Path the WebSocket upgrade is served on — everything else on the same port/server is plain HTTP (the static web UI). Shared so client and server can't drift apart on it. */
export const WS_PATH = "/ws";

export const ClientCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project.create"), commandId: z.string(), workspaceRoot: z.string(), title: z.string() }),
  z.object({ type: z.literal("thread.create"), commandId: z.string(), projectId: z.string(), title: z.string() }),
  z.object({ type: z.literal("thread.send-message"), commandId: z.string(), threadId: z.string(), text: z.string() }),
  z.object({
    type: z.literal("thread.respond-permission"),
    commandId: z.string(),
    threadId: z.string(),
    requestId: z.string(),
    outcome: z.union([z.literal("cancelled"), z.object({ optionId: z.string() })]),
  }),
  z.object({ type: z.literal("thread.set-mode"), commandId: z.string(), threadId: z.string(), modeId: z.string() }),
]);

export type ClientCommand = z.infer<typeof ClientCommandSchema>;

export type CommandResult =
  | { type: "command.result"; commandId: string; ok: true; result: unknown }
  | { type: "command.result"; commandId: string; ok: false; error: string };

export interface ServerWelcome {
  type: "server.welcome";
  apiVersion: string;
}

export interface SessionEventPush {
  type: "session.event";
  threadId: string;
  event: AcpSessionEvent;
}

export interface ProtocolErrorPush {
  type: "protocol-error";
  message: string;
}

export type ServerPush = ServerWelcome | CommandResult | SessionEventPush | ProtocolErrorPush;
