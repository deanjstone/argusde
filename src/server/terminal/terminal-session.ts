import { randomUUID } from "node:crypto";
import fs from "node:fs";
import * as nodePty from "node-pty";

/**
 * One pseudo-terminal, owned by the server for the lifetime of a Thread
 * (spec #128 phase 1).
 *
 * The session — not the WebSocket — owns the process. That is the whole
 * point of the surface: a phone going to sleep mid-build must not kill the
 * build, so there is no "attached client" concept here at all. Clients come
 * and go; they are handed the scrollback when they arrive and the live
 * output while they are there.
 *
 * Nothing here is persisted. A terminal describes what a *live server* is
 * running, exactly like context usage and the agent's plan (see
 * CONTEXT.md), so a value carried across a restart would describe a process
 * that no longer exists. #128 makes that limit visible in the UI rather
 * than papering over it.
 */

/** The half of node-pty's IPty this code uses, as its own type so tests can drive a pty by hand. */
export interface PtyProcess {
  readonly pid: number;
  onData(callback: (data: string) => void): void;
  onExit(callback: (event: { exitCode: number; signal?: number }) => void): void;
  write(data: string): void;
  resize(cols: number, rows: number): void;
  /** Flow control, straight through to the underlying fd — see TERMINAL_BOUNDS for why this matters more than it looks. */
  pause(): void;
  resume(): void;
  kill(signal?: string): void;
}

export type SpawnPty = (options: {
  shell: string;
  args: string[];
  cwd: string;
  cols: number;
  rows: number;
  env: NodeJS.ProcessEnv;
}) => PtyProcess;

export interface TerminalExit {
  exitCode: number;
  /** null rather than undefined — it crosses the wire, where undefined would simply vanish from the JSON. */
  signal: number | null;
}

export interface TerminalScrollback {
  data: string;
  /** True once output has been dropped from the front of the buffer, so a partial replay never reads as a whole session. */
  truncated: boolean;
}

export interface TerminalSessionOptions {
  threadId: string;
  /** The Thread's working tree — its Worktree when promoted, the Project's workspace root otherwise. Resolved by the caller, never guessed here. */
  cwd: string;
  cols: number;
  rows: number;
  onOutput: (data: string) => void;
  onExit: (exit: TerminalExit) => void;
  /** Defaults to a real node-pty spawn; tests pass a fake. Same DI style as createSession/createTransport elsewhere in this server. */
  spawn?: SpawnPty;
  env?: NodeJS.ProcessEnv;
  /** Existence check for shell resolution — injectable so resolveShell's fallback chain is testable without touching the machine's real /bin. */
  shellExists?: (candidate: string) => boolean;
  /**
   * How many bytes the transport still has queued for its slowest client.
   * The session pauses the process while this is high, which is what stops
   * a noisy terminal starving the chat traffic on the same socket.
   */
  transportBacklog?: () => number;
  flushIntervalMs?: number;
  scrollbackMaxBytes?: number;
}

/**
 * Every bound in one place, with the measurement each came from.
 *
 * Measured against a real pty on this machine (spec #128's "verify before
 * designing" #4): `yes` sustains **50 MiB/s across ~76,000 chunks per
 * second, averaging ~1 KiB a chunk**. One WebSocket frame per chunk would
 * be 76k frames a second through the same socket the conversation uses.
 * Hence coalescing, and hence real flow control rather than a drop policy:
 * `pause()` was verified to stop the flow dead (zero bytes after the call)
 * and `resume()` to restore it, so nothing has to be thrown away to keep
 * memory bounded.
 */
export const TERMINAL_BOUNDS = {
  /**
   * ~5 milliseconds of a runaway flood, but roughly 2,000 lines of ordinary
   * command output — which is what scrollback is actually for. Sized for a
   * human catching up, not for capturing a firehose.
   */
  scrollbackMaxBytes: 256 * 1024,
  /** Unflushed output above this pauses the process; it resumes below the low-water mark. */
  pendingHighWaterBytes: 512 * 1024,
  pendingLowWaterBytes: 64 * 1024,
  /** Socket backlog above this pauses the process, so terminal output yields to everything else sharing the connection. */
  transportBacklogHighWaterBytes: 1024 * 1024,
  /** One animation frame: at the measured chunk rate this turns ~1,200 chunks into a single push. */
  flushIntervalMs: 16,
  maxCols: 1000,
  maxRows: 1000,
} as const;

/**
 * The user's own shell, so their prompt, aliases and environment are the
 * ones they know (story 8) — with a stated fallback chain rather than an
 * implicit one.
 */
export function resolveShell(
  env: NodeJS.ProcessEnv = process.env,
  exists: (candidate: string) => boolean = (candidate) => fs.existsSync(candidate),
): string {
  const candidates = [env.SHELL, "/bin/bash", "/bin/sh"];
  for (const candidate of candidates) {
    if (candidate && exists(candidate)) return candidate;
  }
  // Nothing on disk at all. Return the last resort anyway: spawn's own
  // failure names the missing binary, which is a better error than a guess
  // made here.
  return "/bin/sh";
}

/** Real node-pty. Kept behind the same seam as the fake so nothing else in this file knows which it has. */
const spawnNodePty: SpawnPty = ({ shell, args, cwd, cols, rows, env }) =>
  nodePty.spawn(shell, args, { name: "xterm-256color", cwd, cols, rows, env: env as { [key: string]: string } });

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, Math.trunc(value)));
}

export class TerminalSession {
  /** Stable for the life of the process. On the wire from day one so a second terminal per Thread stays an additive change (#128). */
  readonly id = randomUUID();
  readonly threadId: string;
  readonly cwd: string;
  readonly shell: string;
  readonly createdAt = new Date().toISOString();

  #pty: PtyProcess;
  #options: TerminalSessionOptions;
  #cols: number;
  #rows: number;
  #exit: TerminalExit | null = null;
  #disposed = false;

  #pending: string[] = [];
  #pendingBytes = 0;
  #flushTimer: NodeJS.Timeout | null = null;
  #paused = false;

  #scrollback = "";
  #scrollbackTruncated = false;

  constructor(options: TerminalSessionOptions) {
    this.#options = options;
    this.threadId = options.threadId;
    this.cwd = options.cwd;
    this.#cols = clamp(options.cols, 1, TERMINAL_BOUNDS.maxCols);
    this.#rows = clamp(options.rows, 1, TERMINAL_BOUNDS.maxRows);

    const env = options.env ?? process.env;
    this.shell = resolveShell(env, options.shellExists);

    const spawn = options.spawn ?? spawnNodePty;
    this.#pty = spawn({
      shell: this.shell,
      // No arguments: a shell handed a tty runs interactively by itself and
      // reads the user's interactive rc file, which is where their aliases
      // and prompt live. Forcing -l would source the login profile instead
      // and diverge from the terminal they already use.
      args: [],
      cwd: options.cwd,
      cols: this.#cols,
      rows: this.#rows,
      env: {
        ...env,
        // A program decides whether to emit colour by asking the terminal.
        // Without this it asks and is told nothing, so story 4's "raw
        // output including colour" would quietly become monochrome.
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      },
    });

    this.#pty.onData((data) => this.#onData(data));
    this.#pty.onExit(({ exitCode, signal }) => this.#onExit(exitCode, signal ?? null));
  }

  get cols(): number {
    return this.#cols;
  }

  get rows(): number {
    return this.#rows;
  }

  /** Null while the shell is alive. Set once, and the session is never reused afterwards — #128 opens a fresh one instead. */
  get exit(): TerminalExit | null {
    return this.#exit;
  }

  write(data: string): void {
    if (this.#exit) throw new Error(`Terminal has exited (code ${this.#exit.exitCode})`);
    if (this.#disposed) throw new Error("Terminal has been closed");
    this.#pty.write(data);
  }

  resize(cols: number, rows: number): void {
    if (this.#exit || this.#disposed) return;
    this.#cols = clamp(cols, 1, TERMINAL_BOUNDS.maxCols);
    this.#rows = clamp(rows, 1, TERMINAL_BOUNDS.maxRows);
    this.#pty.resize(this.#cols, this.#rows);
  }

  /** What a client arriving now should be shown before live output starts. */
  scrollback(): TerminalScrollback {
    return { data: this.#scrollback, truncated: this.#scrollbackTruncated };
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#flushTimer) {
      clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    this.#pending = [];
    this.#pendingBytes = 0;
    try {
      this.#pty.kill();
    } catch (error) {
      // An already-dead process is the common case here (the shell exited a
      // moment before the Thread was closed) and must not fail a close.
      // Anything else is still worth a trail — never a silent catch.
      const message = error instanceof Error ? error.message : String(error);
      if (!/ESRCH|no such process/i.test(message)) {
        console.warn(`Terminal ${this.id} failed to kill its process: ${message}`);
      }
    }
  }

  #onData(data: string): void {
    if (this.#disposed) return;
    this.#pending.push(data);
    this.#pendingBytes += data.length;
    // Checked on arrival, not on the flush tick: at the measured 50 MiB/s a
    // single tick's worth of unchecked buffering is most of a megabyte.
    if (this.#pendingBytes >= TERMINAL_BOUNDS.pendingHighWaterBytes) this.#pause();
    this.#scheduleFlush();
  }

  #onExit(exitCode: number, signal: number | null): void {
    if (this.#exit) return;
    this.#exit = { exitCode, signal };
    // Flush whatever the process printed on its way out before announcing
    // the exit, so a failure message never loses its last line.
    this.#flush();
    if (!this.#disposed) this.#options.onExit(this.#exit);
  }

  #scheduleFlush(): void {
    if (this.#flushTimer || this.#disposed) return;
    const interval = this.#options.flushIntervalMs ?? TERMINAL_BOUNDS.flushIntervalMs;
    this.#flushTimer = setTimeout(() => {
      this.#flushTimer = null;
      this.#flush();
    }, interval);
    // Never hold the process open on a terminal's flush timer.
    this.#flushTimer.unref?.();
  }

  #flush(): void {
    if (this.#disposed) return;

    if (this.#pending.length > 0) {
      const data = this.#pending.join("");
      this.#pending = [];
      this.#pendingBytes = 0;
      this.#appendScrollback(data);
      this.#options.onOutput(data);
    }

    const backlog = this.#options.transportBacklog?.() ?? 0;
    const congested = backlog >= TERMINAL_BOUNDS.transportBacklogHighWaterBytes;
    if (congested) {
      this.#pause();
      // Nothing else will wake this session while the process is paused —
      // no data means no onData — so the resume check has to keep its own
      // timer running until the transport drains.
      this.#scheduleFlush();
      return;
    }

    if (this.#paused && this.#pendingBytes <= TERMINAL_BOUNDS.pendingLowWaterBytes) this.#resume();
  }

  #appendScrollback(data: string): void {
    const max = this.#options.scrollbackMaxBytes ?? TERMINAL_BOUNDS.scrollbackMaxBytes;
    this.#scrollback += data;
    if (this.#scrollback.length > max) {
      this.#scrollback = this.#scrollback.slice(this.#scrollback.length - max);
      this.#scrollbackTruncated = true;
    }
  }

  #pause(): void {
    if (this.#paused || this.#exit) return;
    this.#paused = true;
    this.#pty.pause();
  }

  #resume(): void {
    if (!this.#paused || this.#exit) return;
    this.#paused = false;
    this.#pty.resume();
  }
}
