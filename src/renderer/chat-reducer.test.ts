import { describe, it, expect } from "vitest";
import { chatReducer, initialChatState, type ChatEvent } from "./chat-reducer.js";

function reduceAll(events: ChatEvent[]) {
  return events.reduce(chatReducer, initialChatState);
}

describe("chatReducer", () => {
  it("starts idle, disconnected, with an empty timeline", () => {
    expect(initialChatState).toEqual({
      connectionState: "disconnected",
      connectionError: undefined,
      timeline: [],
      pendingPermissionRequest: undefined,
      agentStatus: "idle",
    });
  });

  it("tracks connection-state transitions and surfaces the error message on error", () => {
    const state = reduceAll([
      { kind: "connection-state", state: "connecting" },
      { kind: "connection-state", state: "connected" },
      { kind: "connection-state", state: "error", error: "stream closed" },
    ]);

    expect(state.connectionState).toBe("error");
    expect(state.connectionError).toBe("stream closed");
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
      { kind: "user-message-sent", text: "hi" },
      {
        kind: "message-chunk",
        role: "agent",
        messageId: "m1",
        content: { type: "text", text: "Hel" },
      },
      {
        kind: "message-chunk",
        role: "agent",
        messageId: "m1",
        content: { type: "text", text: "lo!" },
      },
    ]);

    const agentMessage = state.timeline.find((item) => item.type === "message" && item.role === "agent");
    expect(agentMessage).toEqual({
      type: "message",
      id: "m1",
      role: "agent",
      content: [{ type: "text", text: "Hello!" }],
    });
  });

  it("starts a new agent message when the messageId changes", () => {
    const state = reduceAll([
      { kind: "message-chunk", role: "agent", messageId: "m1", content: { type: "text", text: "first" } },
      { kind: "message-chunk", role: "agent", messageId: "m2", content: { type: "text", text: "second" } },
    ]);

    const agentMessages = state.timeline.filter((item) => item.type === "message" && item.role === "agent");
    expect(agentMessages).toHaveLength(2);
  });

  it("keeps agent-thought chunks as their own timeline entries, distinct from agent messages", () => {
    const state = reduceAll([
      { kind: "message-chunk", role: "agent-thought", content: { type: "text", text: "thinking..." } },
      { kind: "message-chunk", role: "agent", content: { type: "text", text: "Here's the answer" } },
    ]);

    expect(state.timeline).toHaveLength(2);
    expect(state.timeline[0]).toMatchObject({ role: "agent-thought" });
    expect(state.timeline[1]).toMatchObject({ role: "agent" });
  });

  it("appends a tool-call as a new timeline entry", () => {
    const state = reduceAll([
      {
        kind: "tool-call",
        toolCall: { toolCallId: "tc-1", title: "Read file", status: "pending", content: [] },
      },
    ]);

    expect(state.timeline).toEqual([
      { type: "tool-call", id: "tc-1", title: "Read file", kind: undefined, status: "pending", content: [] },
    ]);
  });

  it("merges a tool-call-update into the matching timeline entry, preserving content when the update omits it", () => {
    const state = reduceAll([
      {
        kind: "tool-call",
        toolCall: { toolCallId: "tc-1", title: "Read file", status: "pending", content: [{ type: "text", text: "partial" }] },
      },
      {
        kind: "tool-call-update",
        toolCall: { toolCallId: "tc-1", status: "completed" },
      },
    ]);

    expect(state.timeline).toEqual([
      {
        type: "tool-call",
        id: "tc-1",
        title: "Read file",
        kind: undefined,
        status: "completed",
        content: [{ type: "text", text: "partial" }],
      },
    ]);
  });

  it("replaces tool-call content when a tool-call-update explicitly includes new content", () => {
    const state = reduceAll([
      { kind: "tool-call", toolCall: { toolCallId: "tc-1", title: "Read file", content: [] } },
      {
        kind: "tool-call-update",
        toolCall: { toolCallId: "tc-1", content: [{ type: "text", text: "final content" }] },
      },
    ]);

    const toolCall = state.timeline.find((item) => item.type === "tool-call");
    expect(toolCall).toMatchObject({ content: [{ type: "text", text: "final content" }] });
  });

  it("sets a pending permission request and clears it once a response event is applied", () => {
    const withRequest = chatReducer(initialChatState, {
      kind: "permission-request",
      request: {
        requestId: "perm-1",
        toolCall: { toolCallId: "tc-1", content: [] },
        options: [{ optionId: "allow", name: "Allow", kind: "allow_once" }],
      },
    });
    expect(withRequest.pendingPermissionRequest?.requestId).toBe("perm-1");

    const cleared = chatReducer(withRequest, { kind: "permission-responded", requestId: "perm-1" });
    expect(cleared.pendingPermissionRequest).toBeUndefined();
  });

  it("sets agentStatus back to idle on turn-complete", () => {
    const state = reduceAll([
      { kind: "user-message-sent", text: "hi" },
      { kind: "turn-complete", stopReason: "end_turn" },
    ]);

    expect(state.agentStatus).toBe("idle");
  });

  it("resets agentStatus to idle when the connection drops mid-turn", () => {
    const state = reduceAll([
      { kind: "user-message-sent", text: "hi" },
      { kind: "connection-state", state: "disconnected" },
    ]);

    expect(state.agentStatus).toBe("idle");
  });
});
