import { cn } from "../lib/utils.js";
import type { CheckpointRecord } from "../../shared/ws-protocol.js";

export interface CheckpointStripProps {
  checkpoints: CheckpointRecord[];
  /** Turn N (N > 0) requests the diff between turn N-1 and N — "what changed this turn". */
  onSelectTurn: (turn: number) => void;
  /** Diffs the latest turn against the turn-0 baseline — the cumulative change since the thread started. */
  onSinceStart: () => void;
  activeTurn?: number;
}

/** Horizontally-scrollable turn markers, per spec #33's checkpoint-timeline UI direction. */
export function CheckpointStrip({ checkpoints, onSelectTurn, onSinceStart, activeTurn }: CheckpointStripProps) {
  if (checkpoints.length === 0) return null;

  return (
    <div className="flex items-center gap-1.5 overflow-x-auto border-b border-neutral-800 px-3 py-2">
      {checkpoints.map((checkpoint) =>
        checkpoint.turn === 0 ? (
          <span
            key="start"
            role="button"
            className="shrink-0 rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-500"
          >
            Start
          </span>
        ) : (
          <button
            key={checkpoint.turn}
            type="button"
            aria-current={checkpoint.turn === activeTurn ? "true" : undefined}
            onClick={() => onSelectTurn(checkpoint.turn)}
            className={cn(
              "shrink-0 rounded-md border px-2 py-1 text-xs transition-colors",
              checkpoint.turn === activeTurn
                ? "border-violet-500 text-violet-300"
                : "border-neutral-700 text-neutral-300 hover:bg-neutral-800",
            )}
          >
            Turn {checkpoint.turn}
          </button>
        ),
      )}
      {checkpoints.length > 1 && (
        <button
          type="button"
          onClick={onSinceStart}
          className="ml-auto shrink-0 rounded-md border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800"
        >
          Since start
        </button>
      )}
    </div>
  );
}
