# Phase 23: Server-side PTY, protocol and lifecycle

> Implemented via `feature/terminal-pty`. Ticket: [#128](https://github.com/deanjstone/argusde/issues/128) phase 1 — the first phase of the terminal spec, which was itself specced from wayfinder map [#83](https://github.com/deanjstone/argusde/issues/83)'s decision ticket [#88](https://github.com/deanjstone/argusde/issues/88) (reversing [#7](https://github.com/deanjstone/argusde/issues/7)). Follows [phase 22](phase-22-plan-panel.md), the last phase of spec #93.

## Context

> As a user, I want to open a terminal for the Thread I am working in, so that I can run a command without leaving the app.

Stories 1–3, 5–6, 8–10, 15–18 and 30 — the whole server half. No UI: the Terminal tab is phase 2, and the composer capture is phase 3. `API_VERSION` **1.5.0 → 1.6.0**: four commands and two pushes are new.

With browsing, search, diff review and durable activity all shipped by spec #93, running one command was the last thing forcing the user out of the app — and on a phone there is nowhere to go.

## Verified before designing

#128 named four things to check first rather than assume. All four were checked against the real thing, and two of them changed the design.

1. **`node-pty` under Node 22.** Builds and runs. `node-pty@1.1.0`, Node v22.22.2, Linux: spawns a real shell, ANSI escapes present in the output, exit code propagated. Prebuilds ship for darwin/win32 only, so Linux compiles locally — `allowBuilds: node-pty: true` in `pnpm-workspace.yaml`, one line beside `better-sqlite3` exactly as #88 predicted. No electron-rebuild: this server is plain Node.
2. **A `yes` flood, measured.** 50.3 MiB/s across ~76,000 chunks a second, averaging ~1 KiB a chunk. `pause()` stops it dead — zero bytes arrived after the call — and `resume()` restores it. That measurement is what chose flow control over a drop policy, and it is quoted in `TERMINAL_BOUNDS` where the numbers live.
3. **xterm.js under this app's CSP — it is blocked.** See below; this is a phase 2 problem, reported on #128 rather than worked around here.
4. **Bundle cost:** `@xterm/xterm` v6 is ~86 KiB gzipped plus ~2.5 KiB of CSS, against the app's current 127 KiB. On a deliberately non-caching service worker that is paid on every load, so phase 2 should load it only when the Terminal tab is first opened.

### The CSP finding

`@xterm/xterm` v6 creates `<style>` elements and sets their `textContent` — theme colours, cell dimensions, the scrollable element. Under this app's `style-src 'self' 'nonce-…'` (no `unsafe-inline`, since [#121](https://github.com/deanjstone/argusde/pull/121)) Chromium raises **10 `style-src-elem` violations** and every one of those sheets applies **zero rules**.

All three mitigations #128 listed fail: xterm has no nonce option (zero occurrences in its source or typings), the renderer addons do not avoid it because one of the injection sites is in the core scrollable element rather than the DOM renderer, and the content is dynamic so a hash cannot cover it. `'unsafe-inline'` is not an option and would not even work — a browser ignores it when a nonce is present.

Two mitigations that *do* work were found and verified in a real browser; the choice belongs to phase 2 and is [reported on #128](https://github.com/deanjstone/argusde/issues/128).

## Design

### 1. The session owns the process, not the socket

There is no "attached client" concept anywhere in `TerminalSession`. Clients are handed the scrollback when they arrive and the live output while they are there; the process neither knows nor cares. That is what makes story 11 — a phone sleeping mid-build — true by construction rather than by a reconnect protocol.

### 2. Nothing is persisted

A terminal describes a live process, so it is session-scoped exactly like context usage and the plan. `terminal.open` after a restart returns `resumed: false`, which is the honest answer and the one story 16 asks the UI to show. Persisting scrollback to SQLite was considered and rejected in the spec itself.

### 3. Flow control, not a drop policy

Output is coalesced on a 16 ms tick (one frame). The process is paused when unflushed output passes 512 KiB — checked on arrival, not on the tick, because at 50 MiB/s a single tick is most of a megabyte — or when the slowest client's socket backlog passes 1 MiB, and resumed once both drain. Nothing is discarded, memory stays bounded, and the chat traffic sharing the socket keeps moving. Scrollback is separately bounded at 256 KiB, dropping from the front and flagging itself truncated.

### 4. One terminal per Thread, with an id on the wire anyway

`terminals` is keyed by Thread. Every command still carries a `terminalId`, which makes "several terminals" an additive change later and, today, stops a stale client typing into a terminal that has been replaced.

### 5. Every teardown path

Thread close (after the in-flight-turn check, before the worktree is removed), project delete, and server shutdown all dispose terminals. The first two are the leak classes this codebase has already been bitten by with agent subprocesses (argusde#67, #35); a terminal is a process too.

## Files

- `src/server/terminal/terminal-session.ts` (new) — the PTY session, its bounds, and shell resolution
- `src/shared/ws-protocol.ts` — four commands, two pushes, `TerminalOpened`, `API_VERSION` 1.6.0
- `src/server/ws/ws-server.ts` — the terminal registry, handlers, transport-backlog gauge, teardown on close/delete/shutdown
- `pnpm-workspace.yaml` — `allowBuilds: node-pty`
- `CONTEXT.md` — Terminal, Scrollback, Flow control as domain vocabulary

## Testing

**Unit, against a fake pty**: coalescing (500 chunks into fewer than five pushes), scrollback bounds and the truncated flag, both pause paths and the resume, exit recorded and writes refused afterwards, resize clamping, dispose.

**Against a real pty**: a real command runs and its shell's exit code comes back; `TERM` is what tells a program it may emit colour; work continues while nothing is attached; and dispose genuinely kills the process — asserted on the shell's own `$$` with `process.kill(pid, 0)`, because "unreferenced" is not "dead".

**Protocol seam, end to end**: open in the Thread's working tree with its branch; reattach returns the same terminal, its scrollback and the new size; a stale `terminalId` is refused; a promoted Thread's terminal starts in its worktree on its own branch; nothing spawns until asked; a real `yes` flood arrives as a handful of pushes and the connection still answers other commands mid-flood; thread close, terminal close, and project delete each end the process; an exited shell is reported and replaced rather than reattached to.

## Done when

- [x] `pnpm typecheck` clean, `xvfb-run -a pnpm test` green
- [x] Suite does not regress from 636/636 across 40 files — now **663/663 across 41**
- [x] All four of #128's *verify before designing* answers recorded on the issue
- [ ] CI green on the PR
