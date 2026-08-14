import { useState } from "react";
import type { ThreadRecord } from "../../shared/ws-protocol.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";

export interface ThreadListProps {
  threads: ThreadRecord[];
  onSelectThread: (threadId: string) => void;
  onCreateThread: (title: string) => void;
  onBack: () => void;
  creating?: boolean;
}

/** Second screen of the Threads tab's Projects→Threads drill-down (spec #33 decision #10). */
export function ThreadList({ threads, onSelectThread, onCreateThread, onBack, creating = false }: ThreadListProps) {
  const [showForm, setShowForm] = useState(false);
  const [title, setTitle] = useState("");

  function handleCreate() {
    const trimmed = title.trim();
    if (!trimmed) return;
    onCreateThread(trimmed);
    setTitle("");
  }

  return (
    <div className="flex h-full flex-col bg-neutral-950 p-4 text-neutral-100">
      <div className="mb-2 flex items-center gap-2">
        <button type="button" onClick={onBack} className="text-xs text-neutral-500 hover:text-neutral-300">
          ← Back
        </button>
        <h2 className="text-xs uppercase tracking-wide text-neutral-500">Threads</h2>
      </div>

      {threads.length === 0 && !showForm && <p className="text-sm text-neutral-500">No threads yet.</p>}

      <div className="flex-1 space-y-1.5 overflow-y-auto">
        {threads.map((thread) => (
          <button
            key={thread.id}
            type="button"
            onClick={() => onSelectThread(thread.id)}
            className="flex w-full items-center justify-between rounded-lg bg-neutral-900 px-3 py-2.5 text-left text-sm hover:bg-neutral-800"
          >
            <span>{thread.title}</span>
            {thread.worktreePath !== null && (
              <span className="flex items-center gap-1 text-xs text-amber-400">
                <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                worktree
              </span>
            )}
          </button>
        ))}
      </div>

      {showForm ? (
        <div className="mt-3 space-y-2 border-t border-neutral-800 pt-3">
          <Input placeholder="Thread title" value={title} onChange={(event) => setTitle(event.target.value)} disabled={creating} />
          <Button size="sm" onClick={handleCreate} disabled={creating} className="w-full">
            {creating ? "Creating…" : "Create"}
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setShowForm(true)} className="mt-3">
          + New thread
        </Button>
      )}
    </div>
  );
}
