export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export type ChatContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string; uri?: string }
  | { type: "resource_link"; uri: string; name: string }
  | { type: "other" };

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";

export interface ToolCallSummary {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: ToolCallStatus;
  content: ChatContentBlock[];
}

/**
 * A partial update to a tool call already on the timeline. Unlike
 * `ToolCallSummary`, `content` is only present when the agent actually sent
 * new content for this update — ACP's `tool_call_update` replaces the
 * content collection only when the field is included, so a missing
 * `content` here must leave the existing content untouched rather than
 * clearing it.
 */
export interface ToolCallUpdateSummary {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: ToolCallStatus;
  content?: ChatContentBlock[];
}

export type PermissionOptionKind = "allow_once" | "allow_always" | "reject_once" | "reject_always";

export interface PermissionOptionSummary {
  optionId: string;
  name: string;
  kind: PermissionOptionKind;
}

export interface PermissionRequestSummary {
  requestId: string;
  toolCall: ToolCallSummary;
  options: PermissionOptionSummary[];
}

export interface PlanEntrySummary {
  content: string;
  priority: string;
  status: string;
}

export type PermissionOutcome = "cancelled" | { optionId: string };

export interface SessionModeSummary {
  id: string;
  name: string;
  description?: string;
}

export type AcpSessionEvent =
  | { kind: "connection-state"; state: ConnectionState; error?: string }
  | {
      kind: "message-chunk";
      role: "user" | "agent" | "agent-thought";
      messageId?: string;
      content: ChatContentBlock;
    }
  | { kind: "tool-call"; toolCall: ToolCallSummary }
  | { kind: "tool-call-update"; toolCall: ToolCallUpdateSummary }
  | { kind: "plan"; entries: PlanEntrySummary[] }
  | { kind: "permission-request"; request: PermissionRequestSummary }
  | { kind: "turn-complete"; stopReason: string }
  | { kind: "mode-changed"; modeId: string; availableModes?: SessionModeSummary[] };
