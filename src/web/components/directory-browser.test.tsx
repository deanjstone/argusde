// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { DirectoryBrowser } from "./directory-browser.js";

const HOME_LISTING = {
  path: "/home/you",
  parentPath: "/home",
  entries: [
    { name: "repos", path: "/home/you/repos" },
    { name: "docs", path: "/home/you/docs" },
  ],
};

const REPOS_LISTING = {
  path: "/home/you/repos",
  parentPath: "/home/you",
  entries: [{ name: "argusde", path: "/home/you/repos/argusde" }],
};

const ROOT_LISTING = {
  path: "/",
  parentPath: null,
  entries: [{ name: "home", path: "/home" }],
};

describe("DirectoryBrowser", () => {
  it("lists the initial directory's entries on mount", async () => {
    const listDirectory = vi.fn().mockResolvedValue(HOME_LISTING);
    render(<DirectoryBrowser listDirectory={listDirectory} onSelect={() => {}} />);

    expect(await screen.findByRole("button", { name: "repos" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "docs" })).toBeInTheDocument();
    expect(listDirectory).toHaveBeenCalledWith(undefined);
  });

  it("navigates into a subdirectory when an entry is clicked", async () => {
    const listDirectory = vi.fn().mockResolvedValueOnce(HOME_LISTING).mockResolvedValueOnce(REPOS_LISTING);
    render(<DirectoryBrowser listDirectory={listDirectory} onSelect={() => {}} />);

    fireEvent.click(await screen.findByRole("button", { name: "repos" }));

    expect(await screen.findByRole("button", { name: "argusde" })).toBeInTheDocument();
    expect(listDirectory).toHaveBeenCalledWith("/home/you/repos");
  });

  it("navigates up to the parent directory when Up is clicked", async () => {
    const listDirectory = vi.fn().mockResolvedValueOnce(REPOS_LISTING).mockResolvedValueOnce(HOME_LISTING);
    render(<DirectoryBrowser listDirectory={listDirectory} onSelect={() => {}} />);

    await screen.findByRole("button", { name: "argusde" });
    fireEvent.click(screen.getByRole("button", { name: /up/i }));

    expect(await screen.findByRole("button", { name: "repos" })).toBeInTheDocument();
    expect(listDirectory).toHaveBeenCalledWith("/home/you");
  });

  it("disables the Up button at the filesystem root", async () => {
    const listDirectory = vi.fn().mockResolvedValue(ROOT_LISTING);
    render(<DirectoryBrowser listDirectory={listDirectory} onSelect={() => {}} />);

    await screen.findByRole("button", { name: "home" });
    expect(screen.getByRole("button", { name: /up/i })).toBeDisabled();
  });

  it("calls onSelect with the current directory's path", async () => {
    const listDirectory = vi.fn().mockResolvedValue(HOME_LISTING);
    const onSelect = vi.fn();
    render(<DirectoryBrowser listDirectory={listDirectory} onSelect={onSelect} />);

    await screen.findByRole("button", { name: "repos" });
    fireEvent.click(screen.getByRole("button", { name: /select this folder/i }));

    expect(onSelect).toHaveBeenCalledWith("/home/you");
  });

  it("shows an error message when listDirectory rejects", async () => {
    const listDirectory = vi.fn().mockRejectedValue(new Error("ENOENT: no such directory"));
    render(<DirectoryBrowser listDirectory={listDirectory} onSelect={() => {}} />);

    expect(await screen.findByText(/enoent/i)).toBeInTheDocument();
  });

  it("shows a loading state while the initial listing is in flight", async () => {
    let resolveListing: (value: typeof HOME_LISTING) => void = () => {};
    const listDirectory = vi.fn(() => new Promise<typeof HOME_LISTING>((resolve) => (resolveListing = resolve)));
    render(<DirectoryBrowser listDirectory={listDirectory} onSelect={() => {}} />);

    expect(screen.getByText(/loading/i)).toBeInTheDocument();

    resolveListing(HOME_LISTING);
    await waitFor(() => expect(screen.queryByText(/loading/i)).not.toBeInTheDocument());
  });
});
