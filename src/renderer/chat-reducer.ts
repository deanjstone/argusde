import type { AcpSessionEvent, ConnectionState } from "../shared/acp-events.js";
import {
  appendOrMergeMessage,
  createMessageIdGenerator,
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
}

export const initialChatState: ChatState = {
  connectionState: "disconnected",
  connectionError: undefined,
  timeline: [],
  pendingPermissionRequest: undefined,
  agentStatus: "idle",
};

/**
 * Local UI-originated actions that aren't part of the ACP wire protocol, but
 * still need to drive the same timeline: sending a message, and clearing a
 * permission request once the user has responded to it (the actual response
 * goes to the main process over IPC; this just updates local UI state).
 */
export type ChatEvent =
  | AcpSessionEvent
  | { kind: "user-message-sent"; text: string }
  | { kind: "permission-responded"; requestId: string };

const generateMessageId = createMessageIdGenerator();

export function chatReducer(state: ChatState, event: ChatEvent): ChatState {
  switch (event.kind) {
    case "connection-state": {
      const next: ChatState = {
        ...state,
        connectionState: event.state,
        connectionError: event.error,
      };
      if (event.state !== "connected") {
        next.agentStatus = "idle";
      }
      return next;
    }

    case "user-message-sent":
      return {
        ...state,
        timeline: appendOrMergeMessage(
          state.timeline,
          "user",
          generateMessageId(),
          { type: "text", text: event.text },
          generateMessageId,
        ),
        agentStatus: "working",
      };

    case "message-chunk":
      return {
        ...state,
        timeline: appendOrMergeMessage(state.timeline, event.role, event.messageId, event.content, generateMessageId),
      };

    case "tool-call":
      return {
        ...state,
        timeline: upsertToolCall(state.timeline, event.toolCall, true),
      };

    case "tool-call-update":
      return {
        ...state,
        timeline: upsertToolCall(state.timeline, event.toolCall, false),
      };

    case "plan":
      // The MVP chat surface doesn't render the plan panel yet; the event
      // is accepted (not dropped as unknown) so future work can add it
      // without touching AcpSession or this reducer's event contract.
      return state;

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

    case "permission-responded":
      if (state.pendingPermissionRequest?.requestId !== event.requestId) return state;
      return { ...state, pendingPermissionRequest: undefined };

    case "turn-complete":
      return { ...state, agentStatus: "idle" };

    default:
      return state;
  }
}
