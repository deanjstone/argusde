import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
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
      { threadId: "thread-1", turn: 0, ref: "refs/argusde/checkpoints/thread-1/turn/0", createdAt: expect.any(String) },
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
