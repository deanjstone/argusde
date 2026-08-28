import { useCallback, useEffect, useRef, useState } from "react";
import type { TerminalExitPush, TerminalOpened, TerminalOutputPush } from "../../shared/ws-protocol.js";
import { createXtermTerminal, type CreateTerminal, type TerminalHandle } from "../lib/xterm-terminal.js";
import { Badge } from "./ui/badge.js";
import { Button } from "./ui/button.js";
import { Empty, EmptyDescription, EmptyTitle } from "./ui/empty.js";
import { Spinner } from "./ui/spinner.js";

export type TerminalPush = TerminalOutputPush | TerminalExitPush;

export interface TerminalViewProps {
  /** Absent when no Thread is active — a terminal is rooted in a Thread's working tree, so there is nothing to open without one. */
  threadId: string | undefined;
  openTerminal: (cols: number, rows: number) => Promise<TerminalOpened>;
  sendInput: (terminalId: string, data: string) => Promise<void>;
  resizeTerminal: (terminalId: string, cols: number, rows: number) => Promise<void>;
  closeTerminal: (terminalId: string) => Promise<void>;
  subscribe: (listener: (push: TerminalPush) => void) => () => void;
  /** Swappable so this component's tests can drive a terminal by hand rather than stand up a real emulator in jsdom. */
  createTerminal?: CreateTerminal;
}

const ESC = String.fromCharCode(27);

/**
 * The keys a soft keyboard does not offer, which is most of the ones a
 * terminal needs (story 19). Ctrl is separate below — it is a modifier, not
 * a key that sends something on its own.
 */
const KEYS: { label: string; data: string; title: string }[] = [
  { label: "Escape", data: ESC, title: "Escape" },
  { label: "Tab", data: "\t", title: "Tab" },
  { label: "Up", data: `${ESC}[A`, title: "Up arrow" },
  { label: "Down", data: `${ESC}[B`, title: "Down arrow" },
  { label: "Left", data: `${ESC}[D`, title: "Left arrow" },
  { label: "Right", data: `${ESC}[C`, title: "Right arrow" },
];

/** Ctrl-<letter> is the letter's position in the alphabet: Ctrl-C is 3, Ctrl-D is 4. Returns null for anything that has no control form. */
function controlByte(key: string): string | null {
  if (key.length !== 1) return null;
  const code = key.toUpperCase().charCodeAt(0);
  if (code >= 64 && code <= 95) return String.fromCharCode(code - 64);
  return null;
}

/**
 * The Thread's terminal (spec #128 phase 2).
 *
 * The process lives on the server, so this component is a *view* of it and
 * nothing more: leaving the tab disposes the emulator, not the shell, and
 * coming back reattaches and replays what was missed. That is why there is
 * no "disconnected" state here — from this side, a terminal is either open
 * or not yet opened.
 */
export function TerminalView({
  threadId,
  openTerminal,
  sendInput,
  resizeTerminal,
  closeTerminal,
  subscribe,
  createTerminal = createXtermTerminal,
}: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const handleRef = useRef<TerminalHandle | null>(null);
  const sessionRef = useRef<TerminalOpened | null>(null);
  const ctrlArmedRef = useRef(false);

  const [session, setSession] = useState<TerminalOpened | null>(null);
  const [exit, setExit] = useState<TerminalOpened["exit"]>(null);
  const [error, setError] = useState<string | undefined>(undefined);
  const [opening, setOpening] = useState(false);
  const [ctrlArmed, setCtrlArmed] = useState(false);
  // Bumped to ask for a fresh shell after one has exited (story 9).
  const [attempt, setAttempt] = useState(0);

  const send = useCallback(
    (data: string) => {
      const current = sessionRef.current;
      if (!current) return;
      void sendInput(current.terminalId, data).catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      });
    },
    [sendInput],
  );

  useEffect(() => {
    if (!threadId) return;
    const container = containerRef.current;
    if (!container) return;

    let cancelled = false;
    let handle: TerminalHandle | null = null;
    let unsubscribeInput: (() => void) | null = null;

    setOpening(true);
    setError(undefined);
    void (async () => {
      try {
        handle = await createTerminal({ container });
        if (cancelled) {
          handle.dispose();
          return;
        }
        handleRef.current = handle;

        const measured = handle.fit();
        const opened = await openTerminal(measured.cols, measured.rows);
        if (cancelled) return;

        sessionRef.current = opened;
        setSession(opened);
        setExit(opened.exit);
        // Everything the terminal printed while nothing was attached
        // (stories 12 and 14). Written before input is wired up so nothing
        // typed can interleave into the middle of the replay.
        if (opened.scrollback) handle.write(opened.scrollback);

        unsubscribeInput = handle.onInput((data) => {
          if (ctrlArmedRef.current) {
            ctrlArmedRef.current = false;
            setCtrlArmed(false);
            const control = controlByte(data);
            if (control) {
              send(control);
              return;
            }
          }
          send(data);
        });
        handle.focus();
      } catch (cause: unknown) {
        if (!cancelled) setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (!cancelled) setOpening(false);
      }
    })();

    return () => {
      cancelled = true;
      unsubscribeInput?.();
      handleRef.current?.dispose();
      handleRef.current = null;
      // Deliberately *not* closeTerminal: leaving this tab must not kill a
      // running build. The server owns the process; this was only a view of
      // it, and the next open reattaches.
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [threadId, attempt]);

  useEffect(() => {
    return subscribe((push) => {
      const current = sessionRef.current;
      // A push for a terminal that has since been replaced belongs to a
      // session this view is no longer showing.
      if (!current || push.terminalId !== current.terminalId) return;
      if (push.type === "terminal.output") {
        handleRef.current?.write(push.data);
        return;
      }
      setExit(push.exit);
    });
  }, [subscribe]);

  // Re-measure whenever the space changes — a rotated phone, a soft keyboard
  // opening, a resized window — and tell the process, so a TUI redraws to
  // the room it actually has (story 6, and story 20 on a phone).
  useEffect(() => {
    if (!session) return;
    let frame = 0;
    const refit = () => {
      window.clearTimeout(frame);
      frame = window.setTimeout(() => {
        const handle = handleRef.current;
        const current = sessionRef.current;
        if (!handle || !current) return;
        const measured = handle.fit();
        void resizeTerminal(current.terminalId, measured.cols, measured.rows).catch(() => {
          // A resize that does not land is not worth an error banner: the
          // next one supersedes it, and the terminal is still usable.
        });
      }, 100);
    };

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(refit);
    if (observer && containerRef.current) observer.observe(containerRef.current);
    window.visualViewport?.addEventListener("resize", refit);
    return () => {
      window.clearTimeout(frame);
      observer?.disconnect();
      window.visualViewport?.removeEventListener("resize", refit);
    };
  }, [session, resizeTerminal]);

  function startFreshTerminal() {
    const current = sessionRef.current;
    sessionRef.current = null;
    setSession(null);
    setExit(null);
    // The old one is already dead when this is offered after an exit; closing
    // it is what makes the server hand back a new shell rather than the
    // corpse. Failure is ignored on purpose — terminal.open replaces an
    // exited session anyway.
    if (current) void closeTerminal(current.terminalId).catch(() => undefined);
    setAttempt((n) => n + 1);
  }

  if (!threadId) {
    return (
      <div className="flex h-full items-center justify-center bg-background p-4">
        <Empty>
          <EmptyTitle>No thread selected</EmptyTitle>
          <EmptyDescription>A terminal runs in a Thread&apos;s working tree — pick one from the Threads tab.</EmptyDescription>
        </Empty>
      </div>
    );
  }

  return (
    <section className="flex h-full min-h-0 flex-col bg-background" aria-label="Terminal">
      <header className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-2 text-xs">
        {session ? (
          <>
            {/* Where the shell is, and what it is on. The shell prints its
                own directory in its prompt anyway — the point here is that
                it is legible before the first command. */}
            <span className="truncate font-mono text-muted-foreground" title={session.cwd}>
              {session.cwd}
            </span>
            {session.branch ? (
              <Badge variant="secondary">{session.branch}</Badge>
            ) : (
              <Badge variant="outline">{session.detached ? "detached HEAD" : "no branch"}</Badge>
            )}
            <span className="font-mono text-muted-foreground">{session.shell}</span>
          </>
        ) : (
          <span className="flex items-center gap-2 text-muted-foreground">
            {opening ? (
              <>
                <Spinner /> Starting a shell…
              </>
            ) : (
              "No terminal"
            )}
          </span>
        )}
      </header>

      {session?.scrollbackTruncated && (
        <p className="border-b border-border px-3 py-1.5 text-xs text-muted-foreground">
          Earlier output was dropped — this terminal has printed more than is kept for replay.
        </p>
      )}

      {exit && (
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2 text-xs">
          <span className="text-foreground">
            The shell exited{exit.signal !== null ? ` on signal ${exit.signal}` : ""} with code {exit.exitCode}.
          </span>
          <Button size="sm" variant="secondary" onClick={startFreshTerminal}>
            New terminal
          </Button>
        </div>
      )}

      {error && (
        <p role="alert" className="border-b border-border px-3 py-2 text-xs text-destructive">
          {error}
        </p>
      )}

      {/* The emulator's own element. A plain div, deliberately: xterm needs a
          real ref, and shadcn primitives cannot take one under this
          project's React 18 (argusde#122). */}
      <div ref={containerRef} data-testid="terminal-surface" className="min-h-0 flex-1 overflow-hidden px-1 py-1" />

      <div className="flex flex-wrap items-center gap-1 border-t border-border px-2 py-1.5">
        <Button
          size="sm"
          variant={ctrlArmed ? "default" : "outline"}
          aria-pressed={ctrlArmed}
          onClick={() => {
            const next = !ctrlArmed;
            ctrlArmedRef.current = next;
            setCtrlArmed(next);
          }}
        >
          Ctrl
        </Button>
        {KEYS.map((key) => (
          <Button key={key.label} size="sm" variant="outline" title={key.title} onClick={() => send(key.data)}>
            {key.label}
          </Button>
        ))}
      </div>

      {/* Story 29: the trust boundary, stated where the terminal is rather
          than left to be inferred. Not a dialog — this is a fact about the
          surface, not a warning to dismiss. */}
      <p className="border-t border-border px-3 py-1.5 text-[11px] leading-snug text-muted-foreground">
        Runs as the ArgusDE server user, on the machine the server is on. Anyone who can reach this app on your tailnet can use it.
      </p>
    </section>
  );
}
