import { cn } from "../lib/utils.js";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "./ui/alert-dialog.js";

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
  /**
   * Set when reverting would be refused right now, with the reason. Passed in
   * rather than derived here: the diff view knows nothing about turns, and the
   * condition belongs to whoever does.
   */
  revertBlockedReason?: string;
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
  // The same theme tokens the working-tree diff uses (spec #93 phase 6), so
  // the two diff surfaces answer different questions in one visual language
  // rather than looking like unrelated features.
  if (line.startsWith("+") && !line.startsWith("+++")) return "text-diff-added";
  if (line.startsWith("-") && !line.startsWith("---")) return "text-diff-removed";
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
  revertBlockedReason,
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
    <div className="border-b border-border bg-background px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">Diff</span>
        <div className="flex items-center gap-3">
          {onRevert && (
            // Reverting force-overwrites the working tree from a checkpoint —
            // the most destructive thing this UI can do, and until now it
            // happened on a single click. #93's component table assigns it an
            // alert-dialog; phase 6 deferred that pending argusde#113, which
            // is now resolved, so it lands here.
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <button
                  type="button"
                  disabled={reverting || revertBlockedReason !== undefined}
                  title={revertBlockedReason}
                  className="text-xs text-warning hover:opacity-80 disabled:pointer-events-none disabled:opacity-50"
                >
                  {reverting ? "Reverting…" : "Revert to this checkpoint"}
                </button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Revert to this checkpoint?</AlertDialogTitle>
                  <AlertDialogDescription>
                    The working tree is restored to how it was at this checkpoint. Anything changed since is overwritten
                    on disk. The Thread's history is kept — the revert is captured as a new checkpoint rather than
                    erasing the turns after it.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={onRevert}>Revert</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          <button type="button" aria-label="Close diff" onClick={onClose} className="text-xs text-muted-foreground hover:text-foreground">
            Close
          </button>
        </div>
      </div>

      {showRangePickers && (
        <div className="mb-1.5 flex items-center gap-2 text-xs text-muted-foreground">
          <label htmlFor="diff-from">Compare from</label>
          <select
            id="diff-from"
            value={range.from}
            onChange={(event) => onChangeRange({ from: Number(event.target.value), to: range.to })}
            className="rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground"
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
            className="rounded-md border border-border bg-card px-2 py-1 text-xs text-foreground"
          >
            {availableTurns.map((turn) => (
              <option key={turn} value={turn}>
                {turnLabel(turn)}
              </option>
            ))}
          </select>
        </div>
      )}

      {loading && <p className="text-sm text-muted-foreground">Loading diff…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
      {!loading && !error && diff !== null && diff.length === 0 && <p className="text-sm text-muted-foreground">No changes.</p>}
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
