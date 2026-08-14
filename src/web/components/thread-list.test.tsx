// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ThreadList } from "./thread-list.js";

const THREADS = [
  { id: "t1", projectId: "p1", title: "Fix the bug", worktreePath: null, currentModeId: null, createdAt: "", closedAt: null },
  {
    id: "t2",
    projectId: "p1",
    title: "Explore worktree",
    worktreePath: "/workspace-worktrees/t2",
    currentModeId: null,
    createdAt: "",
    closedAt: null,
  },
];

describe("ThreadList", () => {
  it("lists every thread by title", () => {
    render(<ThreadList threads={THREADS} onSelectThread={() => {}} onCreateThread={() => {}} onBack={() => {}} />);

    expect(screen.getByRole("button", { name: /fix the bug/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /explore worktree/i })).toBeInTheDocument();
  });

  it("marks a promoted thread's row with a worktree indicator", () => {
    render(<ThreadList threads={THREADS} onSelectThread={() => {}} onCreateThread={() => {}} onBack={() => {}} />);
    expect(screen.getByRole("button", { name: /explore worktree/i })).toHaveTextContent(/worktree/i);
  });

  it("shows an empty-state message when the project has no threads yet", () => {
    render(<ThreadList threads={[]} onSelectThread={() => {}} onCreateThread={() => {}} onBack={() => {}} />);
    expect(screen.getByText(/no threads/i)).toBeInTheDocument();
  });

  it("calls onSelectThread with the clicked thread's id", () => {
    const onSelectThread = vi.fn();
    render(<ThreadList threads={THREADS} onSelectThread={onSelectThread} onCreateThread={() => {}} onBack={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /fix the bug/i }));
    expect(onSelectThread).toHaveBeenCalledWith("t1");
  });

  it("calls onBack when the back control is clicked", () => {
    const onBack = vi.fn();
    render(<ThreadList threads={THREADS} onSelectThread={() => {}} onCreateThread={() => {}} onBack={onBack} />);

    fireEvent.click(screen.getByRole("button", { name: /back/i }));
    expect(onBack).toHaveBeenCalled();
  });

  it("submits a new thread's title via onCreateThread", () => {
    const onCreateThread = vi.fn();
    render(<ThreadList threads={THREADS} onSelectThread={() => {}} onCreateThread={onCreateThread} onBack={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /new thread/i }));
    const input = screen.getByPlaceholderText(/title/i);
    fireEvent.change(input, { target: { value: "Investigate flakiness" } });
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    expect(onCreateThread).toHaveBeenCalledWith("Investigate flakiness");
  });

  it("does not submit an empty title", () => {
    const onCreateThread = vi.fn();
    render(<ThreadList threads={THREADS} onSelectThread={() => {}} onCreateThread={onCreateThread} onBack={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: /new thread/i }));
    fireEvent.click(screen.getByRole("button", { name: /^create$/i }));

    expect(onCreateThread).not.toHaveBeenCalled();
  });
});
