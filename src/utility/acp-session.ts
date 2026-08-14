import { EventEmitter } from "node:events";
import {
  client,
  methods,
  type ActiveSession,
  type AgentApp,
  type ClientConnection,
  type ContentBlock,
  type PermissionOption,
  type RequestPermissionResponse,
  type SessionNotification,
  type Stream,
  type ToolCall,
  type ToolCallContent,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type {
  AcpSessionEvent,
  ChatContentBlock,
  ConnectionState,
  PermissionOutcome,
  ToolCallSummary,
  ToolCallUpdateSummary,
} from "../shared/acp-events.js";

export interface AcpSessionOptions {
  /** Human-readable client name reported to the agent during initialize. */
  name: string;
  /** Working directory for the ACP session (must be absolute). */
  cwd: string;
  /**
   * Produces the transport to connect to for one session lifetime. Called
   * once by `start()` and again by `restartSession()`. Production code
   * returns a `Stream` wrapping a spawned Claude Code subprocess's stdio;
   * tests return an in-process `AgentApp` (e.g. a fake agent), which the SDK
   * supports connecting to directly with no transport at all.
   */
  createTransport: () => Stream | AgentApp;
}

function toChatContentBlock(block: ContentBlock): ChatContentBlock {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "image":
      return { type: "image", mimeType: block.mimeType, data: block.data, uri: block.uri ?? undefined };
    case "resource_link":
      return { type: "resource_link", uri: block.uri, name: block.name };
    default:
      return { type: "other" };
  }
}

function toolCallContentToChatBlocks(content: ToolCallContent[] | null | undefined): ChatContentBlock[] {
  if (!content) return [];
  return content.map((item): ChatContentBlock => {
    if (item.type === "content") return toChatContentBlock(item.content);
    if (item.type === "diff") return { type: "text", text: item.newText };
    return { type: "other" };
  });
}

function toToolCallSummary(toolCall: ToolCall): ToolCallSummary {
  return {
    toolCallId: toolCall.toolCallId,
    title: toolCall.title,
    kind: toolCall.kind ?? undefined,
    status: toolCall.status ?? undefined,
    content: toolCallContentToChatBlocks(toolCall.content),
  };
}

function toToolCallUpdateSummary(toolCall: ToolCallUpdate): ToolCallUpdateSummary {
  return {
    toolCallId: toolCall.toolCallId,
    title: toolCall.title ?? undefined,
    kind: toolCall.kind ?? undefined,
    status: toolCall.status ?? undefined,
    content: toolCall.content ? toolCallContentToChatBlocks(toolCall.content) : undefined,
  };
}

interface PendingPermissionRequest {
  resolve: (response: RequestPermissionResponse) => void;
}

/**
 * Owns one ACP client-side connection to an agent for its whole lifetime.
 * Normalizes raw ACP protocol traffic into `AcpSessionEvent`s and exposes a
 * small imperative surface (`sendMessage`, `respondToPermission`,
 * `restartSession`) for a caller (the utility-process IPC glue, or a test)
 * to drive. Framework-agnostic: no Electron API is used here.
 */
export class AcpSession extends EventEmitter {
  private readonly options: AcpSessionOptions;
  private state: ConnectionState = "disconnected";
  private connection: ClientConnection | undefined;
  private activeSession: ActiveSession | undefined;
  private pendingPermissions = new Map<string, PendingPermissionRequest>();
  private permissionCounter = 0;
  private modeRequestCounter = 0;

  constructor(options: AcpSessionOptions) {
    super();
    this.options = options;
  }

  get connectionState(): ConnectionState {
    return this.state;
  }

  override on(event: "event", listener: (e: AcpSessionEvent) => void): this {
    return super.on(event, listener);
  }

  private emitEvent(event: AcpSessionEvent): void {
    this.emit("event", event);
  }

  private setState(state: ConnectionState, error?: string): void {
    this.state = state;
    this.emitEvent({ kind: "connection-state", state, error });
  }

  async start(): Promise<void> {
    this.setState("connecting");

    const app = client({ name: this.options.name })
      .onNotification(methods.client.session.update, async (ctx) => {
        this.handleSessionNotification(ctx.params);
      })
      .onRequest(methods.client.session.requestPermission, async (ctx) => {
        return this.handlePermissionRequest(ctx.params.toolCall, ctx.params.options);
      });

    const transport = this.options.createTransport();
    const connection = app.connect(transport as never);
    this.connection = connection;

    connection.closed
      .then(() => {
        if (this.state !== "disconnected") this.setState("disconnected");
      })
      .catch((err: unknown) => {
        this.setState("error", err instanceof Error ? err.message : String(err));
      });

    await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
    });

    this.activeSession = await connection.agent.buildSession(this.options.cwd).start();
    this.setState("connected");

    // Unlike `current_mode_update` (a change signal only), the mode catalog
    // is only ever available here, on the session's own start response — an
    // agent that doesn't advertise modes at all leaves this undefined, and
    // no event is emitted (no switcher should render for it).
    const modes = this.activeSession.modes;
    // The SDK's own response validation already replaces a malformed
    // `modes` field with `undefined` before it reaches here (confirmed via
    // its zod schema's defaultOnError fallback) — this guard is extra
    // insurance against a shape violating that contract, not a scenario
    // known to be reachable through a spec-compliant agent.
    if (modes && Array.isArray(modes.availableModes)) {
      this.emitEvent({
        kind: "mode-changed",
        modeId: modes.currentModeId,
        availableModes: modes.availableModes.map((mode) => ({
          id: mode.id,
          name: mode.name,
          description: mode.description ?? undefined,
        })),
      });
    }
  }

  private handleSessionNotification(notification: SessionNotification): void {
    const update = notification.update;
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.emitEvent({
          kind: "message-chunk",
          role: "agent",
          messageId: update.messageId ?? undefined,
          content: toChatContentBlock(update.content),
        });
        break;
      case "agent_thought_chunk":
        this.emitEvent({
          kind: "message-chunk",
          role: "agent-thought",
          messageId: update.messageId ?? undefined,
          content: toChatContentBlock(update.content),
        });
        break;
      case "user_message_chunk":
        this.emitEvent({
          kind: "message-chunk",
          role: "user",
          messageId: update.messageId ?? undefined,
          content: toChatContentBlock(update.content),
        });
        break;
      case "tool_call":
        this.emitEvent({ kind: "tool-call", toolCall: toToolCallSummary(update) });
        break;
      case "tool_call_update":
        this.emitEvent({ kind: "tool-call-update", toolCall: toToolCallUpdateSummary(update) });
        break;
      case "plan":
        this.emitEvent({
          kind: "plan",
          entries: update.entries.map((entry) => ({
            content: entry.content,
            priority: entry.priority,
            status: entry.status,
          })),
        });
        break;
      case "current_mode_update":
        this.emitEvent({ kind: "mode-changed", modeId: update.currentModeId });
        break;
      default:
        // Other update kinds (config options, usage, etc.) are out of scope
        // for the MVP chat surface and are intentionally dropped.
        break;
    }
  }

  private async handlePermissionRequest(
    toolCall: ToolCallUpdate,
    options: PermissionOption[],
  ): Promise<RequestPermissionResponse> {
    const requestId = `perm-${++this.permissionCounter}`;

    const responsePromise = new Promise<RequestPermissionResponse>((resolve) => {
      this.pendingPermissions.set(requestId, { resolve });
    });

    const toolCallUpdate = toToolCallUpdateSummary(toolCall);
    this.emitEvent({
      kind: "permission-request",
      request: {
        requestId,
        toolCall: { ...toolCallUpdate, content: toolCallUpdate.content ?? [] },
        options: options.map((option) => ({
          optionId: option.optionId,
          name: option.name,
          kind: option.kind,
        })),
      },
    });

    return responsePromise;
  }

  respondToPermission(requestId: string, outcome: PermissionOutcome): void {
    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;
    this.pendingPermissions.delete(requestId);
    pending.resolve({
      outcome: outcome === "cancelled" ? { outcome: "cancelled" } : { outcome: "selected", optionId: outcome.optionId },
    });
  }

  async sendMessage(text: string): Promise<void> {
    if (!this.activeSession) {
      throw new Error("AcpSession.sendMessage() called before start()");
    }
    const response = await this.activeSession.prompt(text);
    this.emitEvent({ kind: "turn-complete", stopReason: response.stopReason });
  }

  async setMode(modeId: string): Promise<void> {
    if (!this.connection || !this.activeSession) {
      throw new Error("AcpSession.setMode() called before start()");
    }
    // Guards against out-of-order responses: nothing about the underlying
    // connection guarantees requests resolve in the order they were sent,
    // so a slow response to an earlier setMode() call must not overwrite
    // the confirmation for a newer one that already resolved.
    const requestId = ++this.modeRequestCounter;
    await this.connection.agent.request(methods.agent.session.setMode, {
      sessionId: this.activeSession.sessionId,
      modeId,
    });
    if (requestId !== this.modeRequestCounter) return;
    // A successful response IS the confirmation — confirmed against the
    // real claude-agent-acp that it sends no current_mode_update
    // notification for a client-requested change (that notification is
    // reserved for the agent changing modes autonomously). Without this,
    // the mode switcher UI would silently revert to the old mode after
    // every switch, even though the agent actually changed it.
    this.emitEvent({ kind: "mode-changed", modeId });
  }

  async restartSession(): Promise<void> {
    await this.closeConnection();
    this.pendingPermissions.clear();
    await this.start();
  }

  async dispose(): Promise<void> {
    await this.closeConnection();
  }

  private async closeConnection(): Promise<void> {
    if (this.connection) {
      this.connection.close();
      this.connection = undefined;
    }
    this.activeSession = undefined;
    if (this.state !== "disconnected") {
      this.setState("disconnected");
    }
  }
}
