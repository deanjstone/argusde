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
    CREATE INDEX IF NOT EXISTS idx_projects_workspace_root ON projects(workspace_root);

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

  addColumnIfMissing(db, "checkpoints", "reverted_to_turn", "INTEGER");
  addColumnIfMissing(db, "threads", "closed_at", "TEXT");
}

/**
 * CREATE TABLE IF NOT EXISTS only helps a brand-new database — it's a
 * no-op against a table that already exists from an earlier version, so a
 * column added here later would silently never land on a real user's
 * existing database file, breaking every future INSERT that references it
 * (not just the new feature the column was added for). SQLite has no
 * "ADD COLUMN IF NOT EXISTS", so this is the standard idiom: attempt the
 * ALTER, and ignore the one specific error it raises when the column is
 * already there (from a fresh CREATE TABLE that already included it).
 */
function addColumnIfMissing(db: Database.Database, table: string, column: string, type: string): void {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  } catch (error) {
    if (error instanceof Error && /duplicate column name/i.test(error.message)) return;
    throw error;
  }
}
