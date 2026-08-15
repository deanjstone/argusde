import { useState } from "react";
import type { DirectoryListing } from "../../shared/ws-protocol.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { DirectoryBrowser } from "./directory-browser.js";

export interface WorkspaceSetupProps {
  onSubmit: (workspaceRoot: string) => void;
  listDirectory: (path?: string) => Promise<DirectoryListing>;
  submitting?: boolean;
  error?: string;
}

/**
 * First-run flow: there's no project-picker UI yet (multi-project UI is a
 * later phase per spec #33), so this is the minimum viable "how do I even
 * start chatting" — pick a folder (browsing the *server's* filesystem, see
 * DirectoryBrowser) or fall back to typing a path by hand.
 */
export function WorkspaceSetup({ onSubmit, listDirectory, submitting = false, error }: WorkspaceSetupProps) {
  const [manualMode, setManualMode] = useState(false);
  const [path, setPath] = useState("");

  function handleManualSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = path.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 bg-neutral-950 px-6 text-neutral-100">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-lg font-semibold">ArgusDE</h1>
        <p className="mb-4 text-sm text-neutral-400">Choose a workspace folder to start chatting.</p>

        {manualMode ? (
          <form onSubmit={handleManualSubmit}>
            <label htmlFor="workspace-path" className="mb-1 block text-xs text-neutral-500">
              Workspace path
            </label>
            <Input
              id="workspace-path"
              placeholder="/home/you/repos/project"
              value={path}
              onChange={(event) => setPath(event.target.value)}
              disabled={submitting}
            />
            <Button type="submit" disabled={submitting} className="mt-3 w-full">
              {submitting ? "Starting…" : "Start"}
            </Button>
            <button
              type="button"
              onClick={() => setManualMode(false)}
              className="mt-3 text-xs text-neutral-500 underline hover:text-neutral-300"
            >
              or browse folders
            </button>
          </form>
        ) : (
          <>
            <DirectoryBrowser listDirectory={listDirectory} onSelect={onSubmit} />
            <button
              type="button"
              onClick={() => setManualMode(true)}
              className="mt-3 text-xs text-neutral-500 underline hover:text-neutral-300"
            >
              or type a path manually
            </button>
          </>
        )}

        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}
        {submitting && !manualMode && <p className="mt-2 text-sm text-neutral-500">Starting…</p>}
      </div>
    </div>
  );
}
