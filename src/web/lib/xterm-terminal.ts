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
