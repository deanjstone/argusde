import Database from "better-sqlite3";
import { ensureSchema } from "./schema.js";
import { boundData, boundText, ACTIVITY_BOUNDS } from "./activity-bounds.js";
import type { ChatContentBlock, ToolCallStatus } from "../../shared/acp-events.js";
import type { ActivityRecord, CheckpointRecord, ProjectRecord, ThreadRecord } from "../../shared/ws-protocol.js";

export type { ActivityRecord, CheckpointRecord, ProjectRecord, ThreadRecord };

export type DomainEvent =
  | { kind: "project.created"; projectId: string; workspaceRoot: string; title: string; timestamp: string }
  | {
      kind: "thread.created";
      threadId: string;
      projectId: string;
      title: string;
      worktreePath: string | null;
      timestamp: string;
    }
  | {
      kind: "thread.checkpoint-captured";
      threadId: string;
      turn: number;
      ref: string;
      /** Set when this capture was produced by reverting to an earlier turn — undefined for a normal turn-complete capture. */
      revertedToTurn?: number;
      timestamp: string;
    }
  | {
      kind: "thread.message-recorded";
      threadId: string;
      messageId: string;
      role: "user" | "agent";
      content: ChatContentBlock[];
      /**
       * Thread-wide ordering key shared with activities, assigned when the
       * message *began* rather than when it was persisted — an agent's
       * reply is only appended at turn-complete, after every tool call in
       * its turn, so append order alone would replay a turn as "all the
       * talking, then all the doing" regardless of what actually happened.
       *
       * Optional because messages recorded before spec #93 phase 1 have
       * none. Those keep their relative append order, which costs nothing:
       * a Thread old enough to have unsequenced messages has no activities
       * to interleave them with.
       */
      sequence?: number;
      timestamp: string;
    }
  /**
   * One thing the agent *did* — an ACP tool call, or an update to one it
   * already reported. Absent fields on an update mean "unchanged", matching
   * ACP's own tool_call_update semantics; on a first sighting they mean
   * "not reported". `summary`/`detail`/`data` are bounded by appendEvent
   * before this reaches the log — see activity-bounds.ts.
   */
  | {
      kind: "thread.activity-recorded";
      threadId: string;
      /** The ACP toolCallId — stable across the call's updates, so they merge onto one record. */
      activityId: string;
      /** Fixed at first sighting; an update carrying a later one never reorders the activity. */
      sequence: number;
      turn: number;
      /** ACP's tool kind (read/edit/execute/…). Named `toolKind` because `kind` is this union's own discriminator. */
      toolKind?: string | null;
      status?: ToolCallStatus | null;
      summary?: string | null;
      detail?: string | null;
      data?: ChatContentBlock[];
      /** Set by appendEvent when `data` had to be cut to fit the byte cap — never passed in by callers. */
      dataTruncated?: boolean;
      timestamp: string;
    }
  | { kind: "thread.mode-changed"; threadId: string; modeId: string; timestamp: string }
  | { kind: "thread.worktree-promoted"; threadId: string; worktreePath: string; timestamp: string }
  | { kind: "thread.closed"; threadId: string; timestamp: string }
  /**
   * Removes a Project and everything projected from it. The events
   * themselves stay in the append-only log — this is a read-model deletion,
   * which is what "remove it from my list" actually means here, and keeps
   * the log's history intact rather than rewriting it.
   */
  | { kind: "project.deleted"; projectId: string; timestamp: string };

/**
 * SQLite stores booleans as integers and has no way to express "this column
 * didn't exist when the row was written" other than NULL — both of which
 * have to be flattened before a row can satisfy the shared ThreadRecord
 * shape the clients compile against.
 */
interface ThreadRow extends Omit<ThreadRecord, "recordsActivity"> {
  recordsActivity: number | null;
}

const THREAD_SELECT = `SELECT id, project_id AS projectId, title, worktree_path AS worktreePath,
                current_mode_id AS currentModeId, created_at AS createdAt, closed_at AS closedAt,
                records_activity AS recordsActivity`;

function toThreadRecord(row: ThreadRow): ThreadRecord {
  return { ...row, recordsActivity: row.recordsActivity === 1 };
}

/** Same flattening job for activities: JSON in a text column, a boolean in an integer one. */
interface ActivityRow extends Omit<ActivityRecord, "data" | "dataTruncated"> {
  data: string | null;
  dataTruncated: number | null;
}

function toActivityRecord(row: ActivityRow): ActivityRecord {
  return {
    ...row,
    data: row.data === null ? [] : (JSON.parse(row.data) as ChatContentBlock[]),
    dataTruncated: row.dataTruncated === 1,
  };
}

/**
 * Applies the per-activity storage bounds *before* the event reaches the
 * log, so the append-only table — the one that grows forever — is bounded
 * too, not just the projection that reads from it. Every other event kind
 * passes through untouched.
 *
 * Doing it here rather than in a dedicated write method keeps appendEvent
 * as the store's single write path (the existing design rule) while leaving
 * every boundary case reachable from a plain store test.
 */
function boundEvent(event: DomainEvent): DomainEvent {
  if (event.kind !== "thread.activity-recorded") return event;

  const bounded = event.data === undefined ? undefined : boundData(event.data);
  return {
    ...event,
    summary: boundText(event.summary, ACTIVITY_BOUNDS.summaryChars),
    detail: boundText(event.detail, ACTIVITY_BOUNDS.detailChars),
    ...(bounded ? { data: bounded.data, dataTruncated: bounded.truncated } : {}),
  };
}

/**
 * Append-only event log plus the SQLite read-model projected from it.
 * appendEvent is the only write path: it inserts the event, then applies a
 * synchronous projection update in the same transaction — no separate
 * command/decider/projector layer (spec #33's "lighter than T3" decision).
 */
export class EventStore {
  private readonly db: Database.Database;

  constructor(dbPath: string) {
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    ensureSchema(this.db);
    this.backfillThreadId();
  }

  /**
   * One-time backfill for rows written before the thread_id column existed
   * — addColumnIfMissing only adds the column, it can't retroactively
   * populate it, and listEventsForThread now filters by it at the SQL
   * level (argusde#47). Excludes kind = 'project.created' (the only event
   * with no threadId at all) so this scan only ever re-examines rows that
   * genuinely still need backfilling, instead of re-parsing every
   * project.created row on every future startup forever. A row whose
   * payload fails to parse (corruption, a partial write) is skipped rather
   * than crashing startup — losing that one event's thread_id backfill is
   * far better than the app refusing to start at all.
   */
  private backfillThreadId(): void {
    const rows = this.db
      .prepare("SELECT id, payload FROM events WHERE thread_id IS NULL AND kind <> 'project.created'")
      .all() as { id: number; payload: string }[];
    if (rows.length === 0) return;

    const update = this.db.prepare("UPDATE events SET thread_id = ? WHERE id = ?");
    const backfill = this.db.transaction(() => {
      for (const row of rows) {
        let event: { threadId?: string };
        try {
          event = JSON.parse(row.payload) as { threadId?: string };
        } catch {
          continue;
        }
        if (event.threadId) update.run(event.threadId, row.id);
      }
    });
    backfill();
  }

  appendEvent(event: DomainEvent): void {
    const insertEvent = this.db.prepare(
      "INSERT INTO events (kind, payload, thread_id, created_at) VALUES (?, ?, ?, ?)",
    );

    const apply = this.db.transaction((e: DomainEvent) => {
      const threadId = "threadId" in e ? e.threadId : null;
      insertEvent.run(e.kind, JSON.stringify(e), threadId, e.timestamp);
      this.project(e);
    });
    apply(boundEvent(event));
  }

  private project(event: DomainEvent): void {
    switch (event.kind) {
      case "project.created":
        this.db
          .prepare(
            "INSERT INTO projects (id, workspace_root, title, created_at) VALUES (?, ?, ?, ?)",
          )
          .run(event.projectId, event.workspaceRoot, event.title, event.timestamp);
        break;
      case "thread.created":
        // records_activity is 1 for every Thread created from spec #93
        // phase 1 onward. Rows written by an earlier build keep the NULL
        // addColumnIfMissing left them with, which is the only way to tell
        // "this Thread genuinely did nothing" from "nobody was recording".
        this.db
          .prepare(
            `INSERT INTO threads (id, project_id, title, worktree_path, current_mode_id, records_activity, created_at)
             VALUES (?, ?, ?, ?, NULL, 1, ?)`,
          )
          .run(event.threadId, event.projectId, event.title, event.worktreePath, event.timestamp);
        break;
      case "thread.checkpoint-captured":
        // Turn 0 alone gets INSERT OR REPLACE — its baseline is
        // deliberately re-captured exactly once, at worktree-promotion
        // time, to reflect the clean worktree checkout the agent actually
        // starts from rather than the main workspace's state at Thread
        // creation. Every other turn keeps the plain INSERT's primary-key
        // protection, so a hypothetical future double-fire of completeTurn()
        // for the same turn still surfaces as a real error instead of
        // silently overwriting the ref.
        this.db
          .prepare(
            event.turn === 0
              ? "INSERT OR REPLACE INTO checkpoints (thread_id, turn, ref, created_at, reverted_to_turn) VALUES (?, ?, ?, ?, ?)"
              : "INSERT INTO checkpoints (thread_id, turn, ref, created_at, reverted_to_turn) VALUES (?, ?, ?, ?, ?)",
          )
          .run(event.threadId, event.turn, event.ref, event.timestamp, event.revertedToTurn ?? null);
        break;
      case "thread.activity-recorded":
        // Upsert keyed on (thread_id, activity_id): a tool_call creates the
        // row and each tool_call_update merges onto it, exactly as the live
        // timeline's upsertToolCall does. COALESCE(excluded.x, activities.x)
        // is what makes an omitted field mean "unchanged" rather than
        // "cleared" — ACP replaces a tool call's content collection only
        // when it actually sends one. `sequence` is deliberately absent
        // from the update clause: an activity's place on the timeline is
        // where it began, not where its last update landed.
        this.db
          .prepare(
            `INSERT INTO activities (thread_id, activity_id, sequence, turn, kind, status, summary, detail, data, data_truncated, created_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT (thread_id, activity_id) DO UPDATE SET
               turn = excluded.turn,
               kind = COALESCE(excluded.kind, activities.kind),
               status = COALESCE(excluded.status, activities.status),
               summary = COALESCE(excluded.summary, activities.summary),
               detail = COALESCE(excluded.detail, activities.detail),
               data = COALESCE(excluded.data, activities.data),
               data_truncated = COALESCE(excluded.data_truncated, activities.data_truncated)`,
          )
          .run(
            event.threadId,
            event.activityId,
            event.sequence,
            event.turn,
            event.toolKind ?? null,
            event.status ?? null,
            event.summary ?? null,
            event.detail ?? null,
            // NULL (not "[]") when the event carried no content at all, so
            // COALESCE above can tell "no content reported this time" from
            // "reported as empty".
            event.data === undefined ? null : JSON.stringify(event.data),
            event.data === undefined ? null : event.dataTruncated ? 1 : 0,
            event.timestamp,
          );
        break;
      case "thread.mode-changed":
        this.db
          .prepare("UPDATE threads SET current_mode_id = ? WHERE id = ?")
          .run(event.modeId, event.threadId);
        break;
      case "thread.worktree-promoted":
        this.db
          .prepare("UPDATE threads SET worktree_path = ? WHERE id = ?")
          .run(event.worktreePath, event.threadId);
        break;
      case "thread.closed":
        this.db
          .prepare("UPDATE threads SET closed_at = ? WHERE id = ?")
          .run(event.timestamp, event.threadId);
        break;
      case "project.deleted": {
        // Checkpoints first, then threads, then the project — the reverse
        // of the foreign-key dependency order, so no statement ever leaves
        // a dangling reference. appendEvent already wraps this in a
        // transaction, so a failure part-way rolls the whole thing back.
        this.db
          .prepare("DELETE FROM checkpoints WHERE thread_id IN (SELECT id FROM threads WHERE project_id = ?)")
          .run(event.projectId);
        this.db
          .prepare("DELETE FROM activities WHERE thread_id IN (SELECT id FROM threads WHERE project_id = ?)")
          .run(event.projectId);
        this.db.prepare("DELETE FROM threads WHERE project_id = ?").run(event.projectId);
        this.db.prepare("DELETE FROM projects WHERE id = ?").run(event.projectId);
        break;
      }
      case "thread.message-recorded":
        // Turn/message history projection lands with the UI work that reads
        // it (Phase 2+) — the event is durable in the log either way.
        break;
    }
  }

  getProject(id: string): ProjectRecord | undefined {
    const row = this.db
      .prepare("SELECT id, workspace_root AS workspaceRoot, title, created_at AS createdAt FROM projects WHERE id = ?")
      .get(id) as ProjectRecord | undefined;
    return row;
  }

  listProjects(): ProjectRecord[] {
    return this.db
      .prepare("SELECT id, workspace_root AS workspaceRoot, title, created_at AS createdAt FROM projects ORDER BY created_at")
      .all() as ProjectRecord[];
  }

  /** Exact-string match only — no path normalization (resolving `..`, trailing slashes, symlinks). The client always sends back whatever raw string the user typed or a prior project.list response already returned, so this is sufficient without adding filesystem-touching logic here. */
  getProjectByWorkspaceRoot(workspaceRoot: string): ProjectRecord | undefined {
    const row = this.db
      .prepare("SELECT id, workspace_root AS workspaceRoot, title, created_at AS createdAt FROM projects WHERE workspace_root = ?")
      .get(workspaceRoot) as ProjectRecord | undefined;
    return row;
  }

  getThread(id: string): ThreadRecord | undefined {
    const row = this.db
      .prepare(`${THREAD_SELECT} FROM threads WHERE id = ?`)
      .get(id) as ThreadRow | undefined;
    return row && toThreadRecord(row);
  }

  listThreads(projectId: string): ThreadRecord[] {
    const rows = this.db
      .prepare(`${THREAD_SELECT} FROM threads WHERE project_id = ? ORDER BY created_at`)
      .all(projectId) as ThreadRow[];
    return rows.map(toThreadRecord);
  }

  /**
   * Raw event-log replay for one thread. Phase 1 has no dedicated message/
   * turn-history projection table (that lands with the UI work that reads
   * it) — this is the durable source of truth in the meantime.
   */
  listEventsForThread(threadId: string): DomainEvent[] {
    const rows = this.db.prepare("SELECT payload FROM events WHERE thread_id = ? ORDER BY id").all(threadId) as {
      payload: string;
    }[];
    return rows.map((row) => JSON.parse(row.payload) as DomainEvent);
  }

  /**
   * Everything the agent did in this Thread, in the order it began doing
   * it. Ordered by the explicit sequence rather than by insertion, since
   * several activities land within one Turn and an update can arrive long
   * after a later activity started — see the sequence field's own note.
   */
  listActivities(threadId: string): ActivityRecord[] {
    const rows = this.db
      .prepare(
        `SELECT thread_id AS threadId, activity_id AS activityId, sequence, turn, kind, status,
                summary, detail, data, data_truncated AS dataTruncated, created_at AS createdAt
         FROM activities WHERE thread_id = ? ORDER BY sequence, activity_id`,
      )
      .all(threadId) as ActivityRow[];
    return rows.map(toActivityRecord);
  }

  /**
   * The next unused ordering key for a Thread, so ThreadRuntime's in-memory
   * counter can be re-seeded after a server restart instead of handing out
   * numbers that collide with already-persisted history.
   *
   * Reads the high-water mark from both projections it could be in: the
   * activities table, and the message events (messages have no projection
   * table of their own — the event log is still their source of truth).
   * Messages written before sequencing existed have no `sequence` at all
   * and json_extract yields NULL for them, so they simply don't participate.
   */
  getNextSequence(threadId: string): number {
    const row = this.db
      .prepare(
        `SELECT MAX(seq) AS maxSequence FROM (
           SELECT MAX(sequence) AS seq FROM activities WHERE thread_id = ?
           UNION ALL
           SELECT MAX(json_extract(payload, '$.sequence')) AS seq
             FROM events WHERE thread_id = ? AND kind = 'thread.message-recorded'
         )`,
      )
      .get(threadId, threadId) as { maxSequence: number | null };
    return (row.maxSequence ?? 0) + 1;
  }

  /**
   * The next unused Turn number for a Thread, so ThreadRuntime's in-memory
   * counter can be re-seeded rather than restarting at 1 and colliding with
   * checkpoints that already exist (argusde#96).
   *
   * Sibling of getNextSequence above, and needed for the same reason: a
   * counter that lives only in a runtime's memory has to be recoverable from
   * what was persisted, or rebuilding the runtime silently rewinds it.
   */
  getNextTurn(threadId: string): number {
    const row = this.db
      .prepare("SELECT MAX(turn) AS maxTurn FROM checkpoints WHERE thread_id = ?")
      .get(threadId) as { maxTurn: number | null };
    // Turn 0 is the baseline every Thread gets on start(), so a Thread with
    // only that still has its first real Turn ahead of it.
    return (row.maxTurn ?? 0) + 1;
  }

  listCheckpoints(threadId: string): CheckpointRecord[] {
    return this.db
      .prepare(
        `SELECT thread_id AS threadId, turn, ref, created_at AS createdAt, reverted_to_turn AS revertedToTurn
         FROM checkpoints WHERE thread_id = ? ORDER BY turn`,
      )
      .all(threadId) as CheckpointRecord[];
  }

  close(): void {
    this.db.close();
  }
}
