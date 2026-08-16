import { useState } from "react";
import type { DirectoryListing, ProjectRecord } from "../../shared/ws-protocol.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";
import { DirectoryBrowser } from "./directory-browser.js";

export interface ProjectPickerProps {
  projects: ProjectRecord[];
  onSelectProject: (projectId: string) => void;
  onCreateProject: (workspaceRoot: string) => void;
  listDirectory: (path?: string) => Promise<DirectoryListing>;
  creating?: boolean;
  /**
   * Surfaced from a failed project/thread creation — e.g. picking a folder
   * that isn't a git repository. Without this, the failure was only ever
   * visible inside ChatView's connectionError, which this screen never
   * reaches (creation failing means there's no active Thread to show a
   * Chat tab for) — a silent failure that looked exactly like "nothing
   * happened" when tapping Select this folder / Create.
   */
  error?: string;
  /**
   * Removes a Project and its Threads from ArgusDE. Omit to hide the remove
   * controls entirely. The workspace folder itself is never deleted — see
   * the confirmation copy below, which has to say so out loud.
   */
  onDeleteProject?: (projectId: string) => void;
  /** Id of the project currently being deleted, if any. */
  deletingProjectId?: string;
}

/** First screen of the Threads tab's Projects→Threads drill-down (spec #33 decision #10). */
export function ProjectPicker({
  projects,
  onSelectProject,
  onCreateProject,
  listDirectory,
  creating = false,
  error,
  onDeleteProject,
  deletingProjectId,
}: ProjectPickerProps) {
  const [showForm, setShowForm] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [workspaceRoot, setWorkspaceRoot] = useState("");
  // Which project's confirmation is currently open. Deleting is destructive
  // from the user's point of view (the row is labelled with a real
  // filesystem path), so it never happens on a single click.
  const [pendingDeleteId, setPendingDeleteId] = useState<string | undefined>(undefined);

  function handleCreate() {
    const trimmed = workspaceRoot.trim();
    if (!trimmed) return;
    onCreateProject(trimmed);
    setWorkspaceRoot("");
  }

  function handleConfirmDelete(projectId: string) {
    setPendingDeleteId(undefined);
    onDeleteProject?.(projectId);
  }

  return (
    <div className="flex h-full flex-col bg-neutral-950 p-4 text-neutral-100">
      <h2 className="mb-2 text-xs uppercase tracking-wide text-neutral-500">Projects</h2>

      {projects.length === 0 && !showForm && <p className="text-sm text-neutral-500">No projects yet.</p>}

      <div className="flex-1 space-y-1.5 overflow-y-auto">
        {projects.map((project) => (
          <div key={project.id} className="rounded-lg bg-neutral-900">
            <div className="flex items-center">
              <button
                type="button"
                onClick={() => onSelectProject(project.id)}
                className="min-w-0 flex-1 rounded-lg px-3 py-2.5 text-left text-sm hover:bg-neutral-800"
              >
                <span className="block truncate">{project.title}</span>
              </button>
              {onDeleteProject && (
                <button
                  type="button"
                  // Named per project: the visible label is a filesystem
                  // path, so a bare "Remove" would leave a screen reader
                  // user unable to tell which row they're deleting.
                  aria-label={`Remove ${project.title}`}
                  onClick={() => setPendingDeleteId(project.id)}
                  disabled={deletingProjectId === project.id}
                  className="mr-1 shrink-0 rounded-lg px-2.5 py-2 text-sm text-neutral-500 hover:bg-neutral-800 hover:text-red-400 disabled:opacity-50"
                >
                  {deletingProjectId === project.id ? "…" : "✕"}
                </button>
              )}
            </div>

            {pendingDeleteId === project.id && (
              <div className="border-t border-neutral-800 px-3 py-2.5">
                <p className="text-sm text-neutral-300">Remove this project from ArgusDE?</p>
                <p className="mt-1 text-xs text-neutral-500">
                  Its threads and their history go too. The folder on disk is not deleted.
                </p>
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => handleConfirmDelete(project.id)}
                    className="bg-red-600 hover:bg-red-700"
                  >
                    Remove
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => setPendingDeleteId(undefined)}>
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </div>
        ))}
      </div>

      {showForm ? (
        <div className="mt-3 space-y-2 border-t border-neutral-800 pt-3">
          {error && <p className="text-sm text-red-400">{error}</p>}
          {manualMode ? (
            <>
              <label htmlFor="new-project-path" className="block text-xs text-neutral-500">
                Workspace path
              </label>
              <Input
                id="new-project-path"
                placeholder="/home/you/repos/project"
                value={workspaceRoot}
                onChange={(event) => setWorkspaceRoot(event.target.value)}
                disabled={creating}
              />
              <Button size="sm" onClick={handleCreate} disabled={creating} className="w-full">
                {creating ? "Creating…" : "Create"}
              </Button>
              <button
                type="button"
                onClick={() => setManualMode(false)}
                className="text-xs text-neutral-500 underline hover:text-neutral-300"
              >
                or browse folders
              </button>
            </>
          ) : (
            <>
              <DirectoryBrowser listDirectory={listDirectory} onSelect={onCreateProject} />
              <button
                type="button"
                onClick={() => setManualMode(true)}
                className="text-xs text-neutral-500 underline hover:text-neutral-300"
              >
                or type a path manually
              </button>
            </>
          )}
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setShowForm(true)} className="mt-3">
          + New project
        </Button>
      )}
    </div>
  );
}
