// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ProjectPicker } from "./project-picker.js";

const PROJECTS = [
  { id: "p1", workspaceRoot: "/home/you/repos/one", title: "Project One", createdAt: "" },
  { id: "p2", workspaceRoot: "/home/you/repos/two", title: "Project Two", createdAt: "" },
];

describe("ProjectPicker", () => {
  it("lists every project by title", () => {
    render(<ProjectPicker projects={PROJECTS} onSelectProject={() => {}} onCreateProject={() => {}} />);

    expect(screen.getByRole("button", { name: "Project One" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Project Two" })).toBeInTheDocument();
  });

  it("shows an empty-state message when there are no projects yet", () => {
    render(<ProjectPicker projects={[]} onSelectProject={() => {}} onCreateProject={() => {}} />);
    expect(screen.getByText(/no projects/i)).toBeInTheDocument();
  });

  it("calls onSelectProject with the clicked project's id", () => {
    const onSelectProject = vi.fn();
    render(<ProjectPicker projects={PROJECTS} onSelectProject={onSelectProject} onCreateProject={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Project Two" }));
    expect(onSelectProject).toHaveBeenCalledWith("p2");
  });

  it("submits a new project's workspace path via onCreateProject", () => {
    const onCreateProject = vi.fn();
    render(<ProjectPicker projects={PROJECTS} onSelectProject={() => {}} onCreateProject={onCreateProject} />);

    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    const input = screen.getByPlaceholderText(/workspace path|repos\/project/i);
    fireEvent.change(input, { target: { value: "/home/you/repos/three" } });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    expect(onCreateProject).toHaveBeenCalledWith("/home/you/repos/three");
  });

  it("does not submit an empty workspace path", () => {
    const onCreateProject = vi.fn();
    render(<ProjectPicker projects={PROJECTS} onSelectProject={() => {}} onCreateProject={onCreateProject} />);

    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    expect(onCreateProject).not.toHaveBeenCalled();
  });

  it("disables the create control while creating is true", () => {
    render(<ProjectPicker projects={PROJECTS} onSelectProject={() => {}} onCreateProject={() => {}} creating={true} />);

    fireEvent.click(screen.getByRole("button", { name: /new project/i }));
    expect(screen.getByRole("button", { name: /creating/i })).toBeDisabled();
  });
});
