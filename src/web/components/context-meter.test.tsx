// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ContextMeter, pressureBand } from "./context-meter.js";

/**
 * How full the live session's context window is (spec #93 phase 9,
 * argusde#124). Stories 46–50.
 *
 * The numbers here are shaped by what the real claude-agent-acp actually
 * reports: a 1,000,000-token window sitting at ~5% after two turns. A meter
 * built around "nearly full" would spend its whole life at the left edge,
 * which is why the bands are proportional.
 */
describe("ContextMeter", () => {
  it("renders nothing at all when the agent has reported no usage (story 50)", () => {
    const { container } = render(<ContextMeter usage={null} />);

    // Absent, not zeroed. A 0% bar is a claim about the context; "no meter" is
    // the honest statement that nothing was reported.
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the proportion used as a percentage (story 46)", () => {
    render(<ContextMeter usage={{ used: 50_000, size: 200_000 }} />);

    expect(screen.getByText("25%")).toBeInTheDocument();
  });

  it("names used and total in its accessible label, so the figures need no hover (stories 46, 49)", () => {
    render(<ContextMeter usage={{ used: 54_618, size: 1_000_000 }} />);

    // A tooltip alone would fail the phone, where there is nothing to hover —
    // and the phone is the case this app exists for.
    const meter = screen.getByRole("progressbar");
    expect(meter).toHaveAccessibleName(/54,618/);
    expect(meter).toHaveAccessibleName(/1,000,000/);
  });

  it("rounds rather than truncating, so a nearly-full window never reads as one notch lower", () => {
    render(<ContextMeter usage={{ used: 199_000, size: 200_000 }} />);
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("never shows more than 100%, even if the agent reports more used than the window holds", () => {
    render(<ContextMeter usage={{ used: 300_000, size: 200_000 }} />);
    expect(screen.getByText("100%")).toBeInTheDocument();
  });

  it("survives a zero-sized window without dividing by it", () => {
    render(<ContextMeter usage={{ used: 10, size: 0 }} />);
    expect(screen.getByText("0%")).toBeInTheDocument();
  });

  describe("pressureBand (story 48)", () => {
    it("is comfortable well below the limit", () => {
      expect(pressureBand(0.05)).toBe("comfortable");
      expect(pressureBand(0.7499)).toBe("comfortable");
    });

    it("enters the warning band exactly at three quarters, not before", () => {
      expect(pressureBand(0.75)).toBe("warning");
      expect(pressureBand(0.8999)).toBe("warning");
    });

    it("enters the pressure band exactly at nine tenths", () => {
      expect(pressureBand(0.9)).toBe("pressure");
      expect(pressureBand(1)).toBe("pressure");
    });
  });

  it("marks the band on the element, so appearance changes under pressure rather than only the number", () => {
    const { rerender } = render(<ContextMeter usage={{ used: 10_000, size: 200_000 }} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("data-band", "comfortable");

    rerender(<ContextMeter usage={{ used: 160_000, size: 200_000 }} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("data-band", "warning");

    rerender(<ContextMeter usage={{ used: 190_000, size: 200_000 }} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute("data-band", "pressure");
  });
});
