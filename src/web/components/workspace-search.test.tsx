// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { WorkspaceSearch } from "./workspace-search.js";
import type { SearchResults } from "../../shared/ws-protocol.js";

function results(over: Partial<SearchResults> = {}): SearchResults {
  return {
    query: "needle",
    files: [
      { path: "src/index.ts", matches: [{ line: 3, text: "const needle = 1;" }], matchesTruncated: false },
      {
        path: "src/other.ts",
        matches: [
          { line: 10, text: "needle again" },
          { line: 42, text: "and needle here" },
        ],
        matchesTruncated: false,
      },
    ],
    totalMatches: 3,
    truncated: { files: false, matches: false, timedOut: false },
    ...over,
  };
}

describe("WorkspaceSearch", () => {
  it("groups matches under their file, with line numbers, so relevance is judgeable before opening anything", () => {
    render(<WorkspaceSearch results={results()} loading={false} error={undefined} onOpenMatch={() => {}} />);

    expect(screen.getByText("src/index.ts")).toBeInTheDocument();
    expect(screen.getByText("src/other.ts")).toBeInTheDocument();
    expect(screen.getByText("const needle = 1;")).toBeInTheDocument();
    expect(screen.getByText("3")).toBeInTheDocument();
    expect(screen.getByText("42")).toBeInTheDocument();
  });

  it("summarises the count, so a big result set is legible at a glance", () => {
    render(<WorkspaceSearch results={results()} loading={false} error={undefined} onOpenMatch={() => {}} />);
    expect(screen.getByText(/3 matches in 2 files/)).toBeInTheDocument();
  });

  it("uses singular wording for a single match in a single file", () => {
    render(
      <WorkspaceSearch
        results={results({ files: [results().files[0]!], totalMatches: 1 })}
        loading={false}
        error={undefined}
        onOpenMatch={() => {}}
      />,
    );
    expect(screen.getByText(/1 match in 1 file/)).toBeInTheDocument();
  });

  it("opens the file at the matching line when a result is clicked — a result has to lead somewhere", () => {
    const onOpenMatch = vi.fn();
    render(<WorkspaceSearch results={results()} loading={false} error={undefined} onOpenMatch={onOpenMatch} />);

    fireEvent.click(screen.getByRole("button", { name: /and needle here/ }));
    expect(onOpenMatch).toHaveBeenCalledWith("src/other.ts", 42);
  });

  it("says plainly when nothing matched, echoing the query back", () => {
    render(
      <WorkspaceSearch
        results={results({ files: [], totalMatches: 0, query: "absent-thing" })}
        loading={false}
        error={undefined}
        onOpenMatch={() => {}}
      />,
    );

    expect(screen.getByTestId("search-no-matches")).toBeInTheDocument();
    expect(screen.getByText(/absent-thing/)).toBeInTheDocument();
  });

  it("distinguishes 'no matches' from 'still searching'", () => {
    // Story 21's actual requirement: the two states must not look alike.
    const { rerender } = render(
      <WorkspaceSearch results={null} loading={true} error={undefined} onOpenMatch={() => {}} />,
    );
    expect(screen.getByTestId("search-loading")).toBeInTheDocument();
    expect(screen.queryByTestId("search-no-matches")).not.toBeInTheDocument();

    rerender(
      <WorkspaceSearch results={results({ files: [], totalMatches: 0 })} loading={false} error={undefined} onOpenMatch={() => {}} />,
    );
    expect(screen.queryByTestId("search-loading")).not.toBeInTheDocument();
    expect(screen.getByTestId("search-no-matches")).toBeInTheDocument();
  });

  it("names each cap that bit, so a truncated result set is not read as a complete one", () => {
    render(
      <WorkspaceSearch
        results={results({ truncated: { files: true, matches: true, timedOut: true } })}
        loading={false}
        error={undefined}
        onOpenMatch={() => {}}
      />,
    );

    expect(screen.getByTestId("search-files-capped")).toBeInTheDocument();
    expect(screen.getByTestId("search-matches-capped")).toBeInTheDocument();
    expect(screen.getByTestId("search-timed-out")).toBeInTheDocument();
  });

  it("claims no cap when none bit", () => {
    render(<WorkspaceSearch results={results()} loading={false} error={undefined} onOpenMatch={() => {}} />);

    expect(screen.queryByTestId("search-files-capped")).not.toBeInTheDocument();
    expect(screen.queryByTestId("search-matches-capped")).not.toBeInTheDocument();
    expect(screen.queryByTestId("search-timed-out")).not.toBeInTheDocument();
  });

  it("marks a file whose own matches were capped, next to that file", () => {
    render(
      <WorkspaceSearch
        results={results({ files: [{ ...results().files[0]!, matchesTruncated: true }] })}
        loading={false}
        error={undefined}
        onOpenMatch={() => {}}
      />,
    );
    expect(screen.getByText(/more matches in this file than shown/i)).toBeInTheDocument();
  });

  it("surfaces a failed search where it was triggered", () => {
    // A message distinct from the heading, so this asserts the *error* is
    // shown rather than matching the "Search failed" title next to it.
    render(<WorkspaceSearch results={null} loading={false} error="git grep exited with code 128" onOpenMatch={() => {}} />);
    expect(screen.getByText(/exited with code 128/)).toBeInTheDocument();
  });

  it("renders nothing at all before a search has been run", () => {
    const { container } = render(
      <WorkspaceSearch results={null} loading={false} error={undefined} onOpenMatch={() => {}} />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});
