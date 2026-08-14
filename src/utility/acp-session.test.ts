import { describe, it, expect } from "vitest";
import { AcpSession } from "./acp-session.js";
import { createFakeAgent, type FakeAgentStep } from "./fake-agent.js";
import type { AcpSessionEvent } from "../shared/acp-events.js";

function sessionWithSteps(steps: FakeAgentStep[]) {
  const fakeAgent = createFakeAgent({ steps });
  return new AcpSession({
    name: "argusde-test",
    cwd: "/tmp/argusde-test",
    createTransport: () => fakeAgent,
  });
}

async function collectEvents(session: AcpSession, run: () => Promise<void>): Promise<AcpSessionEvent[]> {
  const events: AcpSessionEvent[] = [];
  session.on("event", (e) => events.push(e));
  await run();
  return events;
}

describe("AcpSession", () => {
  it("transitions through connecting -> connected on start()", async () => {
    const session = sessionWithSteps([]);
    const events = await collectEvents(session, () => session.start());

    expect(events).toContainEqual({ kind: "connection-state", state: "connecting" });
    expect(events).toContainEqual({ kind: "connection-state", state: "connected" });
    expect(session.connectionState).toBe("connected");
  });

  it("emits a message-chunk event for each streamed agent message", async () => {
    const session = sessionWithSteps([{ type: "message", text: "Hello from the agent" }]);
    await session.start();

    const events = await collectEvents(session, () => session.sendMessage("hi"));

    expect(events).toContainEqual({
      kind: "message-chunk",
      role: "agent",
      messageId: undefined,
      content: { type: "text", text: "Hello from the agent" },
    });
  });

  it("emits turn-complete once the prompt turn finishes", async () => {
    const session = sessionWithSteps([{ type: "message", text: "done" }]);
    await session.start();

    const events = await collectEvents(session, () => session.sendMessage("hi"));

    expect(events).toContainEqual({ kind: "turn-complete", stopReason: "end_turn" });
  });

  it("emits a tool-call event with normalized content, then a tool-call-update", async () => {
    const session = sessionWithSteps([
      { type: "tool-call", toolCallId: "tc-1", title: "Read file", status: "pending" },
      {
        type: "tool-call-update",
        toolCallId: "tc-1",
        status: "completed",
        content: [{ type: "content", content: { type: "text", text: "file contents" } }],
      },
    ]);
    await session.start();

    const events = await collectEvents(session, () => session.sendMessage("read a file"));

    expect(events).toContainEqual({
      kind: "tool-call",
      toolCall: { toolCallId: "tc-1", title: "Read file", kind: undefined, status: "pending", content: [] },
    });
    expect(events).toContainEqual({
      kind: "tool-call-update",
      toolCall: {
        toolCallId: "tc-1",
        title: undefined,
        kind: undefined,
        status: "completed",
        content: [{ type: "text", text: "file contents" }],
      },
    });
  });

  it("omits content on a tool-call-update event when the agent didn't send new content, instead of reporting it as cleared", async () => {
    const session = sessionWithSteps([
      {
        type: "tool-call",
        toolCallId: "tc-3",
        title: "Run tests",
        status: "in_progress",
      },
      { type: "tool-call-update", toolCallId: "tc-3", status: "completed" },
    ]);
    await session.start();

    const events = await collectEvents(session, () => session.sendMessage("run tests"));

    const update = events.find((e) => e.kind === "tool-call-update");
    expect(update).toEqual({
      kind: "tool-call-update",
      toolCall: { toolCallId: "tc-3", title: undefined, kind: undefined, status: "completed", content: undefined },
    });
  });

  it("emits a mode-changed event when the agent reports a current_mode_update, instead of dropping it", async () => {
    const session = sessionWithSteps([{ type: "mode-change", modeId: "plan" }]);
    await session.start();

    const events = await collectEvents(session, () => session.sendMessage("hi"));

    expect(events).toContainEqual({ kind: "mode-changed", modeId: "plan" });
  });

  it("setMode requests a mode change and the agent's confirmation round-trips as a mode-changed event", async () => {
    const session = sessionWithSteps([]);
    await session.start();

    const events = await collectEvents(session, () => session.setMode("plan"));

    expect(events).toContainEqual({ kind: "mode-changed", modeId: "plan" });
  });

  it("emits the mode catalog as a mode-changed event during start() when the agent advertises modes", async () => {
    const fakeAgent = createFakeAgent({
      steps: [],
      modes: {
        currentModeId: "default",
        availableModes: [
          { id: "default", name: "Default" },
          { id: "plan", name: "Plan", description: "Plan before editing" },
        ],
      },
    });
    const session = new AcpSession({ name: "argusde-test", cwd: "/tmp/argusde-test", createTransport: () => fakeAgent });

    const events = await collectEvents(session, () => session.start());

    expect(events).toContainEqual({
      kind: "mode-changed",
      modeId: "default",
      availableModes: [
        { id: "default", name: "Default", description: undefined },
        { id: "plan", name: "Plan", description: "Plan before editing" },
      ],
    });
  });

  it("does not emit a mode-changed event during start() when the agent doesn't advertise modes", async () => {
    const session = sessionWithSteps([]);
    const events = await collectEvents(session, () => session.start());
    expect(events.filter((e) => e.kind === "mode-changed")).toHaveLength(0);
  });

  it("emits a permission-request event and resolves the agent's request once respondToPermission is called", async () => {
    const session = sessionWithSteps([
      {
        type: "request-permission",
        toolCallId: "tc-2",
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      },
      { type: "message", text: "proceeding" },
    ]);
    await session.start();

    const events: AcpSessionEvent[] = [];
    session.on("event", (e) => {
      events.push(e);
      if (e.kind === "permission-request") {
        session.respondToPermission(e.request.requestId, { optionId: "allow" });
      }
    });

    await session.sendMessage("do something sensitive");

    const permissionEvent = events.find((e) => e.kind === "permission-request");
    expect(permissionEvent).toMatchObject({
      kind: "permission-request",
      request: {
        toolCall: { toolCallId: "tc-2" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      },
    });
    // the turn only completes because the agent's session/request_permission
    // call was actually resolved by respondToPermission
    expect(events).toContainEqual({ kind: "turn-complete", stopReason: "end_turn" });
  });

  it("moves to connection-state error and stops accepting sends when the agent crashes mid-turn", async () => {
    const session = sessionWithSteps([{ type: "crash", message: "boom" }]);
    await session.start();

    await expect(session.sendMessage("trigger a crash")).rejects.toThrow();
    expect(session.connectionState).not.toBe("connected");
  });

  it("restartSession() reconnects and clears crashed state", async () => {
    let crashed = false;
    const fakeAgentFactory = () =>
      createFakeAgent({
        steps: crashed ? [{ type: "message", text: "back up" }] : [{ type: "crash" }],
      });

    const session = new AcpSession({
      name: "argusde-test",
      cwd: "/tmp/argusde-test",
      createTransport: fakeAgentFactory,
    });

    await session.start();
    await expect(session.sendMessage("first")).rejects.toThrow();

    crashed = true;
    await session.restartSession();
    expect(session.connectionState).toBe("connected");

    const events = await collectEvents(session, () => session.sendMessage("second"));
    expect(events).toContainEqual({
      kind: "message-chunk",
      role: "agent",
      messageId: undefined,
      content: { type: "text", text: "back up" },
    });
  });

  it("dispose() closes the underlying connection", async () => {
    const session = sessionWithSteps([]);
    await session.start();
    const stateChanges: AcpSessionEvent[] = [];
    session.on("event", (e) => {
      if (e.kind === "connection-state") stateChanges.push(e);
    });

    await session.dispose();

    expect(stateChanges).toContainEqual({ kind: "connection-state", state: "disconnected" });
  });
});
