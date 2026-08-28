import { documentStyleNonce, withStyleNonce } from "./style-nonce.js";

/**
 * The terminal emulator, behind the smallest interface the view actually
 * needs (spec #128 phase 2).
 *
 * A seam rather than a direct dependency for two reasons: it keeps xterm
 * out of the main bundle (see `createXtermTerminal` below), and it lets the
 * view's own tests drive a terminal by hand instead of standing up a real
 * emulator in jsdom.
 */
export interface TerminalHandle {
  /** Output from the server, written verbatim — escape sequences and all. */
  write(data: string): void;
  /** Keystrokes headed the other way. Returns an unsubscribe. */
  onInput(listener: (data: string) => void): () => void;
  /** Re-measures the container and returns the size the process should be told about. */
  fit(): { cols: number; rows: number };
  /** Whatever the user has highlighted, or "" — one of the two explicit capture gestures (spec #128 phase 3, story 28). */
  getSelection(): string;
  /**
   * The tail of what the terminal has printed, up to `maxLines`.
   *
   * Deliberately "recent output" rather than "the last command's output":
   * without shell integration (OSC 133 prompt marks) a terminal genuinely
   * cannot know where a command began, and a guessed boundary attaches the
   * wrong thing confidently. The user picks the gesture; this returns what
   * is there.
   */
  readRecentOutput(maxLines: number): string;
  focus(): void;
  dispose(): void;
}

export type CreateTerminal = (options: { container: HTMLElement }) => Promise<TerminalHandle>;

/**
 * Real xterm.js, loaded on demand.
 *
 * The import is dynamic because xterm is ~86 KiB gzipped against an app
 * bundle of ~127 KiB, and this app's service worker deliberately does not
 * cache (spec #33 phase 10) — so a static import would put that on every
 * load of every surface, including for someone who never opens a terminal.
 * Loading it when the Terminal tab is first opened costs the person who
 * asked for it, once.
 *
 * `term.open()` runs inside `withStyleNonce` because xterm builds `<style>`
 * elements with no way to nonce them, and this app's CSP has no
 * `unsafe-inline` — see style-nonce.ts for the full account and what was
 * ruled out.
 */
export const createXtermTerminal: CreateTerminal = async ({ container }) => {
  const [{ Terminal }, { FitAddon }] = await Promise.all([
    import("@xterm/xterm"),
    import("@xterm/addon-fit"),
    // Vite emits this as its own stylesheet alongside the chunk and loads
    // it with a plain <link>, which `style-src 'self'` allows — unlike the
    // elements xterm builds at runtime.
    import("@xterm/xterm/css/xterm.css"),
  ]);

  const terminal = new Terminal({
    // Theme colours come from the app's own tokens rather than xterm's
    // defaults, so the terminal belongs to the same surface as everything
    // else. Read off the computed styles because the tokens are CSS
    // variables, and xterm wants concrete colours.
    theme: readThemeColours(container),
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, "Liberation Mono", monospace',
    fontSize: 13,
    // Enough that a wrapped stack trace is scrollable in the client too,
    // while the server keeps its own bounded scrollback for reattachment.
    scrollback: 5000,
    cursorBlink: true,
    // macOS-style option-as-meta is wrong for the Linux/Windows keyboards
    // this app is used from, and it eats accented characters.
    macOptionIsMeta: false,
  });

  const fitAddon = new FitAddon();
  terminal.loadAddon(fitAddon);
  withStyleNonce(documentStyleNonce(), () => terminal.open(container));
  fitAddon.fit();

  return {
    write: (data) => terminal.write(data),
    onInput: (listener) => {
      const subscription = terminal.onData(listener);
      return () => subscription.dispose();
    },
    fit: () => {
      // Re-measuring can also create style elements (the dimension rule),
      // so it needs the same cover as open().
      withStyleNonce(documentStyleNonce(), () => fitAddon.fit());
      return { cols: terminal.cols, rows: terminal.rows };
    },
    getSelection: () => terminal.getSelection(),
    readRecentOutput: (maxLines) => {
      const buffer = terminal.buffer.active;
      // baseY is the top of the viewport within the scrollback, so this is
      // the last written row — reading past it returns the blank rows the
      // viewport is padded with.
      const end = buffer.baseY + terminal.rows;
      const start = Math.max(0, end - maxLines);
      const lines: string[] = [];
      for (let row = start; row < end; row += 1) {
        // `true` trims each row's trailing whitespace: a terminal pads every
        // line to the full width, and 80-column padding would be most of
        // what got captured.
        lines.push(buffer.getLine(row)?.translateToString(true) ?? "");
      }
      return lines.join("\n");
    },
    focus: () => terminal.focus(),
    dispose: () => terminal.dispose(),
  };
};

/** Pulls the app's theme tokens off the DOM so the terminal is not a differently-coloured hole in the page. */
function readThemeColours(container: HTMLElement): { background: string; foreground: string; cursor: string } {
  const styles = getComputedStyle(container);
  const token = (name: string, fallback: string) => styles.getPropertyValue(name).trim() || fallback;
  return {
    background: token("--background", "#0a0a0a"),
    foreground: token("--foreground", "#e5e5e5"),
    cursor: token("--primary-bright", "#a78bfa"),
  };
}
