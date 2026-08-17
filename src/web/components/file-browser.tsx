import { Fragment, useEffect, useState } from "react";
import { cn } from "../lib/utils.js";
import type { FilePreview as FilePreviewData, WorkingTreeListing } from "../../shared/ws-protocol.js";
import { FilePreview } from "./file-preview.js";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "./ui/breadcrumb.js";
import { Button } from "./ui/button.js";
import { Empty, EmptyDescription, EmptyTitle } from "./ui/empty.js";
import { Item, ItemContent, ItemTitle } from "./ui/item.js";
import { Spinner } from "./ui/spinner.js";

export interface FileBrowserProps {
  /** Absent when no Thread is active — the surface is Thread-scoped, since the tree it shows is the Thread's own. */
  threadId: string | undefined;
  listDirectory: (path: string) => Promise<WorkingTreeListing>;
  readFile: (path: string) => Promise<FilePreviewData>;
}

/**
 * Splits a working-tree-relative path into the crumbs that lead back up it.
 * The root gets an explicit crumb of its own so there is always somewhere to
 * return to, even one level down.
 */
function crumbsFor(relativePath: string): { label: string; path: string }[] {
  const crumbs = [{ label: "root", path: "" }];
  if (relativePath === "") return crumbs;

  let accumulated = "";
  for (const segment of relativePath.split("/")) {
    accumulated = accumulated === "" ? segment : `${accumulated}/${segment}`;
    crumbs.push({ label: segment, path: accumulated });
  }
  return crumbs;
}

/**
 * Reads the Thread's own working tree — the Worktree when it has one, the
 * Project's workspace root otherwise. Which of those it is, is the server's
 * decision (every command here is Thread-scoped), so this component never
 * handles an absolute path and cannot be pointed outside the tree.
 */
export function FileBrowser({ threadId, listDirectory, readFile }: FileBrowserProps) {
  const [listing, setListing] = useState<WorkingTreeListing | null>(null);
  const [listingError, setListingError] = useState<string | undefined>(undefined);
  const [loadingListing, setLoadingListing] = useState(false);

  const [preview, setPreview] = useState<FilePreviewData | null>(null);
  const [previewError, setPreviewError] = useState<string | undefined>(undefined);
  const [loadingPreview, setLoadingPreview] = useState(false);

  useEffect(() => {
    if (threadId === undefined) {
      setListing(null);
      setPreview(null);
      return;
    }
    // Re-roots on every Thread switch, and drops the open file with it — a
    // preview from another Thread's tree would be actively misleading.
    setPreview(null);
    setPreviewError(undefined);
    void navigate("");
    // Keyed on threadId alone: navigation within a Thread is user-driven, not
    // a prop change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId]);

  /**
   * The load/settle/report triad both round trips share. A failed read has to
   * surface where it was triggered rather than leaving a stale pane sitting
   * there — spec #93 story 68 — so the failure path clears the result as well
   * as setting the message.
   */
  async function load<T>(
    fetch: () => Promise<T>,
    setResult: (value: T | null) => void,
    setError: (message: string | undefined) => void,
    setLoading: (loading: boolean) => void,
  ) {
    setLoading(true);
    setError(undefined);
    try {
      setResult(await fetch());
    } catch (error) {
      setResult(null);
      setError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoading(false);
    }
  }

  const navigate = (path: string) => load(() => listDirectory(path), setListing, setListingError, setLoadingListing);
  const open = (path: string) => load(() => readFile(path), setPreview, setPreviewError, setLoadingPreview);

  if (threadId === undefined) {
    return (
      <Empty className="h-full">
        <EmptyTitle>No thread selected</EmptyTitle>
        <EmptyDescription>Open a thread to browse the files it is working in.</EmptyDescription>
      </Empty>
    );
  }

  const crumbs = crumbsFor(listing?.path ?? "");

  // Master-detail on a phone: the tree gets the whole screen until a file is
  // opened, then the file does. Showing both at once in a 390px column gives
  // each about a third of a usable height and makes neither good — and "usable
  // from my phone" is the thing this app is for. Side by side from `md` up,
  // where there is room for both.
  const showingFile = preview !== null || loadingPreview || previewError !== undefined;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background text-foreground">
      <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2">
        {showingFile && (
          <Button
            variant="ghost"
            size="sm"
            className="md:hidden"
            onClick={() => {
              setPreview(null);
              setPreviewError(undefined);
            }}
          >
            ← Files
          </Button>
        )}
        <Breadcrumb className={cn("min-w-0", showingFile && "hidden md:block")}>
          <BreadcrumbList>
          {crumbs.map((crumb, i) => {
            const isCurrent = i === crumbs.length - 1;
            // Separator as a *sibling* of the item, not a child: both render
            // <li>, and BreadcrumbList is an <ol>, so nesting them is invalid
            // HTML (React says so out loud).
            return (
              <Fragment key={crumb.path}>
                <BreadcrumbItem>
                  {isCurrent ? (
                    <BreadcrumbPage>{crumb.label}</BreadcrumbPage>
                  ) : (
                    // A button, not an anchor: navigation here is a server
                    // round trip within the app, not a document link.
                    <BreadcrumbLink asChild>
                      <button type="button" onClick={() => void navigate(crumb.path)}>
                        {crumb.label}
                      </button>
                    </BreadcrumbLink>
                  )}
                </BreadcrumbItem>
                {!isCurrent && <BreadcrumbSeparator />}
              </Fragment>
            );
          })}
          </BreadcrumbList>
        </Breadcrumb>
      </div>

      <div className="flex min-h-0 flex-1 flex-col md:flex-row">
        {/* Plain overflow, not shadcn's `scroll-area` — see
            CONTENT_SECURITY_POLICY in server/http/static-server.ts. */}
        <div
          className={cn(
            "min-h-0 flex-1 overflow-y-auto border-border md:flex-none md:basis-1/3 md:max-w-xs md:border-e",
            showingFile && "hidden md:block",
          )}
        >
          <div className="flex flex-col gap-1 p-2">
            {loadingListing && (
              <div className="flex justify-center py-4">
                <Spinner />
              </div>
            )}
            {listingError && <p className="px-2 py-1 text-sm text-destructive">{listingError}</p>}

            {!loadingListing && !listingError && listing?.entries.length === 0 && (
              <p className="px-2 py-2 text-center text-sm text-muted-foreground">This folder is empty.</p>
            )}

            {!loadingListing &&
              !listingError &&
              listing?.entries.map((entry) => (
                <Item
                  key={entry.path}
                  asChild
                  variant="muted"
                  size="xs"
                  className="cursor-pointer hover:bg-muted"
                >
                  <button
                    type="button"
                    onClick={() => (entry.kind === "directory" ? void navigate(entry.path) : void open(entry.path))}
                  >
                    <ItemContent>
                      <ItemTitle className="font-mono">
                        {/* A trailing slash rather than an icon: it survives
                            a narrow column and needs no legend. */}
                        {entry.name}
                        {entry.kind === "directory" ? "/" : ""}
                      </ItemTitle>
                    </ItemContent>
                  </button>
                </Item>
              ))}
          </div>
        </div>

        <div className={cn("flex min-h-0 flex-1 flex-col", !showingFile && "hidden md:flex")}>
          <FilePreview preview={preview} loading={loadingPreview} error={previewError} />
        </div>
      </div>
    </div>
  );
}
