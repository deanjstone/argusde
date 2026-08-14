import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { agent, methods } from "@agentclientprotocol/sdk";
import { AcpSession } from "../../utility/acp-session.js";
import { createFakeAgent, type FakeAgentStep } from "../../utility/fake-agent.js";
import { EventStore } from "../persistence/event-store.js";
import { CheckpointStore } from "../checkpoint/checkpoint-store.js";
import { ThreadRuntime } from "./thread-runtime.js";
import type { AcpSessionEvent } from "../../shared/acp-events.js";

let repoDir: string;
let dbDir: string;
let eventStore: EventStore;
let checkpointStore: CheckpointStore;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
}

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-thread-runtime-repo-"));
  git(["init", "--initial-branch=main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "ArgusDE Test"]);
  fs.writeFileSync(path.join(repoDir, "file.txt"), "hello\n");
  git(["add", "-A"]);
  git(["commit", "-m", "initial commit"]);

  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-thread-runtime-db-"));
  eventStore = new EventStore(path.join(dbDir, "argusde.sqlite"));
  checkpointStore = new CheckpointStore();

  // ThreadRuntime captures checkpoints and appends thread-scoped events for
  // an already-created Thread — creating the Project/Thread rows is the WS
  // command handler's job (Task #5), not ThreadRuntime's.
  eventStore.appendEvent({
    kind: "project.created",
    projectId: "proj-1",
    workspaceRoot: repoDir,
    title: "Test Project",
    timestamp: "2026-08-13T00:00:00.000Z",
  });
  eventStore.appendEvent({
    kind: "thread.created",
    threadId: "thread-1",
    projectId: "proj-1",
    title: "Test Thread",
    worktreePath: null,
    timestamp: "2026-08-13T00:00:01.000Z",
  });
});

afterEach(() => {
  eventStore.close();
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
});

function runtimeWithSteps(steps: FakeAgentStep[], onEvent: (e: AcpSessionEvent) => void) {
  const session = new AcpSession({
    name: "argusde-server-test",
    cwd: repoDir,
    createTransport: () => createFakeAgent({ steps }),
  });
  return new ThreadRuntime({
    threadId: "thread-1",
    cwd: repoDir,
    session,
    eventStore,
    checkpointStore,
    onEvent,
  });
}

describe("ThreadRuntime", () => {
  it("captures a turn-0 baseline checkpoint on start()", async () => {
    const runtime = runtimeWithSteps([], () => {});
    await runtime.start();

    expect(eventStore.listCheckpoints("thread-1")).toEqual([
      { threadId: "thread-1", turn: 0, ref: "refs/argusde/checkpoints/thread-1/turn/0", createdAt: expect.any(String), revertedToTurn: null },
    ]);
  });

  it("forwards every live session event to onEvent", async () => {
    const events: AcpSessionEvent[] = [];
    const runtime = runtimeWithSteps([{ type: "message", text: "hi there" }], (e) => events.push(e));
    await runtime.start();
    await runtime.sendMessage("hello");

    expect(events.some((e) => e.kind === "connection-state" && e.state === "connected")).toBe(true);
    expect(events).toContainEqual({
      kind: "message-chunk",
      role: "agent",
      messageId: undefined,
      content: { type: "text", text: "hi there" },
    });
    expect(events.some((e) => e.kind === "turn-complete")).toBe(true);
  });

  it("persists the user's message immediately when sendMessage is called", async () => {
    const runtime = runtimeWithSteps([{ type: "message", text: "reply" }], () => {});
    await runtime.start();
    await runtime.sendMessage("what's broken?");

    const events = eventStore.listEventsForThread("thread-1");
    const userMessage = events.find((e) => e.kind === "thread.message-recorded" && e.role === "user");
    expect(userMessage).toMatchObject({
      kind: "thread.message-recorded",
      role: "user",
      content: [{ type: "text", text: "what's broken?" }],
    });
  });

  it("assembles streamed agent message-chunks into one persisted message and captures turn 1 on turn-complete", async () => {
    const runtime = runtimeWithSteps(
      [
        { type: "message", text: "The bug is ", messageId: "m1" },
        { type: "message", text: "in the retry handler.", messageId: "m1" },
      ],
      () => {},
    );
    await runtime.start();
    await runtime.sendMessage("what's broken?");

    const events = eventStore.listEventsForThread("thread-1");
    const agentMessage = events.find((e) => e.kind === "thread.message-recorded" && e.role === "agent");
    expect(agentMessage).toMatchObject({
      kind: "thread.message-recorded",
      role: "agent",
      content: [{ type: "text", text: "The bug is in the retry handler." }],
    });

    expect(eventStore.listCheckpoints("thread-1").map((c) => c.turn)).toEqual([0, 1]);
  });

  it("assembles chunks with no messageId (undefined) into a single message too, not one message per chunk", async () => {
    const runtime = runtimeWithSteps(
      [
        { type: "message", text: "The bug is " },
        { type: "message", text: "in the retry handler." },
      ],
      () => {},
    );
    await runtime.start();
    await runtime.sendMessage("what's broken?");

    const events = eventStore.listEventsForThread("thread-1");
    const agentMessages = events.filter((e) => e.kind === "thread.message-recorded" && e.role === "agent");
    expect(agentMessages).toHaveLength(1);
    expect(agentMessages[0]).toMatchObject({
      content: [{ type: "text", text: "The bug is in the retry handler." }],
    });
  });

  it("captures checkpoint numbers 1:1 with turns across multiple sendMessage calls, even when a turn makes no changes", async () => {
    const runtime = runtimeWithSteps([{ type: "message", text: "ok" }], () => {});
    await runtime.start();

    await runtime.sendMessage("first");
    await runtime.sendMessage("second");
    await runtime.sendMessage("third");

    expect(eventStore.listCheckpoints("thread-1").map((c) => c.turn)).toEqual([0, 1, 2, 3]);
  });

  it("appends a thread.mode-changed event when the agent reports a mode change", async () => {
    const runtime = runtimeWithSteps([{ type: "mode-change", modeId: "plan" }], () => {});
    await runtime.start();
    await runtime.sendMessage("switch to plan mode");

    const events = eventStore.listEventsForThread("thread-1");
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "thread.mode-changed", modeId: "plan" }),
    );
  });

  it("setMode forwards to the underlying session and the confirmation is persisted via the normal mode-changed path", async () => {
    const runtime = runtimeWithSteps([], () => {});
    await runtime.start();

    await runtime.setMode("plan");

    const events = eventStore.listEventsForThread("thread-1");
    expect(events).toContainEqual(
      expect.objectContaining({ kind: "thread.mode-changed", modeId: "plan" }),
    );
  });

  it("getAvailableModes() returns the catalog cached from start(), and it survives a later mode-changed event with no catalog of its own", async () => {
    const session = new AcpSession({
      name: "argusde-server-test",
      cwd: repoDir,
      createTransport: () =>
        createFakeAgent({
          steps: [{ type: "mode-change", modeId: "plan" }],
          modes: {
            currentModeId: "default",
            availableModes: [
              { id: "default", name: "Default" },
              { id: "plan", name: "Plan" },
            ],
          },
        }),
    });
    const runtime = new ThreadRuntime({ threadId: "thread-1", cwd: repoDir, session, eventStore, checkpointStore, onEvent: () => {} });

    expect(runtime.getAvailableModes()).toEqual([]);

    await runtime.start();
    expect(runtime.getAvailableModes()).toEqual([
      { id: "default", name: "Default" },
      { id: "plan", name: "Plan" },
    ]);

    // A later, real mid-session mode change carries no catalog of its own —
    // must not wipe out the one already cached from start().
    await runtime.sendMessage("switch to plan mode");
    expect(runtime.getAvailableModes()).toEqual([
      { id: "default", name: "Default" },
      { id: "plan", name: "Plan" },
    ]);
  });

  it("getConnectionState() reflects the last-known connection status, defaulting to disconnected before start()", async () => {
    const runtime = runtimeWithSteps([{ type: "message", text: "hi there" }], () => {});

    expect(runtime.getConnectionState()).toEqual({ state: "disconnected", error: undefined });

    await runtime.start();
    expect(runtime.getConnectionState()).toEqual({ state: "connected", error: undefined });
  });

  it("revertToCheckpoint restores the workspace and captures a new forward checkpoint marked with the turn it reverted to", async () => {
    const runtime = runtimeWithSteps([{ type: "message", text: "ok" }], () => {});
    await runtime.start(); // turn 0, file.txt = "hello\n"

    fs.writeFileSync(path.join(repoDir, "file.txt"), "hello\nturn 1\n");
    await runtime.sendMessage("first"); // turn 1

    fs.writeFileSync(path.join(repoDir, "file.txt"), "hello\nturn 1\nturn 2\n");
    await runtime.sendMessage("second"); // turn 2

    const result = await runtime.revertToCheckpoint(1);

    // Two new checkpoints, not one: a safety snapshot of whatever was about
    // to be overwritten (turn 3, unmarked — see the dedicated test below
    // for why), then the actual restored state (turn 4, marked). Nothing
    // is ever truncated or silently discarded either way.
    expect(result).toEqual({ newTurn: 4 });
    expect(fs.readFileSync(path.join(repoDir, "file.txt"), "utf8")).toBe("hello\nturn 1\n");
    expect(eventStore.listCheckpoints("thread-1").map((c) => ({ turn: c.turn, revertedToTurn: c.revertedToTurn }))).toEqual([
      { turn: 0, revertedToTurn: null },
      { turn: 1, revertedToTurn: null },
      { turn: 2, revertedToTurn: null },
      { turn: 3, revertedToTurn: null },
      { turn: 4, revertedToTurn: 1 },
    ]);
  });

  it("revertToCheckpoint doesn't reset the turn counter — a normal send afterward continues at the next sequential turn", async () => {
    const runtime = runtimeWithSteps([{ type: "message", text: "ok" }], () => {});
    await runtime.start(); // turn 0
    await runtime.sendMessage("first"); // turn 1
    await runtime.revertToCheckpoint(0); // turn 2 (safety snapshot) + turn 3 (reverted-to-0)

    await runtime.sendMessage("second"); // should be turn 4, not colliding with anything

    expect(eventStore.listCheckpoints("thread-1").map((c) => c.turn)).toEqual([0, 1, 2, 3, 4]);
  });

  it("revertToCheckpoint never silently discards workspace state that was never captured by a normal turn boundary", async () => {
    // e.g. the user hand-edits a file outside the app, mid-conversation,
    // between two turns — that state was never protected by a completed
    // turn's own checkpoint, so restoreCheckpoint would otherwise wipe it
    // out with no way to recover it.
    const runtime = runtimeWithSteps([{ type: "message", text: "ok" }], () => {});
    await runtime.start(); // turn 0, file.txt = "hello\n"
    await runtime.sendMessage("first"); // turn 1, file.txt still "hello\n" (fake agent never touches files)

    fs.writeFileSync(path.join(repoDir, "file.txt"), "hello\nmanual edit outside the app\n");

    await runtime.revertToCheckpoint(0); // turn 2 (safety snapshot of the manual edit) + turn 3 (reverted-to-0)

    const safetySnapshotDiff = checkpointStore.diffCheckpoints("thread-1", 1, 2, repoDir);
    expect(safetySnapshotDiff).toContain("+manual edit outside the app");
  });

  it("revertToCheckpoint rejects while a turn is still in flight", async () => {
    // The standard fake agent resolves session/prompt synchronously/fast —
    // no real in-flight window to observe. This one holds the request
    // open until the test releases it, matching ws-server.test.ts's
    // existing "refuses to promote while a turn is still in flight"
    // precedent verbatim.
    let releasePrompt: (() => void) | undefined;
    const slowAgent = agent({ name: "slow-agent" })
      .onRequest(methods.agent.initialize, async () => ({ protocolVersion: 1, agentCapabilities: {} }))
      .onRequest(methods.agent.session.new, async () => ({ sessionId: "slow-session" }))
      .onRequest(
        methods.agent.session.prompt,
        () =>
          new Promise((resolve) => {
            releasePrompt = () => resolve({ stopReason: "end_turn" });
          }),
      );

    const session = new AcpSession({ name: "argusde-server-test", cwd: repoDir, createTransport: () => slowAgent });
    const runtime = new ThreadRuntime({ threadId: "thread-1", cwd: repoDir, session, eventStore, checkpointStore, onEvent: () => {} });
    await runtime.start();

    const sendPromise = runtime.sendMessage("hello");

    await expect(runtime.revertToCheckpoint(0)).rejects.toThrow(/in flight/);

    releasePrompt?.();
    await sendPromise;
  });

  it("respondToPermission forwards to the underlying session, unblocking the turn", async () => {
    const events: AcpSessionEvent[] = [];
    const runtime = runtimeWithSteps(
      [
        { type: "request-permission", toolCallId: "tc-1", options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }] },
        { type: "message", text: "done" },
      ],
      (e) => {
        events.push(e);
        if (e.kind === "permission-request") {
          runtime.respondToPermission(e.request.requestId, { optionId: "allow" });
        }
      },
    );
    await runtime.start();
    await runtime.sendMessage("do the risky thing");

    expect(events.some((e) => e.kind === "turn-complete")).toBe(true);
  });

  it("dispose() tears down the underlying session, leaving it disconnected", async () => {
    const events: AcpSessionEvent[] = [];
    const runtime = runtimeWithSteps([], (e) => events.push(e));
    await runtime.start();

    await runtime.dispose();

    expect(events).toContainEqual({ kind: "connection-state", state: "disconnected" });
  });
});
