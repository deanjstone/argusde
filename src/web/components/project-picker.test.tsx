// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectPicker } from "./project-picker.js";

const PROJECTS = [
  { id: "p1", workspaceRoot: "/home/you/repos/one", title: "Project One", createdAt: "" },
  { id: "p2", workspaceRoot: "/home/you/repos/two", title: "Project Two", createdAt: "" },
];

const LISTING = {
  path: "/home/you",
  parentPath: "/home",
  entries: [{ name: "repos", path: "/home/you/repos" }],
};

function renderPicker(overrides: Partial<React.ComponentProps<typeof ProjectPicker>> = {}) {
  return render(
    <ProjectPicker
      projects={PROJECTS}
      onSelectProject={() => {}}
      onCreateProject={() => {}}
      listDirectory={vi.fn().mockResolvedValue(LISTING)}
      {...overrides}
    />,
  );
}

describe("ProjectPicker", () => {
  it("lists every project by title", () => {
    renderPicker();

    expect(screen.getByRole("button", { name: "Project One" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project Two" })).toBeInTheDocument();
  });

  it("shows an empty-state message when there are no projects yet", () => {
    renderPicker({ projects: [] });
    expect(screen.getByText(/no projects/i)).toBeInTheDocument();
  });

  it("calls onSelectProject with the clicked project's id", () => {
    const onSelectProject = vi.fn();
    renderPicker({ onSelectProject });

    fireEvent.click(screen.getByRole("button", { name: "Project Two" }));
    expect(onSelectProject).toHaveBeenCalledWith("p2");
  });

  it("browses folders by default and creates a project from the selected folder", async () => {
    const onCreateProject = vi.fn();
    renderPicker({ onCreateProject });

    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    await screen.findByRole("button", { name: "repos" });
    fireEvent.click(screen.getByRole("button", { name: /select this folder/i }));

    expect(onCreateProject).toHaveBeenCalledWith("/home/you");
  });

  it("falls back to a manual path entry and creates a project from the typed path", () => {
    const onCreateProject = vi.fn();
    renderPicker({ onCreateProject });

    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    fireEvent.click(screen.getByRole("button", { name: /type a path manually/i }));
    const input = screen.getByPlaceholderText(/workspace path|repos\/project/i);
    fireEvent.change(input, { target: { value: "/home/you/repos/three" } });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    expect(onCreateProject).toHaveBeenCalledWith("/home/you/repos/three");
  });

  it("does not submit an empty manual workspace path", () => {
    const onCreateProject = vi.fn();
    renderPicker({ onCreateProject });

    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    fireEvent.click(screen.getByRole("button", { name: /type a path manually/i }));
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    expect(onCreateProject).not.toHaveBeenCalled();
  });

  it("disables the manual create control while creating is true", () => {
    renderPicker({ creating: true });

    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    fireEvent.click(screen.getByRole("button", { name: /type a path manually/i }));
    expect(screen.getByRole("button", { name: /creating/i })).toBeDisabled();
  });

  it("shows an error message when project creation fails", () => {
    renderPicker({ error: "Command failed: git add -A -- .\nfatal: not a git repository" });

    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    expect(screen.getByText(/not a git repository/i)).toBeInTheDocument();
  });

  it("offers a remove control per project, naming which project it targets", () => {
    renderPicker({ onDeleteProject: vi.fn() });

    // Named per-project, not a bare "Remove" — with the workspace path as
    // the row label, an unlabelled icon button gives a screen reader user
    // no way to tell which row's delete they're on.
    expect(screen.getByRole("button", { name: /remove project one/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /remove project two/i })).toBeInTheDocument();
  });

  it("does not delete on the first click — it asks for confirmation first", () => {
    const onDeleteProject = vi.fn();
    renderPicker({ onDeleteProject });

    fireEvent.click(screen.getByRole("button", { name: /remove project two/i }));

    expect(onDeleteProject).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /^remove$/i })).toBeInTheDocument();
  });

  it("states plainly that the workspace folder is left alone", () => {
    renderPicker({ onDeleteProject: vi.fn() });

    fireEvent.click(screen.getByRole("button", { name: /remove project two/i }));

    // "Delete project" reads like it might delete the folder. It doesn't,
    // and the confirmation has to say so.
    expect(screen.getByText(/folder .*(isn't|is not|won't be|not) (deleted|touched|removed)/i)).toBeInTheDocument();
  });

  it("calls onDeleteProject with the project's id once confirmed", () => {
    const onDeleteProject = vi.fn();
    renderPicker({ onDeleteProject });

    fireEvent.click(screen.getByRole("button", { name: /remove project two/i }));
    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));

    expect(onDeleteProject).toHaveBeenCalledWith("p2");
  });

  it("cancelling the confirmation leaves the project alone", () => {
    const onDeleteProject = vi.fn();
    renderPicker({ onDeleteProject });

    fireEvent.click(screen.getByRole("button", { name: /remove project two/i }));
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));

    expect(onDeleteProject).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Project Two" })).toBeInTheDocument();
  });

  it("confirming one project never targets a different one", () => {
    const onDeleteProject = vi.fn();
    renderPicker({ onDeleteProject });

    // Open the confirmation on one row, then switch to another — the
    // pending target must follow, not stay stuck on the first.
    fireEvent.click(screen.getByRole("button", { name: /remove project one/i }));
    fireEvent.click(screen.getByRole("button", { name: /remove project two/i }));
    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));

    expect(onDeleteProject).toHaveBeenCalledTimes(1);
    expect(onDeleteProject).toHaveBeenCalledWith("p2");
  });

  it("hides the remove controls entirely when no delete handler is wired", () => {
    renderPicker({ onDeleteProject: undefined });
    expect(screen.queryByRole("button", { name: /remove project one/i })).not.toBeInTheDocument();
  });

  it("selecting a project still works while a different row's confirmation is open", () => {
    const onSelectProject = vi.fn();
    renderPicker({ onSelectProject, onDeleteProject: vi.fn() });

    fireEvent.click(screen.getByRole("button", { name: /remove project one/i }));
    fireEvent.click(screen.getByRole("button", { name: "Project Two" }));

    expect(onSelectProject).toHaveBeenCalledWith("p2");
  });
});
