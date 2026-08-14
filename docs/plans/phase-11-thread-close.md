# Phase 11: Thread close + worktree auto-cleanup

> Implemented via `feature/thread-close`, in progress.

## Context

Spec [#33](https://github.com/deanjstone/argusde/issues/33) Story 8: "As a user, I want an isolated worktree to be cleaned up automatically when I close its conversation, so that I don't accumulate stale worktrees on disk." Confirmed via a fresh repo survey (this session): there is **no way to close a Thread at all** today — no WS command, no schema field, no UI affordance, nothing. Every phase since Phase 7 has explicitly deferred this, each time re-confirming "the trigger doesn't exist yet." This phase builds the trigger and the cleanup it enables.

## Facts gathered this session (not assumed)

- **`WorktreeStore`** (`src/server/worktree/worktree-store.ts`, 23 lines) has exactly one method, `createWorktree` — no removal method exists. Worktrees are created `--detach`, **with no branch at all** ("no branch bookkeeping, since checkpoint refs... are this codebase's durable history mechanism" — the class's own doc comment). The spec's "plus branch cleanup where unmerged" clause describes a mechanism that doesn't exist in the shipped implementation; a removal method only needs `git worktree remove`, nothing branch-related.
- **`runtimes` Map in `ws-server.ts`**: exactly two `.set()` sites (`thread.create`, `thread.promote-to-worktree`), several `.get()` sites, **zero `.delete()` sites anywhere** — confirmed nothing has ever removed a single Thread's runtime mid-server-lifetime. `close()` (server shutdown) is the only place that disposes+clears, and it does all of them in bulk.
- **`ThreadRuntime.dispose()`** only tears down the ACP session (`await this.options.session.dispose()`) — touches nothing else. `nextTurn`/`turnInFlight` are private, in-memory-only fields with no persistence, which is *why* the codebase's established pattern for "seed a runtime that resumes correctly" doesn't exist yet — this phase deliberately doesn't need one, since closing is designed to be **one-way** (no reopen).
- **Zero status/archived/closed concept anywhere** — `threads` table, `ThreadRecord`, and the `DomainEvent` union (six kinds, none close-related) all treat every Thread as implicitly open forever.
- **Phase 9's exact "silently discard uncaptured state" bug class applies here too, and would be worse if not handled**: removing a worktree directory without first checkpointing whatever's currently on disk would permanently lose any state not already captured by a completed turn (e.g. a manual hand-edit) — this time with no way to recover it at all, since the directory itself is gone. Phase 9's fix (capture a safety checkpoint immediately before the destructive operation) applies directly here.
- **A real new architectural gap this phase's own new capability exposes**: `App.tsx`'s top-level render gate is `if (!thread) return <WorkspaceSetup ... />` — today unreachable except on a genuinely fresh page load, since nothing has ever set `thread` back to `null` after it was first set. Closing the currently-active Thread is the **first code path that can ever produce "no active thread, but this page session has definitely used the app before"** — without a fix, closing your current (possibly only) Thread would strand you back on the first-run screen instead of the Threads tab, even though your other Projects/Threads still exist. This is a real correctness gap this phase's own new code introduces, not a pre-existing one being exposed (the precise distinction this session has consistently used to decide what's in-scope vs. a follow-up issue) — it must be fixed here.
- **Promote-to-worktree and revert-checkpoint use `requireThread` directly** (checks the persisted row, not the runtime) — closing a Thread and then calling `thread.promote-to-worktree` on it again would NOT be caught by any existing guard (it doesn't check `runtimes.get()` until after its main guards) and would silently try to re-promote an already-closed Thread. `send-message`/`respond-permission`/`set-mode` key off `runtimes.get()` directly, which *would* incidentally start failing (`"Unknown thread"`) once close deletes the runtime entry — accurate-enough but not a clear "this thread is closed" message.

## Design

**`src/server/persistence/schema.ts`**: `addColumnIfMissing(db, "threads", "closed_at", "TEXT")` — reuses the exact safe-migration helper Phase 9 built for `reverted_to_turn`, no new pattern needed.

**`src/server/persistence/event-store.ts`**: new `DomainEvent` kind `{ kind: "thread.closed"; threadId: string; timestamp: string }`, projected via `UPDATE threads SET closed_at = ? WHERE id = ?`. `ThreadRecord` (`ws-protocol.ts`) gains `closedAt: string | null`; `getThread`/`listThreads` SQL selects `closed_at AS closedAt`.

**`src/server/worktree/worktree-store.ts`**: new `removeWorktree(workspaceRoot: string, worktreePath: string): void` — `git worktree remove --force <worktreePath>` run with `cwd: workspaceRoot` (the main workspace, not the about-to-be-deleted worktree itself). `--force` matches this codebase's existing "checkpoint history is durable elsewhere, so don't let git's own safety checks block a decisive cleanup" posture (same reasoning already applied to `restoreCheckpoint`'s `read-tree --reset`).

**`src/server/session/thread-runtime.ts`**:
- Re-add `isTurnInFlight(): boolean` (removed as dead code in Phase 9's review — now has a real caller).
- New `captureFinalCheckpoint(): number` — throws if `turnInFlight` (mirrors `revertToCheckpoint`'s own self-guard, so it's safe to call directly without relying on the caller remembering to check first); otherwise captures whatever's currently on disk at `this.nextTurn` (via the existing `checkpointStore.captureCheckpoint` + a plain `thread.checkpoint-captured` event, no `revertedToTurn`), increments `nextTurn`, returns the turn number. Called unconditionally on close (not just for worktree Threads) — cheap, and gives every closed Thread a durable "state at close" record.

**`src/shared/ws-protocol.ts`**: new command `{ type: "thread.close", commandId: string, threadId: string }`.

**`src/server/ws/ws-server.ts`**:
- New `requireOpenThread(threadId)` helper (wraps `requireThread`, additionally throws `"Thread is closed"` if `closedAt` is set) — swapped in for `send-message`/`respond-permission`/`set-mode`'s existing runtime-presence checks and for `promote-to-worktree`/`revert-checkpoint`'s `requireThread` calls. Read-only handlers (`list-checkpoints`, `diff-checkpoints`, `get-history`, `list`) stay on plain `requireThread` — viewing a closed Thread's history must keep working.
- New `case "thread.close"`: `requireOpenThread` (idempotency + open-check in one), then if a live runtime exists: `runtime.captureFinalCheckpoint()` (surfaces a clean in-flight-turn error, same as revert), `await runtime.dispose()`, `runtimes.delete(threadId)`; then if `thread.worktreePath`, resolve the Project and call `worktreeStore.removeWorktree(...)`; append `thread.closed` only after both steps succeed (matching every prior mutating command's "event after the mutation is confirmed" precedent).

**Client (`src/web/`)**:
- `ThreadInfo` gains `closedAt: string | null` (from `thread.get-history`'s response, which needs the same field added to its return shape).
- `App.tsx`: new `hasEverHadThread` boolean, set `true` inside `becomeActiveThread` (the one existing chokepoint every "become active" path already funnels through). Top-level gate becomes `if (!thread && !hasEverHadThread) return <WorkspaceSetup ... />` instead of `if (!thread)`. `tab === "chat"` renders a one-line placeholder ("No thread selected — pick one from the Threads tab.") when `thread` is null, defensively — the primary flow already forces `tab` to `"threads"` on a successful close, so this is a fallback, not the common path.
- New `closing` boolean state + `handleCloseThread()` (mirrors `handlePromoteToWorktree`'s exact shape: guard → send command → update state → `finally`). On success: `setThread(null)`, `setTab("threads")`.
- `chat-view.tsx`: new `onCloseThread?`/`closing?`/`threadClosed?` props — a "Close thread" button placed next to the existing "Promote to worktree" button (hidden once already closed), and the message input/send button disabled with a short explanatory note when `threadClosed`.
- `thread-list.tsx`: a "Closed" badge next to the existing worktree-indicator badge when `thread.closedAt !== null` — closed Threads stay visible and selectable (history remains viewable), matching the append-only "nothing is hidden, just marked" pattern already established for reverted checkpoints in Phase 9.

## Explicitly deferred / non-goals

- **Reopening a closed Thread.** Not asked for, and doesn't have a clean design without also reconstructing `nextTurn` from persisted checkpoints — a real follow-up, not a trivial addition.
- **Project-level deletion/archiving.** Story 8 is Thread-scoped; Projects are untouched.
- **Any confirmation dialog before closing.** Matches this session's established, consistent convention (`handlePromoteToWorktree`, `handleRevertCheckpoint` both skip it) — and is lower-stakes than it looks, since the final safety checkpoint means conversation history and workspace state at close time are never actually lost, only the live session and (for a promoted Thread) the worktree directory.
- **Full "resume most-recently-active-thread across a page reload."** Still a separate, already-repeatedly-deferred gap. The `hasEverHadThread` fix above only solves the *new* in-session regression this phase's own close capability introduces — it does not add reload persistence.

## Testing (real collaborators over mocks, per established convention)

- `worktree-store.test.ts`: `removeWorktree` against a real worktree — directory gone, `git worktree list --porcelain` no longer shows it, main repo's own git state unaffected; a clean, catchable error for a nonexistent worktree path.
- `event-store.test.ts`: `thread.closed` projection test, plus a schema-upgrade regression test for the new `closed_at` column against a simulated pre-existing database — reusing the exact "legacy DB" pattern Phase 9 built for `reverted_to_turn`, proactively (not waiting for review to catch it this time).
- `thread-runtime.test.ts`: `captureFinalCheckpoint` (correct turn number/event, rejects while in flight, reusing the slow-agent pattern already established for this exact class of test).
- `ws-server.test.ts`: full E2E for `thread.close` — a non-worktree Thread (dispose + final checkpoint + event, subsequent `send-message` fails with a clear "Thread is closed"), a promoted Thread (worktree directory actually gone from disk afterward), rejecting an already-closed Thread, rejecting while a turn is in flight, and confirming read-only commands (`list-checkpoints`, `get-history`) keep working on a closed Thread.
- Component tests: `chat-view.test.tsx` (close button + disabled input when closed), `thread-list.test.tsx` (closed badge).
- `test/web-smoke.test.ts`: one new real E2E case — close a Thread via the UI, confirm the message input is disabled and the app lands on the Threads tab (not stranded on WorkspaceSetup), confirm the closed Thread is still selectable and its history still renders, and for a promoted Thread confirm the worktree directory is actually gone from the real filesystem afterward.

## Verification

1. `pnpm run typecheck` and `xvfb-run -a pnpm test` (full suite) — clean.
2. `pnpm run build` (full build, not just `build:web`) then a manual check against the real `claude-agent-acp`: create a Project with two Threads (one promoted to a worktree), close each, confirm the worktree directory is actually gone from disk, confirm both closed Threads' history is still browsable, confirm closing the currently-active Thread lands on the Threads tab (not the first-run screen) even though other Projects/Threads still exist.
3. Work happens on a branch (`feature/thread-close`), committed incrementally (schema/event-store/worktree-store plumbing + tests → ThreadRuntime orchestration + tests → ws-server command + tests → UI wiring + tests → web-smoke extension), pushed after each commit, self-reviewed with `/code-review high` before merging (established practice from Phases 1–10), PR opened once complete and green. Plan copied to `docs/plans/phase-11-thread-close.md` per the standing repo convention.
