import { cn } from "../lib/utils.js";

export interface DiffRange {
  from: number;
  to: number;
}

export interface DiffViewProps {
  diff: string | null;
  loading: boolean;
  error: string | undefined;
  onClose: () => void;
  /** Restores the workspace to the checkpoint this diff is showing. Omit to hide the control entirely. */
  onRevert?: () => void;
  reverting?: boolean;
  /** Every captured turn, for the comparison pickers. Omit (with range/onChangeRange) to hide them. */
  availableTurns?: number[];
  range?: DiffRange;
  onChangeRange?: (range: DiffRange) => void;
}

/** Turn 0 is the pre-first-turn baseline, not a turn the user ever ran. */
function turnLabel(turn: number): string {
  return turn === 0 ? "Start" : `Turn ${turn}`;
}

function diffLineClass(line: string): string | undefined {
  if (line.startsWith("+") && !line.startsWith("+++")) return "text-green-400";
  if (line.startsWith("-") && !line.startsWith("---")) return "text-red-400";
  return undefined;
}

/** Raw unified-diff text with per-line +/- coloring — no diffing/highlighting dependency, matching the UI direction's "starting composition, not pixel-accurate" allowance. */
export function DiffView({
  diff,
  loading,
  error,
  onClose,
  onRevert,
  reverting = false,
  availableTurns,
  range,
  onChangeRange,
}: DiffViewProps) {
  if (diff === null && !loading && !error) return null;

  // The strip's own taps cover the two common comparisons (this turn, and
  // since the start). These pickers are what make the story's "any two
  // checkpoints" reachable — comparing turn 2 with turn 7 otherwise means
  // reading five separate diffs and combining them by hand.
  const showRangePickers = availableTurns !== undefined && availableTurns.length > 0 && range !== undefined && onChangeRange !== undefined;

  return (
    <div className="border-b border-neutral-800 bg-neutral-950 px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-neutral-500">Diff</span>
        <div className="flex items-center gap-3">
          {onRevert && (
            <button
              type="button"
              onClick={onRevert}
              disabled={reverting}
              className="text-xs text-amber-400 hover:text-amber-300 disabled:pointer-events-none disabled:opacity-50"
            >
              {reverting ? "Reverting…" : "Revert to this checkpoint"}
            </button>
          )}
          <button type="button" aria-label="Close diff" onClick={onClose} className="text-xs text-neutral-500 hover:text-neutral-300">
            Close
          </button>
        </div>
      </div>

      {showRangePickers && (
        <div className="mb-1.5 flex items-center gap-2 text-xs text-neutral-500">
          <label htmlFor="diff-from">Compare from</label>
          <select
            id="diff-from"
            value={range.from}
            onChange={(event) => onChangeRange({ from: Number(event.target.value), to: range.to })}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300"
          >
            {availableTurns.map((turn) => (
              <option key={turn} value={turn}>
                {turnLabel(turn)}
              </option>
            ))}
          </select>
          <label htmlFor="diff-to">to</label>
          <select
            id="diff-to"
            aria-label="Compare to"
            value={range.to}
            onChange={(event) => onChangeRange({ from: range.from, to: Number(event.target.value) })}
            className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300"
          >
            {availableTurns.map((turn) => (
              <option key={turn} value={turn}>
                {turnLabel(turn)}
              </option>
            ))}
          </select>
        </div>
      )}

      {loading && <p className="text-sm text-neutral-500">Loading diff…</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}
      {!loading && !error && diff !== null && diff.length === 0 && <p className="text-sm text-neutral-500">No changes.</p>}
      {!loading && !error && diff !== null && diff.length > 0 && (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap font-mono text-xs">
          {diff.split("\n").map((line, i) => (
            <div key={i} className={cn(diffLineClass(line))}>
              {line}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
