import { useState } from "react";
import type { ProjectRecord } from "../../shared/ws-protocol.js";
import { Button } from "./ui/button.js";
import { Input } from "./ui/input.js";

export interface ProjectPickerProps {
  projects: ProjectRecord[];
  onSelectProject: (projectId: string) => void;
  onCreateProject: (workspaceRoot: string) => void;
  creating?: boolean;
}

/** First screen of the Threads tab's Projects→Threads drill-down (spec #33 decision #10). */
export function ProjectPicker({ projects, onSelectProject, onCreateProject, creating = false }: ProjectPickerProps) {
  const [showForm, setShowForm] = useState(false);
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
          <Input
            placeholder="/home/you/repos/project"
            value={workspaceRoot}
            onChange={(event) => setWorkspaceRoot(event.target.value)}
            disabled={creating}
          />
          <Button size="sm" onClick={handleCreate} disabled={creating} className="w-full">
            {creating ? "Creating…" : "Create"}
          </Button>
        </div>
      ) : (
        <Button variant="outline" size="sm" onClick={() => setShowForm(true)} className="mt-3">
          + New project
        </Button>
      )}
    </div>
  );
}
