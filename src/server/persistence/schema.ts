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
  `);

  ensureWorkspaceRootIndex(db);

  db.exec(`
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

    /*
     * Durable record of what the agent *did* — one row per ACP tool call,
     * projected from thread.activity-recorded events (spec #93 phase 1).
     * Keyed by (thread_id, activity_id) rather than an autoincrement id so
     * a tool_call_update merges onto the row its tool_call created, which
     * is the same upsert-by-toolCallId shape the live timeline already uses
     * (src/shared/timeline.ts).
     */
    CREATE TABLE IF NOT EXISTS activities (
      thread_id TEXT NOT NULL REFERENCES threads(id),
      activity_id TEXT NOT NULL,
      sequence INTEGER NOT NULL,
      turn INTEGER NOT NULL,
      kind TEXT,
      status TEXT,
      summary TEXT,
      detail TEXT,
      -- Nullable, and NULL is meaningful: "this update reported no content
      -- at all", which is what lets the upsert leave existing content alone
      -- rather than clearing it. Reads back as an empty list.
      data TEXT,
      data_truncated INTEGER,
      created_at TEXT NOT NULL,
      PRIMARY KEY (thread_id, activity_id)
    );
    CREATE INDEX IF NOT EXISTS idx_activities_thread_sequence ON activities(thread_id, sequence);
  `);

  addColumnIfMissing(db, "checkpoints", "reverted_to_turn", "INTEGER");
  addColumnIfMissing(db, "threads", "closed_at", "TEXT");
  // NULL on every Thread row written before durable activity existed —
  // which is exactly the signal the UI needs, since activity recording is
  // prospective only and those Threads have nothing to show.
  addColumnIfMissing(db, "threads", "records_activity", "INTEGER");
  addColumnIfMissing(db, "events", "thread_id", "TEXT");
  db.exec("CREATE INDEX IF NOT EXISTS idx_events_thread_id ON events(thread_id)");
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

/**
 * Enforces (and indexes) projects.workspace_root uniqueness at the schema
 * level, so the dedup invariant ws-server.ts's project.create handler
 * relies on isn't only enforced by that one call site.
 *
 * This previously fell back to a plain (non-unique) index when a real
 * database already had duplicate rows, and left it that way. That looked
 * conservative but silently disabled dedup permanently: project.create is
 * insert-first and only detects a duplicate when the index *rejects* the
 * insert, so with no real constraint every resubmission created another
 * row. Having duplicates was what prevented the constraint that would have
 * stopped more of them (argusde#72) — so the duplicates are merged first,
 * and the constraint always ends up real.
 *
 * A single index name either way — CREATE ... IF NOT EXISTS treats an
 * existing index of that name as satisfied regardless of its uniqueness,
 * so an older database that already has the non-unique version has to have
 * it dropped explicitly rather than "created over".
 */
function ensureWorkspaceRootIndex(db: Database.Database): void {
  mergeDuplicateProjects(db);
  // An existing non-unique index of this name (written by the older
  // fallback above) would otherwise satisfy CREATE ... IF NOT EXISTS and
  // leave the constraint permanently absent.
  db.exec("DROP INDEX IF EXISTS idx_projects_workspace_root");
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_workspace_root ON projects(workspace_root)");
}

/**
 * Collapses projects that describe the same workspace_root down to one.
 *
 * The earliest-created row wins and the rest are merged into it. Threads
 * are re-parented rather than dropped — every duplicate row described the
 * same folder, so their Threads are all legitimately that Project's
 * history, and losing them would be losing real user data to a cleanup.
 *
 * Idempotent: on a database with no duplicates this does nothing, so it's
 * safe on every open.
 */
function mergeDuplicateProjects(db: Database.Database): void {
  // Only meaningful once both tables exist — on a brand-new database this
  // runs before threads is created, and there's nothing to merge anyway.
  const hasThreads = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'threads'")
    .get() as { name: string } | undefined;

  const duplicateRoots = db
    .prepare("SELECT workspace_root FROM projects GROUP BY workspace_root HAVING COUNT(*) > 1")
    .all() as { workspace_root: string }[];
  if (duplicateRoots.length === 0) return;

  const merge = db.transaction(() => {
    for (const { workspace_root: root } of duplicateRoots) {
      const rows = db
        .prepare("SELECT id FROM projects WHERE workspace_root = ? ORDER BY created_at, id")
        .all(root) as { id: string }[];
      const [winner, ...losers] = rows;
      if (!winner || losers.length === 0) continue;

      for (const loser of losers) {
        if (hasThreads) {
          db.prepare("UPDATE threads SET project_id = ? WHERE project_id = ?").run(winner.id, loser.id);
        }
        db.prepare("DELETE FROM projects WHERE id = ?").run(loser.id);
      }
    }
  });
  merge();
}
