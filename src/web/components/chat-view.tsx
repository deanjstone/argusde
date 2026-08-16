import { useState } from "react";
import type { ChatContentBlock, PermissionOutcome } from "../../shared/acp-events.js";
import type { CheckpointRecord } from "../../shared/ws-protocol.js";
import type { ChatState, TimelineItem } from "../chat-state.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { CheckpointStrip } from "./checkpoint-strip.js";
import { DiffView } from "./diff-view.js";
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
  onSetMode?: (modeId: string) => void;
  worktreePath?: string | null;
  onPromoteToWorktree?: () => void;
  promoting?: boolean;
  onCloseThread?: () => void;
  closing?: boolean;
  threadClosed?: boolean;
}

function renderContentBlock(block: ChatContentBlock, key: number) {
  switch (block.type) {
    case "text":
      return (
        <span key={key} className="whitespace-pre-wrap">
          {block.text}
        </span>
      );
    case "image":
      return <img key={key} src={block.uri ?? `data:${block.mimeType};base64,${block.data}`} alt="" className="max-w-full rounded" />;
    case "resource_link":
      return (
        <a key={key} href={block.uri} className="text-violet-400 underline">
          {block.name}
        </a>
      );
    default:
      return null;
  }
}

function TimelineItemView({ item }: { item: TimelineItem }) {
  if (item.type === "message") {
    return (
      <div className={`flex ${item.role === "user" ? "justify-end" : "justify-start"}`}>
        <div
          className={`max-w-[85%] rounded-2xl px-4 py-2.5 text-sm leading-relaxed ${
            item.role === "user" ? "bg-violet-600 text-white" : "bg-neutral-900 text-neutral-100"
          }`}
        >
          {item.content.map((block, i) => renderContentBlock(block, i))}
        </div>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium text-neutral-200">{item.title ?? item.id}</span>
        {item.status && <span className="text-xs text-neutral-500">{item.status}</span>}
      </div>
      {item.content.length > 0 && (
        <div className="mt-1 text-neutral-400">{item.content.map((block, i) => renderContentBlock(block, i))}</div>
      )}
    </div>
  );
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
      className={`flex h-full flex-col border-2 bg-neutral-950 text-neutral-100 ${
        worktreePath !== null ? "border-amber-500" : "border-transparent"
      }`}
    >
      {state.connectionState !== "connected" && !threadClosed && (
        <div className="border-b border-neutral-800 px-4 py-2 text-xs text-neutral-400">
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
        <div className="border-b border-neutral-800 px-4 py-2 text-xs">
          <span className="text-red-400">{state.connectionError}</span>
        </div>
      )}

      <ModeSwitcher currentModeId={state.currentModeId} availableModes={state.availableModes} onSetMode={onSetMode} />

      {(showLiveWorktreeBadge || canPromote || showCloseButton) && (
        <div className="flex items-center justify-end gap-2 border-b border-neutral-800 px-3 py-2">
          {showLiveWorktreeBadge && (
            <span className="flex items-center gap-1.5 text-xs text-amber-400">
              <span aria-hidden className="h-2 w-2 rounded-full bg-amber-500" />
              Running in an isolated worktree
            </span>
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
      <DiffView diff={diff.text} loading={diff.loading} error={diff.error} onClose={onCloseDiff} onRevert={onRevert} reverting={reverting} />

      <div className="flex-1 space-y-3 overflow-y-auto px-4 py-4">
        {state.timeline.map((item) => (
          <TimelineItemView key={item.id} item={item} />
        ))}
        {state.agentStatus === "working" && <p className="text-sm text-neutral-500">Claude is working…</p>}

        {state.pendingPermissionRequest && (
          <div className="rounded-xl border border-amber-500/30 bg-amber-500/5 p-4">
            <p className="mb-3 text-sm text-amber-200">{state.pendingPermissionRequest.toolCallTitle ?? "Permission requested"}</p>
            <div className="flex gap-2">
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
            </div>
          </div>
        )}
      </div>

      {threadClosed && <p className="border-t border-neutral-800 px-4 pt-2 text-xs text-neutral-500">This thread is closed.</p>}
      <form onSubmit={handleSubmit} className="flex items-center gap-2 border-t border-neutral-800 p-3">
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
