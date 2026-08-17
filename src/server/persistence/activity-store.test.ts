import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventStore, type DomainEvent } from "./event-store.js";
import { ACTIVITY_BOUNDS } from "./activity-bounds.js";
import type { ChatContentBlock } from "../../shared/acp-events.js";

let dbDir: string;
let dbPath: string;
let store: EventStore;

/** Every activity assertion needs a Thread to hang off, and a Thread needs a Project — this is that preamble, not the thing under test. */
function seedProjectAndThread(threadId = "thread-1"): void {
  store.appendEvent({
    kind: "project.created",
    projectId: "proj-1",
    workspaceRoot: `/tmp/${threadId}`,
    title: "ArgusDE",
    timestamp: "2026-08-17T00:00:00.000Z",
  });
  store.appendEvent({
    kind: "thread.created",
    threadId,
    projectId: "proj-1",
    title: "Thread",
    worktreePath: null,
    timestamp: "2026-08-17T00:00:01.000Z",
  });
}

function activity(overrides: Partial<Extract<DomainEvent, { kind: "thread.activity-recorded" }>> = {}) {
  return {
    kind: "thread.activity-recorded" as const,
    threadId: "thread-1",
    activityId: "tool-1",
    sequence: 1,
    turn: 1,
    toolKind: "read",
    status: "completed" as const,
    summary: "Read src/index.ts",
    detail: "the file contents",
    data: [{ type: "text" as const, text: "the file contents" }],
    timestamp: "2026-08-17T00:00:02.000Z",
    ...overrides,
  };
}

/** The single activity on `thread-1`, asserted to be single — most cases record exactly one and then make claims about it. */
function onlyActivity(threadId = "thread-1") {
  const activities = store.listActivities(threadId);
  expect(activities).toHaveLength(1);
  return activities[0]!;
}

beforeEach(() => {
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-activity-store-"));
  dbPath = path.join(dbDir, "argusde.sqlite");
  store = new EventStore(dbPath);
});

afterEach(() => {
  store.close();
  fs.rmSync(dbDir, { recursive: true, force: true });
});

describe("EventStore activity projection", () => {
  it("projects a thread.activity-recorded event into listActivities", () => {
    seedProjectAndThread();
    store.appendEvent(activity());

    expect(store.listActivities("thread-1")).toEqual([
      {
        threadId: "thread-1",
        activityId: "tool-1",
        sequence: 1,
        turn: 1,
        kind: "read",
        status: "completed",
        summary: "Read src/index.ts",
        detail: "the file contents",
        data: [{ type: "text", text: "the file contents" }],
        dataTruncated: false,
        createdAt: "2026-08-17T00:00:02.000Z",
      },
    ]);
  });

  it("returns activities in sequence order, not insertion order", () => {
    seedProjectAndThread();
    // Deliberately appended out of order within a single turn — the point of
    // an explicit sequence is that insertion accident can't decide the
    // timeline when several activities land in one Turn.
    store.appendEvent(activity({ activityId: "tool-c", sequence: 3, summary: "third" }));
    store.appendEvent(activity({ activityId: "tool-a", sequence: 1, summary: "first" }));
    store.appendEvent(activity({ activityId: "tool-b", sequence: 2, summary: "second" }));

    expect(store.listActivities("thread-1").map((a) => a.summary)).toEqual(["first", "second", "third"]);
  });

  it("scopes activities to their own thread", () => {
    seedProjectAndThread("thread-1");
    store.appendEvent({
      kind: "thread.created",
      threadId: "thread-2",
      projectId: "proj-1",
      title: "Other",
      worktreePath: null,
      timestamp: "2026-08-17T00:00:01.000Z",
    });
    store.appendEvent(activity({ threadId: "thread-1", activityId: "a" }));
    store.appendEvent(activity({ threadId: "thread-2", activityId: "b" }));

    expect(store.listActivities("thread-1").map((a) => a.activityId)).toEqual(["a"]);
    expect(store.listActivities("thread-2").map((a) => a.activityId)).toEqual(["b"]);
  });

  describe("updates", () => {
    it("merges an update onto the existing activity and keeps its original sequence", () => {
      seedProjectAndThread();
      store.appendEvent(activity({ sequence: 1, status: "pending", detail: null, data: [] }));
      store.appendEvent(
        activity({
          // A later sequence on the update must NOT reorder the activity —
          // it began where it began.
          sequence: 99,
          status: "completed",
          detail: "done",
          data: [{ type: "text", text: "done" }],
        }),
      );

      const record = onlyActivity();
      expect(record.sequence).toBe(1);
      expect(record.status).toBe("completed");
      expect(record.detail).toBe("done");
    });

    it("leaves existing content untouched when an update omits it", () => {
      seedProjectAndThread();
      store.appendEvent(activity({ data: [{ type: "text", text: "original" }], detail: "original" }));
      // ACP's tool_call_update replaces the content collection only when the
      // field is present — an absent one must not clear it.
      store.appendEvent(activity({ data: undefined, detail: undefined, status: "failed" }));

      const record = onlyActivity();
      expect(record.status).toBe("failed");
      expect(record.detail).toBe("original");
      expect(record.data).toEqual([{ type: "text", text: "original" }]);
    });

    it("records a failed tool call with that outcome", () => {
      seedProjectAndThread();
      store.appendEvent(activity({ status: "pending" }));
      store.appendEvent(activity({ status: "failed", detail: "permission denied" }));

      expect(onlyActivity()).toMatchObject({ status: "failed", detail: "permission denied" });
    });
  });

  describe("bounds", () => {
    it("stores a summary exactly at the bound untouched", () => {
      seedProjectAndThread();
      const atBound = "x".repeat(ACTIVITY_BOUNDS.summaryChars);
      store.appendEvent(activity({ summary: atBound }));

      expect(onlyActivity().summary).toBe(atBound);
    });

    it("truncates a summary one character over the bound", () => {
      seedProjectAndThread();
      store.appendEvent(activity({ summary: "x".repeat(ACTIVITY_BOUNDS.summaryChars + 1) }));

      const { summary } = onlyActivity();
      expect(summary).toHaveLength(ACTIVITY_BOUNDS.summaryChars);
      expect(summary?.endsWith("…")).toBe(true);
    });

    it("truncates a detail over the bound and leaves one at the bound alone", () => {
      seedProjectAndThread();
      const atBound = "y".repeat(ACTIVITY_BOUNDS.detailChars);
      store.appendEvent(activity({ activityId: "at", detail: atBound }));
      store.appendEvent(activity({ activityId: "over", detail: "y".repeat(ACTIVITY_BOUNDS.detailChars + 1) }));

      const byId = new Map(store.listActivities("thread-1").map((a) => [a.activityId, a] as const));
      expect(byId.get("at")?.detail).toBe(atBound);
      expect(byId.get("over")?.detail).toHaveLength(ACTIVITY_BOUNDS.detailChars);
    });

    it("stores data under the byte cap whole, and flags nothing", () => {
      seedProjectAndThread();
      const data: ChatContentBlock[] = [{ type: "text", text: "z".repeat(1000) }];
      store.appendEvent(activity({ data }));

      const record = onlyActivity();
      expect(record.data).toEqual(data);
      expect(record.dataTruncated).toBe(false);
    });

    it("truncates data over the byte cap and flags it", () => {
      seedProjectAndThread();
      // Several blocks so truncation can drop whole ones and still leave
      // parseable JSON behind.
      const data: ChatContentBlock[] = Array.from({ length: 8 }, (_, i) => ({
        type: "text" as const,
        text: `${i}`.repeat(4000),
      }));
      store.appendEvent(activity({ data }));

      const record = onlyActivity();
      expect(record.dataTruncated).toBe(true);
      expect(record.data.length).toBeLessThan(data.length);
      expect(Buffer.byteLength(JSON.stringify(record.data), "utf8")).toBeLessThanOrEqual(ACTIVITY_BOUNDS.dataBytes);
    });

    it("bounds the appended event itself, not only the projection", () => {
      seedProjectAndThread();
      store.appendEvent(activity({ summary: "x".repeat(500), data: [{ type: "text", text: "z".repeat(40_000) }] }));

      // The whole point of bounding before the insert: the append-only log
      // is the thing that grows forever, so an unbounded payload there
      // defeats the cap even with a tidy projection.
      const recorded = store
        .listEventsForThread("thread-1")
        .find((e): e is Extract<DomainEvent, { kind: "thread.activity-recorded" }> => e.kind === "thread.activity-recorded");
      expect(recorded?.summary).toHaveLength(ACTIVITY_BOUNDS.summaryChars);
      expect(Buffer.byteLength(JSON.stringify(recorded?.data), "utf8")).toBeLessThanOrEqual(ACTIVITY_BOUNDS.dataBytes);
    });
  });

  describe("sequence allocation", () => {
    it("starts at 1 for a thread with no history", () => {
      seedProjectAndThread();
      expect(store.getNextSequence("thread-1")).toBe(1);
    });

    it("continues past both persisted activities and persisted messages", () => {
      seedProjectAndThread();
      store.appendEvent(activity({ sequence: 4 }));
      store.appendEvent({
        kind: "thread.message-recorded",
        threadId: "thread-1",
        messageId: "agent-1",
        role: "agent",
        content: [{ type: "text", text: "hi" }],
        sequence: 7,
        timestamp: "2026-08-17T00:00:03.000Z",
      });

      // Survives a restart — the counter lives in ThreadRuntime's memory,
      // so it has to be recoverable from what was persisted.
      expect(store.getNextSequence("thread-1")).toBe(8);
    });

    it("ignores messages left over from before sequencing existed", () => {
      seedProjectAndThread();
      store.appendEvent({
        kind: "thread.message-recorded",
        threadId: "thread-1",
        messageId: "user-1",
        role: "user",
        content: [{ type: "text", text: "hi" }],
        timestamp: "2026-08-17T00:00:03.000Z",
      });

      expect(store.getNextSequence("thread-1")).toBe(1);
    });
  });

  describe("pre-feature threads", () => {
    it("marks a Thread created now as recording activity", () => {
      seedProjectAndThread();
      expect(store.getThread("thread-1")?.recordsActivity).toBe(true);
      expect(store.listThreads("proj-1")[0]?.recordsActivity).toBe(true);
    });

    it("reports a Thread row that predates the feature as not recording activity", () => {
      seedProjectAndThread();
      store.close();
      // Simulates a row written by a build that had no records_activity
      // column at all — exactly what addColumnIfMissing leaves behind on a
      // real user's existing database.
      const raw = new Database(dbPath);
      raw.prepare("UPDATE threads SET records_activity = NULL WHERE id = ?").run("thread-1");
      raw.close();

      store = new EventStore(dbPath);
      expect(store.getThread("thread-1")?.recordsActivity).toBe(false);
    });
  });

  describe("schema setup", () => {
    it("adds the activities table to a database that predates it", () => {
      seedProjectAndThread();
      store.appendEvent(activity());
      store.close();

      // Drop it the way an older build's database would simply never have
      // had it, then reopen: ensureSchema has to put it back, and the
      // surviving rows have to stay readable.
      const raw = new Database(dbPath);
      raw.exec("DROP TABLE activities");
      raw.close();

      store = new EventStore(dbPath);
      expect(store.listActivities("thread-1")).toEqual([]);
      expect(store.getThread("thread-1")?.title).toBe("Thread");
      store.appendEvent(activity({ activityId: "tool-2", sequence: 2 }));
      expect(store.listActivities("thread-1")).toHaveLength(1);
    });
  });

  describe("project.deleted", () => {
    it("removes the deleted Project's activities", () => {
      seedProjectAndThread();
      store.appendEvent(activity());
      store.appendEvent({ kind: "project.deleted", projectId: "proj-1", timestamp: "2026-08-17T00:00:09.000Z" });

      expect(store.listActivities("thread-1")).toEqual([]);
      expect(store.listProjects()).toEqual([]);
    });
  });
});
