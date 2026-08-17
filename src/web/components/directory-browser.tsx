import { useEffect, useState } from "react";
import type { DirectoryListing } from "../../shared/ws-protocol.js";
import { Button } from "./ui/button.js";
import { Item, ItemContent, ItemTitle } from "./ui/item.js";

export interface DirectoryBrowserProps {
  /** Lists a directory's subdirectories — omit path to list the server's default (home) directory. */
  listDirectory: (path?: string) => Promise<DirectoryListing>;
  onSelect: (path: string) => void;
}

/**
 * Navigable folder picker for choosing a project's workspace root. The
 * path being picked has to exist on the machine running the *server*, not
 * whatever device is doing the picking (true for Electron, and
 * unavoidably true for the PWA reached over Tailscale from a phone) — so
 * this browses via `listDirectory` (a server round trip) rather than any
 * client-device file API. Directories only, not a general file browser.
 */
export function DirectoryBrowser({ listDirectory, onSelect }: DirectoryBrowserProps) {
  const [listing, setListing] = useState<DirectoryListing | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | undefined>(undefined);

  function navigate(path: string | undefined) {
    setLoading(true);
    setError(undefined);
    listDirectory(path)
      .then((result) => setListing(result))
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }

  useEffect(() => {
    navigate(undefined);
    // Only ever runs once, on mount — subsequent navigation is user-driven
    // (clicking an entry or Up), not a prop change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-2">
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={!listing?.parentPath}
          onClick={() => listing?.parentPath && navigate(listing.parentPath)}
        >
          Up
        </Button>
        <p className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{listing?.path ?? ""}</p>
      </div>

      {loading && <p className="py-4 text-center text-sm text-muted-foreground">Loading…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {!loading && !error && listing && (
        <div className="max-h-48 overflow-y-auto">
          <div className="flex flex-col gap-1">
            {listing.entries.length === 0 && <p className="py-2 text-center text-sm text-muted-foreground">No subfolders here.</p>}
            {listing.entries.map((entry) => (
              <Item key={entry.path} asChild variant="muted" size="xs" className="cursor-pointer hover:bg-muted">
                <button type="button" onClick={() => navigate(entry.path)}>
                  <ItemContent>
                    <ItemTitle>{entry.name}</ItemTitle>
                  </ItemContent>
                </button>
              </Item>
            ))}
          </div>
        </div>
      )}

      <Button type="button" size="sm" disabled={!listing} onClick={() => listing && onSelect(listing.path)}>
        Select this folder
      </Button>
    </div>
  );
}
