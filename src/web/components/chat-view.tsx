import { useState } from "react";
import type { ChatContentBlock, PermissionOutcome } from "../../shared/acp-events.js";
import type { CheckpointRecord } from "../../shared/ws-protocol.js";
import type { ChatState, TimelineItem } from "../chat-state.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { CheckpointStrip } from "./checkpoint-strip.js";
import { DiffView } from "./diff-view.js";

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
}: ChatViewProps) {
  const [text, setText] = useState("");

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText("");
  }

  return (
    <div className="flex h-full flex-col bg-neutral-950 text-neutral-100">
      {state.connectionState !== "connected" && (
        <div className="border-b border-neutral-800 px-4 py-2 text-xs text-neutral-400">
          {state.connectionError ? <span className="text-red-400">{state.connectionError}</span> : <span>{state.connectionState}…</span>}
        </div>
      )}

      <CheckpointStrip checkpoints={checkpoints} onSelectTurn={onSelectTurn} onSinceStart={onSinceStart} activeTurn={activeTurn} />
      <DiffView diff={diff.text} loading={diff.loading} error={diff.error} onClose={onCloseDiff} />

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

      <form onSubmit={handleSubmit} className="flex items-center gap-2 border-t border-neutral-800 p-3">
        <Input placeholder="Message ArgusDE…" value={text} onChange={(event) => setText(event.target.value)} className="flex-1" />
        <Button type="submit" size="icon" aria-label="Send">
          →
        </Button>
      </form>
    </div>
  );
}
