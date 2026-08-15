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
});
