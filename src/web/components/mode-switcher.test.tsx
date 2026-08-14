// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ModeSwitcher } from "./mode-switcher.js";

const MODES = [
  { id: "default", name: "Default" },
  { id: "plan", name: "Plan", description: "Plan before editing" },
];

describe("ModeSwitcher", () => {
  it("renders nothing when there are no available modes", () => {
    const { container } = render(<ModeSwitcher currentModeId={undefined} availableModes={[]} onSetMode={() => {}} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("lists every available mode by name, with the current one selected", () => {
    render(<ModeSwitcher currentModeId="plan" availableModes={MODES} onSetMode={() => {}} />);

    const select = screen.getByRole("combobox") as HTMLSelectElement;
    expect(select.value).toBe("plan");
    expect(screen.getByRole("option", { name: "Default" })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: "Plan" })).toBeInTheDocument();
  });

  it("calls onSetMode with the chosen id when the selection changes", () => {
    const onSetMode = vi.fn();
    render(<ModeSwitcher currentModeId="default" availableModes={MODES} onSetMode={onSetMode} />);

    fireEvent.change(screen.getByRole("combobox"), { target: { value: "plan" } });
    expect(onSetMode).toHaveBeenCalledWith("plan");
  });
});
