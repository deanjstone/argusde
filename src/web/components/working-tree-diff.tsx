import type { FileDiff, DiffLine } from "../../shared/ws-protocol.js";
import { Badge } from "./ui/badge.js";
import { Empty, EmptyDescription, EmptyTitle } from "./ui/empty.js";
import { Spinner } from "./ui/spinner.js";

export interface WorkingTreeDiffProps {
  diff: FileDiff | null;
  loading: boolean;
  error: string | undefined;
}

/**
 * Static classes per line kind, written out rather than built as
 * `bg-diff-${kind}` — Tailwind only generates classes it can see in the
 * source, so an interpolated name compiles to nothing.
 *
 * Colour comes from theme tokens for the same reason syntax tokens do: the
 * server sends a *kind*, and a per-line colour would need an inline style
 * attribute, which this app's CSP blocks. See contentSecurityPolicy in
 * server/http/static-server.ts.
 */
const DIFF_CLASS: Record<DiffLine["kind"], string> = {
  added: "bg-diff-added-bg text-diff-added",
  removed: "bg-diff-removed-bg text-diff-removed",
  hunk: "text-diff-hunk",
  meta: "text-muted-foreground",
  context: "",
};

/**
 * One file's diff against the **live working tree** — deliberately a separate
 * surface from Checkpoint diffing, which answers "what changed between Turn 4
 * and Turn 7". Spec #93 is emphatic that the two must never be confused, so
 * this component shares no code with `diff-view.tsx` beyond the theme.
 */
export function WorkingTreeDiff({ diff, loading, error }: WorkingTreeDiffProps) {
  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-6" data-testid="wt-diff-loading">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <Empty className="flex-1">
        <EmptyTitle>Couldn&apos;t read that diff</EmptyTitle>
        <EmptyDescription className="text-destructive">{error}</EmptyDescription>
      </Empty>
    );
  }

  if (!diff) {
    return (
      <Empty className="flex-1">
        <EmptyTitle>No file selected</EmptyTitle>
        <EmptyDescription>Pick a changed file to see what the agent did to it.</EmptyDescription>
      </Empty>
    );
  }

  if (diff.kind === "binary") {
    return (
      <Empty className="flex-1" data-testid="wt-diff-binary">
        <EmptyTitle>Binary file</EmptyTitle>
        <EmptyDescription>{diff.path} changed, but there is nothing readable to show.</EmptyDescription>
      </Empty>
    );
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <p className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{diff.path}</p>
        {/* Says which question this answers, since the app has two diff
            surfaces and confusing them would be the expensive mistake. */}
        <Badge variant="outline">working tree</Badge>
      </div>

      {/* Plain overflow, not shadcn's `scroll-area`, which styles through an
          inline style attribute that no CSP nonce can cover — see the
          style-src commentary in server/http/static-server.ts. */}
      <div className="min-h-0 flex-1 overflow-auto">
        <pre className="w-max min-w-full py-2 font-mono text-xs leading-relaxed">
          <code data-testid="wt-diff-lines">
            {diff.lines.map((line, i) => (
              <span key={i} className={`block px-3 ${DIFF_CLASS[line.kind]}`}>
                {line.text === "" ? " " : line.text}
              </span>
            ))}
          </code>
        </pre>
      </div>
    </div>
  );
}
