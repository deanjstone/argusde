import { cn } from "../lib/utils.js";

export interface DiffViewProps {
  diff: string | null;
  loading: boolean;
  error: string | undefined;
  onClose: () => void;
}

function diffLineClass(line: string): string | undefined {
  if (line.startsWith("+") && !line.startsWith("+++")) return "text-green-400";
  if (line.startsWith("-") && !line.startsWith("---")) return "text-red-400";
  return undefined;
}

/** Raw unified-diff text with per-line +/- coloring — no diffing/highlighting dependency, matching the UI direction's "starting composition, not pixel-accurate" allowance. */
export function DiffView({ diff, loading, error, onClose }: DiffViewProps) {
  if (diff === null && !loading && !error) return null;

  return (
    <div className="border-b border-neutral-800 bg-neutral-950 px-3 py-2">
      <div className="mb-1.5 flex items-center justify-between">
        <span className="text-xs uppercase tracking-wide text-neutral-500">Diff</span>
        <button type="button" aria-label="Close diff" onClick={onClose} className="text-xs text-neutral-500 hover:text-neutral-300">
          Close
        </button>
      </div>

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
