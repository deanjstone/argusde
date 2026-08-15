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
}

/** First screen of the Threads tab's Projects→Threads drill-down (spec #33 decision #10). */
export function ProjectPicker({ projects, onSelectProject, onCreateProject, listDirectory, creating = false, error }: ProjectPickerProps) {
  const [showForm, setShowForm] = useState(false);
  const [manualMode, setManualMode] = useState(false);
  const [workspaceRoot, setWorkspaceRoot] = useState("");

  function handleCreate() {
    const trimmed = workspaceRoot.trim();
    if (!trimmed) return;
    onCreateProject(trimmed);
    setWorkspaceRoot("");
  }

  return (
    <div className="flex h-full flex-col bg-neutral-950 p-4 text-neutral-100">
      <h2 className="mb-2 text-xs uppercase tracking-wide text-neutral-500">Projects</h2>

      {projects.length === 0 && !showForm && <p className="text-sm text-neutral-500">No projects yet.</p>}

      <div className="flex-1 space-y-1.5 overflow-y-auto">
        {projects.map((project) => (
          <button
            key={project.id}
            type="button"
            onClick={() => onSelectProject(project.id)}
            className="block w-full rounded-lg bg-neutral-900 px-3 py-2.5 text-left text-sm hover:bg-neutral-800"
          >
            {project.title}
          </button>
        ))}
      </div>

      {showForm ? (
        <div className="mt-3 space-y-2 border-t border-neutral-800 pt-3">
          {error && <p className="text-sm text-red-400">{error}</p>}
          {manualMode ? (
            <>
              <Input
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
