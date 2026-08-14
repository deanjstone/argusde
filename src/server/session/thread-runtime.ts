import type { AcpSession } from "../../utility/acp-session.js";
import type { AcpSessionEvent, ChatContentBlock, ConnectionState, PermissionOutcome, SessionModeSummary } from "../../shared/acp-events.js";
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
  // The mode catalog is never persisted — only ever broadcast live, once,
  // from AcpSession.start(). Cached here (in memory, for this runtime's
  // whole lifetime) so a client that switches to this Thread later, after
  // missing that original broadcast, can still learn what modes it
  // supports — see thread.get-history in ws-server.ts.
  private lastKnownModes: SessionModeSummary[] = [];
  // Same rationale as lastKnownModes, but this one genuinely changes across
  // a session's lifetime (not just a one-shot catalog) — every
  // "connection-state" event updates it, so a client that missed the live
  // broadcast (the exact race that also motivated lastKnownModes: start()
  // broadcasts synchronously before the triggering command's own response
  // reaches the client) can still learn the current status via
  // thread.get-history.
  private lastKnownConnectionState: ConnectionState = "disconnected";
  private lastKnownConnectionError: string | undefined;
  // Set the instant sendMessage() persists the user's message (synchronous,
  // before the actual agent round trip is awaited), cleared the instant
  // completeTurn() fires — a revert mid-turn would force-overwrite the
  // workspace out from under whatever the agent is actively doing to it.
  private turnInFlight = false;

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
    this.turnInFlight = true;
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

  getAvailableModes(): SessionModeSummary[] {
    return this.lastKnownModes;
  }

  getConnectionState(): { state: ConnectionState; error: string | undefined } {
    return { state: this.lastKnownConnectionState, error: this.lastKnownConnectionError };
  }

  isTurnInFlight(): boolean {
    return this.turnInFlight;
  }

  /**
   * Captures whatever's currently on disk as the next turn, unmarked (not
   * a revert). Used by thread.close before disposing the runtime and (for
   * a promoted Thread) removing its worktree — the same "capture whatever
   * hasn't been checkpointed yet, before a destructive operation" idea
   * revertToCheckpoint's own safety snapshot already established, applied
   * here so a worktree removal never silently discards state that was
   * never protected by a completed turn.
   */
  captureFinalCheckpoint(): number {
    if (this.turnInFlight) throw new Error("Cannot capture a final checkpoint while a turn is still in flight");

    const { threadId, cwd, checkpointStore, eventStore } = this.options;
    const turn = this.nextTurn++;
    const ref = checkpointStore.captureCheckpoint(threadId, turn, cwd);
    eventStore.appendEvent({
      kind: "thread.checkpoint-captured",
      threadId,
      turn,
      ref,
      timestamp: new Date().toISOString(),
    });
    return turn;
  }

  /**
   * Restores the workspace to an earlier checkpoint's snapshot, then
   * captures that restored state as a brand-new forward checkpoint marked
   * with which turn it reverted to — nothing is ever truncated or
   * overwritten (matches spec #33's durable-checkpoint-history design), and
   * `nextTurn` is never reset, so a normal send afterward just continues.
   * Pure git + persistence — no ACP/agent-session interaction, so this is
   * safe to run without the agent being involved at all.
   */
  async revertToCheckpoint(turn: number): Promise<{ newTurn: number }> {
    if (this.turnInFlight) throw new Error("Cannot revert while a turn is still in flight");

    const { threadId, cwd, checkpointStore, eventStore } = this.options;

    // Snapshot whatever is currently on disk BEFORE overwriting it —
    // restoreCheckpoint force-rewrites the real working tree, and not
    // every byte on disk is necessarily protected by an earlier checkpoint
    // (e.g. a hand-edit made outside the app, between two turns). Without
    // this, that state would be silently and permanently lost with no
    // checkpoint ref to recover it from. Left unmarked (not a revert
    // itself) — its only job is to make sure nothing is ever discarded.
    const safetyTurn = this.nextTurn++;
    const safetyRef = checkpointStore.captureCheckpoint(threadId, safetyTurn, cwd);
    eventStore.appendEvent({
      kind: "thread.checkpoint-captured",
      threadId,
      turn: safetyTurn,
      ref: safetyRef,
      timestamp: new Date().toISOString(),
    });

    checkpointStore.restoreCheckpoint(threadId, turn, cwd);

    const newTurn = this.nextTurn++;
    const ref = checkpointStore.captureCheckpoint(threadId, newTurn, cwd);
    eventStore.appendEvent({
      kind: "thread.checkpoint-captured",
      threadId,
      turn: newTurn,
      ref,
      revertedToTurn: turn,
      timestamp: new Date().toISOString(),
    });

    return { newTurn };
  }

  private handleEvent(event: AcpSessionEvent): void {
    this.options.onEvent(event);

    switch (event.kind) {
      case "connection-state":
        this.lastKnownConnectionState = event.state;
        this.lastKnownConnectionError = event.error;
        break;
      case "message-chunk":
        if (event.role === "agent") this.accumulateAgentChunk(event.messageId, event.content);
        break;
      case "mode-changed":
        // Only the session-start event carries the catalog — a mid-session
        // change (client-requested or autonomous) doesn't, and must not
        // wipe out the one already cached.
        if (event.availableModes) this.lastKnownModes = event.availableModes;
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
    this.turnInFlight = false;

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
