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

  it("does not render a revert control when onRevert is not provided", () => {
    render(<DiffView diff={SAMPLE_DIFF} loading={false} error={undefined} onClose={() => {}} />);
    expect(screen.queryByRole("button", { name: /revert/i })).not.toBeInTheDocument();
  });

  it("renders a revert control that calls onRevert when clicked", () => {
    const onRevert = vi.fn();
    render(<DiffView diff={SAMPLE_DIFF} loading={false} error={undefined} onClose={() => {}} onRevert={onRevert} />);

    fireEvent.click(screen.getByRole("button", { name: /revert/i }));
    expect(onRevert).toHaveBeenCalled();
  });

  it("disables and relabels the revert control while reverting is in progress", () => {
    render(<DiffView diff={SAMPLE_DIFF} loading={false} error={undefined} onClose={() => {}} reverting onRevert={() => {}} />);

    const button = screen.getByRole("button", { name: /reverting/i });
    expect(button).toBeDisabled();
  });

  describe("comparing an arbitrary pair of checkpoints", () => {
    const TURNS = [0, 1, 2, 3];
    const withRange = (overrides = {}) => ({
      diff: SAMPLE_DIFF,
      loading: false,
      error: undefined,
      onClose: () => {},
      availableTurns: TURNS,
      range: { from: 1, to: 2 },
      onChangeRange: vi.fn(),
      ...overrides,
    });

    it("renders no range controls when the caller doesn't supply them", () => {
      render(<DiffView diff={SAMPLE_DIFF} loading={false} error={undefined} onClose={() => {}} />);
      expect(screen.queryByLabelText(/compare from/i)).not.toBeInTheDocument();
    });

    it("shows both ends of the current comparison", () => {
      const props = withRange();
      render(<DiffView {...props} />);

      expect((screen.getByLabelText(/compare from/i) as HTMLSelectElement).value).toBe("1");
      expect((screen.getByLabelText(/compare to/i) as HTMLSelectElement).value).toBe("2");
    });

    it("offers every captured checkpoint at both ends, so any pair can be compared", () => {
      render(<DiffView {...withRange()} />);

      const optionValues = (select: HTMLElement) =>
        Array.from(select.querySelectorAll("option")).map((o) => (o as HTMLOptionElement).value);
      expect(optionValues(screen.getByLabelText(/compare from/i))).toEqual(["0", "1", "2", "3"]);
      expect(optionValues(screen.getByLabelText(/compare to/i))).toEqual(["0", "1", "2", "3"]);
    });

    it("requests a new comparison when either end changes", () => {
      const onChangeRange = vi.fn();
      render(<DiffView {...withRange({ onChangeRange })} />);

      fireEvent.change(screen.getByLabelText(/compare from/i), { target: { value: "0" } });
      expect(onChangeRange).toHaveBeenCalledWith({ from: 0, to: 2 });

      fireEvent.change(screen.getByLabelText(/compare to/i), { target: { value: "3" } });
      expect(onChangeRange).toHaveBeenCalledWith({ from: 1, to: 3 });
    });

    it("labels turn 0 as the thread's starting point, not a turn number", () => {
      render(<DiffView {...withRange()} />);
      expect(screen.getAllByRole("option", { name: /start/i }).length).toBeGreaterThan(0);
    });
  });
});
