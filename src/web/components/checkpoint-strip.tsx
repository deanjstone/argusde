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
    <div className="flex items-center gap-1.5 overflow-x-auto border-b border-border px-3 py-2">
      {checkpoints.map((checkpoint) =>
        checkpoint.turn === 0 ? (
          <span
            key="start"
            role="button"
            className="shrink-0 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground"
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
                ? "border-primary-bright text-primary-bright"
                : "border-border text-foreground hover:bg-muted",
            )}
          >
            Turn {checkpoint.turn}
            {checkpoint.revertedToTurn !== null && (
              <span className="ml-1 text-warning" title={`Reverted to turn ${checkpoint.revertedToTurn}`}>
                ↩ reverted to turn {checkpoint.revertedToTurn}
              </span>
            )}
          </button>
        ),
      )}
      {checkpoints.length > 1 && (
        <button
          type="button"
          onClick={onSinceStart}
          className="ml-auto shrink-0 rounded-md border border-border px-2 py-1 text-xs text-foreground hover:bg-muted"
        >
          Since start
        </button>
      )}
    </div>
  );
}
