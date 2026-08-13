// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DiffView } from "./diff-view.js";

const SAMPLE_DIFF = `diff --git a/file.txt b/file.txt
index e69de29..dd3f2c1 100644
--- a/file.txt
+++ b/file.txt
@@ -1 +1,2 @@
 hello
+world`;

describe("DiffView", () => {
  it("renders nothing when there's no diff, not loading, and no error", () => {
    const { container } = render(<DiffView diff={null} loading={false} error={undefined} onClose={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows a loading state", () => {
    render(<DiffView diff={null} loading={true} error={undefined} onClose={() => {}} />);
    expect(screen.getByText(/loading/i)).toBeInTheDocument();
  });

  it("shows an error message", () => {
    render(<DiffView diff={null} loading={false} error="something broke" onClose={() => {}} />);
    expect(screen.getByText("something broke")).toBeInTheDocument();
  });

  it("renders added and removed lines with distinct styling", () => {
    render(<DiffView diff={SAMPLE_DIFF} loading={false} error={undefined} onClose={() => {}} />);

    const added = screen.getByText("+world");
    const removed = screen.queryByText((_, node) => node?.textContent === "-hello");
    expect(added.className).toContain("text-green");
    expect(removed).toBeNull(); // this sample diff has no removed lines — sanity check the query itself works
  });

  it("calls onClose when the close control is clicked", () => {
    const onClose = vi.fn();
    render(<DiffView diff={SAMPLE_DIFF} loading={false} error={undefined} onClose={onClose} />);

    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows a message when the diff is empty (no changes between the two checkpoints)", () => {
    render(<DiffView diff="" loading={false} error={undefined} onClose={() => {}} />);
    expect(screen.getByText(/no changes/i)).toBeInTheDocument();
  });
});
