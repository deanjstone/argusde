import Database from "better-sqlite3";
import { ensureSchema } from "./schema.js";
import type { ChatContentBlock } from "../../shared/acp-events.js";
import type { CheckpointRecord, ProjectRecord, ThreadRecord } from "../../shared/ws-protocol.js";

export type { CheckpointRecord, ProjectRecord, ThreadRecord };

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
      timestamp: string;
    }
  | { kind: "thread.mode-changed"; threadId: string; modeId: string; timestamp: string }
  | { kind: "thread.worktree-promoted"; threadId: string; worktreePath: string; timestamp: string }
  | { kind: "thread.closed"; threadId: string; timestamp: string };

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
   * level (argusde#47). Cheap to re-run on every startup: after the first
   * successful backfill, only genuinely thread-less events (project.created)
   * still have a NULL thread_id, and there are always few of those for a
   * personal-scale app.
   */
  private backfillThreadId(): void {
    const rows = this.db.prepare("SELECT id, payload FROM events WHERE thread_id IS NULL").all() as {
      id: number;
      payload: string;
    }[];
    if (rows.length === 0) return;

    const update = this.db.prepare("UPDATE events SET thread_id = ? WHERE id = ?");
    const backfill = this.db.transaction(() => {
      for (const row of rows) {
        const event = JSON.parse(row.payload) as { threadId?: string };
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
    apply(event);
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
        this.db
          .prepare(
            `INSERT INTO threads (id, project_id, title, worktree_path, current_mode_id, created_at)
             VALUES (?, ?, ?, ?, NULL, ?)`,
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

  getThread(id: string): ThreadRecord | undefined {
    const row = this.db
      .prepare(
        `SELECT id, project_id AS projectId, title, worktree_path AS worktreePath,
                current_mode_id AS currentModeId, created_at AS createdAt, closed_at AS closedAt
         FROM threads WHERE id = ?`,
      )
      .get(id) as ThreadRecord | undefined;
    return row;
  }

  listThreads(projectId: string): ThreadRecord[] {
    return this.db
      .prepare(
        `SELECT id, project_id AS projectId, title, worktree_path AS worktreePath,
                current_mode_id AS currentModeId, created_at AS createdAt, closed_at AS closedAt
         FROM threads WHERE project_id = ? ORDER BY created_at`,
      )
      .all(projectId) as ThreadRecord[];
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
