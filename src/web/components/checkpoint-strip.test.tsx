// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { CheckpointStrip } from "./checkpoint-strip.js";

const CHECKPOINTS = [
  { threadId: "t1", turn: 0, ref: "refs/argusde/checkpoints/t1/turn/0", createdAt: "2026-08-14T00:00:00.000Z" },
  { threadId: "t1", turn: 1, ref: "refs/argusde/checkpoints/t1/turn/1", createdAt: "2026-08-14T00:01:00.000Z" },
  { threadId: "t1", turn: 2, ref: "refs/argusde/checkpoints/t1/turn/2", createdAt: "2026-08-14T00:02:00.000Z" },
];

describe("CheckpointStrip", () => {
  it("renders a marker for every checkpoint, labeling turn 0 as the start", () => {
    render(<CheckpointStrip checkpoints={CHECKPOINTS} onSelectTurn={() => {}} onSinceStart={() => {}} />);

    expect(screen.getByRole("button", { name: "Start" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn 1" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Turn 2" })).toBeInTheDocument();
  });

  it("calls onSelectTurn with the clicked turn number for a non-zero turn", () => {
    const onSelectTurn = vi.fn();
    render(<CheckpointStrip checkpoints={CHECKPOINTS} onSelectTurn={onSelectTurn} onSinceStart={() => {}} />);

    fireEvent.click(screen.getByRole("button", { name: "Turn 2" }));
    expect(onSelectTurn).toHaveBeenCalledWith(2);
  });

  it("does not render a 'since start' control with fewer than two checkpoints", () => {
    render(<CheckpointStrip checkpoints={CHECKPOINTS.slice(0, 1)} onSelectTurn={() => {}} onSinceStart={() => {}} />);
    expect(screen.queryByRole("button", { name: /since start/i })).not.toBeInTheDocument();
  });

  it("renders a 'since start' control that calls onSinceStart when there's more than one checkpoint", () => {
    const onSinceStart = vi.fn();
    render(<CheckpointStrip checkpoints={CHECKPOINTS} onSelectTurn={() => {}} onSinceStart={onSinceStart} />);

    fireEvent.click(screen.getByRole("button", { name: /since start/i }));
    expect(onSinceStart).toHaveBeenCalled();
  });

  it("renders nothing when there are no checkpoints yet", () => {
    const { container } = render(<CheckpointStrip checkpoints={[]} onSelectTurn={() => {}} onSinceStart={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });
});
