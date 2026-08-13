import type { AcpSession } from "../../utility/acp-session.js";
import type { AcpSessionEvent, ChatContentBlock, PermissionOutcome } from "../../shared/acp-events.js";
import type { EventStore } from "../persistence/event-store.js";
import type { CheckpointStore } from "../checkpoint/checkpoint-store.js";

export interface ThreadRuntimeOptions {
  threadId: string;
  /** Working directory the checkpoint snapshots and the agent session both operate in. */
  cwd: string;
  session: AcpSession;
  eventStore: EventStore;
  checkpointStore: CheckpointStore;
  /** Forwards every live session event (streaming or not) to a WS broadcaster. */
  onEvent: (event: AcpSessionEvent) => void;
}

function mergeContent(existing: ChatContentBlock[], next: ChatContentBlock): ChatContentBlock[] {
  const last = existing[existing.length - 1];
  if (last?.type === "text" && next.type === "text") {
    return [...existing.slice(0, -1), { type: "text", text: last.text + next.text }];
  }
  return [...existing, next];
}

/**
 * Bridges one running AcpSession to persistence: captures a checkpoint per
 * Turn (turn numbers stay 1:1 with checkpoint numbers, including a turn-0
 * baseline on start()), persists the user's message eagerly and the agent's
 * assembled reply on turn-complete, and stops dropping mode-change updates
 * (persists them instead). Streaming chunks and everything else (tool
 * calls, permission requests, connection state) are forwarded live via
 * `onEvent` but not individually persisted — only Turn/Checkpoint
 * boundaries and completed messages are, per spec #33.
 */
export class ThreadRuntime {
  private readonly options: ThreadRuntimeOptions;
  private nextTurn = 1;
  private pendingAgentMessages = new Map<string, ChatContentBlock[]>();
  private pendingAgentMessageOrder: string[] = [];
  private anonymousMessageCounter = 0;

  constructor(options: ThreadRuntimeOptions) {
    this.options = options;
    options.session.on("event", (event) => this.handleEvent(event));
  }

  async start(): Promise<void> {
    const { threadId, cwd, checkpointStore, eventStore } = this.options;
    const ref = checkpointStore.captureBaseline(threadId, cwd);
    eventStore.appendEvent({
      kind: "thread.checkpoint-captured",
      threadId,
      turn: 0,
      ref,
      timestamp: new Date().toISOString(),
    });
    await this.options.session.start();
  }

  async sendMessage(text: string): Promise<void> {
    const { threadId, eventStore } = this.options;
    eventStore.appendEvent({
      kind: "thread.message-recorded",
      threadId,
      messageId: `user-${++this.anonymousMessageCounter}`,
      role: "user",
      content: [{ type: "text", text }],
      timestamp: new Date().toISOString(),
    });
    await this.options.session.sendMessage(text);
  }

  async setMode(modeId: string): Promise<void> {
    await this.options.session.setMode(modeId);
  }

  respondToPermission(requestId: string, outcome: PermissionOutcome): void {
    this.options.session.respondToPermission(requestId, outcome);
  }

  async dispose(): Promise<void> {
    await this.options.session.dispose();
  }

  private handleEvent(event: AcpSessionEvent): void {
    this.options.onEvent(event);

    switch (event.kind) {
      case "message-chunk":
        if (event.role === "agent") this.accumulateAgentChunk(event.messageId, event.content);
        break;
      case "mode-changed":
        this.options.eventStore.appendEvent({
          kind: "thread.mode-changed",
          threadId: this.options.threadId,
          modeId: event.modeId,
          timestamp: new Date().toISOString(),
        });
        break;
      case "turn-complete":
        this.completeTurn();
        break;
      default:
        break;
    }
  }

  private accumulateAgentChunk(messageId: string | undefined, content: ChatContentBlock): void {
    // An undefined messageId means the agent isn't distinguishing messages —
    // every such chunk in a turn belongs to the same message (mirrors the
    // chat-reducer's "continues last" heuristic), so it gets one stable key,
    // not a fresh key per call.
    const key = messageId ?? "__anon__";
    const existing = this.pendingAgentMessages.get(key);
    if (existing) {
      this.pendingAgentMessages.set(key, mergeContent(existing, content));
    } else {
      this.pendingAgentMessages.set(key, [content]);
      this.pendingAgentMessageOrder.push(key);
    }
  }

  private completeTurn(): void {
    const { threadId, eventStore, checkpointStore, cwd } = this.options;

    for (const key of this.pendingAgentMessageOrder) {
      const content = this.pendingAgentMessages.get(key);
      if (!content) continue;
      eventStore.appendEvent({
        kind: "thread.message-recorded",
        threadId,
        messageId: `agent-${++this.anonymousMessageCounter}`,
        role: "agent",
        content,
        timestamp: new Date().toISOString(),
      });
    }
    this.pendingAgentMessages.clear();
    this.pendingAgentMessageOrder = [];

    const turn = this.nextTurn++;
    const ref = checkpointStore.captureCheckpoint(threadId, turn, cwd);
    eventStore.appendEvent({
      kind: "thread.checkpoint-captured",
      threadId,
      turn,
      ref,
      timestamp: new Date().toISOString(),
    });
  }
}
