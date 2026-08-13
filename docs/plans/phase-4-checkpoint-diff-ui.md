# Phase 4: Checkpoint diff + timeline UI

> Implemented via `feature/checkpoint-diff-ui`, in progress.

## Context

Spec [#33](https://github.com/deanjstone/argusde/issues/33) stories 9-11 and 21 want checkpoint history surfaced to the user: every turn auto-checkpoints (already shipped in Phase 1), diffing any two checkpoints, diffing current state against the thread's start, and a visible timeline strip to jump between them. Phases 1-3 built the server, the shared UI, Electron's cutover, and Tailscale remote access — checkpoint capture and even the git-diff plumbing (`CheckpointStore.diffCheckpoints`) already exist server-side from Phase 1, but nothing exposes them over the WS API or in the UI yet. This phase closes that gap.

**End state**: the chat view gains a checkpoint timeline strip (turn markers, including the turn-0 baseline). Tapping a turn shows the diff between it and the turn before; a "since start" option diffs the latest turn against turn 0. All real `git diff` output from real checkpoint refs — no new git logic needed, just wiring what Phase 1 already built through to the client.

## Facts gathered this session (not assumptions)

- **Server-side git plumbing already exists and is untouched by this phase**: `CheckpointStore.diffCheckpoints(threadId, turnA, turnB, cwd)` (`src/server/checkpoint/checkpoint-store.ts`) already runs a real `git diff` between two checkpoint refs and returns the raw diff text.
- **Persistence already tracks every checkpoint**: the `checkpoints` table (`src/server/persistence/schema.ts`) and `EventStore.listCheckpoints(threadId)` (`src/server/persistence/event-store.ts:157`) already return `{threadId, turn, ref, createdAt}[]` for a thread, ordered by turn — including the turn-0 baseline. Nothing new to build here either.
- **What's missing is entirely the wiring**: no `ClientCommand` variant exists for listing or diffing checkpoints (`src/shared/ws-protocol.ts`'s discriminated union has `project.create`/`thread.create`/`thread.send-message`/`thread.respond-permission`/`thread.set-mode` only), `ws-server.ts`'s `handleCommand` switch has no matching cases, and the web UI has no checkpoint-related component at all.
- **Resolving `cwd` for a diff/list query doesn't need a live `ThreadRuntime`** — `eventStore.getThread(threadId)` → `eventStore.getProject(thread.projectId)` → `project.workspaceRoot` (both methods already exist, same lookup `thread.create`'s handler already does at `ws-server.ts:78`) is sufficient. This matters because it means these two new commands work even for a thread whose `ThreadRuntime` isn't in the in-memory `runtimes` map (e.g. after a server restart) — no artificial dependency on an active agent session for a read-only history query.
- **`App.tsx` is the composition root** or `sendCommand` calls; `ChatView` (`src/web/components/chat-view.tsx`) is presentational, driven entirely by props — the same pattern (`handleSend`/`handleRespondPermission` in `App.tsx`, passed down as callbacks) fits a new `handleFetchCheckpoints`/`handleDiffCheckpoints` pair.
- **Checkpoint state doesn't belong in `chat-state.ts`'s reducer** — that reducer is purely driven by `AcpSessionEvent`s streamed from the agent; checkpoint list/diff are separate, on-demand, request/response data with no streaming component. Keeping it as its own `App.tsx`-level `useState` (parallel to `chatState`, not folded into it) matches the existing separation of concerns cleaner than overloading the reducer.
- **No diff-rendering dependency exists yet** — a hand-rolled line-based +/- colorer (split on `\n`, color lines starting with `+`/`-`) is enough for a unified-diff view; no need for a diffing/highlighting library given the UI direction's own "starting composition, not pixel-accurate" allowance (spec's UI-direction decision).

## Design

**Protocol (`src/shared/ws-protocol.ts`)** — two new `ClientCommand` variants:
- `{ type: "thread.list-checkpoints", commandId, threadId }` → result `CheckpointRecord[]` (reuse the existing type from `event-store.ts`, re-exported from the protocol module or imported directly — no shape duplication).
- `{ type: "thread.diff-checkpoints", commandId, threadId, turnA: number, turnB: number }` → result `{ diff: string }`.

**Server (`src/server/ws/ws-server.ts`)** — two new `handleCommand` cases, both resolving `cwd` via the `getThread`→`getProject` lookup described above (throwing "Unknown thread"/"Unknown project" the same way existing cases do for a bad id):
- `thread.list-checkpoints` → `eventStore.listCheckpoints(threadId)`.
- `thread.diff-checkpoints` → `checkpointStore.diffCheckpoints(threadId, turnA, turnB, cwd)`, wrapped as `{ diff }`.

**Client wiring (`src/web/App.tsx`)**:
- New `const [checkpoints, setCheckpoints] = useState<CheckpointRecord[]>([])`.
- Fetch checkpoints once right after `thread.create` succeeds (mirrors the existing flow immediately after `setThread(...)`), and re-fetch after every `turn-complete` session event (extend the existing `session.event` case in the `onPush` switch: after dispatching to `chatStateReducer`, if `push.event.kind === "turn-complete"`, re-run the list-checkpoints fetch) — keeps the strip current without polling.
- New `handleDiffCheckpoints(turnA, turnB): Promise<string>` — thin wrapper around `client.sendCommand({ type: "thread.diff-checkpoints", ... })`, returning the diff text (or throwing, left to the caller/component to handle — this one's local to the checkpoint UI, doesn't need to touch `chatState`).

**UI (`src/web/components/`)**:
- New `CheckpointStrip` component: horizontally-scrollable row of turn markers (small numbered buttons, turn 0 visually distinguished as "start") above the message list in `ChatView`. Takes `checkpoints: CheckpointRecord[]` and an `onSelectTurn(turn: number)` callback — selecting turn *N* (N > 0) requests the diff between turn N-1 and N; a separate "Since start" control requests the diff between turn 0 and the latest turn.
- New `DiffView` component: a collapsible panel (rendered inline below the strip, not a separate route/tab — keeps the mobile-first single-screen flow) showing the raw diff text in a monospace block, with per-line `+`/`-` coloring via a small pure function (`splitDiffLines`/similar) — no new dependency.
- Both wired into `ChatView` via new props (`checkpoints`, `onSelectTurn`, `activeDiff`, `onCloseDiff` or similar) — `App.tsx` owns the diff-fetch state (loading/result/error) the same way it owns `setup`/`chatState`.

## Explicitly deferred out of Phase 4

- The colored-border worktree indicator (spec UI direction) — unrelated to checkpoints, still tied to the not-yet-built worktree promotion feature.
- Any diff view richer than raw unified-diff text (side-by-side, syntax highlighting) — the UI direction is a starting composition, not a design target for this phase.
- Mode-switcher UI, worktree promotion UI, multi-project UI, the version-compatibility handshake, the PWA — unchanged from prior phases' deferred lists.

## Testing (real collaborators over mocks, per established convention)

- `ws-server.test.ts`: extend with a real end-to-end case — create a project/thread against a real temp git repo and the fixture agent, send a message (turn 1 completes → its checkpoint captures whatever's on disk at that moment), directly modify a file in the repo via `fs.writeFileSync` between turns (isolates "checkpoint capture reflects real filesystem state" without needing the fixture agent to perform file edits itself), send a second message (turn 2's checkpoint captures the change), then assert `thread.list-checkpoints` returns turns 0/1/2 in order and `thread.diff-checkpoints(1, 2)` contains the real, expected diff hunk for the edited file.
- `CheckpointStrip.test.tsx` / `DiffView.test.tsx`: component-level, props in → rendered output out, matching `tab-bar.test.tsx`'s existing style — turn markers render for a given checkpoint list, clicking a turn calls `onSelectTurn` with the right turn number, diff text renders with the expected line coloring.
- `test/web-smoke.test.ts`: extend the existing real-browser round trip to also exercise the new WS commands once — after the existing message round trip, click a turn marker and assert real diff text appears in the DOM. This is the one new integration seam (a new pair of WS commands), so it gets the same "one thin E2E proving the seam" treatment Phase 1-3 gave their own new seams.

## Verification

1. `pnpm run typecheck` and `xvfb-run -a pnpm test` (full suite) — clean, including all new/extended test files above.
2. Manual check: run `argusde serve`, open the web UI, send a couple of messages that cause real file changes (via the real `claude-agent-acp`, not the fixture), confirm the timeline strip shows one marker per turn, confirm tapping a turn shows a real, correct diff, confirm "since start" shows the cumulative diff.
3. Work happens on a branch (`feature/checkpoint-diff-ui`), committed incrementally (protocol + server wiring + tests → App.tsx wiring → CheckpointStrip/DiffView components + tests → web-smoke extension), pushed after each commit, self-reviewed with `/code-review high` before merging (established practice from Phases 1-3), PR opened once complete and green. Plan copied to `docs/plans/phase-4-checkpoint-diff-ui.md` per the standing repo convention.

## Outcome

Landed as planned — all the server-side git/persistence plumbing really was already there from Phase 1, this phase was purely wiring (protocol + WS handlers + UI). `/code-review high` on the completed branch found 6 real issues, all fixed except one deliberately deferred:

- **Diff-request race condition**: `fetchDiff` had no sequencing — a slow "Turn 5" request could resolve after a fast "Turn 8" request and silently overwrite the diff panel with stale content. Fixed with a request-id ref in `App.tsx`; a response is only applied if it's still the most recent request, and closing the panel invalidates any in-flight request too.
- **Silent `catch {}`**: `refreshCheckpoints` swallowed WS command failures with no logging, directly violating the repo's explicit error-handling rule. Fixed with `console.error`.
- **`activeTurn` was fully implemented but never wired up**: `CheckpointStrip`'s selected-turn highlighting (`aria-current`, violet border) was dead code — no caller ever passed the prop. Fixed by tracking the selected turn in `App.tsx` state, threaded through `ChatView` → `CheckpointStrip`, cleared on diff-panel close.
- **`CheckpointRecord` was redeclared three times** (`App.tsx`, `chat-view.tsx`, `checkpoint-strip.tsx`) instead of reusing the canonical server-side type, contrary to the plan's own explicit "no shape duplication" call. Fixed by moving the canonical definition into `src/shared/ws-protocol.ts` (browser-safe, unlike `event-store.ts` which pulls in `better-sqlite3`) and having `event-store.ts` re-export it; all three UI call sites now import the one type.
- **Duplicated "unknown thread" lookup** between the `thread.list-checkpoints` handler and `resolveThreadCwd` in `ws-server.ts`. Fixed by factoring both through a shared `requireThread(threadId)` helper.
- **Deferred, not fixed**: `CheckpointStore`'s git subprocess calls (`captureCheckpoint`, and now `diffCheckpoints`) are fully synchronous (`execFileSync`), blocking the server's single event loop while they run. This is a pre-existing Phase 1 characteristic, not a regression from this phase's diff wiring — fixing it properly means touching already-shipped, well-tested code for a disproportionate amount of scope in a UI-focused phase. Filed as [argusde#41](https://github.com/deanjstone/argusde/issues/41).

Also manually verified against the real `claude-agent-acp` (not just the fixture agent): asked it to edit a real file, confirmed the timeline strip showed the new turn, confirmed both "Turn N" and "Since start" diffs rendered the real, correct `git diff` content in the browser.

Verified after fixes: full suite green (130 tests, 19 files, up from 129 immediately post-implementation), typecheck clean.
