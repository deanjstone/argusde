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
    <div className="flex h-full flex-col bg-background p-4 text-foreground">
      <div className="mb-2 flex items-center gap-2">
        <button type="button" onClick={onBack} className="text-xs text-muted-foreground hover:text-foreground">
          ← Back
        </button>
        <h2 className="text-xs uppercase tracking-wide text-muted-foreground">Threads</h2>
      </div>

      {threads.length === 0 && !showForm && <p className="text-sm text-muted-foreground">No threads yet.</p>}

      <div className="flex-1 space-y-1.5 overflow-y-auto">
        {threads.map((thread) => (
          <button
            key={thread.id}
            type="button"
            onClick={() => onSelectThread(thread.id)}
            className="flex w-full items-center justify-between rounded-lg bg-card px-3 py-2.5 text-left text-sm hover:bg-muted"
          >
            <span>{thread.title}</span>
            <span className="flex items-center gap-2">
              {thread.worktreePath !== null && (
                <span className="flex items-center gap-1 text-xs text-warning">
                  <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-warning" />
                  worktree
                </span>
              )}
              {thread.closedAt !== null && <span className="text-xs text-muted-foreground">closed</span>}
            </span>
          </button>
        ))}
      </div>

      {showForm ? (
        <div className="mt-3 space-y-2 border-t border-border pt-3">
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
