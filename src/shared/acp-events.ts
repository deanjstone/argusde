export type ConnectionState = "disconnected" | "connecting" | "connected" | "error";

export type ChatContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string; uri?: string }
  | { type: "resource_link"; uri: string; name: string }
  | { type: "other" };

/**
 * What the connected agent said it can be *prompted with*, from its
 * `initialize` response (spec #93 phase 7). Booleans rather than optionals:
 * ACP omits a capability it doesn't have, and "absent" and "false" mean the
 * same thing to every caller — an agent that never advertised images takes
 * text only. Verified against the real claude-agent-acp, which advertises
 * `{ image: true, embeddedContext: true }` and no audio.
 */
export interface AgentPromptCapabilities {
  image: boolean;
  audio: boolean;
  embeddedContext: boolean;
}

export const NO_PROMPT_CAPABILITIES: AgentPromptCapabilities = {
  image: false,
  audio: false,
  embeddedContext: false,
};

/**
 * One command the connected agent will recognise in a prompt (spec #93 phase
 * 8). Discovery only — ArgusDE never executes one. Selecting it puts text in
 * the composer and the user sends it like any other message; the agent side
 * parses the leading `/name` itself (verified against the real
 * claude-agent-acp, which answers an unknown one with "Unknown command: …"
 * rather than treating it as prose).
 */
export interface AgentCommand {
  name: string;
  description: string;
  /**
   * Flattened out of ACP's `input: { hint }`. The only input kind ACP defines
   * is unstructured — a single hint string — so a nested optional object would
   * make every consumer unwrap the same one field. Null when the command takes
   * no argument, which is the overwhelming majority (107 of 122 on the real
   * agent).
   */
  inputHint: string | null;
}

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
  | { kind: "mode-changed"; modeId: string; availableModes?: SessionModeSummary[] }
  /**
   * Emitted once, on session start, from the agent's initialize response.
   * Like the mode catalog it is only ever available there — nothing later in
   * the session restates it — so a client that connects afterwards learns it
   * from thread.get-history instead.
   */
  | { kind: "agent-capabilities"; capabilities: AgentPromptCapabilities }
  /**
   * The agent's command list. Unlike the mode catalog, this legitimately
   * arrives more than once — ACP resends the whole list whenever it changes
   * (spec #93 story 44) — so a later event *replaces* the previous list
   * rather than adding to it: a command the agent dropped has to disappear.
   */
  | { kind: "available-commands"; commands: AgentCommand[] };
