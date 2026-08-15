import { useEffect, useState } from "react";
import type { DirectoryListing } from "../../shared/ws-protocol.js";
import { Button } from "./ui/button.js";

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
    <div className="flex flex-col gap-2 rounded-lg border border-neutral-800 bg-neutral-900 p-2">
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
        <p className="min-w-0 flex-1 truncate text-xs text-neutral-400">{listing?.path ?? ""}</p>
      </div>

      {loading && <p className="py-4 text-center text-sm text-neutral-500">Loading…</p>}
      {error && <p className="text-sm text-red-400">{error}</p>}

      {!loading && !error && listing && (
        <div className="max-h-48 space-y-1 overflow-y-auto">
          {listing.entries.length === 0 && <p className="py-2 text-center text-sm text-neutral-500">No subfolders here.</p>}
          {listing.entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              onClick={() => navigate(entry.path)}
              className="block w-full rounded-lg bg-neutral-800 px-3 py-2 text-left text-sm hover:bg-neutral-700"
            >
              {entry.name}
            </button>
          ))}
        </div>
      )}

      <Button type="button" size="sm" disabled={!listing} onClick={() => listing && onSelect(listing.path)}>
        Select this folder
      </Button>
    </div>
  );
}
