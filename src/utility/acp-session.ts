import { EventEmitter } from "node:events";
import {
  client,
  methods,
  type ActiveSession,
  type AgentApp,
  type ClientConnection,
  type ContentBlock,
  type PermissionOption,
  type PromptCapabilities,
  type RequestPermissionResponse,
  type SessionNotification,
  type Stream,
  type ToolCall,
  type ToolCallContent,
  type ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type {
  AcpSessionEvent,
  AgentPromptCapabilities,
  ChatContentBlock,
  ConnectionState,
  PermissionOutcome,
  ToolCallSummary,
  ToolCallUpdateSummary,
} from "../shared/acp-events.js";
import { NO_PROMPT_CAPABILITIES } from "../shared/acp-events.js";
import { isDisposableStream } from "./spawn-agent-process.js";

/** What a client may put in a prompt — see toPromptContentBlock. */
export type PromptContentBlock =
  | { type: "text"; text: string }
  | { type: "image"; mimeType: string; data: string };

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

/**
 * The other direction: what the *client* sends. Only text and image blocks
 * are producible here — spec #93 phase 7 attaches images and nothing else,
 * and the wire schema refuses anything further upstream, so a block that
 * can't be represented is a bug rather than a case to degrade.
 */
/**
 * ACP omits a capability the agent doesn't have, and the SDK's own response
 * validation can replace a malformed field with undefined — both of which
 * mean the same thing here, so everything absent normalises to false rather
 * than staying optional for every caller to re-handle.
 */
function toPromptCapabilities(capabilities: PromptCapabilities | null | undefined): AgentPromptCapabilities {
  return {
    image: capabilities?.image === true,
    audio: capabilities?.audio === true,
    embeddedContext: capabilities?.embeddedContext === true,
  };
}

function toPromptContentBlock(block: PromptContentBlock): ContentBlock {
  if (block.type === "image") {
    return { type: "image", mimeType: block.mimeType, data: block.data };
  }
  return { type: "text", text: block.text };
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
  /** Retained solely so closeConnection() can kill the subprocess it owns. */
  private transport: Stream | AgentApp | undefined;
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

  /**
   * From the agent's initialize response. Defaults to nothing advertised,
   * which is also what a session that hasn't started yet honestly reports.
   */
  private promptCapabilities: AgentPromptCapabilities = NO_PROMPT_CAPABILITIES;

  getPromptCapabilities(): AgentPromptCapabilities {
    return this.promptCapabilities;
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
    this.transport = transport;
    const connection = app.connect(transport as never);
    this.connection = connection;

    connection.closed
      .then(() => {
        if (this.state !== "disconnected") this.setState("disconnected");
      })
      .catch((err: unknown) => {
        this.setState("error", err instanceof Error ? err.message : String(err));
      });

    const initialize = await connection.agent.request(methods.agent.initialize, {
      protocolVersion: 1,
    });
    this.promptCapabilities = toPromptCapabilities(initialize.agentCapabilities?.promptCapabilities);

    this.activeSession = await connection.agent.buildSession(this.options.cwd).start();
    this.setState("connected");

    // Emitted unconditionally, unlike the mode catalog below: "this agent
    // takes text only" is itself the answer the composer needs (story 38),
    // where "this agent advertises no modes" means no switcher at all.
    this.emitEvent({ kind: "agent-capabilities", capabilities: this.promptCapabilities });

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
      case "available_commands_update":
        // Arrives unprompted shortly after session start, and again whenever
        // the agent's command set changes — verified against the real
        // claude-agent-acp, which pushed 122 commands before any prompt was
        // sent and offers them nowhere else (the session/new response carries
        // none).
        this.emitEvent({
          kind: "available-commands",
          commands: update.availableCommands.map((command) => ({
            name: command.name,
            description: command.description,
            // ACP's only input kind is unstructured — one hint string — so it
            // is flattened here rather than passed through as a nested
            // optional object every consumer would unwrap identically.
            inputHint: command.input?.hint ?? null,
          })),
        });
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

  async sendMessage(content: PromptContentBlock[]): Promise<void> {
    if (!this.activeSession) {
      throw new Error("AcpSession.sendMessage() called before start()");
    }
    // The SDK's prompt() already accepts a block array (string | ContentBlock
    // | ContentBlock[]), so this is the whole of spec #93's "sole narrowing
    // point" — nothing below here needed widening.
    const response = await this.activeSession.prompt(content.map(toPromptContentBlock));
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
    // Closing the connection only closes the agent subprocess's stdio, which
    // the real claude-agent-acp happily survives. The transport owns the
    // process, so it's the only thing that can actually end it — skipped for
    // in-process test agents, which have nothing to kill.
    if (isDisposableStream(this.transport)) {
      this.transport.dispose();
    }
    this.transport = undefined;
    this.activeSession = undefined;
    if (this.state !== "disconnected") {
      this.setState("disconnected");
    }
  }
}
