import { describe, it, expect } from "vitest";
import { agent, methods } from "@agentclientprotocol/sdk";
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

  it("setMode emits its own mode-changed confirmation once the agent's request succeeds, even though the agent sends no notification for it", async () => {
    // Real Claude Code's ACP agent accepts session/set_mode and returns
    // success with no current_mode_update notification — that notification
    // is for the agent changing modes autonomously, not confirming a
    // client-requested change (confirmed against the real agent, not
    // assumed). The fake agent here mirrors that: its session.setMode
    // handler doesn't notify, so this test only passes if AcpSession itself
    // synthesizes the confirmation.
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

  it("only confirms the most recently requested mode when two setMode responses resolve out of order", async () => {
    // The underlying ACP connection has no guarantee that responses resolve
    // in the same order requests were sent — a slow first response arriving
    // after a fast second one must not let the switcher revert to the
    // stale, superseded mode.
    const resolvers: Array<() => void> = [];
    const reorderingAgent = agent({ name: "reordering-agent" })
      .onRequest(methods.agent.initialize, async () => ({ protocolVersion: 1, agentCapabilities: {} }))
      .onRequest(methods.agent.session.new, async () => ({ sessionId: "s1" }))
      .onRequest(
        methods.agent.session.setMode,
        () =>
          new Promise((resolve) => {
            resolvers.push(() => resolve({}));
          }),
      );

    const session = new AcpSession({ name: "argusde-test", cwd: "/tmp/argusde-test", createTransport: () => reorderingAgent });
    await session.start();

    const events: AcpSessionEvent[] = [];
    session.on("event", (e) => events.push(e));

    const first = session.setMode("plan");
    const second = session.setMode("bypassPermissions");

    await new Promise<void>((resolve) => {
      const check = () => (resolvers.length === 2 ? resolve() : setTimeout(check, 5));
      check();
    });

    // Resolve out of order: the second (most recent) request's response
    // arrives first, then the stale first request's response arrives after.
    resolvers[1]!();
    await second;
    resolvers[0]!();
    await first;

    const modeChangedEvents = events.filter((e) => e.kind === "mode-changed");
    expect(modeChangedEvents).toEqual([{ kind: "mode-changed", modeId: "bypassPermissions" }]);
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

  it("dispose() also tears down a transport that owns a subprocess", async () => {
    // Closing the ACP connection only closes the child's stdio — the real
    // claude-agent-acp keeps running through that, so every closed Thread
    // leaked an agent process until dispose() started reaching through to
    // the transport itself.
    const fakeAgent = createFakeAgent({ steps: [] });
    let disposed = 0;
    const session = new AcpSession({
      name: "argusde-test",
      cwd: "/tmp/argusde-test",
      createTransport: () => Object.assign(fakeAgent, { dispose: () => void disposed++ }),
    });

    await session.start();
    expect(disposed).toBe(0);

    await session.dispose();

    expect(disposed).toBe(1);
  });

  it("restartSession() disposes the outgoing transport before spawning its replacement", async () => {
    // Promotion-to-worktree restarts the session against a new cwd. Without
    // this, each promotion stranded the pre-promotion agent process.
    const disposals: number[] = [];
    let created = 0;
    const session = new AcpSession({
      name: "argusde-test",
      cwd: "/tmp/argusde-test",
      createTransport: () => {
        const id = created++;
        return Object.assign(createFakeAgent({ steps: [] }), { dispose: () => disposals.push(id) });
      },
    });

    await session.start();
    await session.restartSession();

    expect(disposals).toEqual([0]);
  });
});
