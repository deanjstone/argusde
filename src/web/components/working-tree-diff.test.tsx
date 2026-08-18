// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { WorkingTreeDiff } from "./working-tree-diff.js";
import type { FileDiff } from "../../shared/ws-protocol.js";

function diff(over: Partial<FileDiff> = {}): FileDiff {
  return {
    path: "src/index.ts",
    kind: "text",
    lines: [
      { kind: "meta", text: "diff --git a/src/index.ts b/src/index.ts" },
      { kind: "hunk", text: "@@ -1,2 +1,2 @@" },
      { kind: "context", text: " const kept = 1;" },
      { kind: "removed", text: "-const gone = 2;" },
      { kind: "added", text: "+const fresh = 3;" },
    ],
    ...over,
  };
}

describe("WorkingTreeDiff", () => {
  it("renders every line of the patch", () => {
    render(<WorkingTreeDiff diff={diff()} loading={false} error={undefined} />);
    expect(screen.getByTestId("wt-diff-lines")).toHaveTextContent("+const fresh = 3;");
    expect(screen.getByTestId("wt-diff-lines")).toHaveTextContent("-const gone = 2;");
  });

  it("colours added and removed lines from theme tokens, not from re-parsing the text", () => {
    // The server sends a kind precisely so the client never has to guess from
    // the leading character — and an inline colour would be CSP-blocked anyway.
    render(<WorkingTreeDiff diff={diff()} loading={false} error={undefined} />);

    expect(screen.getByText("+const fresh = 3;")).toHaveClass("text-diff-added");
    expect(screen.getByText("-const gone = 2;")).toHaveClass("text-diff-removed");
    expect(screen.getByText("@@ -1,2 +1,2 @@")).toHaveClass("text-diff-hunk");
  });

  it("labels itself as the working tree, so it is not mistaken for a Checkpoint diff", () => {
    // The app has two diff surfaces answering different questions; spec #93
    // requires them to stay distinguishable.
    render(<WorkingTreeDiff diff={diff()} loading={false} error={undefined} />);
    expect(screen.getByText(/working tree/i)).toBeInTheDocument();
  });

  it("names a binary file rather than rendering it", () => {
    render(<WorkingTreeDiff diff={diff({ kind: "binary", lines: [] })} loading={false} error={undefined} />);

    expect(screen.getByTestId("wt-diff-binary")).toBeInTheDocument();
    expect(screen.queryByTestId("wt-diff-lines")).not.toBeInTheDocument();
  });

  it("invites a selection when nothing is open", () => {
    render(<WorkingTreeDiff diff={null} loading={false} error={undefined} />);
    expect(screen.getByText(/no file selected/i)).toBeInTheDocument();
  });

  it("surfaces a failed read where it was triggered", () => {
    render(<WorkingTreeDiff diff={null} loading={false} error="Path is outside this Thread's working tree" />);
    expect(screen.getByText(/outside this Thread's working tree/)).toBeInTheDocument();
  });
});
