import type { SearchResults } from "../../shared/ws-protocol.js";
import { Badge } from "./ui/badge.js";
import { Empty, EmptyDescription, EmptyTitle } from "./ui/empty.js";
import { Item, ItemContent, ItemTitle } from "./ui/item.js";
import { Spinner } from "./ui/spinner.js";

export interface WorkspaceSearchProps {
  results: SearchResults | null;
  loading: boolean;
  error: string | undefined;
  /** Opens a file at a line — story 19: a result has to lead somewhere. */
  onOpenMatch: (path: string, line: number) => void;
}

/**
 * Search results, grouped by file (story 18).
 *
 * Every cap the server applied is named rather than implied: a silently
 * truncated result set reads as a complete one, which is worse than a slow
 * search. The server reports each cap separately for that reason, and this
 * says which one bit.
 */
export function WorkspaceSearch({ results, loading, error, onOpenMatch }: WorkspaceSearchProps) {
  if (loading) {
    return (
      <div className="flex justify-center py-6" data-testid="search-loading">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <Empty>
        <EmptyTitle>Search failed</EmptyTitle>
        <EmptyDescription className="text-destructive">{error}</EmptyDescription>
      </Empty>
    );
  }

  if (!results) return null;

  if (results.files.length === 0) {
    return (
      <Empty data-testid="search-no-matches">
        {/* Story 21: "no matches" has to be distinguishable from "still
            searching" — which is why this is a separate branch from the
            spinner above rather than an empty list. */}
        <EmptyTitle>No matches</EmptyTitle>
        <EmptyDescription>Nothing in this working tree contains “{results.query}”.</EmptyDescription>
      </Empty>
    );
  }

  return (
    <div className="flex flex-col gap-2 p-2" data-testid="search-results">
      <div className="flex flex-wrap items-center gap-2 px-1">
        <p className="text-xs text-muted-foreground">
          {results.totalMatches} {results.totalMatches === 1 ? "match" : "matches"} in {results.files.length}{" "}
          {results.files.length === 1 ? "file" : "files"}
        </p>
        {results.truncated.timedOut && (
          <Badge variant="outline" data-testid="search-timed-out">
            stopped early
          </Badge>
        )}
        {results.truncated.files && (
          <Badge variant="outline" data-testid="search-files-capped">
            more files matched
          </Badge>
        )}
        {results.truncated.matches && (
          <Badge variant="outline" data-testid="search-matches-capped">
            some files have more
          </Badge>
        )}
      </div>

      {results.files.map((file) => (
        <div key={file.path} className="flex flex-col gap-1">
          <p className="truncate px-1 font-mono text-xs text-muted-foreground" title={file.path}>
            {file.path}
          </p>
          {file.matches.map((match) => (
            <Item
              key={`${file.path}:${match.line}`}
              asChild
              variant="muted"
              size="xs"
              className="cursor-pointer hover:bg-muted"
            >
              <button type="button" onClick={() => onOpenMatch(file.path, match.line)}>
                <ItemContent className="min-w-0 flex-row items-baseline gap-2">
                  {/* The line number is the thing you scan, so it leads and
                      keeps a fixed width — tabular digits stop the match text
                      shifting between rows. */}
                  <span aria-hidden className="shrink-0 tabular-nums text-muted-foreground">
                    {match.line}
                  </span>
                  <ItemTitle className="min-w-0 truncate font-mono font-normal">{match.text.trim()}</ItemTitle>
                </ItemContent>
              </button>
            </Item>
          ))}
          {file.matchesTruncated && (
            <p className="px-1 text-xs text-muted-foreground">…more matches in this file than shown</p>
          )}
        </div>
      ))}
    </div>
  );
}
