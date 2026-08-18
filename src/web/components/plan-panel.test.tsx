// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { PlanPanel } from "./plan-panel.js";
import type { PlanEntrySummary } from "../../shared/acp-events.js";

/**
 * The agent's plan, as a resting pill and an expanding panel (spec #93 phase
 * 10, argusde#126). Stories 51–59, shape settled by prototype #90.
 *
 * The entries here mirror what the real claude-agent-acp produces: short
 * content, `priority` always "medium" (which is why nothing renders it), and
 * the whole plan resent on every revision.
 */

const PLAN: PlanEntrySummary[] = [
  { content: "Read the router", priority: "medium", status: "completed" },
  { content: "Add the route handler", priority: "medium", status: "in_progress" },
  { content: "Add a test", priority: "medium", status: "pending" },
];

describe("PlanPanel", () => {
  it("renders nothing at all when the agent has produced no plan (story 58)", () => {
    const { container } = render(<PlanPanel plan={null} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for an empty plan either — a pill with no steps answers nothing", () => {
    const { container } = render(<PlanPanel plan={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows how far through the plan the agent is, without being opened (story 51)", () => {
    render(<PlanPanel plan={PLAN} />);
    expect(screen.getByText("1/3")).toBeInTheDocument();
  });

  it("names the step currently in progress, so the resting state answers the common question (story 52)", () => {
    render(<PlanPanel plan={PLAN} />);
    expect(screen.getByRole("button", { name: /add the route handler/i })).toBeInTheDocument();
  });

  it("keeps the plan collapsed until asked — detail is one gesture away, not in the way (story 53)", () => {
    render(<PlanPanel plan={PLAN} />);
    // The in-progress step is named on the pill; the others are not shown yet.
    expect(screen.queryByText("Add a test")).toBeNull();
  });

  it("expands the full plan when the pill is tapped (story 53)", () => {
    render(<PlanPanel plan={PLAN} />);

    fireEvent.click(screen.getByRole("button", { name: /add the route handler/i }));

    expect(screen.getByText("Read the router")).toBeInTheDocument();
    expect(screen.getByText("Add a test")).toBeInTheDocument();
  });

  it("closes the same way it opened, so the interaction is reversible (story 59)", () => {
    render(<PlanPanel plan={PLAN} />);
    const pill = screen.getByRole("button", { name: /add the route handler/i });

    fireEvent.click(pill);
    expect(screen.getByText("Add a test")).toBeInTheDocument();

    fireEvent.click(pill);
    expect(screen.queryByText("Add a test")).toBeNull();
  });

  it("says whether it is open, so the control is not a mystery to a screen reader", () => {
    render(<PlanPanel plan={PLAN} />);
    const pill = screen.getByRole("button", { name: /add the route handler/i });

    expect(pill).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(pill);
    expect(pill).toHaveAttribute("aria-expanded", "true");
  });

  it("distinguishes the three statuses by more than their text (story 55)", () => {
    render(<PlanPanel plan={PLAN} />);
    fireEvent.click(screen.getByRole("button", { name: /add the route handler/i }));

    const steps = screen.getAllByRole("listitem");
    expect(steps.map((step) => step.getAttribute("data-status"))).toEqual(["completed", "in_progress", "pending"]);
  });

  it("counts a finished plan as finished rather than looping back to zero", () => {
    const done: PlanEntrySummary[] = PLAN.map((entry) => ({ ...entry, status: "completed" }));
    render(<PlanPanel plan={done} />);

    expect(screen.getByText("3/3")).toBeInTheDocument();
  });

  it("falls back to a plain label when no step is in progress, rather than naming nothing", () => {
    const done: PlanEntrySummary[] = PLAN.map((entry) => ({ ...entry, status: "completed" }));
    render(<PlanPanel plan={done} />);

    expect(screen.getByRole("button", { name: /plan/i })).toBeInTheDocument();
  });

  it("names the first in-progress step when the agent reports more than one", () => {
    const twoRunning: PlanEntrySummary[] = [
      { content: "First running step", priority: "medium", status: "in_progress" },
      { content: "Second running step", priority: "medium", status: "in_progress" },
    ];
    render(<PlanPanel plan={twoRunning} />);

    expect(screen.getByRole("button", { name: /first running step/i })).toBeInTheDocument();
  });

  it("updates in place as the plan is revised, without needing to be reopened (stories 56, 57)", () => {
    const { rerender } = render(<PlanPanel plan={PLAN} />);
    fireEvent.click(screen.getByRole("button", { name: /add the route handler/i }));

    const revised: PlanEntrySummary[] = [
      { content: "Read the router", priority: "medium", status: "completed" },
      { content: "Add the route handler", priority: "medium", status: "completed" },
      { content: "Add a test", priority: "medium", status: "in_progress" },
    ];
    rerender(<PlanPanel plan={revised} />);

    // Still open, and showing the revision rather than the plan it replaced.
    expect(screen.getByText("2/3")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((step) => step.getAttribute("data-status"))).toEqual([
      "completed",
      "completed",
      "in_progress",
    ]);
  });
});
