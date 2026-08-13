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
  /** From the server's welcome push — shown on the Settings tab. */
  apiVersion: string | undefined;
}

export const initialChatState: ChatState = {
  connectionState: "disconnected",
  connectionError: undefined,
  timeline: [],
  pendingPermissionRequest: undefined,
  agentStatus: "idle",
  apiVersion: undefined,
};

/**
 * Driven by the WS protocol's pushes (unwrapped from ServerPush — see
 * App.tsx for the WsClient.onPush -> ChatEvent translation), not directly
 * by ServerPush itself, plus two local UI-originated actions. This is a
 * fresh reducer for the new shape (threadId-scoped session events, a
 * server.welcome case, a protocol-error case) — not the old
 * src/renderer/chat-reducer.ts adapted in place; the two apps' protocols
 * don't match.
 */
export type ChatEvent =
  | { kind: "welcome"; apiVersion: string }
  | { kind: "session-event"; threadId: string; event: AcpSessionEvent }
  | { kind: "protocol-error"; message: string }
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

function applySessionEvent(state: ChatState, event: AcpSessionEvent): ChatState {
  switch (event.kind) {
    case "connection-state":
      return { ...state, connectionState: event.state, connectionError: event.error };
    case "message-chunk":
      if (event.role === "agent-thought") return state;
      return { ...state, timeline: appendOrMergeMessage(state.timeline, event.role, event.messageId, event.content) };
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
    case "plan":
    case "mode-changed":
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
    case "user-message-sent": {
      // A fresh id (not undefined) on every call — undefined means "merge
      // into the last message of this role" (matching a streaming agent
      // reply with no id), which is wrong here: two separately-sent user
      // messages must never collapse into one timeline entry.
      const newMessage: TimelineMessage = {
        type: "message",
        id: generateMessageId(),
        role: "user",
        content: [{ type: "text", text: event.text }],
      };
      return { ...state, timeline: [...state.timeline, newMessage], agentStatus: "working" };
    }
    case "permission-responded":
      return state.pendingPermissionRequest?.requestId === event.requestId
        ? { ...state, pendingPermissionRequest: undefined }
        : state;
  }
}
