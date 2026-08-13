// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkspaceSetup } from "./workspace-setup.js";

describe("WorkspaceSetup", () => {
  it("submits the entered workspace path", () => {
    const onSubmit = vi.fn();
    render(<WorkspaceSetup onSubmit={onSubmit} />);

    fireEvent.change(screen.getByLabelText(/workspace path/i), { target: { value: "/home/deanj/repos/argusde" } });
    fireEvent.click(screen.getByRole("button", { name: /start/i }));

    expect(onSubmit).toHaveBeenCalledWith("/home/deanj/repos/argusde");
  });

  it("does not submit an empty path", () => {
    const onSubmit = vi.fn();
    render(<WorkspaceSetup onSubmit={onSubmit} />);

    fireEvent.click(screen.getByRole("button", { name: /start/i }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables the form while submitting", () => {
    render(<WorkspaceSetup onSubmit={() => {}} submitting />);

    expect(screen.getByRole("button", { name: /start/i })).toBeDisabled();
    expect(screen.getByLabelText(/workspace path/i)).toBeDisabled();
  });

  it("shows an error message when provided", () => {
    render(<WorkspaceSetup onSubmit={() => {}} error="Unknown project: xyz" />);

    expect(screen.getByText("Unknown project: xyz")).toBeInTheDocument();
  });
});
