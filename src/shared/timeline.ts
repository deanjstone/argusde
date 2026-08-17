import type { ChatContentBlock } from "./acp-events.js";
import type { ActivityRecord, ThreadHistoryMessage } from "./ws-protocol.js";

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
  /**
   * Only ever set on a replayed activity: the stored result was cut to fit
   * the per-activity byte cap at *capture* time (spec #93 phase 1), so
   * expanding the card shows everything that was kept rather than
   * everything the tool produced. A live tool call always has its full
   * content and leaves this undefined.
   */
  dataTruncated?: boolean;
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

/**
 * Rebuilds one Thread's timeline from persisted history — messages and
 * activities merged back into the order they actually happened, using the
 * `sequence` both sides carry for exactly this purpose (spec #93 phase 1).
 *
 * A replayed activity becomes a plain TimelineToolCall rather than an item
 * type of its own, so a single card renders the live and the replayed path
 * alike and the two can't drift apart.
 *
 * Messages with a null sequence predate sequencing. They are partitioned to
 * the front in their original order rather than sorted with a sentinel:
 * they have no position relative to an activity, and a sentinel would be
 * inventing one. It never comes up in practice — a Thread old enough to
 * hold unsequenced messages has no recorded activity to interleave.
 */
export function mergeHistoryTimeline(
  messages: ThreadHistoryMessage[],
  activities: ActivityRecord[],
): TimelineItem[] {
  const unsequenced: TimelineItem[] = [];
  const sequenced: { sequence: number; item: TimelineItem }[] = [];

  for (const message of messages) {
    const item: TimelineMessage = { type: "message", id: message.messageId, role: message.role, content: message.content };
    if (message.sequence === null) unsequenced.push(item);
    else sequenced.push({ sequence: message.sequence, item });
  }

  for (const activity of activities) {
    const item: TimelineToolCall = {
      type: "tool-call",
      id: activity.activityId,
      title: activity.summary ?? undefined,
      kind: activity.kind ?? undefined,
      status: activity.status ?? undefined,
      content: activity.data,
      dataTruncated: activity.dataTruncated,
    };
    sequenced.push({ sequence: activity.sequence, item });
  }

  sequenced.sort((a, b) => a.sequence - b.sequence);
  return [...unsequenced, ...sequenced.map((entry) => entry.item)];
}
