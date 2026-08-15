import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventStore } from "./event-store.js";

let dbDir: string;
let dbPath: string;
let store: EventStore;

beforeEach(() => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-event-store-"));
  dbPath = path.join(dbDir, "argusde.sqlite");
  store = new EventStore(dbPath);
});

afterEach(() => {
  store.close();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

describe("EventStore", () => {
  it("projects a project.created event into listProjects/getProject", () => {
    store.appendEvent({
      kind: "project.created",
      projectId: "proj-1",
      workspaceRoot: "/home/deanj/repos/argusde",
      title: "ArgusDE",
      timestamp: "2026-08-13T00:00:00.000Z",
    });

    expect(store.listProjects()).toEqual([
      { id: "proj-1", workspaceRoot: "/home/deanj/repos/argusde", title: "ArgusDE", createdAt: "2026-08-13T00:00:00.000Z" },
    ]);
    expect(store.getProject("proj-1")).toEqual({
      id: "proj-1",
      workspaceRoot: "/home/deanj/repos/argusde",
      title: "ArgusDE",
      createdAt: "2026-08-13T00:00:00.000Z",
    });
    expect(store.getProject("missing")).toBeUndefined();
  });

  it("getProjectByWorkspaceRoot finds an existing project by its exact workspaceRoot, or returns undefined", () => {
    store.appendEvent({
      kind: "project.created",
      projectId: "proj-1",
      workspaceRoot: "/home/deanj/repos/argusde",
      title: "ArgusDE",
      timestamp: "2026-08-13T00:00:00.000Z",
    });

    expect(store.getProjectByWorkspaceRoot("/home/deanj/repos/argusde")).toEqual({
      id: "proj-1",
      workspaceRoot: "/home/deanj/repos/argusde",
      title: "ArgusDE",
      createdAt: "2026-08-13T00:00:00.000Z",
    });
    expect(store.getProjectByWorkspaceRoot("/home/deanj/repos/argusde/")).toBeUndefined();
    expect(store.getProjectByWorkspaceRoot("/no/such/path")).toBeUndefined();
  });

  it("enforces workspace_root uniqueness at the database level on a fresh install — not just via ws-server.ts's own check-then-insert", () => {
    // appendEvent itself has no dedup logic (only ws-server.ts's
    // project.create handler does, via getProjectByWorkspaceRoot) — this
    // probes the constraint directly, independent of that one call site,
    // so a future caller that bypasses it (a batch import, a refactor)
    // still can't insert a second row for the same workspace_root.
    store.appendEvent({
      kind: "project.created",
      projectId: "proj-a",
      workspaceRoot: "/dup",
      title: "A",
      timestamp: "2026-08-14T00:00:00.000Z",
    });
    expect(() =>
      store.appendEvent({
        kind: "project.created",
        projectId: "proj-b",
        workspaceRoot: "/dup",
        title: "B",
        timestamp: "2026-08-14T00:00:01.000Z",
      }),
    ).toThrow(/UNIQUE constraint failed/);
  });

  it("upgrading a database that already has duplicate workspace_root rows (from before this constraint existed) doesn't break — falls back to a non-unique index", () => {
    const legacyDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-event-store-legacy-dup-projects-"));
    const legacyDbPath = path.join(legacyDbDir, "argusde.sqlite");
    const legacyDb = new Database(legacyDbPath);
    legacyDb.exec(`
      CREATE TABLE projects (
        id TEXT PRIMARY KEY,
        workspace_root TEXT NOT NULL,
        title TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    legacyDb
      .prepare("INSERT INTO projects (id, workspace_root, title, created_at) VALUES (?, ?, ?, ?)")
      .run("proj-a", "/dup", "A", "2026-08-14T00:00:00.000Z");
    legacyDb
      .prepare("INSERT INTO projects (id, workspace_root, title, created_at) VALUES (?, ?, ?, ?)")
      .run("proj-b", "/dup", "B", "2026-08-14T00:00:01.000Z");
    legacyDb.close();

    expect(() => new EventStore(legacyDbPath)).not.toThrow();
    const upgraded = new EventStore(legacyDbPath);
    try {
      expect(upgraded.listProjects().map((p) => p.id)).toEqual(["proj-a", "proj-b"]);
    } finally {
      upgraded.close();
      fs.rmSync(legacyDbDir, { recursive: true, force: true });
    }
  });

  it("projects a thread.created event into listThreads/getThread, scoped by project", () => {
    store.appendEvent({
      kind: "project.created",
      projectId: "proj-1",
      workspaceRoot: "/workspace",
      title: "Project One",
      timestamp: "2026-08-13T00:00:00.000Z",
    });
    store.appendEvent({
      kind: "thread.created",
      threadId: "thread-1",
      projectId: "proj-1",
      title: "Fix the bug",
      worktreePath: null,
      timestamp: "2026-08-13T00:01:00.000Z",
    });
    store.appendEvent({
      kind: "thread.created",
      threadId: "thread-2",
      projectId: "proj-1",
      title: "Explore worktree",
      worktreePath: "/workspace-worktrees/thread-2",
      timestamp: "2026-08-13T00:02:00.000Z",
    });

    expect(store.listThreads("proj-1")).toEqual([
      {
        id: "thread-1",
        projectId: "proj-1",
        title: "Fix the bug",
        worktreePath: null,
        currentModeId: null,
        createdAt: "2026-08-13T00:01:00.000Z",
        closedAt: null,
      },
      {
        id: "thread-2",
        projectId: "proj-1",
        title: "Explore worktree",
        worktreePath: "/workspace-worktrees/thread-2",
        currentModeId: null,
        createdAt: "2026-08-13T00:02:00.000Z",
        closedAt: null,
      },
    ]);
    expect(store.getThread("thread-2")?.worktreePath).toBe("/workspace-worktrees/thread-2");
    expect(store.listThreads("other-project")).toEqual([]);
  });

  it("projects thread.checkpoint-captured events into listCheckpoints, ordered by turn", () => {
    store.appendEvent({
      kind: "project.created",
      projectId: "proj-1",
      workspaceRoot: "/workspace",
      title: "Project One",
      timestamp: "2026-08-13T00:00:00.000Z",
    });
    store.appendEvent({
      kind: "thread.created",
      threadId: "thread-1",
      projectId: "proj-1",
      title: "Fix the bug",
      worktreePath: null,
      timestamp: "2026-08-13T00:00:30.000Z",
    });
    store.appendEvent({
      kind: "thread.checkpoint-captured",
      threadId: "thread-1",
      turn: 0,
      ref: "refs/argusde/checkpoints/thread-1/turn/0",
      timestamp: "2026-08-13T00:00:00.000Z",
    });
    store.appendEvent({
      kind: "thread.checkpoint-captured",
      threadId: "thread-1",
      turn: 1,
      ref: "refs/argusde/checkpoints/thread-1/turn/1",
      timestamp: "2026-08-13T00:05:00.000Z",
    });

    expect(store.listCheckpoints("thread-1")).toEqual([
      { threadId: "thread-1", turn: 0, ref: "refs/argusde/checkpoints/thread-1/turn/0", createdAt: "2026-08-13T00:00:00.000Z", revertedToTurn: null },
      { threadId: "thread-1", turn: 1, ref: "refs/argusde/checkpoints/thread-1/turn/1", createdAt: "2026-08-13T00:05:00.000Z", revertedToTurn: null },
    ]);
  });

  it("adds reverted_to_turn to a checkpoints table that predates it, instead of leaving an existing database permanently broken", () => {
    // A fresh path of its own — beforeEach's `store` has already run
    // ensureSchema (with the current, already-upgraded shape) against
    // `dbPath`, so reusing it here couldn't simulate a real pre-existing
    // database. CREATE TABLE IF NOT EXISTS is a no-op against an
    // already-existing table — this builds one against the checkpoints
    // table's original (narrower) shape, the way a real user's pre-Phase-9
    // database file actually looks, then confirms opening an EventStore
    // against it upgrades it instead of leaving it permanently broken.
    const legacyDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-event-store-legacy-"));
    const legacyDbPath = path.join(legacyDbDir, "argusde.sqlite");
    const legacyDb = new Database(legacyDbPath);
    legacyDb.exec(`
      CREATE TABLE checkpoints (
        thread_id TEXT NOT NULL,
        turn INTEGER NOT NULL,
        ref TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (thread_id, turn)
      );
    `);
    legacyDb.close();

    // Constructing an EventStore (which runs ensureSchema) must not throw,
    // and ordinary checkpoint capture — not just revert — must keep working
    // against the now-upgraded table.
    const upgraded = new EventStore(legacyDbPath);
    try {
      upgraded.appendEvent({
        kind: "project.created",
        projectId: "proj-1",
        workspaceRoot: "/workspace",
        title: "Project One",
        timestamp: "2026-08-14T00:00:00.000Z",
      });
      upgraded.appendEvent({
        kind: "thread.created",
        threadId: "thread-1",
        projectId: "proj-1",
        title: "Fix the bug",
        worktreePath: null,
        timestamp: "2026-08-14T00:00:30.000Z",
      });

      expect(() =>
        upgraded.appendEvent({
          kind: "thread.checkpoint-captured",
          threadId: "thread-1",
          turn: 0,
          ref: "refs/argusde/checkpoints/thread-1/turn/0",
          timestamp: "2026-08-14T00:00:00.000Z",
        }),
      ).not.toThrow();

      expect(upgraded.listCheckpoints("thread-1")).toEqual([
        { threadId: "thread-1", turn: 0, ref: "refs/argusde/checkpoints/thread-1/turn/0", createdAt: "2026-08-14T00:00:00.000Z", revertedToTurn: null },
      ]);
    } finally {
      upgraded.close();
      fs.rmSync(legacyDbDir, { recursive: true, force: true });
    }
  });

  it("projects a revert-originated thread.checkpoint-captured event's revertedToTurn field", () => {
    store.appendEvent({
      kind: "project.created",
      projectId: "proj-1",
      workspaceRoot: "/workspace",
      title: "Project One",
      timestamp: "2026-08-13T00:00:00.000Z",
    });
    store.appendEvent({
      kind: "thread.created",
      threadId: "thread-1",
      projectId: "proj-1",
      title: "Fix the bug",
      worktreePath: null,
      timestamp: "2026-08-13T00:00:30.000Z",
    });
    store.appendEvent({
      kind: "thread.checkpoint-captured",
      threadId: "thread-1",
      turn: 0,
      ref: "refs/argusde/checkpoints/thread-1/turn/0",
      timestamp: "2026-08-13T00:00:00.000Z",
    });
    store.appendEvent({
      kind: "thread.checkpoint-captured",
      threadId: "thread-1",
      turn: 1,
      ref: "refs/argusde/checkpoints/thread-1/turn/1",
      revertedToTurn: 0,
      timestamp: "2026-08-13T00:05:00.000Z",
    });

    expect(store.listCheckpoints("thread-1")).toEqual([
      { threadId: "thread-1", turn: 0, ref: "refs/argusde/checkpoints/thread-1/turn/0", createdAt: "2026-08-13T00:00:00.000Z", revertedToTurn: null },
      { threadId: "thread-1", turn: 1, ref: "refs/argusde/checkpoints/thread-1/turn/1", createdAt: "2026-08-13T00:05:00.000Z", revertedToTurn: 0 },
    ]);
  });

  it("projects thread.mode-changed events onto the thread's currentModeId", () => {
    store.appendEvent({
      kind: "project.created",
      projectId: "proj-1",
      workspaceRoot: "/workspace",
      title: "Project One",
      timestamp: "2026-08-13T00:00:00.000Z",
    });
    store.appendEvent({
      kind: "thread.created",
      threadId: "thread-1",
      projectId: "proj-1",
      title: "Fix the bug",
      worktreePath: null,
      timestamp: "2026-08-13T00:01:00.000Z",
    });

    expect(store.getThread("thread-1")?.currentModeId).toBeNull();

    store.appendEvent({
      kind: "thread.mode-changed",
      threadId: "thread-1",
      modeId: "plan",
      timestamp: "2026-08-13T00:02:00.000Z",
    });

    expect(store.getThread("thread-1")?.currentModeId).toBe("plan");
  });

  it("projects a thread.worktree-promoted event onto the thread's worktreePath", () => {
    store.appendEvent({
      kind: "project.created",
      projectId: "proj-1",
      workspaceRoot: "/workspace",
      title: "Project One",
      timestamp: "2026-08-13T00:00:00.000Z",
    });
    store.appendEvent({
      kind: "thread.created",
      threadId: "thread-1",
      projectId: "proj-1",
      title: "Fix the bug",
      worktreePath: null,
      timestamp: "2026-08-13T00:01:00.000Z",
    });

    expect(store.getThread("thread-1")?.worktreePath).toBeNull();

    store.appendEvent({
      kind: "thread.worktree-promoted",
      threadId: "thread-1",
      worktreePath: "/workspace-worktrees/thread-1",
      timestamp: "2026-08-13T00:02:00.000Z",
    });

    expect(store.getThread("thread-1")?.worktreePath).toBe("/workspace-worktrees/thread-1");
  });

  it("projects a thread.closed event onto the thread's closedAt, leaving other threads untouched", () => {
    store.appendEvent({
      kind: "project.created",
      projectId: "proj-1",
      workspaceRoot: "/workspace",
      title: "Project One",
      timestamp: "2026-08-14T00:00:00.000Z",
    });
    store.appendEvent({
      kind: "thread.created",
      threadId: "thread-1",
      projectId: "proj-1",
      title: "Fix the bug",
      worktreePath: null,
      timestamp: "2026-08-14T00:01:00.000Z",
    });
    store.appendEvent({
      kind: "thread.created",
      threadId: "thread-2",
      projectId: "proj-1",
      title: "Unrelated thread",
      worktreePath: null,
      timestamp: "2026-08-14T00:01:30.000Z",
    });

    expect(store.getThread("thread-1")?.closedAt).toBeNull();

    store.appendEvent({
      kind: "thread.closed",
      threadId: "thread-1",
      timestamp: "2026-08-14T00:02:00.000Z",
    });

    expect(store.getThread("thread-1")?.closedAt).toBe("2026-08-14T00:02:00.000Z");
    expect(store.getThread("thread-2")?.closedAt).toBeNull();
  });

  it("adds closed_at to a threads table that predates it, instead of leaving an existing database permanently broken", () => {
    // Same rationale and pattern as the reverted_to_turn upgrade test above
    // — a fresh path of its own, since beforeEach's `store` has already run
    // ensureSchema with the current, already-upgraded shape.
    const legacyDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-event-store-legacy-threads-"));
    const legacyDbPath = path.join(legacyDbDir, "argusde.sqlite");
    const legacyDb = new Database(legacyDbPath);
    legacyDb.exec(`
      CREATE TABLE threads (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        worktree_path TEXT,
        current_mode_id TEXT,
        created_at TEXT NOT NULL
      );
    `);
    legacyDb.close();

    const upgraded = new EventStore(legacyDbPath);
    try {
      upgraded.appendEvent({
        kind: "project.created",
        projectId: "proj-1",
        workspaceRoot: "/workspace",
        title: "Project One",
        timestamp: "2026-08-14T00:00:00.000Z",
      });
      upgraded.appendEvent({
        kind: "thread.created",
        threadId: "thread-1",
        projectId: "proj-1",
        title: "Fix the bug",
        worktreePath: null,
        timestamp: "2026-08-14T00:00:30.000Z",
      });

      expect(() =>
        upgraded.appendEvent({ kind: "thread.closed", threadId: "thread-1", timestamp: "2026-08-14T00:01:00.000Z" }),
      ).not.toThrow();

      expect(upgraded.getThread("thread-1")?.closedAt).toBe("2026-08-14T00:01:00.000Z");
    } finally {
      upgraded.close();
      fs.rmSync(legacyDbDir, { recursive: true, force: true });
    }
  });

  it("re-appending thread.checkpoint-captured for turn 0 replaces the prior ref instead of throwing a primary-key violation", () => {
    store.appendEvent({
      kind: "project.created",
      projectId: "proj-1",
      workspaceRoot: "/workspace",
      title: "Project One",
      timestamp: "2026-08-13T00:00:00.000Z",
    });
    store.appendEvent({
      kind: "thread.created",
      threadId: "thread-1",
      projectId: "proj-1",
      title: "Fix the bug",
      worktreePath: null,
      timestamp: "2026-08-13T00:00:30.000Z",
    });
    store.appendEvent({
      kind: "thread.checkpoint-captured",
      threadId: "thread-1",
      turn: 0,
      ref: "refs/argusde/checkpoints/thread-1/turn/0",
      timestamp: "2026-08-13T00:00:00.000Z",
    });

    // Promotion re-captures the baseline in the new worktree cwd — same
    // turn, a new timestamp, the same ref name (update-ref just moves it).
    expect(() =>
      store.appendEvent({
        kind: "thread.checkpoint-captured",
        threadId: "thread-1",
        turn: 0,
        ref: "refs/argusde/checkpoints/thread-1/turn/0",
        timestamp: "2026-08-13T00:03:00.000Z",
      }),
    ).not.toThrow();

    expect(store.listCheckpoints("thread-1")).toEqual([
      { threadId: "thread-1", turn: 0, ref: "refs/argusde/checkpoints/thread-1/turn/0", createdAt: "2026-08-13T00:03:00.000Z", revertedToTurn: null },
    ]);
  });

  it("still rejects a duplicate thread.checkpoint-captured for a non-zero turn — only turn 0 gets the re-baseline exception", () => {
    store.appendEvent({
      kind: "project.created",
      projectId: "proj-1",
      workspaceRoot: "/workspace",
      title: "Project One",
      timestamp: "2026-08-13T00:00:00.000Z",
    });
    store.appendEvent({
      kind: "thread.created",
      threadId: "thread-1",
      projectId: "proj-1",
      title: "Fix the bug",
      worktreePath: null,
      timestamp: "2026-08-13T00:00:30.000Z",
    });
    store.appendEvent({
      kind: "thread.checkpoint-captured",
      threadId: "thread-1",
      turn: 1,
      ref: "refs/argusde/checkpoints/thread-1/turn/1",
      timestamp: "2026-08-13T00:01:00.000Z",
    });

    // A hypothetical bug causing completeTurn() to fire twice for the same
    // turn must still surface as a real error, not silently overwrite the
    // ref — the PK's protection is only relaxed for turn 0's one
    // legitimate re-baseline path.
    expect(() =>
      store.appendEvent({
        kind: "thread.checkpoint-captured",
        threadId: "thread-1",
        turn: 1,
        ref: "refs/argusde/checkpoints/thread-1/turn/1-duplicate",
        timestamp: "2026-08-13T00:02:00.000Z",
      }),
    ).toThrow();
  });

  it("persists across reopening the same database file", () => {
    store.appendEvent({
      kind: "project.created",
      projectId: "proj-1",
      workspaceRoot: "/workspace",
      title: "Project One",
      timestamp: "2026-08-13T00:00:00.000Z",
    });
    store.close();

    const reopened = new EventStore(dbPath);
    expect(reopened.listProjects()).toHaveLength(1);
    reopened.close();

    // afterEach still closes `store`; re-point it at the reopened instance's
    // already-closed handle so the double-close is a no-op rather than an error.
    store = reopened;
  });

  it("listEventsForThread returns only events belonging to that thread, in append order", () => {
    store.appendEvent({
      kind: "project.created",
      projectId: "proj-1",
      workspaceRoot: "/workspace",
      title: "Project One",
      timestamp: "2026-08-13T00:00:00.000Z",
    });
    store.appendEvent({
      kind: "thread.created",
      threadId: "thread-1",
      projectId: "proj-1",
      title: "Fix the bug",
      worktreePath: null,
      timestamp: "2026-08-13T00:01:00.000Z",
    });
    store.appendEvent({
      kind: "thread.created",
      threadId: "thread-2",
      projectId: "proj-1",
      title: "Other thread",
      worktreePath: null,
      timestamp: "2026-08-13T00:01:30.000Z",
    });
    store.appendEvent({
      kind: "thread.message-recorded",
      threadId: "thread-1",
      messageId: "msg-1",
      role: "agent",
      content: [{ type: "text", text: "hello" }],
      timestamp: "2026-08-13T00:02:00.000Z",
    });

    const events = store.listEventsForThread("thread-1");

    expect(events.map((e) => e.kind)).toEqual(["thread.created", "thread.message-recorded"]);
    expect(events.every((e) => "threadId" in e && e.threadId === "thread-1")).toBe(true);
  });

  it("backfills thread_id for events written before the column existed, so listEventsForThread still finds them", () => {
    // Same rationale and pattern as the reverted_to_turn/closed_at upgrade
    // tests — a fresh path of its own, since beforeEach's `store` has
    // already run ensureSchema with the current, already-upgraded shape.
    // This one also has to hand-insert real event rows (not just an empty
    // legacy table), because the thing under test is backfilling existing
    // data, not just tolerating a missing column on write.
    const legacyDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-event-store-legacy-events-"));
    const legacyDbPath = path.join(legacyDbDir, "argusde.sqlite");
    const legacyDb = new Database(legacyDbPath);
    legacyDb.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const insertLegacyEvent = legacyDb.prepare("INSERT INTO events (kind, payload, created_at) VALUES (?, ?, ?)");
    const threadCreated = {
      kind: "thread.created",
      threadId: "thread-1",
      projectId: "proj-1",
      title: "Fix the bug",
      worktreePath: null,
      timestamp: "2026-08-14T00:00:00.000Z",
    };
    const messageRecorded = {
      kind: "thread.message-recorded",
      threadId: "thread-1",
      messageId: "msg-1",
      role: "agent",
      content: [{ type: "text", text: "hello" }],
      timestamp: "2026-08-14T00:01:00.000Z",
    };
    insertLegacyEvent.run(threadCreated.kind, JSON.stringify(threadCreated), threadCreated.timestamp);
    insertLegacyEvent.run(messageRecorded.kind, JSON.stringify(messageRecorded), messageRecorded.timestamp);
    legacyDb.close();

    const upgraded = new EventStore(legacyDbPath);
    try {
      const events = upgraded.listEventsForThread("thread-1");
      expect(events.map((e) => e.kind)).toEqual(["thread.created", "thread.message-recorded"]);
    } finally {
      upgraded.close();
      fs.rmSync(legacyDbDir, { recursive: true, force: true });
    }
  });

  it("skips a malformed payload during thread_id backfill rather than crashing startup for every thread", () => {
    // A single corrupted row (crash mid-write, manual edit, whatever the
    // cause) shouldn't take down the whole app on the next startup —
    // review finding on argusde#47's backfill. The good row alongside it
    // must still backfill and remain readable.
    const legacyDbDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-event-store-legacy-malformed-"));
    const legacyDbPath = path.join(legacyDbDir, "argusde.sqlite");
    const legacyDb = new Database(legacyDbPath);
    legacyDb.exec(`
      CREATE TABLE events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
    `);
    const insertLegacyEvent = legacyDb.prepare("INSERT INTO events (kind, payload, created_at) VALUES (?, ?, ?)");
    const threadCreated = {
      kind: "thread.created",
      threadId: "thread-1",
      projectId: "proj-1",
      title: "Fix the bug",
      worktreePath: null,
      timestamp: "2026-08-14T00:00:00.000Z",
    };
    insertLegacyEvent.run(threadCreated.kind, JSON.stringify(threadCreated), threadCreated.timestamp);
    insertLegacyEvent.run("thread.message-recorded", "{not valid json", "2026-08-14T00:01:00.000Z");
    legacyDb.close();

    let upgraded: EventStore | undefined;
    try {
      expect(() => (upgraded = new EventStore(legacyDbPath))).not.toThrow();
      expect(upgraded!.listEventsForThread("thread-1").map((e) => e.kind)).toEqual(["thread.created"]);
    } finally {
      upgraded?.close();
      fs.rmSync(legacyDbDir, { recursive: true, force: true });
    }
  });

  it("projects a project.deleted event by removing the project, its threads, and their checkpoints", () => {
    store.appendEvent({
      kind: "project.created",
      projectId: "proj-1",
      workspaceRoot: "/workspace-one",
      title: "Project One",
      timestamp: "2026-08-16T00:00:00.000Z",
    });
    store.appendEvent({
      kind: "project.created",
      projectId: "proj-2",
      workspaceRoot: "/workspace-two",
      title: "Project Two",
      timestamp: "2026-08-16T00:00:01.000Z",
    });
    store.appendEvent({
      kind: "thread.created",
      threadId: "thread-1",
      projectId: "proj-1",
      title: "Doomed",
      worktreePath: null,
      timestamp: "2026-08-16T00:01:00.000Z",
    });
    store.appendEvent({
      kind: "thread.checkpoint-captured",
      threadId: "thread-1",
      turn: 0,
      ref: "ref-0",
      timestamp: "2026-08-16T00:01:01.000Z",
    });
    store.appendEvent({
      kind: "thread.created",
      threadId: "thread-2",
      projectId: "proj-2",
      title: "Survivor",
      worktreePath: null,
      timestamp: "2026-08-16T00:02:00.000Z",
    });
    store.appendEvent({
      kind: "thread.checkpoint-captured",
      threadId: "thread-2",
      turn: 0,
      ref: "ref-other",
      timestamp: "2026-08-16T00:02:01.000Z",
    });

    store.appendEvent({ kind: "project.deleted", projectId: "proj-1", timestamp: "2026-08-16T00:03:00.000Z" });

    expect(store.getProject("proj-1")).toBeUndefined();
    expect(store.listThreads("proj-1")).toEqual([]);
    expect(store.getThread("thread-1")).toBeUndefined();
    expect(store.listCheckpoints("thread-1")).toEqual([]);

    // Strictly scoped — a sibling project keeps everything.
    expect(store.getProject("proj-2")?.title).toBe("Project Two");
    expect(store.getThread("thread-2")?.title).toBe("Survivor");
    expect(store.listCheckpoints("thread-2")).toHaveLength(1);
  });

  it("frees the deleted project's workspaceRoot for reuse, so the same folder can be added again", () => {
    store.appendEvent({
      kind: "project.created",
      projectId: "proj-1",
      workspaceRoot: "/reusable",
      title: "First",
      timestamp: "2026-08-16T00:00:00.000Z",
    });
    store.appendEvent({ kind: "project.deleted", projectId: "proj-1", timestamp: "2026-08-16T00:01:00.000Z" });

    expect(store.getProjectByWorkspaceRoot("/reusable")).toBeUndefined();
    // The unique index on workspace_root would throw here if the delete
    // hadn't really removed the row.
    expect(() =>
      store.appendEvent({
        kind: "project.created",
        projectId: "proj-2",
        workspaceRoot: "/reusable",
        title: "Second",
        timestamp: "2026-08-16T00:02:00.000Z",
      }),
    ).not.toThrow();
    expect(store.getProjectByWorkspaceRoot("/reusable")?.id).toBe("proj-2");
  });

  it("deleting an unknown project is a no-op, not an error", () => {
    expect(() =>
      store.appendEvent({ kind: "project.deleted", projectId: "nope", timestamp: "2026-08-16T00:00:00.000Z" }),
    ).not.toThrow();
  });
});
