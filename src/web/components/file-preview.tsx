import { useEffect, useRef } from "react";
import { cn } from "../lib/utils.js";
import type { FilePreview as FilePreviewData, SyntaxKind } from "../../shared/ws-protocol.js";
import { Badge } from "./ui/badge.js";
import { Empty, EmptyDescription, EmptyTitle } from "./ui/empty.js";
import { Spinner } from "./ui/spinner.js";

export interface FilePreviewProps {
  preview: FilePreviewData | null;
  loading: boolean;
  error: string | undefined;
  /**
   * 1-based line to mark and scroll to — set when the file was opened from a
   * search result (story 19: a result has to lead somewhere).
   *
   * A prop rather than state on purpose: the preview stays a rendering
   * component with no notion of where the request came from.
   */
  highlightLine?: number;
}

/**
 * Static classes per token kind, written out in full rather than built as
 * `text-syntax-${kind}` — Tailwind only generates classes it can see in the
 * source, so an interpolated name compiles to nothing at all.
 */
const SYNTAX_CLASS: Record<SyntaxKind, string> = {
  plain: "",
  comment: "text-syntax-comment italic",
  string: "text-syntax-string",
  number: "text-syntax-number",
  constant: "text-syntax-constant",
  keyword: "text-syntax-keyword",
  function: "text-syntax-function",
  type: "text-syntax-type",
  variable: "text-syntax-variable",
  punctuation: "text-syntax-punctuation",
};

/** Human-readable size, so "too large" and "binary" can say *how* large without the reader doing arithmetic. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * One file, rendered from the tokens the *server* produced — see
 * server/workspace/highlight.ts for why highlighting lives there rather than
 * in this bundle.
 *
 * Tokens arrive carrying a *kind*, not a colour, and this maps kinds onto
 * theme tokens. Not a stylistic preference — see CONTENT_SECURITY_POLICY in
 * server/http/static-server.ts.
 */
export function FilePreview({ preview, loading, error, highlightLine }: FilePreviewProps) {
  const highlighted = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    // Centred rather than merely scrolled into view: a match pinned to the top
    // or bottom edge shows no surrounding code, which is the whole reason for
    // opening it from a search result.
    //
    // Called optionally because scrolling is a nicety and its absence must not
    // throw — jsdom has no scrollIntoView at all, and an unhandled TypeError
    // from a convenience would be a poor trade.
    highlighted.current?.scrollIntoView?.({ block: "center" });
  }, [highlightLine, preview?.path]);

  if (loading) {
    return (
      <div className="flex flex-1 items-center justify-center p-6">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <Empty className="flex-1">
        <EmptyTitle>Couldn&apos;t open that file</EmptyTitle>
        <EmptyDescription className="text-destructive">{error}</EmptyDescription>
      </Empty>
    );
  }

  if (!preview) {
    return (
      <Empty className="flex-1">
        <EmptyTitle>No file open</EmptyTitle>
        <EmptyDescription>Pick a file from the tree to read it.</EmptyDescription>
      </Empty>
    );
  }

  if (preview.kind === "binary") {
    return (
      <Empty className="flex-1" data-testid="preview-binary">
        <EmptyTitle>Binary file</EmptyTitle>
        {/* Named rather than rendered — story 14: identified as binary, not
            shown as noise, so nobody has to guess why it looks broken. */}
        <EmptyDescription>
          {preview.path} · {formatBytes(preview.byteLength)}
        </EmptyDescription>
      </Empty>
    );
  }

  if (preview.kind === "too-large") {
    return (
      <Empty className="flex-1" data-testid="preview-too-large">
        <EmptyTitle>Too large to preview</EmptyTitle>
        <EmptyDescription>
          {preview.path} · {formatBytes(preview.byteLength)}
        </EmptyDescription>
      </Empty>
    );
  }

  const lineCount = preview.lines?.length ?? preview.plainLines?.length ?? 0;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <p className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">{preview.path}</p>
        {preview.language && <Badge variant="outline">{preview.language}</Badge>}
        {/* A file can be text and still arrive uncoloured — too big to
            tokenise, or a language the server couldn't resolve. Saying so
            beats letting it look like a highlighting bug. */}
        {preview.lines === null && (
          <Badge variant="outline" data-testid="preview-unhighlighted">
            not highlighted
          </Badge>
        )}
      </div>

      {/* Plain overflow, not shadcn's `scroll-area` — see
          CONTENT_SECURITY_POLICY in server/http/static-server.ts. */}
      <div className="min-h-0 flex-1 overflow-auto">
        <pre className="w-max min-w-full py-2 font-mono text-xs leading-relaxed">
          <code data-testid="preview-code">
            {Array.from({ length: lineCount }, (_, i) => {
              const isMatch = highlightLine === i + 1;
              return (
              <span
                key={i}
                ref={isMatch ? highlighted : undefined}
                data-testid={isMatch ? "preview-highlighted-line" : undefined}
                className={cn("flex", isMatch && "bg-primary/15")}
              >
                {/* Fixed-width gutter with tabular digits, so the code column
                    doesn't shift as the line count crosses a power of ten. */}
                <span aria-hidden className="sticky left-0 shrink-0 select-none bg-background px-3 text-right tabular-nums text-muted-foreground">
                  {i + 1}
                </span>
                <span className="pr-3">
                  {preview.lines
                    ? preview.lines[i]?.map((token, t) => (
                        <span key={t} className={SYNTAX_CLASS[token.kind]}>
                          {token.content}
                        </span>
                      ))
                    : preview.plainLines?.[i]}
                </span>
              </span>
              );
            })}
          </code>
        </pre>
      </div>
    </div>
  );
}
