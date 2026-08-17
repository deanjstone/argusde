// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { FilePreview } from "./file-preview.js";
import type { FilePreview as FilePreviewData } from "../../shared/ws-protocol.js";

function preview(over: Partial<FilePreviewData> = {}): FilePreviewData {
  return {
    path: "src/index.ts",
    kind: "text",
    byteLength: 24,
    language: "typescript",
    lines: [
      [
        { content: "const", kind: "keyword" as const },
        { content: " x = 1;", kind: "plain" as const },
      ],
    ],
    plainLines: null,
    ...over,
  };
}

describe("FilePreview", () => {
  it("renders the file's tokens with the colours the server resolved", () => {
    render(<FilePreview preview={preview()} loading={false} error={undefined} />);

    expect(screen.getByTestId("preview-code")).toHaveTextContent("const x = 1;");
    // The token's *kind* becomes a theme-token class. Asserting the class
    // rather than a colour is the point: an inline colour would be blocked by
    // this app's `style-src 'self'` CSP, so if this ever became a style
    // attribute, highlighting would silently stop working in the real app.
    expect(screen.getByText("const")).toHaveClass("text-syntax-keyword");
  });

  it("numbers the lines, so a result can be talked about", () => {
    render(
      <FilePreview
        preview={preview({ lines: [[{ content: "a", kind: "plain" as const }], [{ content: "b", kind: "plain" as const }]] })}
        loading={false}
        error={undefined}
      />,
    );

    expect(screen.getByText("1")).toBeInTheDocument();
    expect(screen.getByText("2")).toBeInTheDocument();
  });

  it("names the language, so it is clear what was highlighted as what", () => {
    render(<FilePreview preview={preview()} loading={false} error={undefined} />);
    expect(screen.getByText("typescript")).toBeInTheDocument();
  });

  it("renders plain lines when the server sent no tokens, and says it isn't highlighted", () => {
    // A text file can arrive uncoloured — too big to tokenise, or a language
    // the server couldn't resolve. Silence here would read as a bug.
    render(
      <FilePreview
        preview={preview({ language: null, lines: null, plainLines: ["plain one", "plain two"] })}
        loading={false}
        error={undefined}
      />,
    );

    expect(screen.getByTestId("preview-code")).toHaveTextContent("plain one");
    expect(screen.getByTestId("preview-unhighlighted")).toBeInTheDocument();
  });

  it("does not claim a highlighted file is unhighlighted", () => {
    render(<FilePreview preview={preview()} loading={false} error={undefined} />);
    expect(screen.queryByTestId("preview-unhighlighted")).not.toBeInTheDocument();
  });

  it("identifies a binary file as binary instead of rendering noise", () => {
    render(
      <FilePreview
        preview={preview({ path: "logo.png", kind: "binary", byteLength: 2048, language: null, lines: null })}
        loading={false}
        error={undefined}
      />,
    );

    expect(screen.getByTestId("preview-binary")).toBeInTheDocument();
    expect(screen.getByText(/logo\.png/)).toBeInTheDocument();
    expect(screen.queryByTestId("preview-code")).not.toBeInTheDocument();
  });

  it("says a file is too large rather than trying to render it", () => {
    render(
      <FilePreview
        preview={preview({ path: "bundle.js", kind: "too-large", byteLength: 5 * 1024 * 1024, language: null, lines: null })}
        loading={false}
        error={undefined}
      />,
    );

    expect(screen.getByTestId("preview-too-large")).toBeInTheDocument();
    // The size is part of the answer: it tells you whether you opened the
    // wrong file or hit a real limit.
    expect(screen.getByText(/5\.0 MB/)).toBeInTheDocument();
    expect(screen.queryByTestId("preview-code")).not.toBeInTheDocument();
  });

  it("surfaces a failed read where it was triggered, not silently", () => {
    render(<FilePreview preview={null} loading={false} error="Path is outside this Thread's working tree" />);
    expect(screen.getByText(/outside this Thread's working tree/i)).toBeInTheDocument();
  });

  it("invites a selection when nothing is open yet", () => {
    render(<FilePreview preview={null} loading={false} error={undefined} />);
    expect(screen.getByText(/no file open/i)).toBeInTheDocument();
  });
});
