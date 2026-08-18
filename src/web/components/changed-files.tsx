import type { ChangedFile, WorkingTreeChanges } from "../../shared/ws-protocol.js";
import { Badge } from "./ui/badge.js";
import { Empty, EmptyDescription, EmptyTitle } from "./ui/empty.js";
import { Item, ItemContent, ItemTitle } from "./ui/item.js";
import { Spinner } from "./ui/spinner.js";

export interface ChangedFilesProps {
  changes: WorkingTreeChanges | null;
  loading: boolean;
  error: string | undefined;
  selectedPath: string | undefined;
  onSelect: (path: string) => void;
}

/**
 * Change kinds are shown as words, not colours alone — colour-only encoding
 * fails anyone who cannot distinguish them, and "A/M/D" letters need a legend
 * the surface has no room for at 390px.
 */
const KIND_LABEL: Record<ChangedFile["kind"], string> = {
  added: "added",
  modified: "modified",
  deleted: "deleted",
  renamed: "renamed",
  untracked: "new",
};

/** `deleted` is the one that wants to read as a loss; the rest are neutral. */
function kindVariant(kind: ChangedFile["kind"]) {
  return kind === "deleted" ? ("destructive" as const) : ("secondary" as const);
}

/**
 * What is changed in the Thread's working tree *right now* — a different
 * question from the Checkpoint strip, which answers "what changed between two
 * Turns". Spec #93 requires the two to stay visibly distinct, which is why
 * this names the branch and says "working tree" rather than borrowing the
 * Checkpoint vocabulary.
 */
export function ChangedFiles({ changes, loading, error, selectedPath, onSelect }: ChangedFilesProps) {
  if (loading) {
    return (
      <div className="flex justify-center py-6" data-testid="changes-loading">
        <Spinner />
      </div>
    );
  }

  if (error) {
    return (
      <Empty>
        <EmptyTitle>Couldn&apos;t read the working tree</EmptyTitle>
        <EmptyDescription className="text-destructive">{error}</EmptyDescription>
      </Empty>
    );
  }

  if (!changes) return null;

  return (
    <div className="flex flex-col gap-2 p-2" data-testid="changed-files">
      <div className="flex flex-wrap items-center gap-2 px-1">
        {/* Story 28. Read from git, never derived from the Thread id — a
            Worktree promoted before spec #93 phase 3 has no branch at all,
            and `rev-parse --abbrev-ref` returns the literal "HEAD" for one. */}
        {changes.detached ? (
          <Badge variant="outline" data-testid="branch-detached">
            detached HEAD
          </Badge>
        ) : (
          <Badge variant="outline" data-testid="branch-name">
            {changes.branch}
          </Badge>
        )}
        <p className="text-xs text-muted-foreground">
          {changes.files.length === 0
            ? "no uncommitted changes"
            : `${changes.files.length} changed ${changes.files.length === 1 ? "file" : "files"}`}
        </p>
      </div>

      {changes.files.length === 0 && (
        <Empty data-testid="changes-clean">
          <EmptyTitle>Nothing changed yet</EmptyTitle>
          <EmptyDescription>This working tree matches its last commit.</EmptyDescription>
        </Empty>
      )}

      {changes.files.map((file) => (
        <Item
          key={file.path}
          asChild
          variant={file.path === selectedPath ? "outline" : "muted"}
          size="xs"
          className="cursor-pointer hover:bg-muted"
        >
          <button type="button" onClick={() => onSelect(file.path)} aria-current={file.path === selectedPath || undefined}>
            <ItemContent className="min-w-0 gap-1">
              <ItemTitle className="min-w-0 truncate font-mono font-normal">{file.path}</ItemTitle>
              {/* A rename is the one kind whose old name is part of the story —
                  without it the file just appears and another disappears. */}
              {file.previousPath && (
                <span className="truncate font-mono text-xs text-muted-foreground">from {file.previousPath}</span>
              )}
            </ItemContent>
            <Badge variant={kindVariant(file.kind)}>{KIND_LABEL[file.kind]}</Badge>
          </button>
        </Item>
      ))}
    </div>
  );
}
