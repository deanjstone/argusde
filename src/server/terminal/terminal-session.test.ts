import { describe, it, expect, vi } from "vitest";
import os from "node:os";
import { TerminalSession, resolveShell, TERMINAL_BOUNDS, type PtyProcess, type SpawnPty, type TerminalSessionOptions } from "./terminal-session.js";

/**
 * A pty this test drives by hand. Everything below the seam (node-pty
 * itself) is exercised separately by the real-pty cases at the bottom of
 * this file — these cases are about the buffering, bounds and flow control
 * the session wraps it in, which a real `yes` can only demonstrate flakily.
 */
function fakePty() {
  let onData: (data: string) => void = () => {};
  let onExit: (e: { exitCode: number; signal?: number }) => void = () => {};
  const pty: PtyProcess & {
    written: string[];
    resized: Array<{ cols: number; rows: number }>;
    killed: boolean;
    paused: boolean;
    pauseCount: number;
    resumeCount: number;
    emit(data: string): void;
    exit(exitCode: number, signal?: number): void;
  } = {
    pid: 4242,
    written: [],
    resized: [],
    killed: false,
    paused: false,
    pauseCount: 0,
    resumeCount: 0,
    onData: (cb) => {
      onData = cb;
    },
    onExit: (cb) => {
      onExit = cb;
    },
    write: (data) => {
      pty.written.push(data);
    },
    resize: (cols, rows) => {
      pty.resized.push({ cols, rows });
    },
    pause: () => {
      pty.paused = true;
      pty.pauseCount += 1;
    },
    resume: () => {
      pty.paused = false;
      pty.resumeCount += 1;
    },
    kill: () => {
      pty.killed = true;
    },
    emit: (data) => onData(data),
    exit: (exitCode, signal) => onExit({ exitCode, signal }),
  };
  return pty;
}

function harness(overrides: Partial<TerminalSessionOptions> = {}) {
  const pty = fakePty();
  const pushes: string[] = [];
  const exits: Array<{ exitCode: number; signal: number | null }> = [];
  const backlog = { bytes: 0 };
  const session = new TerminalSession({
    threadId: "thread-1",
    cwd: os.tmpdir(),
    cols: 80,
    rows: 24,
    spawn: () => pty,
    onOutput: (data) => pushes.push(data),
    onExit: (exit) => exits.push(exit),
    transportBacklog: () => backlog.bytes,
    // Short enough to keep the suite quick, long enough that a burst of
    // writes in the same tick lands in one flush.
    flushIntervalMs: 5,
    ...overrides,
  });
  return { session, pty, pushes, exits, backlog };
}

const flushed = () => new Promise((resolve) => setTimeout(resolve, 40));

/** Ctrl-C, as a client would send it. Written as an escape so the byte itself never lands in a source file. */
const CTRL_C = "\u0003";

describe("TerminalSession", () => {
  it("spawns the resolved shell in the Thread's working tree at the requested size", () => {
    const spawned: Parameters<SpawnPty>[0][] = [];
    const pty = fakePty();
    new TerminalSession({
      threadId: "t",
      cwd: "/tmp/some-worktree",
      cols: 100,
      rows: 30,
      spawn: (opts) => {
        spawned.push(opts);
        return pty;
      },
      env: { SHELL: "/bin/zsh" },
      shellExists: () => true,
      onOutput: () => {},
      onExit: () => {},
    });

    expect(spawned).toHaveLength(1);
    expect(spawned[0]?.cwd).toBe("/tmp/some-worktree");
    expect(spawned[0]?.shell).toBe("/bin/zsh");
    expect(spawned[0]?.cols).toBe(100);
    expect(spawned[0]?.rows).toBe(30);
    // Without this a program cannot know it may emit colour at all, which
    // is the whole point of story 4's "raw output".
    expect(spawned[0]?.env.TERM).toBe("xterm-256color");
  });

  it("forwards input byte-for-byte, including control characters", () => {
    const { session, pty } = harness();

    session.write("ls -la\r");
    session.write(CTRL_C);

    expect(pty.written).toEqual(["ls -la\r", CTRL_C]);
  });

  it("coalesces a burst of chunks into one push rather than one push per chunk", async () => {
    const { session, pty, pushes } = harness();

    // The measurement this exists for: a `yes` flood arrives as ~76k chunks
    // per second of ~1 KiB each. One push per chunk is what starves the
    // socket everything else shares.
    for (let i = 0; i < 500; i += 1) pty.emit(`chunk-${i} `);
    await flushed();

    expect(pushes.length).toBeLessThan(5);
    expect(pushes.join("")).toContain("chunk-0 ");
    expect(pushes.join("")).toContain("chunk-499 ");
    expect(session.exit).toBeNull();
  });

  it("replays scrollback on reattach, keeping the most recent output when it overflows its bound", async () => {
    const { session, pty } = harness({ scrollbackMaxBytes: 1000 });

    pty.emit("A".repeat(600));
    pty.emit("B".repeat(600));
    await flushed();

    const scrollback = session.scrollback();
    // Bounded, and it is the *tail* that survives — a terminal's recent
    // lines are the ones worth replaying.
    expect(scrollback.data.length).toBeLessThanOrEqual(1000);
    expect(scrollback.data.endsWith("B".repeat(600))).toBe(true);
    expect(scrollback.data).not.toContain("A".repeat(600));
    // Story 13: a truncated replay must never read as the whole session.
    expect(scrollback.truncated).toBe(true);
  });

  it("reports scrollback as untruncated while it still fits", async () => {
    const { session, pty } = harness({ scrollbackMaxBytes: 1000 });

    pty.emit("short output\r\n");
    await flushed();

    expect(session.scrollback()).toEqual({ data: "short output\r\n", truncated: false });
  });

  it("pauses the pty when unflushed output passes the high-water mark, and resumes once it drains", async () => {
    const { session, pty } = harness();

    // Faster than one flush window can drain — the case `yes` creates.
    for (let i = 0; i < 40; i += 1) pty.emit("x".repeat(20_000));

    expect(pty.paused).toBe(true);
    await flushed();
    expect(pty.paused).toBe(false);
    expect(pty.resumeCount).toBeGreaterThan(0);
    expect(session.scrollback().data.length).toBeLessThanOrEqual(TERMINAL_BOUNDS.scrollbackMaxBytes);
  });

  it("pauses the pty while the transport is still draining, so terminal output cannot starve chat traffic", async () => {
    const { pty, backlog } = harness();

    backlog.bytes = TERMINAL_BOUNDS.transportBacklogHighWaterBytes + 1;
    pty.emit("noisy");
    await flushed();

    expect(pty.paused).toBe(true);

    backlog.bytes = 0;
    await flushed();
    expect(pty.paused).toBe(false);
  });

  it("records the shell exiting, stops forwarding, and keeps the scrollback readable", async () => {
    const { session, pty, exits } = harness();

    pty.emit("goodbye\r\n");
    pty.exit(3, undefined);
    await flushed();

    expect(exits).toEqual([{ exitCode: 3, signal: null }]);
    expect(session.exit).toEqual({ exitCode: 3, signal: null });
    // Story 9: a dead terminal has to be obviously dead rather than
    // silently unresponsive — a write is refused, not swallowed.
    expect(() => session.write("still there?")).toThrow(/exited/i);
    expect(session.scrollback().data).toContain("goodbye");
  });

  it("passes a resize through to the process and remembers the new size", () => {
    const { session, pty } = harness();

    session.resize(120, 40);

    expect(pty.resized).toEqual([{ cols: 120, rows: 40 }]);
    expect(session.cols).toBe(120);
    expect(session.rows).toBe(40);
  });

  it("clamps an absurd resize rather than passing it to the process", () => {
    const { session, pty } = harness();

    session.resize(0, 99_999);

    expect(pty.resized).toEqual([{ cols: 1, rows: TERMINAL_BOUNDS.maxRows }]);
  });

  it("kills the process on dispose and flushes nothing afterwards", async () => {
    const { session, pty, pushes } = harness();

    await session.dispose();

    expect(pty.killed).toBe(true);
    pty.emit("output after dispose");
    await flushed();
    expect(pushes.join("")).not.toContain("output after dispose");
  });
});

describe("resolveShell", () => {
  it("prefers the user's own $SHELL, so their prompt, aliases and environment are the ones they know", () => {
    expect(resolveShell({ SHELL: "/usr/bin/fish" }, () => true)).toBe("/usr/bin/fish");
  });

  it("falls back to /bin/bash, then /bin/sh, when $SHELL is unset or missing from disk", () => {
    expect(resolveShell({}, (candidate) => candidate === "/bin/bash")).toBe("/bin/bash");
    expect(resolveShell({ SHELL: "/opt/deleted-shell" }, (candidate) => candidate === "/bin/sh")).toBe("/bin/sh");
    // Nothing on disk at all: still returns something rather than throwing.
    // spawn's own failure is a better error than this function guessing.
    expect(resolveShell({}, () => false)).toBe("/bin/sh");
  });
});

describe("TerminalSession over a real pty", () => {
  // The fake above cannot prove node-pty is installed, built and behaving
  // like a terminal. These do — and they are what would catch a broken
  // native build rather than shipping one.
  const itPosix = os.platform() === "win32" ? it.skip : it;

  itPosix("runs a real command in a real shell and reports the shell's exit", async () => {
    const output: string[] = [];
    const exits: Array<{ exitCode: number; signal: number | null }> = [];
    const session = new TerminalSession({
      threadId: "real",
      cwd: os.tmpdir(),
      cols: 80,
      rows: 24,
      env: { ...process.env, SHELL: "/bin/sh" },
      onOutput: (data) => output.push(data),
      onExit: (exit) => exits.push(exit),
      flushIntervalMs: 5,
    });

    session.write("echo TERMINAL_OK_$((6*7))\n");
    await vi.waitFor(() => expect(output.join("")).toContain("TERMINAL_OK_42"), { timeout: 10_000 });

    session.write("exit 7\n");
    await vi.waitFor(() => expect(exits).toHaveLength(1), { timeout: 10_000 });
    expect(exits[0]?.exitCode).toBe(7);
    expect(session.exit?.exitCode).toBe(7);

    await session.dispose();
  });

  itPosix("gives the process a terminal that reports colour support", async () => {
    const output: string[] = [];
    const session = new TerminalSession({
      threadId: "real-colour",
      cwd: os.tmpdir(),
      cols: 80,
      rows: 24,
      env: { ...process.env, SHELL: "/bin/sh" },
      onOutput: (data) => output.push(data),
      onExit: () => {},
      flushIntervalMs: 5,
    });

    // A program deciding whether to emit colour asks the terminal, not us.
    session.write("echo COLOURS=$TERM\n");
    await vi.waitFor(() => expect(output.join("")).toContain("COLOURS=xterm-256color"), { timeout: 10_000 });

    await session.dispose();
  });

  itPosix("keeps running while nothing is attached, so a phone going to sleep does not kill a build", async () => {
    const output: string[] = [];
    const session = new TerminalSession({
      threadId: "real-detached",
      cwd: os.tmpdir(),
      cols: 80,
      rows: 24,
      env: { ...process.env, SHELL: "/bin/sh" },
      onOutput: (data) => output.push(data),
      onExit: () => {},
      flushIntervalMs: 5,
    });

    // Nothing here represents a client at all — the session owns the
    // process, so there is no attachment to lose.
    session.write("(sleep 0.4; echo STILL_RUNNING) &\n");
    await vi.waitFor(() => expect(session.scrollback().data).toContain("STILL_RUNNING"), { timeout: 10_000 });

    await session.dispose();
  });
});

describe("TerminalSession disposal, against a real process", () => {
  const itPosix = os.platform() === "win32" ? it.skip : it;

  itPosix("actually kills the shell, so closing a Thread cannot leave one running", async () => {
    const output: string[] = [];
    const session = new TerminalSession({
      threadId: "real-kill",
      cwd: os.tmpdir(),
      cols: 80,
      rows: 24,
      env: { ...process.env, SHELL: "/bin/sh" },
      onOutput: (data) => output.push(data),
      onExit: () => {},
      flushIntervalMs: 5,
    });

    // The shell's own pid, from the shell — nothing else here can prove the
    // process is gone rather than merely unreferenced.
    session.write("echo PID=$$\n");
    await vi.waitFor(() => expect(output.join("")).toMatch(/PID=\d+/), { timeout: 10_000 });
    const pid = Number(/PID=(\d+)/.exec(output.join(""))?.[1]);
    expect(pid).toBeGreaterThan(0);
    expect(() => process.kill(pid, 0)).not.toThrow();

    await session.dispose();

    await vi.waitFor(
      () => {
        // Signal 0 checks for existence without delivering anything.
        expect(() => process.kill(pid, 0)).toThrow(/ESRCH/);
      },
      { timeout: 10_000 },
    );
  });
});
