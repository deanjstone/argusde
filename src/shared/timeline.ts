import type { ChatContentBlock } from "./acp-events.js";

/**
 * Shared chat-timeline shape and merge logic between the old Electron
 * renderer (src/renderer/chat-reducer.ts, MVP, being superseded per spec
 * #33) and the new web UI's reducer (src/web/chat-state.ts) — both render
 * the same kind of message/tool-call timeline from streamed ACP events,
 * just wrapped in different top-level event shapes (flat AcpSessionEvent
 * vs. threadId-scoped session-event pushes). Extracted here after the two
 * reducers were found to be byte-for-byte duplicates of this part.
 */
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

/**
 * Each reducer keeps its own generator instance (module-scoped in that
 * reducer's file) — a counter shared across the Electron app and the web
 * app would be meaningless, since they're separate sessions with no
 * relationship to each other's ids.
 */
export function createMessageIdGenerator(prefix = "local"): () => string {
  let counter = 0;
  return () => `${prefix}-${++counter}`;
}

export function appendOrMergeMessage(
  timeline: TimelineItem[],
  role: MessageRole,
  messageId: string | undefined,
  content: ChatContentBlock,
  generateId: () => string,
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
    id: messageId ?? generateId(),
    role,
    content: [content],
  };
  return [...timeline, newMessage];
}

export function upsertToolCall(
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
