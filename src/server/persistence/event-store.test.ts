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
});
