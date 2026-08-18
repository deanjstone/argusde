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
export const API_VERSION = "1.2.0";

export const ClientCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("project.create"), commandId: z.string(), workspaceRoot: z.string(), title: z.string() }),
  z.object({ type: z.literal("thread.create"), commandId: z.string(), projectId: z.string(), title: z.string() }),
  z.object({
    type: z.literal("thread.send-message"),
    commandId: z.string(),
    threadId: z.string(),
    text: z.string(),
    /**
     * Image attachments (spec #93 phase 7). `text` stays a string rather
     * than widening to a block array: a text-only message is then
     * byte-identical to what it always was, and the schema can say exactly
     * what is attachable in this phase instead of accepting any block and
     * validating afterwards. The widening #93 calls for happens at
     * AcpSession.sendMessage, which is the seam it names.
     *
     * Bounds (type, size, count) are checked by the server against the
     * shared rules in src/shared/attachments.ts, not here — a zod refusal
     * would surface as a protocol error rather than the actionable reason
     * story 38 requires.
     */
    attachments: z.array(z.object({ mimeType: z.string(), data: z.string() })).optional(),
  }),
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
  /**
   * Working-tree reads (spec #93 phase 4). Thread-scoped, not
   * Project-scoped, so the *server* resolves which working tree is meant
   * (the Worktree when the Thread is promoted, the Project's workspace root
   * otherwise) rather than the client passing a path it guessed. `path` is
   * always relative to that root; omit it for the root itself.
   */
  z.object({ type: z.literal("thread.list-directory"), commandId: z.string(), threadId: z.string(), path: z.string().optional() }),
  z.object({ type: z.literal("thread.read-file"), commandId: z.string(), threadId: z.string(), path: z.string() }),
  z.object({ type: z.literal("thread.search"), commandId: z.string(), threadId: z.string(), query: z.string() }),
  z.object({ type: z.literal("thread.changed-files"), commandId: z.string(), threadId: z.string() }),
  z.object({ type: z.literal("thread.file-diff"), commandId: z.string(), threadId: z.string(), path: z.string() }),
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
 * One message as returned by thread.get-history. `sequence` is null for
 * messages recorded before spec #93 phase 1 introduced it — see
 * mergeHistoryTimeline for what that means when rebuilding a timeline.
 */
export interface ThreadHistoryMessage {
  messageId: string;
  role: "user" | "agent";
  content: ChatContentBlock[];
  sequence: number | null;
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

/**
 * One directory inside a Thread's working tree. Distinct from
 * DirectoryListing above, which browses the *server's* filesystem to pick a
 * Project root and is deliberately directories-only: this one is a file
 * browser, so it carries files and dotfiles too, and every path is relative
 * to the working tree so nothing outside it is ever named on the wire.
 */
export interface WorkingTreeListing {
  /** Relative to the working tree; "" is the root. */
  path: string;
  /** null at the root — browsing can never walk out of the tree. */
  parentPath: string | null;
  entries: { name: string; path: string; kind: "file" | "directory" }[];
}

/**
 * What a syntax token *is*, rather than what colour it should be.
 *
 * The server sends kinds and the stylesheet decides colours: a per-token
 * colour would need an inline style attribute, which the UI's CSP blocks (see
 * contentSecurityPolicy in server/http/static-server.ts), and colour belongs
 * in the theme's CSS variables rather than a payload (CLAUDE.md). Bucketed
 * from TextMate scopes — see server/workspace/highlight.ts.
 */
export type SyntaxKind =
  | "plain"
  | "comment"
  | "string"
  | "number"
  | "constant"
  | "keyword"
  | "function"
  | "type"
  | "variable"
  | "punctuation";

export interface SyntaxToken {
  content: string;
  kind: SyntaxKind;
}

export type SyntaxLine = SyntaxToken[];

/**
 * One file, ready to render.
 *
 * `lines` and `plainLines` are separate nullable fields rather than a
 * discriminated union so a client can render whichever it was given without
 * unwrapping a variant; `kind` says what to expect, and a text file always
 * has exactly one of the two.
 */
export interface FilePreview {
  /** Relative to the working tree. */
  path: string;
  /**
   * `binary` — a NUL byte in the first 8 KiB, so rendering it would be
   * noise. `too-large` — past the preview cap; opening a build artefact by
   * accident has to be recoverable rather than a hang.
   */
  kind: "text" | "binary" | "too-large";
  byteLength: number;
  /** null when no language could be resolved, or when tokenising was skipped or failed — in which case `plainLines` is populated. */
  language: string | null;
  lines: SyntaxLine[] | null;
  /** Set instead of `lines` for a text file too big to tokenise, or one whose language isn't known. */
  plainLines: string[] | null;
}

/**
 * One search's results, grouped by file (story 18) with every cap that bit
 * reported (spec #93) — a silently truncated result set reads as a complete
 * one. Paths are relative to the working tree, like every other
 * working-tree response.
 */
export interface SearchResults {
  query: string;
  files: {
    path: string;
    matches: { line: number; text: string }[];
    /** This file had more matches than the per-file cap allows. */
    matchesTruncated: boolean;
  }[];
  totalMatches: number;
  truncated: {
    /** More files matched than the file cap allows. */
    files: boolean;
    /** Matches were capped — within a file, or across the whole result set. */
    matches: boolean;
    /**
     * git was cut off mid-stream (its output exceeded what the server will
     * buffer, or it ran out of time), so these results are partial for a
     * reason no per-file or per-result cap describes.
     */
    output: boolean;
    /** The specific reason for `output`: the search hit its wall-clock bound. */
    timedOut: boolean;
  };
}

/**
 * One file changed in the Thread's working tree right now — a different
 * question from Checkpoint-to-Checkpoint diffing, which answers "what changed
 * between Turn 4 and Turn 7". Paths are relative to the working tree.
 */
export interface ChangedFile {
  path: string;
  kind: "added" | "modified" | "deleted" | "renamed" | "untracked";
  /** Where a renamed file came from. Absent for every other kind. */
  previousPath?: string;
}

/**
 * One line of a per-file diff, pre-classified.
 *
 * The *kind* travels rather than a colour, for the same two reasons as syntax
 * tokens: a per-line colour would need an inline style attribute, which the
 * UI's CSP blocks (see contentSecurityPolicy in server/http/static-server.ts),
 * and colour belongs in the theme. It also spares the client re-parsing a
 * patch it was just handed.
 */
export interface DiffLine {
  kind: "added" | "removed" | "context" | "meta" | "hunk";
  text: string;
}

export interface FileDiff {
  path: string;
  /** `binary` — git reports no textual diff, so there is nothing to render. */
  kind: "text" | "binary";
  lines: DiffLine[];
}

/** What the working tree is checked out on. Read from git, never derived from a Thread id — a Worktree promoted before spec #93 phase 3 has no branch at all. */
export interface WorkingTreeBranch {
  branch: string | null;
  detached: boolean;
}

/** thread.changed-files: what is changed right now, and where. */
export interface WorkingTreeChanges extends WorkingTreeBranch {
  files: ChangedFile[];
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
