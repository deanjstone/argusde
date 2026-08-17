import type { AcpSessionEvent, ConnectionState, SessionModeSummary } from "../shared/acp-events.js";
import type { ActivityRecord, ThreadHistoryMessage } from "../shared/ws-protocol.js";
import {
  appendOrMergeMessage,
  createMessageIdGenerator,
  mergeHistoryTimeline,
  upsertToolCall,
  type TimelineItem,
} from "../shared/timeline.js";

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
  /**
   * False only for a Thread created before durable activity existed (spec
   * #93 phase 1). Defaults to true: a Thread with no history loaded yet is
   * recording, and an empty timeline must not be explained away as a
   * limitation unless the server actually said so.
   */
  recordsActivity: boolean;
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
  recordsActivity: true,
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
  /**
   * Takes a previously-surfaced action failure back down as a new
   * user-initiated action starts. The error banner is always visible once
   * set, so without this a one-off failure would sit there for the rest of
   * the session.
   *
   * Dispatched per handler rather than from a shared sendCommand wrapper on
   * purpose: background refreshes (checkpoints, project/thread lists,
   * history) also send commands, and letting those clear the banner would
   * hide a real failure the moment any poll happened to run. "The user
   * tried something" is the signal, not "a command went out" — so every new
   * user-initiated handler has to opt in.
   */
  | { kind: "action-attempted" }
  | { kind: "user-message-sent"; text: string }
  | { kind: "permission-responded"; requestId: string }
  | {
      kind: "history-loaded";
      messages: ThreadHistoryMessage[];
      activities: ActivityRecord[];
      recordsActivity: boolean;
      currentModeId: string | null;
      availableModes: SessionModeSummary[];
      connectionState: ConnectionState;
      connectionError: string | undefined;
    };

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
    case "action-attempted":
      return state.connectionError === undefined ? state : { ...state, connectionError: undefined };
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
    case "history-loaded":
      // A full "this is a different conversation now" reset — deliberately
      // not appendOrMergeMessage's single-append semantics, which would
      // merge this thread's history into whatever was already displayed.
      return {
        ...state,
        timeline: mergeHistoryTimeline(event.messages, event.activities),
        recordsActivity: event.recordsActivity,
        currentModeId: event.currentModeId ?? undefined,
        availableModes: event.availableModes,
        connectionState: event.connectionState,
        connectionError: event.connectionError,
        pendingPermissionRequest: undefined,
        agentStatus: "idle",
      };
  }
}
