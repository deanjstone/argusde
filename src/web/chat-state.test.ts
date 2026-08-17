import { describe, it, expect } from "vitest";
import { chatStateReducer, initialChatState, type ChatEvent } from "./chat-state.js";

function reduceAll(events: ChatEvent[]) {
  return events.reduce(chatStateReducer, initialChatState);
}

describe("chatStateReducer", () => {
  it("starts idle, disconnected, with an empty timeline and no apiVersion", () => {
    expect(initialChatState).toEqual({
      connectionState: "disconnected",
      connectionError: undefined,
      timeline: [],
      pendingPermissionRequest: undefined,
      agentStatus: "idle",
      apiVersion: undefined,
      currentModeId: undefined,
      availableModes: [],
      recordsActivity: true,
    });
  });

  it("records the server's apiVersion on welcome", () => {
    const state = reduceAll([{ kind: "welcome", apiVersion: "1.0.0" }]);
    expect(state.apiVersion).toBe("1.0.0");
  });

  it("tracks connection-state transitions and surfaces the error on error, from a session-event push", () => {
    const state = reduceAll([
      { kind: "session-event", threadId: "t1", event: { kind: "connection-state", state: "connecting" } },
      { kind: "session-event", threadId: "t1", event: { kind: "connection-state", state: "connected" } },
      { kind: "session-event", threadId: "t1", event: { kind: "connection-state", state: "error", error: "stream closed" } },
    ]);

    expect(state.connectionState).toBe("error");
    expect(state.connectionError).toBe("stream closed");
  });

  it("surfaces a protocol-error push as a connection error", () => {
    const state = reduceAll([{ kind: "protocol-error", message: "invalid command" }]);
    expect(state.connectionError).toBe("invalid command");
  });

  it("clears a previous error when a new attempt starts, so a one-off failure doesn't stick forever", () => {
    // The error banner is now always visible when set, so nothing else would
    // ever take a stale message down.
    const state = reduceAll([{ kind: "protocol-error", message: "promote failed" }, { kind: "action-attempted" }]);
    expect(state.connectionError).toBeUndefined();
  });

  it("clearing an error leaves a pending permission request alone", () => {
    // handleRespondPermission clears the banner too, and must not take the
    // prompt down with it — the prompt has its own permission-responded path.
    const withRequest = reduceAll([
      {
        kind: "session-event",
        threadId: "t1",
        event: {
          kind: "permission-request",
          request: {
            requestId: "perm-1",
            toolCall: { toolCallId: "tc-1", content: [] },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          },
        },
      },
      { kind: "protocol-error", message: "earlier failure" },
      { kind: "action-attempted" },
    ]);
    expect(withRequest.connectionError).toBeUndefined();
    expect(withRequest.pendingPermissionRequest?.requestId).toBe("perm-1");
  });

  it("clearing an error leaves the rest of the conversation untouched", () => {
    const state = reduceAll([
      { kind: "user-message-sent", text: "hello" },
      { kind: "protocol-error", message: "promote failed" },
      { kind: "action-attempted" },
    ]);
    expect(state.connectionError).toBeUndefined();
    expect(state.timeline).toHaveLength(1);
  });

  it("adds a user message to the timeline and marks the agent as working when the user sends a message", () => {
    const state = reduceAll([{ kind: "user-message-sent", text: "hello" }]);

    expect(state.timeline).toEqual([
      { type: "message", id: expect.any(String), role: "user", content: [{ type: "text", text: "hello" }] },
    ]);
    expect(state.agentStatus).toBe("working");
  });

  it("appends a new agent message on the first message-chunk and concatenates subsequent text chunks with the same messageId", () => {
    const state = reduceAll([
      {
        kind: "session-event",
        threadId: "t1",
        event: { kind: "message-chunk", role: "agent", messageId: "m1", content: { type: "text", text: "The bug is " } },
      },
      {
        kind: "session-event",
        threadId: "t1",
        event: { kind: "message-chunk", role: "agent", messageId: "m1", content: { type: "text", text: "fixed." } },
      },
    ]);

    expect(state.timeline).toEqual([
      { type: "message", id: "m1", role: "agent", content: [{ type: "text", text: "The bug is fixed." }] },
    ]);
  });

  it("adds a tool-call and applies a later tool-call-update in place", () => {
    const state = reduceAll([
      {
        kind: "session-event",
        threadId: "t1",
        event: {
          kind: "tool-call",
          toolCall: { toolCallId: "tc-1", title: "Read file", status: "pending", content: [] },
        },
      },
      {
        kind: "session-event",
        threadId: "t1",
        event: {
          kind: "tool-call-update",
          toolCall: { toolCallId: "tc-1", status: "completed", content: [{ type: "text", text: "file contents" }] },
        },
      },
    ]);

    expect(state.timeline).toEqual([
      {
        type: "tool-call",
        id: "tc-1",
        title: "Read file",
        kind: undefined,
        status: "completed",
        content: [{ type: "text", text: "file contents" }],
      },
    ]);
  });

  it("sets pendingPermissionRequest on a permission-request event and clears it on permission-responded", () => {
    const withRequest = reduceAll([
      {
        kind: "session-event",
        threadId: "t1",
        event: {
          kind: "permission-request",
          request: {
            requestId: "perm-1",
            toolCall: { toolCallId: "tc-1", content: [] },
            options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
          },
        },
      },
    ]);
    expect(withRequest.pendingPermissionRequest).toEqual({
      requestId: "perm-1",
      toolCallId: "tc-1",
      toolCallTitle: undefined,
      options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
    });

    const afterResponse = chatStateReducer(withRequest, { kind: "permission-responded", requestId: "perm-1" });
    expect(afterResponse.pendingPermissionRequest).toBeUndefined();
  });

  it("keeps two separately-sent user messages as two distinct timeline entries, not merged", () => {
    const state = reduceAll([
      { kind: "user-message-sent", text: "first question" },
      { kind: "session-event", threadId: "t1", event: { kind: "turn-complete", stopReason: "end_turn" } },
      { kind: "user-message-sent", text: "second question" },
    ]);

    const userMessages = state.timeline.filter((item) => item.type === "message" && item.role === "user");
    expect(userMessages).toHaveLength(2);
    expect(userMessages.map((m) => (m.type === "message" ? m.content : null))).toEqual([
      [{ type: "text", text: "first question" }],
      [{ type: "text", text: "second question" }],
    ]);
  });

  it("records the mode catalog and current mode from an initial mode-changed event (with availableModes)", () => {
    const state = reduceAll([
      {
        kind: "session-event",
        threadId: "t1",
        event: {
          kind: "mode-changed",
          modeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "plan", name: "Plan", description: "Plan before editing" },
          ],
        },
      },
    ]);

    expect(state.currentModeId).toBe("default");
    expect(state.availableModes).toEqual([
      { id: "default", name: "Default" },
      { id: "plan", name: "Plan", description: "Plan before editing" },
    ]);
  });

  it("updates only currentModeId on a later mode-changed event with no availableModes, leaving the catalog untouched", () => {
    const state = reduceAll([
      {
        kind: "session-event",
        threadId: "t1",
        event: {
          kind: "mode-changed",
          modeId: "default",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "plan", name: "Plan" },
          ],
        },
      },
      { kind: "session-event", threadId: "t1", event: { kind: "mode-changed", modeId: "plan" } },
    ]);

    expect(state.currentModeId).toBe("plan");
    expect(state.availableModes).toEqual([
      { id: "default", name: "Default" },
      { id: "plan", name: "Plan" },
    ]);
  });

  it("history-loaded replaces the whole timeline and resets mode/permission/agent-status state — switching to a different thread, not appending to the current one", () => {
    const state = reduceAll([
      { kind: "user-message-sent", text: "old thread message" },
      {
        kind: "history-loaded",
        messages: [
          { messageId: "m1", role: "user", content: [{ type: "text", text: "what's broken?" }], sequence: 1 },
          { messageId: "m2", role: "agent", content: [{ type: "text", text: "the retry handler." }], sequence: 2 },
        ],
        activities: [],
        recordsActivity: true,
        currentModeId: "plan",
        availableModes: [{ id: "plan", name: "Plan" }],
        connectionState: "connected",
        connectionError: undefined,
      },
    ]);

    expect(state.timeline).toEqual([
      { type: "message", id: "m1", role: "user", content: [{ type: "text", text: "what's broken?" }] },
      { type: "message", id: "m2", role: "agent", content: [{ type: "text", text: "the retry handler." }] },
    ]);
    expect(state.currentModeId).toBe("plan");
    expect(state.availableModes).toEqual([{ id: "plan", name: "Plan" }]);
    expect(state.agentStatus).toBe("idle");
    expect(state.pendingPermissionRequest).toBeUndefined();
  });

  it("history-loaded carries the connection state a client would otherwise have missed racing the new Thread's own start()-time broadcast", () => {
    const state = reduceAll([
      { kind: "history-loaded", messages: [], activities: [], recordsActivity: true, currentModeId: null, availableModes: [], connectionState: "connected", connectionError: undefined },
    ]);

    expect(state.connectionState).toBe("connected");
    expect(state.connectionError).toBeUndefined();
  });

  it("history-loaded with a null currentModeId (agent doesn't support modes) clears any prior mode state", () => {
    const state = reduceAll([
      {
        kind: "session-event",
        threadId: "t1",
        event: { kind: "mode-changed", modeId: "default", availableModes: [{ id: "default", name: "Default" }] },
      },
      { kind: "history-loaded", messages: [], activities: [], recordsActivity: true, currentModeId: null, availableModes: [], connectionState: "connected", connectionError: undefined },
    ]);

    expect(state.currentModeId).toBeUndefined();
    expect(state.availableModes).toEqual([]);
    expect(state.timeline).toEqual([]);
  });

  it("clears the mode catalog on a fresh connecting transition, so a restarted session never shows a stale mode from before", () => {
    const state = reduceAll([
      {
        kind: "session-event",
        threadId: "t1",
        event: {
          kind: "mode-changed",
          modeId: "plan",
          availableModes: [
            { id: "default", name: "Default" },
            { id: "plan", name: "Plan" },
          ],
        },
      },
      { kind: "session-event", threadId: "t1", event: { kind: "connection-state", state: "connecting" } },
    ]);

    expect(state.currentModeId).toBeUndefined();
    expect(state.availableModes).toEqual([]);
  });

  it("returns the agent to idle on turn-complete", () => {
    const state = reduceAll([
      { kind: "user-message-sent", text: "hi" },
      { kind: "session-event", threadId: "t1", event: { kind: "turn-complete", stopReason: "end_turn" } },
    ]);
    expect(state.agentStatus).toBe("idle");
  });
  describe("history-loaded with recorded activity", () => {
    const activity = (over = {}) => ({
      threadId: "t1",
      activityId: "tc-1",
      sequence: 3,
      turn: 1,
      kind: "read",
      status: "completed" as const,
      summary: "Read src/index.ts",
      detail: "file contents",
      data: [{ type: "text" as const, text: "file contents" }],
      dataTruncated: false,
      createdAt: "",
      ...over,
    });

    it("merges activities and messages into one timeline ordered by sequence", () => {
      const state = reduceAll([
        {
          kind: "history-loaded",
          messages: [
            { messageId: "m1", role: "user", content: [{ type: "text", text: "what's broken?" }], sequence: 1 },
            { messageId: "m2", role: "agent", content: [{ type: "text", text: "let me look" }], sequence: 2 },
            { messageId: "m3", role: "agent", content: [{ type: "text", text: "found it" }], sequence: 4 },
          ],
          activities: [activity({ activityId: "tc-1", sequence: 3 }), activity({ activityId: "tc-2", sequence: 5, summary: "Edit src/index.ts" })],
          recordsActivity: true,
          currentModeId: null,
          availableModes: [],
          connectionState: "connected",
          connectionError: undefined,
        },
      ]);

      // One narrative, not two lists — and specifically the order the agent
      // worked in, with its second reply after the first tool call.
      expect(state.timeline.map((item) => item.id)).toEqual(["m1", "m2", "tc-1", "m3", "tc-2"]);
    });

    it("replays an activity as a tool call carrying its title, status and result", () => {
      const state = reduceAll([
        {
          kind: "history-loaded",
          messages: [],
          activities: [activity()],
          recordsActivity: true,
          currentModeId: null,
          availableModes: [],
          connectionState: "connected",
          connectionError: undefined,
        },
      ]);

      // The same shape a live tool call takes, deliberately — one card
      // renders both paths, so a replayed timeline can't drift from the
      // live one it is meant to reproduce.
      expect(state.timeline).toEqual([
        {
          type: "tool-call",
          id: "tc-1",
          title: "Read src/index.ts",
          kind: "read",
          status: "completed",
          content: [{ type: "text", text: "file contents" }],
          dataTruncated: false,
        },
      ]);
    });

    it("carries the capture-time truncation flag through to the timeline", () => {
      const state = reduceAll([
        {
          kind: "history-loaded",
          messages: [],
          activities: [activity({ dataTruncated: true })],
          recordsActivity: true,
          currentModeId: null,
          availableModes: [],
          connectionState: "connected",
          connectionError: undefined,
        },
      ]);

      expect(state.timeline[0]).toMatchObject({ type: "tool-call", dataTruncated: true });
    });

    it("keeps messages recorded before sequencing existed in their original relative order, ahead of anything sequenced", () => {
      const state = reduceAll([
        {
          kind: "history-loaded",
          messages: [
            { messageId: "old-1", role: "user", content: [{ type: "text", text: "first" }], sequence: null },
            { messageId: "old-2", role: "agent", content: [{ type: "text", text: "second" }], sequence: null },
            { messageId: "new-1", role: "user", content: [{ type: "text", text: "third" }], sequence: 1 },
          ],
          activities: [activity({ sequence: 2 })],
          recordsActivity: true,
          currentModeId: null,
          availableModes: [],
          connectionState: "connected",
          connectionError: undefined,
        },
      ]);

      // Unsequenced messages have no position relative to activities, so
      // they keep their own order and lead — rather than being given an
      // invented one.
      expect(state.timeline.map((item) => item.id)).toEqual(["old-1", "old-2", "new-1", "tc-1"]);
    });

    it("records whether the Thread was recording activity at all", () => {
      const notRecording = reduceAll([
        {
          kind: "history-loaded",
          messages: [],
          activities: [],
          recordsActivity: false,
          currentModeId: null,
          availableModes: [],
          connectionState: "connected",
          connectionError: undefined,
        },
      ]);

      // An empty timeline means two different things depending on this
      // flag, which is the whole reason it exists.
      expect(notRecording.recordsActivity).toBe(false);
      expect(initialChatState.recordsActivity).toBe(true);
    });
  });
});
