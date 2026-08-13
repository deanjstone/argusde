// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { TabBar } from "./tab-bar.js";

describe("TabBar", () => {
  it("renders all three tabs and marks the active one", () => {
    render(<TabBar active="chat" onChange={() => {}} />);

    expect(screen.getByRole("button", { name: "Chat" })).toHaveAttribute("aria-current", "page");
    expect(screen.getByRole("button", { name: "Threads" })).not.toHaveAttribute("aria-current");
    expect(screen.getByRole("button", { name: "Settings" })).not.toHaveAttribute("aria-current");
  });

  it("calls onChange with the clicked tab", () => {
    const onChange = vi.fn();
    render(<TabBar active="chat" onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Threads" }));
    expect(onChange).toHaveBeenCalledWith("threads");

    fireEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onChange).toHaveBeenCalledWith("settings");
  });
});
