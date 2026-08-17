// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { FileBrowser } from "./file-browser.js";
import type { FilePreview as FilePreviewData, WorkingTreeListing } from "../../shared/ws-protocol.js";

const ROOT: WorkingTreeListing = {
  path: "",
  parentPath: null,
  entries: [
    { name: "src", path: "src", kind: "directory" },
    { name: ".gitignore", path: ".gitignore", kind: "file" },
    { name: "README.md", path: "README.md", kind: "file" },
  ],
};

const SRC: WorkingTreeListing = {
  path: "src",
  parentPath: "",
  entries: [{ name: "index.ts", path: "src/index.ts", kind: "file" }],
};

const FILE: FilePreviewData = {
  path: "src/index.ts",
  kind: "text",
  byteLength: 12,
  language: "typescript",
  lines: [[{ content: "const x = 1;", kind: "plain" as const }]],
  plainLines: null,
};

function listingsFor(map: Record<string, WorkingTreeListing>) {
  return vi.fn(async (path: string) => {
    const listing = map[path];
    if (!listing) throw new Error(`unexpected path: ${path}`);
    return listing;
  });
}

describe("FileBrowser", () => {
  it("lists the working tree's entries on mount, files and dotfiles included", async () => {
    render(<FileBrowser threadId="t1" listDirectory={listingsFor({ "": ROOT })} readFile={vi.fn()} search={vi.fn()} />);

    expect(await screen.findByRole("button", { name: /src\// })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /\.gitignore/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /README\.md/ })).toBeInTheDocument();
  });

  it("marks directories so they are distinguishable from files in a narrow column", async () => {
    render(<FileBrowser threadId="t1" listDirectory={listingsFor({ "": ROOT })} readFile={vi.fn()} search={vi.fn()} />);

    // A trailing slash rather than an icon — it survives a phone-width
    // column and needs no legend.
    expect(await screen.findByRole("button", { name: "src/" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "README.md" })).toBeInTheDocument();
  });

  it("navigates into a directory when it is clicked", async () => {
    const listDirectory = listingsFor({ "": ROOT, src: SRC });
    render(<FileBrowser threadId="t1" listDirectory={listDirectory} readFile={vi.fn()} search={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "src/" }));

    expect(await screen.findByRole("button", { name: "index.ts" })).toBeInTheDocument();
    expect(listDirectory).toHaveBeenCalledWith("src");
  });

  it("offers a breadcrumb back to the root, so navigation is reversible", async () => {
    const listDirectory = listingsFor({ "": ROOT, src: SRC });
    render(<FileBrowser threadId="t1" listDirectory={listDirectory} readFile={vi.fn()} search={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "src/" }));
    await screen.findByRole("button", { name: "index.ts" });

    fireEvent.click(screen.getByRole("button", { name: "root" }));
    expect(await screen.findByRole("button", { name: "README.md" })).toBeInTheDocument();
  });

  it("opens a file into the preview rather than navigating", async () => {
    const readFile = vi.fn(async () => FILE);
    render(<FileBrowser threadId="t1" listDirectory={listingsFor({ "": ROOT, src: SRC })} readFile={readFile} search={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "src/" }));
    fireEvent.click(await screen.findByRole("button", { name: "index.ts" }));

    expect(await screen.findByTestId("preview-code")).toHaveTextContent("const x = 1;");
    expect(readFile).toHaveBeenCalledWith("src/index.ts");
  });

  it("surfaces a failed listing where it was triggered", async () => {
    const listDirectory = vi.fn(async () => {
      throw new Error("EACCES: permission denied");
    });
    render(<FileBrowser threadId="t1" listDirectory={listDirectory} readFile={vi.fn()} search={vi.fn()} />);

    expect(await screen.findByText(/permission denied/i)).toBeInTheDocument();
  });

  it("says so when a folder is empty, rather than looking like it failed to load", async () => {
    render(
      <FileBrowser threadId="t1" listDirectory={listingsFor({ "": { path: "", parentPath: null, entries: [] } })} readFile={vi.fn()} search={vi.fn()} />,
    );

    expect(await screen.findByText(/this folder is empty/i)).toBeInTheDocument();
  });

  it("asks for a thread when none is active, instead of showing an empty tree", () => {
    const listDirectory = vi.fn();
    render(<FileBrowser threadId={undefined} listDirectory={listDirectory} readFile={vi.fn()} search={vi.fn()} />);

    expect(screen.getByText(/no thread selected/i)).toBeInTheDocument();
    expect(listDirectory).not.toHaveBeenCalled();
  });

  it("re-roots and drops the open file when the active Thread changes", async () => {
    // A preview from another Thread's tree would be actively misleading —
    // same path, different working tree.
    const listDirectory = listingsFor({ "": ROOT, src: SRC });
    const { rerender } = render(<FileBrowser threadId="t1" listDirectory={listDirectory} readFile={vi.fn(async () => FILE)} search={vi.fn()} />);

    fireEvent.click(await screen.findByRole("button", { name: "src/" }));
    fireEvent.click(await screen.findByRole("button", { name: "index.ts" }));
    await screen.findByTestId("preview-code");

    rerender(<FileBrowser threadId="t2" listDirectory={listDirectory} readFile={vi.fn(async () => FILE)} search={vi.fn()} />);

    await waitFor(() => expect(screen.queryByTestId("preview-code")).not.toBeInTheDocument());
    expect(await screen.findByRole("button", { name: "README.md" })).toBeInTheDocument();
  });
  it("hands the whole phone screen to the file once one is open, and offers a way back", async () => {
    // Master-detail rather than two cramped panes: at 390px, splitting gives
    // each about a third of a usable height and makes neither good.
    render(<FileBrowser threadId="t1" listDirectory={listingsFor({ "": ROOT, src: SRC })} readFile={vi.fn(async () => FILE)} search={vi.fn()} />);

    expect(screen.queryByRole("button", { name: /← Files/ })).not.toBeInTheDocument();

    fireEvent.click(await screen.findByRole("button", { name: "src/" }));
    fireEvent.click(await screen.findByRole("button", { name: "index.ts" }));
    await screen.findByTestId("preview-code");

    const back = screen.getByRole("button", { name: /← Files/ });
    fireEvent.click(back);

    // Back to the tree, still where it was — going back must not re-root.
    expect(await screen.findByRole("button", { name: "index.ts" })).toBeInTheDocument();
    expect(screen.queryByTestId("preview-code")).not.toBeInTheDocument();
  });
  describe("search", () => {
    const RESULTS = {
      query: "needle",
      files: [{ path: "src/index.ts", matches: [{ line: 2, text: "const needle = 1;" }], matchesTruncated: false }],
      totalMatches: 1,
      truncated: { files: false, matches: false, timedOut: false },
    };

    it("searches the working tree and shows results in place of the tree", async () => {
      const search = vi.fn(async () => RESULTS);
      render(<FileBrowser threadId="t1" listDirectory={listingsFor({ "": ROOT })} readFile={vi.fn()} search={search} />);
      await screen.findByRole("button", { name: "README.md" });

      fireEvent.change(screen.getByLabelText(/search the working tree/i), { target: { value: "needle" } });
      fireEvent.click(screen.getByRole("button", { name: "Search" }));

      expect(await screen.findByTestId("search-results")).toBeInTheDocument();
      expect(search).toHaveBeenCalledWith("needle");
    });

    it("opens a result into the preview at its matching line", async () => {
      // A file with more than one line, so "line 2 is marked" is a real claim
      // rather than trivially the only line there is.
      const multiLine = {
        ...FILE,
        lines: [
          [{ content: "first", kind: "plain" as const }],
          [{ content: "const needle = 1;", kind: "plain" as const }],
          [{ content: "third", kind: "plain" as const }],
        ],
      };
      const readFile = vi.fn(async () => multiLine);
      render(
        <FileBrowser
          threadId="t1"
          listDirectory={listingsFor({ "": ROOT })}
          readFile={readFile}
          search={vi.fn(async () => RESULTS)}
        />,
      );
      await screen.findByRole("button", { name: "README.md" });
      fireEvent.change(screen.getByLabelText(/search the working tree/i), { target: { value: "needle" } });
      fireEvent.click(screen.getByRole("button", { name: "Search" }));
      fireEvent.click(await screen.findByRole("button", { name: /const needle = 1;/ }));

      expect(readFile).toHaveBeenCalledWith("src/index.ts");
      // The line only marks if the browser threaded it through to the preview,
      // and it has to be the *matching* line rather than just any line.
      const marked = await screen.findByTestId("preview-highlighted-line");
      expect(marked).toHaveTextContent("const needle = 1;");
    });

    it("returns to browsing when the search is cleared", async () => {
      render(
        <FileBrowser
          threadId="t1"
          listDirectory={listingsFor({ "": ROOT })}
          readFile={vi.fn()}
          search={vi.fn(async () => RESULTS)}
        />,
      );
      await screen.findByRole("button", { name: "README.md" });
      fireEvent.change(screen.getByLabelText(/search the working tree/i), { target: { value: "needle" } });
      fireEvent.click(screen.getByRole("button", { name: "Search" }));
      await screen.findByTestId("search-results");

      fireEvent.click(screen.getByRole("button", { name: /clear search/i }));

      await waitFor(() => expect(screen.queryByTestId("search-results")).not.toBeInTheDocument());
      expect(screen.getByRole("button", { name: "README.md" })).toBeInTheDocument();
    });

    it("does not search for an empty query", async () => {
      const search = vi.fn();
      render(<FileBrowser threadId="t1" listDirectory={listingsFor({ "": ROOT })} readFile={vi.fn()} search={search} />);
      await screen.findByRole("button", { name: "README.md" });

      fireEvent.change(screen.getByLabelText(/search the working tree/i), { target: { value: "   " } });
      fireEvent.click(screen.getByRole("button", { name: "Search" }));

      expect(search).not.toHaveBeenCalled();
    });

    it("drops results when the active Thread changes — they belong to the tree they were found in", async () => {
      const search = vi.fn(async () => RESULTS);
      const { rerender } = render(
        <FileBrowser threadId="t1" listDirectory={listingsFor({ "": ROOT })} readFile={vi.fn()} search={search} />,
      );
      await screen.findByRole("button", { name: "README.md" });
      fireEvent.change(screen.getByLabelText(/search the working tree/i), { target: { value: "needle" } });
      fireEvent.click(screen.getByRole("button", { name: "Search" }));
      await screen.findByTestId("search-results");

      rerender(<FileBrowser threadId="t2" listDirectory={listingsFor({ "": ROOT })} readFile={vi.fn()} search={search} />);

      await waitFor(() => expect(screen.queryByTestId("search-results")).not.toBeInTheDocument());
    });
  });
});
