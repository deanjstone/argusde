// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import type { TerminalOpened } from "../../shared/ws-protocol.js";
import type { TerminalHandle } from "../lib/xterm-terminal.js";
import type { TerminalCapture } from "../lib/terminal-capture.js";
import { TerminalView, type TerminalPush } from "./terminal-view.js";

function fakeHandle() {
  const written: string[] = [];
  let onInput: (data: string) => void = () => {};
  const handle: TerminalHandle & {
    written: string[];
    type(data: string): void;
    disposed: boolean;
    selection: string;
    recentOutput: string;
  } = {
    written,
    disposed: false,
    selection: "",
    recentOutput: "",
    write: (data) => written.push(data),
    onInput: (listener) => {
      onInput = listener;
      return () => {
        onInput = () => {};
      };
    },
    fit: () => ({ cols: 80, rows: 24 }),
    getSelection: () => handle.selection,
    readRecentOutput: () => handle.recentOutput,
    focus: () => {},
    dispose: () => {
      handle.disposed = true;
    },
    type: (data) => onInput(data),
  };
  return handle;
}

function opened(overrides: Partial<TerminalOpened> = {}): TerminalOpened {
  return {
    terminalId: "term-1",
    threadId: "thread-1",
    cwd: "/home/dev/repos/argusde",
    shell: "/bin/zsh",
    cols: 80,
    rows: 24,
    resumed: false,
    scrollback: "",
    scrollbackTruncated: false,
    exit: null,
    createdAt: new Date().toISOString(),
    branch: "main",
    detached: false,
    ...overrides,
  };
}

function setup(
  options: {
    session?: TerminalOpened;
    threadId?: string | undefined;
    openTerminal?: () => Promise<TerminalOpened>;
    onCapture?: ((capture: TerminalCapture) => void) | undefined;
  } = {},
) {
  const handle = fakeHandle();
  const sendInput = vi.fn(async () => {});
  const resizeTerminal = vi.fn(async () => {});
  const closeTerminal = vi.fn(async () => {});
  const openTerminal = options.openTerminal ?? vi.fn(async () => options.session ?? opened());
  const onCapture = "onCapture" in options ? options.onCapture : vi.fn();
  let push: (event: TerminalPush) => void = () => {};

  const view = render(
    <TerminalView
      threadId={"threadId" in options ? options.threadId : "thread-1"}
      openTerminal={openTerminal}
      sendInput={sendInput}
      resizeTerminal={resizeTerminal}
      closeTerminal={closeTerminal}
      subscribe={(listener) => {
        push = listener;
        return () => {
          push = () => {};
        };
      }}
      onCapture={onCapture}
      createTerminal={async () => handle}
    />,
  );

  return { handle, openTerminal, sendInput, resizeTerminal, closeTerminal, onCapture, push: (event: TerminalPush) => push(event), view };
}

describe("TerminalView", () => {
  it("opens a terminal for the Thread at the size it actually measured", async () => {
    const { openTerminal } = setup();

    await waitFor(() => expect(openTerminal).toHaveBeenCalledWith(80, 24));
  });

  it("says where the shell is rooted and which branch that is", async () => {
    setup({ session: opened({ cwd: "/home/dev/repos/argusde-worktrees/thread-9", branch: "argusde/thread-9" }) });

    // Story 7: never run a command against a working tree you did not mean.
    expect(await screen.findByText("/home/dev/repos/argusde-worktrees/thread-9")).toBeInTheDocument();
    expect(await screen.findByText("argusde/thread-9")).toBeInTheDocument();
  });

  it("replays the scrollback it was handed, so a reattach reads as continuous", async () => {
    const { handle } = setup({ session: opened({ resumed: true, scrollback: "$ pnpm test\r\n636 passed\r\n" }) });

    await waitFor(() => expect(handle.written.join("")).toContain("636 passed"));
  });

  it("says so when earlier output was dropped, rather than letting a partial replay read as a whole session", async () => {
    setup({ session: opened({ resumed: true, scrollback: "…tail only", scrollbackTruncated: true }) });

    expect(await screen.findByText(/earlier output/i)).toBeInTheDocument();
  });

  it("writes live output straight through, including the escape sequences that carry colour", async () => {
    const { handle, push } = setup();
    await waitFor(() => expect(handle.written).toBeDefined());

    const coloured = `${String.fromCharCode(27)}[32mpassing${String.fromCharCode(27)}[0m`;
    push({ type: "terminal.output", threadId: "thread-1", terminalId: "term-1", data: coloured });

    await waitFor(() => expect(handle.written.join("")).toContain(coloured));
  });

  it("ignores output addressed to a terminal that is not the one on screen", async () => {
    const { handle, push } = setup();
    await waitFor(() => expect(handle.written).toBeDefined());

    push({ type: "terminal.output", threadId: "thread-1", terminalId: "a-previous-terminal", data: "not mine" });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(handle.written.join("")).not.toContain("not mine");
  });

  it("sends what is typed to the server", async () => {
    const { handle, sendInput } = setup();
    await waitFor(() => expect(sendInput).not.toHaveBeenCalled());

    handle.type("ls\r");

    await waitFor(() => expect(sendInput).toHaveBeenCalledWith("term-1", "ls\r"));
  });

  it("offers the keys a soft keyboard does not have", async () => {
    const { sendInput } = setup();

    fireEvent.click(await screen.findByRole("button", { name: "Escape" }));
    fireEvent.click(await screen.findByRole("button", { name: "Tab" }));
    fireEvent.click(await screen.findByRole("button", { name: "Up" }));
    fireEvent.click(await screen.findByRole("button", { name: "Left" }));

    await waitFor(() => {
      expect(sendInput).toHaveBeenCalledWith("term-1", String.fromCharCode(27));
      expect(sendInput).toHaveBeenCalledWith("term-1", "\t");
      expect(sendInput).toHaveBeenCalledWith("term-1", `${String.fromCharCode(27)}[A`);
      expect(sendInput).toHaveBeenCalledWith("term-1", `${String.fromCharCode(27)}[D`);
    });
  });

  it("arms Ctrl for the next key, so Ctrl-C is reachable without a hardware keyboard", async () => {
    const { handle, sendInput } = setup();
    const ctrl = await screen.findByRole("button", { name: "Ctrl" });

    fireEvent.click(ctrl);
    expect(ctrl).toHaveAttribute("aria-pressed", "true");

    handle.type("c");

    await waitFor(() => expect(sendInput).toHaveBeenCalledWith("term-1", String.fromCharCode(3)));
    // One key only — a sticky modifier that stayed armed would turn the
    // next command into control bytes.
    expect(ctrl).toHaveAttribute("aria-pressed", "false");

    handle.type("c");
    await waitFor(() => expect(sendInput).toHaveBeenLastCalledWith("term-1", "c"));
  });

  it("says the shell exited and offers a new one rather than going quietly unresponsive", async () => {
    const { push, openTerminal } = setup();
    await waitFor(() => expect(openTerminal).toHaveBeenCalledTimes(1));

    push({ type: "terminal.exit", threadId: "thread-1", terminalId: "term-1", exit: { exitCode: 130, signal: null } });

    expect(await screen.findByText(/exited/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /new terminal/i }));

    await waitFor(() => expect(openTerminal).toHaveBeenCalledTimes(2));
  });

  it("states what a terminal here actually is, rather than leaving the trust boundary implied", async () => {
    setup();

    // Story 29. Not a warning dialog — a line of text where the terminal is.
    expect(await screen.findByText(/runs as the argusde server/i)).toBeInTheDocument();
  });

  it("shows an error instead of an empty black rectangle when opening fails", async () => {
    setup({ openTerminal: vi.fn(async () => Promise.reject(new Error("Thread is closed: t1"))) });

    expect(await screen.findByText(/Thread is closed/)).toBeInTheDocument();
  });

  it("opens nothing at all when there is no Thread to root a terminal in", async () => {
    const { openTerminal } = setup({ threadId: undefined });

    expect(await screen.findByText(/no thread selected/i)).toBeInTheDocument();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(openTerminal).not.toHaveBeenCalled();
  });

  it("hands the recent output to the composer when asked, bounded and labelled", async () => {
    const { handle, onCapture } = setup();
    handle.recentOutput = "$ pnpm test\r\n636 passed\r\n\n";
    await screen.findByRole("button", { name: /send output to agent/i });

    fireEvent.click(screen.getByRole("button", { name: /send output to agent/i }));

    await waitFor(() =>
      expect(onCapture).toHaveBeenCalledWith({ text: "$ pnpm test\n636 passed", lines: 2, truncated: false, source: "output" }),
    );
  });

  it("captures the selection as a selection, on its own gesture", async () => {
    const { handle, onCapture } = setup();
    handle.selection = "npm ERR! code E404";
    await screen.findByRole("button", { name: /send selection/i });

    fireEvent.click(screen.getByRole("button", { name: /send selection/i }));

    await waitFor(() => expect(onCapture).toHaveBeenCalledWith(expect.objectContaining({ source: "selection" })));
  });

  it("says so rather than capturing nothing when there is nothing to capture", async () => {
    const { onCapture } = setup();
    await screen.findByRole("button", { name: /send selection/i });

    fireEvent.click(screen.getByRole("button", { name: /send selection/i }));

    // Story 28: never attach something the user did not point at — including
    // "the output" when a selection was what they asked for.
    expect(await screen.findByText(/nothing is selected/i)).toBeInTheDocument();
    expect(onCapture).not.toHaveBeenCalled();
  });

  it("offers no capture controls when there is nowhere to send output", async () => {
    setup({ onCapture: undefined });
    await screen.findByRole("button", { name: "Ctrl" });

    expect(screen.queryByRole("button", { name: /send output to agent/i })).toBeNull();
  });
});
