# Phase 1: ArgusDE server foundation (event-sourced persistence + checkpoints + WebSocket API)

> Implemented via [PR #34](https://github.com/deanjstone/argusde/pull/34), merged 2026-08-13.

## Context

Spec [#33](https://github.com/deanjstone/argusde/issues/33) (collapsed from wayfinder map [#20](https://github.com/deanjstone/argusde/issues/20)) calls for a near-total architectural rewrite of ArgusDE: session logic moves out of Electron into a standalone Node server process, gains event-sourced SQLite persistence, git-ref-based checkpoints, a shared server-served UI, Tailscale-only remote access, and a PWA. The spec itself flags that this shouldn't be attempted as one change and leaves sequencing to whoever implements it.

This plan scopes **Phase 1 only**: the server-side foundation. It stands up the new standalone server process — persistence, checkpoint git plumbing, and a WebSocket API driving the existing `AcpSession` — as new code alongside the current Electron app, which **keeps working unchanged** throughout this phase (still its own IPC-based MVP architecture). Nothing here touches `src/main`, `src/preload`, or `src/renderer`. Migrating Electron to be a thin client of this server, building the new shared shadcn UI, the PWA, worktree-promotion UI, Tailscale serve wiring, and the mode-switcher UI are all separate follow-up phases, deliberately deferred so this lands as one reviewable, independently-testable PR.

**End state of Phase 1**: running `argusde serve`, a WebSocket client can create a Project and a Thread, send a message, see it streamed back through a real Claude Code (or fixture) agent, and see a checkpoint captured after each turn — all durable across a server restart.

## New module layout

Following the existing convention (one `src/<target>/` directory per process/build target, `tsc -p tsconfig.node.json` for everything non-renderer):

- `src/server/persistence/schema.ts` — SQLite table definitions (event log + projection tables for projects, threads, checkpoints), created idempotently on startup. No migration framework — plain `CREATE TABLE IF NOT EXISTS`.
- `src/server/persistence/event-store.ts` — the only module touching SQL. Public API: `appendEvent(event)`, `getProject(id)`, `listProjects()`, `getThread(id)`, `listThreads(projectId)`, `listCheckpoints(threadId)`. Each `appendEvent` call is a synchronous `better-sqlite3` transaction: insert into the event log, then apply the matching projection update to the relevant read table — no separate command/decider layer, per the spec's "lighter than T3" decision.
- `src/server/checkpoint/checkpoint-store.ts` — the only module touching git. Public API: `captureBaseline(threadId, cwd)`, `captureCheckpoint(threadId, turn, cwd)`, `diffCheckpoints(threadId, turnA, turnB)`. Implements the T3-derived mechanism from spec: isolated `GIT_INDEX_FILE`, `read-tree HEAD` → `add -A -- .` → `write-tree` → `commit-tree` → `update-ref` against `refs/argusde/checkpoints/<threadId>/turn/<n>`; diffing via `git diff <refA>^{commit} <refB>^{commit}`.
- `src/server/session/thread-runtime.ts` — bridges one running `AcpSession` (reused as-is from `src/utility/acp-session.ts` — it's plain Node code with an injectable transport, no Electron dependency) to the event store and checkpoint store: on `turn-complete`, captures a checkpoint and appends `thread.checkpoint-captured`; on the final assembled assistant message, appends a persisted message event; on mode-change updates (currently silently dropped in `acp-session.ts` — this phase stops dropping them), appends `thread.mode-changed`. Streaming chunks are forwarded live over WebSocket without individual event-log entries — only the completed message and turn/checkpoint boundaries are persisted, matching the spec's "push on mutation, not event-log replay" decision.
- `src/server/ws/protocol.ts` — Zod schemas (matching the existing `zod` dependency and `src/shared/ipc-contract.ts`'s style) for the WebSocket command/event wire format: commands (`project.create`, `thread.create`, `thread.send-message`, `thread.respond-permission`, `thread.set-mode`) and pushed events (state snapshots + the live session events already defined in `src/shared/acp-events.ts`).
- `src/server/ws/ws-server.ts` — thin `ws`-based server: accepts connections, includes the server's API version in a welcome message (sets up Phase 2's Electron-side version-handshake check for free, per spec — no client enforces it yet), dispatches validated commands to the persistence/session layer, broadcasts resulting events to subscribed clients.
- `src/server/index.ts` — composition root: `startServer({ host, port, dbPath })` wires everything together.
- `src/server/cli.ts` — `argusde serve [--host] [--port]` entry point (parses argv, calls `startServer`). No required workspace-root argument — Projects are created via the `project.create` command, matching the resolved "one server, multiple Projects" decision, not fixed at CLI-startup like T3's optional cwd arg.

## New dependencies

- `better-sqlite3` (+ `@types/better-sqlite3`): synchronous SQLite — fits the "no separate command/decider layer, straightforward synchronous projection updates" decision far better than an async driver. Native bindings are fine here since this runs in the plain Node server process, not Electron (no ABI-mismatch concern for this phase).
- `ws` (+ `@types/ws`): minimal WebSocket server/client — no need for socket.io's rooms/reconnection machinery for a single-server, single-user tool.

## Explicitly deferred out of Phase 1

- Electron migration (`loadURL`, native connect screen, dropping `IpcRelay`/`utilityProcess`) — Phase 2.
- The shared shadcn UI and PWA — Phase 2/3.
- Worktree **promotion** mechanics (git worktree creation/teardown) — the event schema gets a nullable `worktreePath` field on Thread now (cheap to add, expensive to retrofit later), but the actual worktree lifecycle logic is Phase 2. Phase 1 Threads always run in the Project's main workspace.
- Tailscale `serve` wiring and the startup QR code — Phase 2/3; Phase 1's CLI just binds to a configurable host/port.
- Mode-switcher UI — Phase 1 stops dropping and persists mode-change events server-side (cheap, directly useful), but there's no UI yet to switch modes from.

## Testing (test-first, per repo convention: real collaborators over mocks)

- `event-store.test.ts`: real temp-file SQLite DB per test (`os.tmpdir()`, cleaned up after). Append events, assert on the resulting `listProjects`/`listThreads`/`listCheckpoints` projections.
- `checkpoint-store.test.ts`: real temp git repo per test (`git init` in a tmpdir). Capture a baseline, modify a file, capture a checkpoint, assert `diffCheckpoints` reflects the change.
- `thread-runtime.test.ts`: reuses the existing `createFakeAgent`/`FakeAgentStep` fixture from `src/utility/fake-agent.ts` (same pattern as `acp-session.test.ts`) to drive a `ThreadRuntime` against a real `EventStore` + `CheckpointStore` (temp file/repo), asserting a checkpoint and message event land after a turn completes.
- `ws-server.test.ts` (in `test/`, alongside the existing `smoke.test.ts`): starts a real server on an ephemeral port, connects a real `ws` client, sends `project.create` → `thread.create` → `thread.send-message` against the fixture agent CLI (`test/fixtures/fake-agent-cli.mjs`, already used by `test/smoke.test.ts`), asserts on the pushed events received — the primary integration seam per the spec.

## Verification

1. `pnpm run typecheck` — extend `tsconfig.node.json`'s `include` to cover `src/server/**/*.ts`.
2. `pnpm test` (vitest) — new unit tests above all pass, plus the existing suite stays green (nothing in `src/renderer`, `src/main`, `src/preload`, or `src/utility` is modified except the mode-change handling in `acp-session.ts`, which existing tests should still cover).
3. Manual end-to-end check: `pnpm run build && node dist/server/cli.js --port 4173`, then connect with a throwaway `ws` script (or `websocat`) and drive `project.create`/`thread.create`/`thread.send-message` against the real `claude-agent-acp`, confirming streamed replies and a checkpoint ref appearing via `git for-each-ref refs/argusde/checkpoints`.
4. Work happens on a branch (`feature/server-foundation`), committed incrementally per module (persistence → checkpoints → thread-runtime → WS server → CLI), pushed after each commit, PR opened once Phase 1 is complete and green.

## Outcome

Landed as planned, plus a self-review pass (`/code-review high`) before merging that found and fixed 5 real bugs: a message-fragmentation bug in `ThreadRuntime`'s chunk assembly, a WebSocket server shutdown hang, a resource leak on failed agent startup (follow-up: [#35](https://github.com/deanjstone/argusde/issues/35) for full retry/recovery), a `--port 0` CLI parsing bug, and a `.then()` chain violating the project's async/await convention — plus one more found while writing that last fix's regression test (an import-side-effect bug in the CLI entry point). See [PR #34](https://github.com/deanjstone/argusde/pull/34) for full detail.
