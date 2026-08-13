import { useState } from "react";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";

export interface WorkspaceSetupProps {
  onSubmit: (workspaceRoot: string) => void;
  submitting?: boolean;
  error?: string;
}

/**
 * First-run flow: there's no project-picker UI yet (multi-project UI is a
 * later phase per spec #33), so this is the minimum viable "how do I even
 * start chatting" — one path, one button.
 */
export function WorkspaceSetup({ onSubmit, submitting = false, error }: WorkspaceSetupProps) {
  const [path, setPath] = useState("");

  function handleSubmit(event: React.FormEvent) {
    event.preventDefault();
    const trimmed = path.trim();
    if (!trimmed) return;
    onSubmit(trimmed);
  }

  return (
    <form onSubmit={handleSubmit} className="flex h-full flex-col items-center justify-center gap-4 bg-neutral-950 px-6 text-neutral-100">
      <div className="w-full max-w-sm">
        <h1 className="mb-1 text-lg font-semibold">ArgusDE</h1>
        <p className="mb-4 text-sm text-neutral-400">Enter a workspace path to start chatting.</p>

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

        {error && <p className="mt-2 text-sm text-red-400">{error}</p>}

        <Button type="submit" disabled={submitting} className="mt-4 w-full">
          {submitting ? "Starting…" : "Start"}
        </Button>
      </div>
    </form>
  );
}
