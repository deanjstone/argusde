import { z } from "zod";
import type { AcpSessionEvent } from "./acp-events.js";

/**
 * Wire format for ArgusDE's standalone server WebSocket API (spec #33).
 * Every client (Electron, PWA) speaks this same protocol — it's the
 * highest, and only, integration seam between clients and the server.
 */

/** Path the WebSocket upgrade is served on — everything else on the same port/server is plain HTTP (the static web UI). Shared so client and server can't drift apart on it. */
export const WS_PATH = "/ws";

/**
 * Bumped whenever this protocol (this file's shape) changes. The server
 * announces this in its server.welcome push on every connect; Electron's
 * native shell (src/main/version-check.ts, Phase 6) compares it against
 * this same compiled-in constant and refuses to connect on mismatch — see
 * spec #33's version-skew decision. Shared (not server-only) so both sides
 * compile against the one source of truth, and so Electron's main process
 * doesn't need to import the whole server module graph just to reach this
 * string.
 */
export const API_VERSION = "1.0.0";

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
  z.object({ type: z.literal("thread.list-checkpoints"), commandId: z.string(), threadId: z.string() }),
  z.object({
    type: z.literal("thread.diff-checkpoints"),
    commandId: z.string(),
    threadId: z.string(),
    turnA: z.number(),
    turnB: z.number(),
  }),
  z.object({ type: z.literal("thread.promote-to-worktree"), commandId: z.string(), threadId: z.string() }),
  z.object({ type: z.literal("thread.revert-checkpoint"), commandId: z.string(), threadId: z.string(), turn: z.number() }),
  z.object({ type: z.literal("project.list"), commandId: z.string() }),
  z.object({ type: z.literal("thread.list"), commandId: z.string(), projectId: z.string() }),
  z.object({ type: z.literal("thread.get-history"), commandId: z.string(), threadId: z.string() }),
]);

export type ClientCommand = z.infer<typeof ClientCommandSchema>;

/**
 * Canonical shape for a checkpoint as returned by thread.list-checkpoints —
 * shared (not just server-side) so browser code importing it doesn't have
 * to redeclare the shape or reach into server-only modules (event-store.ts
 * pulls in better-sqlite3, not browser-safe).
 */
export interface CheckpointRecord {
  threadId: string;
  turn: number;
  ref: string;
  createdAt: string;
  /** Set when this checkpoint was captured by reverting to an earlier turn, naming which one — null for a normal turn-complete capture. */
  revertedToTurn: number | null;
}

/** Canonical shapes for project.list/thread.list — shared for the same reason as CheckpointRecord above. */
export interface ProjectRecord {
  id: string;
  workspaceRoot: string;
  title: string;
  createdAt: string;
}

export interface ThreadRecord {
  id: string;
  projectId: string;
  title: string;
  worktreePath: string | null;
  currentModeId: string | null;
  createdAt: string;
}

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
