import type { AcpSessionEvent, ChatContentBlock, ConnectionState } from "../shared/acp-events.js";

export type MessageRole = "user" | "agent" | "agent-thought";

export interface TimelineMessage {
  type: "message";
  id: string;
  role: MessageRole;
  content: ChatContentBlock[];
}

export interface TimelineToolCall {
  type: "tool-call";
  id: string;
  title?: string;
  kind?: string;
  status?: "pending" | "in_progress" | "completed" | "failed";
  content: ChatContentBlock[];
}

export type TimelineItem = TimelineMessage | TimelineToolCall;

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

let messageIdCounter = 0;
function generateMessageId(): string {
  messageIdCounter += 1;
  return `local-${messageIdCounter}`;
}

function appendOrMergeMessage(
  timeline: TimelineItem[],
  role: MessageRole,
  messageId: string | undefined,
  content: ChatContentBlock,
): TimelineItem[] {
  const last = timeline[timeline.length - 1];
  const continuesLast =
    last?.type === "message" && last.role === role && (messageId === undefined || last.id === messageId);

  if (continuesLast && last?.type === "message") {
    const lastContent = last.content[last.content.length - 1];
    const mergedLastBlock =
      lastContent?.type === "text" && content.type === "text"
        ? [...last.content.slice(0, -1), { type: "text" as const, text: lastContent.text + content.text }]
        : [...last.content, content];

    const merged: TimelineMessage = { ...last, content: mergedLastBlock };
    return [...timeline.slice(0, -1), merged];
  }

  const newMessage: TimelineMessage = {
    type: "message",
    id: messageId ?? generateMessageId(),
    role,
    content: [content],
  };
  return [...timeline, newMessage];
}

function upsertToolCall(
  timeline: TimelineItem[],
  update: { toolCallId: string; title?: string; kind?: string; status?: TimelineToolCall["status"]; content?: ChatContentBlock[] },
  isNew: boolean,
): TimelineItem[] {
  const index = timeline.findIndex((item) => item.type === "tool-call" && item.id === update.toolCallId);

  if (index === -1) {
    const created: TimelineToolCall = {
      type: "tool-call",
      id: update.toolCallId,
      title: update.title,
      kind: update.kind,
      status: update.status,
      content: update.content ?? [],
    };
    return [...timeline, created];
  }

  const existing = timeline[index] as TimelineToolCall;
  const merged: TimelineToolCall = {
    ...existing,
    title: isNew ? update.title : (update.title ?? existing.title),
    kind: isNew ? update.kind : (update.kind ?? existing.kind),
    status: isNew ? update.status : (update.status ?? existing.status),
    content: update.content ?? existing.content,
  };
  return [...timeline.slice(0, index), merged, ...timeline.slice(index + 1)];
}

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
        timeline: appendOrMergeMessage(state.timeline, "user", generateMessageId(), {
          type: "text",
          text: event.text,
        }),
        agentStatus: "working",
      };

    case "message-chunk":
      return {
        ...state,
        timeline: appendOrMergeMessage(state.timeline, event.role, event.messageId, event.content),
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
