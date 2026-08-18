import type {
  AcpSessionEvent,
  AgentCommand,
  AgentPromptCapabilities,
  ChatContentBlock,
  ConnectionState,
  PlanEntrySummary,
  SessionModeSummary,
  SessionUsage,
} from "../shared/acp-events.js";
import { NO_PROMPT_CAPABILITIES } from "../shared/acp-events.js";
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
  /**
   * What the connected agent said it can be prompted with, learned once at
   * session start (spec #93 phase 7). Nothing advertised until an agent says
   * otherwise — the composer must not offer an attachment on faith.
   */
  promptCapabilities: AgentPromptCapabilities;
  /**
   * The agent's own slash commands (spec #93 phase 8). Empty until the agent
   * pushes them, which is also the honest state for an agent that advertises
   * none — story 45 wants no menu at all in that case, not an empty one.
   */
  availableCommands: AgentCommand[];
  /**
   * How full the live session's context window is (spec #93 phase 9). Null
   * until the agent reports — story 50 wants an absent meter, not a zeroed
   * one — and null again on reconnect, since the number describes a context
   * that no longer exists once the session restarts.
   */
  usage: SessionUsage | null;
  /**
   * The agent's current plan (spec #93 phase 10). Null until it produces one —
   * story 58 wants no pill at all in that case. Session-scoped like usage and
   * never persisted: a plan describes what a live session is doing now.
   */
  plan: PlanEntrySummary[] | null;
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
  promptCapabilities: NO_PROMPT_CAPABILITIES,
  availableCommands: [],
  usage: null,
  plan: null,
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
  | { kind: "user-message-sent"; text: string; attachments?: { mimeType: string; data: string }[] }
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
      promptCapabilities: AgentPromptCapabilities;
      availableCommands: AgentCommand[];
      usage: SessionUsage | null;
      plan: PlanEntrySummary[] | null;
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
        // Capabilities go with it, for the same reason: a restarted agent
        // that takes no images must not inherit an attach control from the
        // one before it.
        ...(event.state === "connecting"
          ? {
              currentModeId: undefined,
              availableModes: [],
              promptCapabilities: NO_PROMPT_CAPABILITIES,
              availableCommands: [],
              usage: null,
              plan: null,
            }
          : {}),
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
    case "agent-capabilities":
      return { ...state, promptCapabilities: event.capabilities };
    case "usage":
      return { ...state, usage: event.usage };
    case "available-commands":
      // Replaced, never merged — ACP resends the whole list on every change,
      // so a command the agent dropped has to stop being offered.
      return { ...state, availableCommands: event.commands };
    case "plan":
      // Replaced, never appended. Every notification carries the whole plan
      // (verified against the real agent), and story 57 wants exactly one
      // answer to "what is the plan".
      return { ...state, plan: event.entries };
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
    case "user-message-sent": {
      // A fresh id (not undefined) on every call — undefined means "merge
      // into the last message of this role" (matching a streaming agent reply
      // with no id), which is wrong here: two separately-sent user messages
      // must never collapse into one timeline entry. The id is reused across
      // this message's own blocks so they land on one entry, which is what
      // makes an attached image appear on the message it was sent with
      // (story 37) rather than as a message of its own.
      const messageId = generateMessageId();
      const blocks: ChatContentBlock[] = [
        { type: "text", text: event.text },
        ...(event.attachments ?? []).map((attachment) => ({
          type: "image" as const,
          mimeType: attachment.mimeType,
          data: attachment.data,
        })),
      ];
      return {
        ...state,
        timeline: blocks.reduce(
          (timeline, block) => appendOrMergeMessage(timeline, "user", messageId, block, generateMessageId),
          state.timeline,
        ),
        agentStatus: "working",
      };
    }
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
        promptCapabilities: event.promptCapabilities,
        availableCommands: event.availableCommands,
        usage: event.usage,
        plan: event.plan,
        pendingPermissionRequest: undefined,
        agentStatus: "idle",
      };
  }
}
