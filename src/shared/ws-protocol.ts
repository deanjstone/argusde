import { z } from "zod";
import type { AcpSessionEvent, ChatContentBlock, ToolCallStatus } from "./acp-events.js";

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
export const API_VERSION = "1.1.0";

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
  z.object({ type: z.literal("thread.close"), commandId: z.string(), threadId: z.string() }),
  z.object({ type: z.literal("project.list"), commandId: z.string() }),
  /**
   * Removes a Project and its Threads from ArgusDE. Records only — the
   * workspace folder on disk is never touched.
   */
  z.object({ type: z.literal("project.delete"), commandId: z.string(), projectId: z.string() }),
  z.object({ type: z.literal("thread.list"), commandId: z.string(), projectId: z.string() }),
  z.object({ type: z.literal("thread.get-history"), commandId: z.string(), threadId: z.string() }),
  z.object({ type: z.literal("fs.list-directory"), commandId: z.string(), path: z.string().optional() }),
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
  /** Set once the Thread is closed — its live session is torn down and (if promoted) its worktree removed, but persisted history stays browsable. */
  closedAt: string | null;
  /**
   * False for Threads created before durable activity existed (spec #93
   * phase 1). Activity recording is prospective only — the events were
   * never emitted for those Threads, so there is nothing to backfill, and
   * the UI has to be able to say "not recorded here" rather than showing an
   * empty timeline that reads as data loss.
   */
  recordsActivity: boolean;
}

/**
 * One recorded thing the agent *did* (as opposed to said) — currently a
 * tool call, projected from `thread.activity-recorded` events. Shared for
 * the same reason as CheckpointRecord above: browser code can't import the
 * server's event-store module.
 *
 * `summary`/`detail` are bounded and `data` is byte-capped at record time —
 * see ACTIVITY_BOUNDS in the server's activity-bounds module for the values
 * and why they were chosen.
 */
export interface ActivityRecord {
  threadId: string;
  /** Stable per Thread — the ACP toolCallId, so updates land on the same record. */
  activityId: string;
  /** Explicit thread-wide ordering key, shared with messages so the two merge into one timeline. Assigned when the activity began, never on update. */
  sequence: number;
  turn: number;
  /** ACP's tool kind (read/edit/execute/…) — null when the agent didn't say. */
  kind: string | null;
  status: ToolCallStatus | null;
  /** Display headline, bounded. Denormalised so list rendering never parses `data`. */
  summary: string | null;
  /** Longer preview shown when the activity is expanded, bounded. */
  detail: string | null;
  /** The tool call's content blocks, passed through from ACP. */
  data: ChatContentBlock[];
  /** True when `data` exceeded the byte cap and was stored truncated. */
  dataTruncated: boolean;
  createdAt: string;
}

/**
 * Response shape for fs.list-directory — lets a client browse the
 * *server's* filesystem to pick a project path, since that's whose
 * filesystem actually matters (true for Electron, and unavoidably true
 * for the PWA reached over Tailscale from a different device entirely).
 * Directories only, dotfiles excluded — this is for picking a project
 * root, not a general file browser.
 */
export interface DirectoryListing {
  /** Resolved absolute path actually listed. */
  path: string;
  /** null only at the filesystem root. */
  parentPath: string | null;
  entries: { name: string; path: string }[];
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
