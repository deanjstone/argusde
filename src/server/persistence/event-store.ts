import Database from "better-sqlite3";
import { ensureSchema } from "./schema.js";
import type { ChatContentBlock } from "../../shared/acp-events.js";

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
  | { kind: "thread.checkpoint-captured"; threadId: string; turn: number; ref: string; timestamp: string }
  | {
      kind: "thread.message-recorded";
      threadId: string;
      messageId: string;
      role: "user" | "agent";
      content: ChatContentBlock[];
      timestamp: string;
    }
  | { kind: "thread.mode-changed"; threadId: string; modeId: string; timestamp: string };

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

export interface CheckpointRecord {
  threadId: string;
  turn: number;
  ref: string;
  createdAt: string;
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
  }

  appendEvent(event: DomainEvent): void {
    const insertEvent = this.db.prepare(
      "INSERT INTO events (kind, payload, created_at) VALUES (?, ?, ?)",
    );

    const apply = this.db.transaction((e: DomainEvent) => {
      insertEvent.run(e.kind, JSON.stringify(e), e.timestamp);
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
        this.db
          .prepare("INSERT INTO checkpoints (thread_id, turn, ref, created_at) VALUES (?, ?, ?, ?)")
          .run(event.threadId, event.turn, event.ref, event.timestamp);
        break;
      case "thread.mode-changed":
        this.db
          .prepare("UPDATE threads SET current_mode_id = ? WHERE id = ?")
          .run(event.modeId, event.threadId);
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
                current_mode_id AS currentModeId, created_at AS createdAt
         FROM threads WHERE id = ?`,
      )
      .get(id) as ThreadRecord | undefined;
    return row;
  }

  listThreads(projectId: string): ThreadRecord[] {
    return this.db
      .prepare(
        `SELECT id, project_id AS projectId, title, worktree_path AS worktreePath,
                current_mode_id AS currentModeId, created_at AS createdAt
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
    const rows = this.db.prepare("SELECT payload FROM events ORDER BY id").all() as { payload: string }[];
    return rows
      .map((row) => JSON.parse(row.payload) as DomainEvent)
      .filter((event): event is DomainEvent & { threadId: string } => "threadId" in event && event.threadId === threadId);
  }

  listCheckpoints(threadId: string): CheckpointRecord[] {
    return this.db
      .prepare(
        "SELECT thread_id AS threadId, turn, ref, created_at AS createdAt FROM checkpoints WHERE thread_id = ? ORDER BY turn",
      )
      .all(threadId) as CheckpointRecord[];
  }

  close(): void {
    this.db.close();
  }
}
