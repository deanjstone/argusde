import { useState } from "react";
import type { PermissionOutcome } from "../../shared/acp-events.js";
import type { CheckpointRecord } from "../../shared/ws-protocol.js";
import type { ChatState, TimelineItem } from "../chat-state.js";
import { renderContentBlock } from "./content-block.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { Badge } from "./ui/badge.js";
import { Bubble, BubbleContent } from "./ui/bubble.js";
import { Item, ItemContent, ItemTitle } from "./ui/item.js";
import { Marker, MarkerContent } from "./ui/marker.js";
import { Message, MessageContent } from "./ui/message.js";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "./ui/message-scroller.js";
import { ActivityCard } from "./activity-card.js";
import { CheckpointStrip } from "./checkpoint-strip.js";
import { DiffView, type DiffRange } from "./diff-view.js";
import { ModeSwitcher } from "./mode-switcher.js";

export interface DiffState {
  text: string | null;
  loading: boolean;
  error: string | undefined;
}

export interface ChatViewProps {
  state: ChatState;
  onSend: (text: string) => void;
  onRespondPermission: (requestId: string, outcome: PermissionOutcome) => void;
  checkpoints?: CheckpointRecord[];
  onSelectTurn?: (turn: number) => void;
  onSinceStart?: () => void;
  activeTurn?: number;
  diff?: DiffState;
  onCloseDiff?: () => void;
  onRevert?: () => void;
  reverting?: boolean;
  /** Every captured turn, so the diff panel can offer any pair for comparison. */
  availableTurns?: number[];
  diffRange?: DiffRange;
  onChangeDiffRange?: (range: DiffRange) => void;
  onSetMode?: (modeId: string) => void;
  worktreePath?: string | null;
  onPromoteToWorktree?: () => void;
  promoting?: boolean;
  onCloseThread?: () => void;
  closing?: boolean;
  threadClosed?: boolean;
}

function TimelineItemView({ item }: { item: TimelineItem }) {
  if (item.type === "message") {
    const align = item.role === "user" ? "end" : "start";
    return (
      <Message align={align}>
        <MessageContent>
          {/* The user's own words take the accent (default = primary); the
              agent's take the neutral surface, so authorship is readable
              without a label. Both come from the theme's tokens via the
              variant, not from per-message colour classes. */}
          <Bubble align={align} variant={item.role === "user" ? "default" : "muted"}>
            <BubbleContent>{item.content.map((block, i) => renderContentBlock(block, i))}</BubbleContent>
          </Bubble>
        </MessageContent>
      </Message>
    );
  }

  return <ActivityCard item={item} />;
}

/** Message list + input + permission prompt + connection status, mobile-first. */
export function ChatView({
  state,
  onSend,
  onRespondPermission,
  checkpoints = [],
  onSelectTurn = () => {},
  onSinceStart = () => {},
  activeTurn,
  diff = { text: null, loading: false, error: undefined },
  onCloseDiff = () => {},
  onRevert,
  reverting = false,
  availableTurns,
  diffRange,
  onChangeDiffRange,
  onSetMode = () => {},
  worktreePath = null,
  onPromoteToWorktree = () => {},
  promoting = false,
  onCloseThread,
  closing = false,
  threadClosed = false,
}: ChatViewProps) {
  const [text, setText] = useState("");
  // Promoting relocates the thread's agent session to a fresh worktree —
  // only safe while nothing has happened yet. Mirrors state.timeline being
  // empty, not checkpoints.length: a checkpoint only lands once a turn
  // fully completes, so it would still read "nothing sent" while a message
  // is in flight. See ws-server.ts's matching server-side guard (keyed off
  // the persisted thread.message-recorded event) for the authoritative
  // check — this is purely a UI-visibility mirror, not itself an
  // enforcement point.
  const canPromote = worktreePath === null && state.timeline.length === 0;
  // "Running" is present tense — wrong once the thread (and the worktree
  // itself) is closed. worktreePath deliberately stays set after close as
  // a historical record (see thread-list.tsx's own "closed" badge), so
  // this can't just be `worktreePath !== null`.
  const showLiveWorktreeBadge = worktreePath !== null && !threadClosed;
  const showCloseButton = onCloseThread !== undefined && !threadClosed;

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText("");
  }

  return (
    <div
      className={`flex h-full flex-col border-2 bg-background text-foreground ${
        worktreePath !== null ? "border-warning" : "border-transparent"
      }`}
    >
      {state.connectionState !== "connected" && !threadClosed && (
        <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground">
          <span>{state.connectionState}…</span>
        </div>
      )}

      {/* Separate from the status line above, and deliberately not gated on
          connectionState. A failed promote/revert/close/set-mode/thread-create
          lands here while the agent connection is perfectly healthy — gating
          this on "not connected" made every one of those a silent no-op, with
          the UI showing nothing at all when the action failed. It stays
          visible on a closed thread too: the status line is noise there, an
          actual error isn't. */}
      {state.connectionError && (
        <div className="border-b border-border px-4 py-2 text-xs">
          <span className="text-destructive">{state.connectionError}</span>
        </div>
      )}

      <ModeSwitcher currentModeId={state.currentModeId} availableModes={state.availableModes} onSetMode={onSetMode} />

      {(showLiveWorktreeBadge || canPromote || showCloseButton) && (
        <div className="flex items-center justify-end gap-2 border-b border-border px-3 py-2">
          {showLiveWorktreeBadge && (
            <Badge variant="outline" className="gap-1.5 border-warning/40 text-warning">
              <span aria-hidden className="size-2 rounded-full bg-warning" />
              Running in an isolated worktree
            </Badge>
          )}
          {worktreePath === null && canPromote && (
            <Button variant="outline" size="sm" aria-label="Promote to worktree" onClick={onPromoteToWorktree} disabled={promoting}>
              {promoting ? "Promoting…" : "Promote to worktree"}
            </Button>
          )}
          {showCloseButton && (
            <Button variant="outline" size="sm" onClick={onCloseThread} disabled={closing}>
              {closing ? "Closing…" : "Close thread"}
            </Button>
          )}
        </div>
      )}

      <CheckpointStrip checkpoints={checkpoints} onSelectTurn={onSelectTurn} onSinceStart={onSinceStart} activeTurn={activeTurn} />
      <DiffView
        diff={diff.text}
        loading={diff.loading}
        error={diff.error}
        onClose={onCloseDiff}
        onRevert={onRevert}
        reverting={reverting}
        availableTurns={availableTurns}
        range={diffRange}
        onChangeRange={onChangeDiffRange}
      />

      {/* Scroll to the actual end, rather than the library default
          "last-anchor" — which pins the newest turn to the *top* of the
          viewport. That is a real pattern (Claude.ai does it) but not this
          app's, and on a short Thread it leaves most of the screen blank
          while clipping the top of the conversation.
          `defaultScrollPosition` alone is not enough: the spacer that makes
          last-anchor work is injected unconditionally, so "end" would land
          at the bottom of it. Killing the spacer is what actually fixes it —
          see spacerClassName below. */}
      <MessageScrollerProvider defaultScrollPosition="end">
        {/* Replaces a bare overflow-y-auto div, which had no scroll
            anchoring at all — a streaming reply used to scroll out from
            under the reader. The scroller keeps the view pinned to the end
            while the agent is talking and offers a jump-to-end control the
            moment you scroll away from it. */}
        <MessageScroller className="flex-1">
          <MessageScrollerViewport>
            <MessageScrollerContent className="gap-3 px-4 py-4" spacerClassName="!h-0 !mt-0">
              {!state.recordsActivity && (
                <Marker variant="separator">
                  <MarkerContent>
                    This thread predates activity recording — its tool calls were never saved.
                  </MarkerContent>
                </Marker>
              )}

              {state.timeline.map((item) => (
                <MessageScrollerItem key={item.id}>
                  <TimelineItemView item={item} />
                </MessageScrollerItem>
              ))}

              {state.agentStatus === "working" && (
                <MessageScrollerItem scrollAnchor>
                  <p className="text-sm text-muted-foreground">Claude is working…</p>
                </MessageScrollerItem>
              )}

              {state.pendingPermissionRequest && (
                <MessageScrollerItem scrollAnchor>
                  {/* Deliberately NOT shadcn's `questionnaire`, which spec
                      #93's component table suggests: that component is a
                      multi-step form wizard (progress, previous/skip/next/
                      submit), and an ACP permission request is a one-shot
                      choice among N options. Built from `item` + `button`
                      instead — real primitives, real tokens, without
                      forcing a wizard's semantics onto a prompt. */}
                  <Item variant="outline" size="sm" className="flex-col items-stretch gap-3 border-warning/40 bg-warning/5">
                    <ItemTitle className="text-warning">
                      {state.pendingPermissionRequest.toolCallTitle ?? "Permission requested"}
                    </ItemTitle>
                    <ItemContent className="flex flex-row flex-wrap gap-2">
                      {state.pendingPermissionRequest.options.map((option) => (
                        <Button
                          key={option.optionId}
                          variant="outline"
                          size="sm"
                          onClick={() => onRespondPermission(state.pendingPermissionRequest!.requestId, { optionId: option.optionId })}
                        >
                          {option.name}
                        </Button>
                      ))}
                    </ItemContent>
                  </Item>
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>

      {threadClosed && <p className="border-t border-border px-4 pt-2 text-xs text-muted-foreground">This thread is closed.</p>}
      <form onSubmit={handleSubmit} className="flex items-center gap-2 border-t border-border p-3">
        <Input
          placeholder="Message ArgusDE…"
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={threadClosed}
          className="flex-1"
        />
        <Button type="submit" size="icon" aria-label="Send" disabled={threadClosed}>
          →
        </Button>
      </form>
    </div>
  );
}
