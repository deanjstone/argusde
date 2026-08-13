import type Database from "better-sqlite3";

/**
 * Idempotent schema setup: an append-only event log plus the read-model
 * tables projected from it. No migration framework — MVP-scale "create if
 * not exists" is sufficient (see spec #33: no formal command/decider/
 * projector split, straightforward synchronous projections).
 */
export function ensureSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      workspace_root TEXT NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS threads (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id),
      title TEXT NOT NULL,
      worktree_path TEXT,
      current_mode_id TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_threads_project_id ON threads(project_id);

    CREATE TABLE IF NOT EXISTS checkpoints (
      thread_id TEXT NOT NULL REFERENCES threads(id),
      turn INTEGER NOT NULL,
      ref TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, turn)
    );
  `);
}
