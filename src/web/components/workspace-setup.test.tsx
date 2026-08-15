// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkspaceSetup } from "./workspace-setup.js";

const LISTING = {
  path: "/home/you",
  parentPath: "/home",
  entries: [{ name: "repos", path: "/home/you/repos" }],
};

describe("WorkspaceSetup", () => {
  it("browses folders by default and submits the selected folder", async () => {
    const onSubmit = vi.fn();
    const listDirectory = vi.fn().mockResolvedValue(LISTING);
    render(<WorkspaceSetup onSubmit={onSubmit} listDirectory={listDirectory} />);

    await screen.findByRole("button", { name: "repos" });
    fireEvent.click(screen.getByRole("button", { name: /select this folder/i }));

    expect(onSubmit).toHaveBeenCalledWith("/home/you");
  });

  it("falls back to a manual path entry and submits the typed path", () => {
    const onSubmit = vi.fn();
    render(<WorkspaceSetup onSubmit={onSubmit} listDirectory={vi.fn().mockResolvedValue(LISTING)} />);

    fireEvent.click(screen.getByRole("button", { name: /type a path manually/i }));
    fireEvent.change(screen.getByLabelText(/workspace path/i), { target: { value: "/home/deanj/repos/argusde" } });
    fireEvent.click(screen.getByRole("button", { name: /^start$/i }));

    expect(onSubmit).toHaveBeenCalledWith("/home/deanj/repos/argusde");
  });

  it("does not submit an empty manual path", () => {
    const onSubmit = vi.fn();
    render(<WorkspaceSetup onSubmit={onSubmit} listDirectory={vi.fn().mockResolvedValue(LISTING)} />);

    fireEvent.click(screen.getByRole("button", { name: /type a path manually/i }));
    fireEvent.click(screen.getByRole("button", { name: /^start$/i }));

    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("disables the manual form while submitting", () => {
    render(<WorkspaceSetup onSubmit={() => {}} listDirectory={vi.fn().mockResolvedValue(LISTING)} submitting />);

    fireEvent.click(screen.getByRole("button", { name: /type a path manually/i }));

    expect(screen.getByRole("button", { name: /starting/i })).toBeDisabled();
    expect(screen.getByLabelText(/workspace path/i)).toBeDisabled();
  });

  it("shows an error message when provided", () => {
    render(<WorkspaceSetup onSubmit={() => {}} listDirectory={vi.fn().mockResolvedValue(LISTING)} error="Unknown project: xyz" />);

    expect(screen.getByText("Unknown project: xyz")).toBeInTheDocument();
  });
});
