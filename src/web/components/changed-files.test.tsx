// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChangedFiles } from "./changed-files.js";
import type { WorkingTreeChanges } from "../../shared/ws-protocol.js";

function changes(over: Partial<WorkingTreeChanges> = {}): WorkingTreeChanges {
  return {
    branch: "main",
    detached: false,
    files: [
      { path: "src/index.ts", kind: "modified" },
      { path: "added.ts", kind: "added" },
      { path: "gone.ts", kind: "deleted" },
      { path: "fresh.ts", kind: "untracked" },
      { path: "new-name.ts", kind: "renamed", previousPath: "old-name.ts" },
    ],
    ...over,
  };
}

describe("ChangedFiles", () => {
  it("lists each changed file with a scannable label for how it changed", () => {
    render(<ChangedFiles changes={changes()} loading={false} error={undefined} selectedPath={undefined} onSelect={() => {}} />);

    expect(screen.getByText("src/index.ts")).toBeInTheDocument();
    // Words, not colours or single letters — colour alone excludes anyone who
    // can't distinguish them, and letters need a legend there's no room for.
    expect(screen.getByText("modified")).toBeInTheDocument();
    expect(screen.getByText("added")).toBeInTheDocument();
    expect(screen.getByText("deleted")).toBeInTheDocument();
    expect(screen.getByText("new")).toBeInTheDocument();
    expect(screen.getByText("renamed")).toBeInTheDocument();
  });

  it("shows where a renamed file came from, which is half the story", () => {
    render(<ChangedFiles changes={changes()} loading={false} error={undefined} selectedPath={undefined} onSelect={() => {}} />);
    expect(screen.getByText(/from old-name\.ts/)).toBeInTheDocument();
  });

  it("names the branch the working tree is on", () => {
    render(<ChangedFiles changes={changes()} loading={false} error={undefined} selectedPath={undefined} onSelect={() => {}} />);
    expect(screen.getByTestId("branch-name")).toHaveTextContent("main");
  });

  it("says detached rather than showing a branch called HEAD", () => {
    // `rev-parse --abbrev-ref HEAD` returns the literal string "HEAD" for a
    // detached worktree — which a Worktree promoted before spec #93 phase 3 is.
    render(
      <ChangedFiles
        changes={changes({ branch: null, detached: true })}
        loading={false}
        error={undefined}
        selectedPath={undefined}
        onSelect={() => {}}
      />,
    );

    expect(screen.getByTestId("branch-detached")).toBeInTheDocument();
    expect(screen.queryByTestId("branch-name")).not.toBeInTheDocument();
  });

  it("says a clean tree is clean, rather than showing an empty list", () => {
    render(
      <ChangedFiles changes={changes({ files: [] })} loading={false} error={undefined} selectedPath={undefined} onSelect={() => {}} />,
    );

    expect(screen.getByTestId("changes-clean")).toBeInTheDocument();
    expect(screen.getByText(/no uncommitted changes/i)).toBeInTheDocument();
  });

  it("distinguishes a clean tree from a still-loading one", () => {
    const { rerender } = render(
      <ChangedFiles changes={null} loading={true} error={undefined} selectedPath={undefined} onSelect={() => {}} />,
    );
    expect(screen.getByTestId("changes-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("changes-clean")).not.toBeInTheDocument();

    rerender(
      <ChangedFiles changes={changes({ files: [] })} loading={false} error={undefined} selectedPath={undefined} onSelect={() => {}} />,
    );
    expect(screen.queryByTestId("changes-loading")).not.toBeInTheDocument();
    expect(screen.getByTestId("changes-clean")).toBeInTheDocument();
  });

  it("selects a file when it is clicked", () => {
    const onSelect = vi.fn();
    render(<ChangedFiles changes={changes()} loading={false} error={undefined} selectedPath={undefined} onSelect={onSelect} />);

    fireEvent.click(screen.getByRole("button", { name: /src\/index\.ts/ }));
    expect(onSelect).toHaveBeenCalledWith("src/index.ts");
  });

  it("marks which file is currently open, so the list and the diff agree", () => {
    render(
      <ChangedFiles changes={changes()} loading={false} error={undefined} selectedPath="added.ts" onSelect={() => {}} />,
    );
    expect(screen.getByRole("button", { name: /added\.ts/ })).toHaveAttribute("aria-current", "true");
  });

  it("surfaces a failure where it was triggered", () => {
    render(
      <ChangedFiles changes={null} loading={false} error="fatal: not a git repository" selectedPath={undefined} onSelect={() => {}} />,
    );
    expect(screen.getByText(/not a git repository/)).toBeInTheDocument();
  });
});
