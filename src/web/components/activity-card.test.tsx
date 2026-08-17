// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ActivityCard, ACTIVITY_PREVIEW_CHARS } from "./activity-card.js";
import type { TimelineToolCall } from "../chat-state.js";

function toolCall(over: Partial<TimelineToolCall> = {}): TimelineToolCall {
  return {
    type: "tool-call",
    id: "tc-1",
    title: "Read src/index.ts",
    kind: "read",
    status: "completed",
    content: [{ type: "text", text: "the file contents" }],
    ...over,
  };
}

describe("ActivityCard", () => {
  it("shows the activity's title, its status, and its result", () => {
    render(<ActivityCard item={toolCall()} />);

    expect(screen.getByText("Read src/index.ts")).toBeInTheDocument();
    expect(screen.getByText("completed")).toBeInTheDocument();
    expect(screen.getByText(/the file contents/)).toBeInTheDocument();
  });

  it("falls back to the activity's id when the agent reported no title", () => {
    render(<ActivityCard item={toolCall({ title: undefined })} />);
    expect(screen.getByText("tc-1")).toBeInTheDocument();
  });

  it("clamps a long result rather than dumping the whole thing into the transcript", () => {
    const long = "x".repeat(ACTIVITY_PREVIEW_CHARS * 3);
    render(<ActivityCard item={toolCall({ content: [{ type: "text", text: long }] })} />);

    const preview = screen.getByTestId("activity-preview");
    expect(preview.textContent?.length).toBeLessThanOrEqual(ACTIVITY_PREVIEW_CHARS + 1);
    expect(preview.textContent).not.toBe(long);
  });

  it("reveals the full result when expanded — truncation is a display default, not data loss", () => {
    const long = "x".repeat(ACTIVITY_PREVIEW_CHARS * 3);
    render(<ActivityCard item={toolCall({ content: [{ type: "text", text: long }] })} />);

    fireEvent.click(screen.getByRole("button", { name: /show more/i }));
    expect(screen.getByText(long)).toBeInTheDocument();
  });

  it("offers no expand control when there is nothing more to show", () => {
    render(<ActivityCard item={toolCall()} />);
    expect(screen.queryByRole("button", { name: /show more/i })).not.toBeInTheDocument();
  });

  it("offers no expand control when the activity produced no result at all", () => {
    render(<ActivityCard item={toolCall({ content: [] })} />);

    expect(screen.queryByRole("button", { name: /show more/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId("activity-preview")).not.toBeInTheDocument();
  });

  it("says when the stored result was cut at capture time, so expanding isn't mistaken for full recovery", () => {
    render(<ActivityCard item={toolCall({ dataTruncated: true })} />);
    expect(screen.getByText(/too large to store in full/i)).toBeInTheDocument();
  });

  it("does not claim capture-time truncation on a live tool call", () => {
    render(<ActivityCard item={toolCall()} />);
    expect(screen.queryByText(/too large to store in full/i)).not.toBeInTheDocument();
  });

  it("marks a failed activity distinctly from a completed one", () => {
    const { rerender } = render(<ActivityCard item={toolCall({ status: "completed" })} />);
    const completed = screen.getByTestId("activity-status").className;

    rerender(<ActivityCard item={toolCall({ status: "failed" })} />);
    const failed = screen.getByTestId("activity-status");

    expect(failed).toHaveTextContent("failed");
    expect(failed.className).not.toBe(completed);
  });

  it("omits the status badge when the agent reported no status", () => {
    render(<ActivityCard item={toolCall({ status: undefined })} />);
    expect(screen.queryByTestId("activity-status")).not.toBeInTheDocument();
  });
});
