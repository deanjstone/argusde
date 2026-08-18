import type { AcpSession, PromptContentBlock } from "../../utility/acp-session.js";
import type {
  AcpSessionEvent,
  AgentPromptCapabilities,
  ChatContentBlock,
  ConnectionState,
  PermissionOutcome,
  SessionModeSummary,
  ToolCallSummary,
  ToolCallUpdateSummary,
} from "../../shared/acp-events.js";
import { NO_PROMPT_CAPABILITIES } from "../../shared/acp-events.js";
import type { EventStore } from "../persistence/event-store.js";
import { flattenDetail } from "../persistence/activity-bounds.js";
import type { CheckpointStore } from "../checkpoint/checkpoint-store.js";

/** One image attachment as it arrives on the wire — base64, already bounds-checked. */
export interface PromptImageAttachment {
  mimeType: string;
  data: string;
}

/**
 * A persisted user message and a prompt carry the same blocks, but the two
 * types differ: `ChatContentBlock` also covers things only an *agent* sends
 * (resource links, unrecognised blocks). Anything outside text/image is
 * unreachable here — the wire schema admits only text and images — so it
 * degrades to its text form rather than inventing a prompt block.
 */
function toPromptBlock(block: ChatContentBlock): PromptContentBlock {
  if (block.type === "image") return { type: "image", mimeType: block.mimeType, data: block.data };
  return { type: "text", text: block.type === "text" ? block.text : "" };
}

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
 * assembled reply on turn-complete, persists mode-change updates rather
 * than dropping them, and records each tool call as a durable Activity
 * (spec #93 phase 1). Streaming chunks and the rest (permission
 * requests, connection state) are forwarded live via `onEvent` but not
 * individually persisted — only Turn/Checkpoint boundaries, completed
 * messages, and Activities are.
 *
 * Messages and Activities share one per-Thread `sequence`, allocated when
 * an item *begins*, so history replay can merge them back into the order
 * they actually happened rather than the order they were written.
 */
export class ThreadRuntime {
  private readonly options: ThreadRuntimeOptions;
  // Seeded from persisted checkpoints, not reset to 1 (argusde#96). A second
  // runtime over a Thread that already has history would otherwise hand out
  // turn numbers that are already taken and fail on the checkpoints primary
  // key at its first turn-complete. Worktree promotion is the only path that
  // rebuilds a runtime today and it only runs before the first message, which
  // is why this stayed latent rather than being noticed in use.
  private nextTurn: number;
  private pendingAgentMessages = new Map<string, { content: ChatContentBlock[]; sequence: number }>();
  private pendingAgentMessageOrder: string[] = [];
  private anonymousMessageCounter = 0;
  // Thread-wide ordering key shared by messages and activities, so history
  // replay can merge the two into one timeline. Seeded from what's already
  // persisted (constructor) rather than from zero, so a server restart
  // doesn't start handing out numbers that collide with existing history.
  private nextSequence: number;
  // toolCallId -> the sequence it was first seen at. An update has to reuse
  // it: an activity's place on the timeline is where it began, not where
  // its last status change landed.
  private activitySequences = new Map<string, number>();
  // Distinguishes the segments of an agent's prose when the agent itself
  // sends no message ids (which claude-agent-acp doesn't) — see
  // accumulateAgentChunk for why prose has to be segmented at all.
  private anonymousAgentSegment = 0;
  // Set when a tool call is first seen, cleared when the next prose chunk
  // opens a fresh segment because of it.
  private activitySinceLastAgentChunk = false;
  // The mode catalog is never persisted — only ever broadcast live, once,
  // from AcpSession.start(). Cached here (in memory, for this runtime's
  // whole lifetime) so a client that switches to this Thread later, after
  // missing that original broadcast, can still learn what modes it
  // supports — see thread.get-history in ws-server.ts.
  private lastKnownModes: SessionModeSummary[] = [];
  // Cached from the agent-capabilities event for the same reason as
  // lastKnownModes: it is broadcast once, at session start, and a client
  // that connects afterwards has no other way to learn it.
  private lastKnownCapabilities: AgentPromptCapabilities = NO_PROMPT_CAPABILITIES;
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
  // Set by handleEvent's turn-complete branch to the completeTurn() call it
  // just kicked off (fire-and-forget from the EventEmitter's own
  // perspective, since it never awaits its listeners) — sendMessage awaits
  // this after session.sendMessage() resolves so its own promise doesn't
  // settle until the turn's checkpoint capture (now async, per argusde#41)
  // has actually landed, and so a capture failure surfaces as a
  // sendMessage() rejection rather than an unhandled rejection.
  private pendingTurnCompletion: Promise<void> = Promise.resolve();

  constructor(options: ThreadRuntimeOptions) {
    this.options = options;
    this.nextTurn = options.eventStore.getNextTurn(options.threadId);
    this.nextSequence = options.eventStore.getNextSequence(options.threadId);
    options.session.on("event", (event) => this.handleEvent(event));
  }

  private allocateSequence(): number {
    return this.nextSequence++;
  }

  async start(): Promise<void> {
    const { threadId, cwd, checkpointStore, eventStore } = this.options;
    const ref = await checkpointStore.captureBaseline(threadId, cwd);
    eventStore.appendEvent({
      kind: "thread.checkpoint-captured",
      threadId,
      turn: 0,
      ref,
      timestamp: new Date().toISOString(),
    });
    await this.options.session.start();
  }

  /**
   * `attachments` are image blocks the client asked to send (spec #93 phase
   * 7). They are persisted onto the user's own message exactly as they are
   * sent, so replaying a Thread shows what the agent was actually given
   * (story 37) with no second path to keep in step. Bounds are enforced
   * before this is reached — see ws-server's send-message handler.
   */
  async sendMessage(text: string, attachments: PromptImageAttachment[] = []): Promise<void> {
    const { threadId, eventStore } = this.options;
    // Text first: the prompt reads as a message with images attached to it
    // rather than images with a caption. (Verified against the real
    // claude-agent-acp that both orderings reach the model, so this is a
    // legibility choice, not a compatibility one.)
    const content: ChatContentBlock[] = [
      { type: "text", text },
      ...attachments.map((attachment) => ({
        type: "image" as const,
        mimeType: attachment.mimeType,
        data: attachment.data,
      })),
    ];
    eventStore.appendEvent({
      kind: "thread.message-recorded",
      threadId,
      messageId: `user-${++this.anonymousMessageCounter}`,
      role: "user",
      content,
      sequence: this.allocateSequence(),
      timestamp: new Date().toISOString(),
    });
    this.turnInFlight = true;
    await this.options.session.sendMessage(content.map(toPromptBlock));
    await this.pendingTurnCompletion;
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

  /**
   * What the agent said it can be prompted with. Cached from the live
   * session for the same reason the mode catalog is: it only ever arrives
   * once, on the initialize response, so a client connecting later can only
   * learn it from thread.get-history.
   */
  getPromptCapabilities(): AgentPromptCapabilities {
    return this.lastKnownCapabilities;
  }

  getConnectionState(): { state: ConnectionState; error: string | undefined } {
    return { state: this.lastKnownConnectionState, error: this.lastKnownConnectionError };
  }

  isTurnInFlight(): boolean {
    return this.turnInFlight;
  }

  /**
   * Captures whatever's currently on disk as the next turn — the shared
   * "advance nextTurn, snapshot cwd, persist the event" sequence used by
   * every checkpoint-capture path (completeTurn, revertToCheckpoint's own
   * safety snapshot and its post-restore capture, and
   * captureFinalCheckpoint). `revertedToTurn` is only ever passed by
   * revertToCheckpoint; every other caller leaves it undefined, which the
   * event-store projection already treats as "not a revert."
   */
  private async captureCheckpointEvent(revertedToTurn?: number): Promise<number> {
    const { threadId, cwd, checkpointStore, eventStore } = this.options;
    const turn = this.nextTurn++;
    const ref = await checkpointStore.captureCheckpoint(threadId, turn, cwd);
    eventStore.appendEvent({
      kind: "thread.checkpoint-captured",
      threadId,
      turn,
      ref,
      revertedToTurn,
      timestamp: new Date().toISOString(),
    });
    return turn;
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
  async captureFinalCheckpoint(): Promise<number> {
    if (this.isTurnInFlight()) throw new Error("Cannot capture a final checkpoint while a turn is still in flight");
    return this.captureCheckpointEvent();
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
    if (this.isTurnInFlight()) throw new Error("Cannot revert while a turn is still in flight");

    // Snapshot whatever is currently on disk BEFORE overwriting it —
    // restoreCheckpoint force-rewrites the real working tree, and not
    // every byte on disk is necessarily protected by an earlier checkpoint
    // (e.g. a hand-edit made outside the app, between two turns). Without
    // this, that state would be silently and permanently lost with no
    // checkpoint ref to recover it from. Left unmarked (not a revert
    // itself) — its only job is to make sure nothing is ever discarded.
    await this.captureCheckpointEvent();

    this.options.checkpointStore.restoreCheckpoint(this.options.threadId, turn, this.options.cwd);

    const newTurn = await this.captureCheckpointEvent(turn);
    return { newTurn };
  }

  private handleEvent(event: AcpSessionEvent): void {
    // turn-complete is forwarded to onEvent by completeTurn() itself, only
    // once its checkpoint capture has actually landed — not here,
    // unconditionally like every other event kind. Before captureCheckpoint
    // became async (argusde#41), broadcasting first and capturing second
    // was still safe: nothing yielded to the event loop in between, so the
    // checkpoint was always durable by the time this synchronous call
    // returned and the socket write actually flushed. Now that the capture
    // genuinely awaits a subprocess, broadcasting turn-complete up front
    // would let a client's checkpoint-strip refresh (triggered by that
    // exact push, see App.tsx) race ahead of the write and miss the new
    // turn.
    if (event.kind === "turn-complete") {
      this.pendingTurnCompletion = this.completeTurn(event);
      return;
    }

    this.options.onEvent(event);

    switch (event.kind) {
      case "connection-state":
        this.lastKnownConnectionState = event.state;
        this.lastKnownConnectionError = event.error;
        break;
      case "message-chunk":
        if (event.role === "agent") this.accumulateAgentChunk(event.messageId, event.content);
        break;
      case "tool-call":
        this.recordActivity(event.toolCall);
        break;
      case "tool-call-update":
        this.recordActivity(event.toolCall);
        break;
      case "agent-capabilities":
        this.lastKnownCapabilities = event.capabilities;
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
      default:
        break;
    }
  }

  private accumulateAgentChunk(messageId: string | undefined, content: ChatContentBlock): void {
    // An undefined messageId means the agent isn't distinguishing messages,
    // so this has to reproduce the live timeline's own rule for where one
    // agent message ends and the next begins (appendOrMergeMessage's
    // `continuesLast` check, src/shared/timeline.ts): chunks merge into the
    // message still at the end of the timeline, and a tool call appended in
    // between ends it. Without the segmenting, prose sent *after* a tool
    // call would merge back into the prose sent before it and inherit its
    // earlier sequence — so a reopened Thread would read as "said
    // everything, then did everything" even though the live view showed
    // them interleaved.
    if (messageId === undefined && this.activitySinceLastAgentChunk) {
      this.anonymousAgentSegment++;
      this.activitySinceLastAgentChunk = false;
    }
    const key = messageId ?? `__anon__-${this.anonymousAgentSegment}`;
    const existing = this.pendingAgentMessages.get(key);
    if (existing) {
      this.pendingAgentMessages.set(key, { ...existing, content: mergeContent(existing.content, content) });
    } else {
      // The sequence is taken here, at the first chunk, not at
      // completeTurn() where the message is actually persisted — otherwise
      // every agent reply would sort after all of its own turn's tool
      // calls, replaying a turn as "said everything, then did everything"
      // no matter what really happened.
      this.pendingAgentMessages.set(key, { content: [content], sequence: this.allocateSequence() });
      this.pendingAgentMessageOrder.push(key);
    }
  }

  /**
   * Persists one tool call, or an update to one already recorded, as a
   * durable Activity (spec #93 phase 1).
   *
   * Called from handleEvent's switch, i.e. *after* the event has already
   * been forwarded to `onEvent` — persistence must never sit between the
   * agent and the client's stream, and forwarding first is the observable
   * form of that guarantee.
   *
   * An update's absent fields stay absent all the way to the store, since
   * that is what ACP means by them (unchanged) and what the upsert is built
   * to preserve — appendEvent normalises them to null on the way, which the
   * projection's COALESCE reads identically.
   */
  private recordActivity(toolCall: ToolCallSummary | ToolCallUpdateSummary): void {
    const existingSequence = this.activitySequences.get(toolCall.toolCallId);
    // An update for a call never announced (an agent that skipped the
    // tool_call, or a session resumed after a restart) still gets a place
    // rather than being dropped — its "beginning" is simply the first time
    // this runtime saw it.
    const sequence = existingSequence ?? this.allocateSequence();
    if (existingSequence === undefined) {
      this.activitySequences.set(toolCall.toolCallId, sequence);
      // Only a first sighting ends the agent's current prose segment — that
      // is the case where the live timeline appends a new item and stops
      // "continuing last". An update merges into a tool call already on the
      // timeline and moves nothing.
      this.activitySinceLastAgentChunk = true;
    }

    this.options.eventStore.appendEvent({
      kind: "thread.activity-recorded",
      threadId: this.options.threadId,
      activityId: toolCall.toolCallId,
      sequence,
      // nextTurn is the turn *in progress*: it is only consumed (and
      // incremented) by captureCheckpointEvent at turn-complete, which by
      // definition hasn't run yet while the agent is still calling tools.
      turn: this.nextTurn,
      toolKind: toolCall.kind,
      status: toolCall.status,
      summary: toolCall.title,
      detail: toolCall.content === undefined ? undefined : flattenDetail(toolCall.content),
      // Passed straight through, absence included: a tool_call always
      // carries content (possibly empty), an update only sometimes, and
      // ACP means "unchanged" by the difference — which is exactly what
      // the store's upsert preserves. No branch on new-vs-update needed.
      data: toolCall.content,
      timestamp: new Date().toISOString(),
    });
  }

  private async completeTurn(event: AcpSessionEvent): Promise<void> {
    const { threadId, eventStore } = this.options;

    for (const key of this.pendingAgentMessageOrder) {
      const pending = this.pendingAgentMessages.get(key);
      if (!pending) continue;
      eventStore.appendEvent({
        kind: "thread.message-recorded",
        threadId,
        messageId: `agent-${++this.anonymousMessageCounter}`,
        role: "agent",
        content: pending.content,
        sequence: pending.sequence,
        timestamp: new Date().toISOString(),
      });
    }
    this.pendingAgentMessages.clear();
    this.pendingAgentMessageOrder = [];
    // A new Turn always starts a new prose segment: the user's own message
    // now sits at the end of the timeline, so nothing the agent says next
    // can continue what it said last Turn.
    this.anonymousAgentSegment++;
    this.activitySinceLastAgentChunk = false;

    // Cleared only once the turn's checkpoint has actually landed (not
    // synchronously at the top, now that the capture is async) — otherwise
    // a revert or captureFinalCheckpoint could race a still-in-flight
    // capture of this same turn's snapshot.
    await this.captureCheckpointEvent();
    this.turnInFlight = false;

    // Broadcast turn-complete only now — see handleEvent's comment on why
    // this can no longer happen up front.
    this.options.onEvent(event);
  }
}
