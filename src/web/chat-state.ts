import type { AcpSessionEvent, ConnectionState, SessionModeSummary } from "../shared/acp-events.js";
import { appendOrMergeMessage, createMessageIdGenerator, upsertToolCall, type TimelineItem } from "../shared/timeline.js";

export type { MessageRole, TimelineMessage, TimelineToolCall, TimelineItem } from "../shared/timeline.js";

export interface PendingPermissionRequest {
  requestId: string;
  toolCallId: string;
  toolCallTitle?: string;
  options: Array<{ optionId: string; name: string; kind: string }>;
}

export interface ChatState {
  connectionState: ConnectionState;
  connectionError: string | undefined;
  timeline: TimelineItem[];
  pendingPermissionRequest: PendingPermissionRequest | undefined;
  agentStatus: "idle" | "working";
  /** From the server's welcome push — shown on the Settings tab. */
  apiVersion: string | undefined;
  currentModeId: string | undefined;
  /** The mode catalog, learned once from the session-start mode-changed event — empty when the connected agent doesn't advertise modes at all. */
  availableModes: SessionModeSummary[];
}

export const initialChatState: ChatState = {
  connectionState: "disconnected",
  connectionError: undefined,
  timeline: [],
  pendingPermissionRequest: undefined,
  agentStatus: "idle",
  apiVersion: undefined,
  currentModeId: undefined,
  availableModes: [],
};

/**
 * Driven by the WS protocol's pushes (unwrapped from ServerPush — see
 * App.tsx for the WsClient.onPush -> ChatEvent translation), not directly
 * by ServerPush itself, plus two local UI-originated actions. This is a
 * fresh reducer for the new shape (threadId-scoped session events, a
 * server.welcome case, a protocol-error case) — not the old
 * src/renderer/chat-reducer.ts adapted in place; the two apps' protocols
 * don't match. The timeline merge logic itself (appendOrMergeMessage/
 * upsertToolCall) is shared — see src/shared/timeline.ts.
 */
export type ChatEvent =
  | { kind: "welcome"; apiVersion: string }
  | { kind: "session-event"; threadId: string; event: AcpSessionEvent }
  | { kind: "protocol-error"; message: string }
  | { kind: "user-message-sent"; text: string }
  | { kind: "permission-responded"; requestId: string };

const generateMessageId = createMessageIdGenerator();

function applySessionEvent(state: ChatState, event: AcpSessionEvent): ChatState {
  switch (event.kind) {
    case "connection-state":
      return {
        ...state,
        connectionState: event.state,
        connectionError: event.error,
        // A fresh "connecting" transition means a session is starting from
        // scratch (initial connect or a future restart) — clear any mode
        // catalog learned from a prior session so a restarted agent that
        // doesn't advertise modes can't leave a stale one displayed.
        ...(event.state === "connecting" ? { currentModeId: undefined, availableModes: [] } : {}),
      };
    case "message-chunk":
      if (event.role === "agent-thought") return state;
      return {
        ...state,
        timeline: appendOrMergeMessage(state.timeline, event.role, event.messageId, event.content, generateMessageId),
      };
    case "tool-call":
      return { ...state, timeline: upsertToolCall(state.timeline, event.toolCall, true) };
    case "tool-call-update":
      return { ...state, timeline: upsertToolCall(state.timeline, event.toolCall, false) };
    case "permission-request":
      return {
        ...state,
        pendingPermissionRequest: {
          requestId: event.request.requestId,
          toolCallId: event.request.toolCall.toolCallId,
          toolCallTitle: event.request.toolCall.title,
          options: event.request.options,
        },
      };
    case "turn-complete":
      return { ...state, agentStatus: "idle" };
    case "mode-changed":
      return {
        ...state,
        currentModeId: event.modeId,
        // Only the session-start event carries the catalog — a mid-session
        // current_mode_update has no availableModes, and mustn't clobber
        // the one already learned.
        availableModes: event.availableModes ?? state.availableModes,
      };
    case "plan":
      return state;
  }
}

export function chatStateReducer(state: ChatState, event: ChatEvent): ChatState {
  switch (event.kind) {
    case "welcome":
      return { ...state, apiVersion: event.apiVersion };
    case "session-event":
      return applySessionEvent(state, event.event);
    case "protocol-error":
      return { ...state, connectionError: event.message };
    case "user-message-sent":
      return {
        ...state,
        // A fresh id (not undefined) on every call — undefined means "merge
        // into the last message of this role" (matching a streaming agent
        // reply with no id), which is wrong here: two separately-sent user
        // messages must never collapse into one timeline entry.
        timeline: appendOrMergeMessage(
          state.timeline,
          "user",
          generateMessageId(),
          { type: "text", text: event.text },
          generateMessageId,
        ),
        agentStatus: "working",
      };
    case "permission-responded":
      return state.pendingPermissionRequest?.requestId === event.requestId
        ? { ...state, pendingPermissionRequest: undefined }
        : state;
  }
}
