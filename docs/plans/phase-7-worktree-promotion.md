# Phase 7: Worktree promotion UI

> Implemented via `feature/worktree-promotion`, in progress.

## Context

Spec [#33](https://github.com/deanjstone/argusde/issues/33) / wayfinder ticket [argusde#23](https://github.com/deanjstone/argusde/issues/23) locked the worktree lifecycle design: Threads default to running in their Project's main workspace; the user can explicitly promote a Thread to an isolated git worktree (sibling directory, never nested), and story 20 wants a visible indicator ("colored-border worktree indicator") so the user can tell a Thread's blast radius at a glance. Phase 1 added the schema groundwork (`threads.worktree_path`, nullable) but nothing since has touched worktree mechanics — every phase plan since has explicitly deferred it.

**Confirmed via this session's research** (not assumed): `resolveThreadCwd` (`ws-server.ts`, used today only by `thread.diff-checkpoints`) already resolves `thread.worktreePath ?? project.workspaceRoot` — forward-compatible and already correct. But `thread.create`'s actual runtime cwd is hardcoded to `project.workspaceRoot` with no worktree-awareness at all, `ThreadRuntimeOptions.cwd` is fixed at construction with no mutation path, and there is no "close a Thread" concept anywhere in the codebase yet (confirmed via grep — zero WS commands for it) — so the spec's "auto-removed when their Thread closes" cleanup story has no trigger to hook into today.

**Scoping decision (confirmed with the user)**: promotion is only available on a fresh Thread that hasn't sent any message yet. This sidesteps needing to relocate a *live, already-running* agent session (a substantially bigger, riskier mechanism) — promoting at that point is safe because nothing has happened yet: the existing `ThreadRuntime`/`AcpSession` pair (both effectively immutable-cwd today) can simply be disposed and recreated against the new worktree cwd, identical in spirit to the existing `restartSession()` pattern but with a new working directory instead of the same one. Auto-cleanup-on-Thread-close is explicitly **deferred** — that trigger doesn't exist yet, and building it is its own scope (thread lifecycle management), not this phase's job. Worktrees created by this phase persist as ordinary directories until a future "close Thread" feature exists to remove them.

**End state**: a fresh Thread (before its first message) shows a "Promote to worktree" control in the chat view. Clicking it creates a real sibling git worktree, relocates the Thread's agent session into it, and the chat view gains a visible colored-border indicator for the rest of the session. Once the first message is sent, the promote option disappears (no longer relevant/safe).

## Facts gathered this session (not assumptions)

- **`resolveThreadCwd`** (`src/server/ws/ws-server.ts`) already does `thread.worktreePath ?? project.workspaceRoot` — reused as-is for `thread.create`'s cwd resolution too, so a future promoted Thread's cwd resolution has exactly one code path, not two.
- **`ThreadRuntime.dispose()`** already exists and is already called in an error-recovery path (`thread.create`'s handler, on `runtime.start()` failure) — the same discard-and-recreate shape this phase needs for promotion, not a new pattern.
- **`CheckpointStore`'s git plumbing is repo-database-level** (`read-tree`/`write-tree`/`commit-tree`/`update-ref`, all resolved via each worktree's own `.git` file pointer back to the shared object database) — confirmed this means a checkpoint ref written from inside a worktree is immediately visible from the main workspace too, matching issue #23's design claim. Verified by reasoning through git's worktree model, to be *proven* by this phase's own tests (create a worktree, capture from inside it, confirm the ref resolves from the main repo) rather than left as an assumption.
- **The `checkpoints` table's `PRIMARY KEY (thread_id, turn)`** means naively re-capturing turn 0's baseline after promotion (to reflect the clean worktree checkout, not the main workspace's working-tree state at thread-creation time) needs `INSERT OR REPLACE`, not a plain `INSERT` — the existing projection in `event-store.ts`'s `thread.checkpoint-captured` case uses a plain `INSERT` today and needs this one, deliberate change (turn 0 is the only turn ever legitimately re-captured, exactly once, at promotion time).
- **The "Threads" tab is a placeholder today** (`App.tsx`, renders only the single active thread's title, no real list/drill-down) — building the real Projects→Threads navigation is explicitly out of scope (that's the separate, still-deferred "multi-project UI" phase). This phase puts the promote action directly in the active Chat view instead (near the existing mode switcher), not in the Threads tab.
- **`git worktree add --detach <path>`** (checked out from `HEAD`, no branch bookkeeping) is the right primitive — this phase's worktrees are throwaway isolation for agent edits, not long-lived feature branches; checkpoint refs (not branches) are the durable history mechanism per spec. A repo with no commits yet (no `HEAD`) will fail this — handled as a clean, surfaced error (matching `CheckpointStore.captureCheckpoint`'s own existing `hasHead` check), not built around.
- **Existing test fixture convention** (`ws-server.test.ts`, `checkpoint-store.test.ts`): real temp git repos via `execFileSync`, no mocking of git — this phase's worktree tests follow the exact same pattern.

## Design

**New `src/server/worktree/worktree-store.ts`** (parallel to `CheckpointStore`, same `execFileSync` style): `createWorktree(workspaceRoot: string, threadId: string): string` — runs `git worktree add --detach <workspaceRoot>-worktrees/<threadId>/` (issue #23's fixed naming convention), returns the created path. Throws a clean, catchable error (not a crash) on failure (no `HEAD`, path collision, etc.) — the WS handler translates this into an ordinary `ok: false` command result, matching every other fallible command in this codebase.

**`src/server/persistence/event-store.ts`**: new `DomainEvent` kind `{ kind: "thread.worktree-promoted"; threadId: string; worktreePath: string; timestamp: string }`; its projection does `UPDATE threads SET worktree_path = ? WHERE id = ?`. The existing `thread.checkpoint-captured` projection's `INSERT` becomes `INSERT OR REPLACE` (turn 0 only ever gets a second write from this one re-baseline path — every other turn is still write-once in practice).

**`src/shared/ws-protocol.ts`**: new command `{ type: "thread.promote-to-worktree"; commandId: string; threadId: string }` (no extra params — location and detached-HEAD checkout are fixed conventions, matching the zero-extra-param shape of `thread.list-checkpoints`).

**`src/server/ws/ws-server.ts`**: new `handleCommand` case —
1. `requireThread` + guard: reject with a clear error if `worktreePath` is already set, or if `eventStore.listCheckpoints(threadId).length > 1` (more than the turn-0 baseline — a message has already been sent).
2. `worktreeStore.createWorktree(project.workspaceRoot, threadId)`.
3. Dispose the existing `ThreadRuntime` (ends the old agent subprocess cleanly — safe, since nothing has happened in this Thread yet) and construct+start a new one with `cwd = worktreePath`, replacing the entry in the `runtimes` map.
4. Append `thread.worktree-promoted`, then re-capture the turn-0 baseline via `checkpointStore.captureBaseline(threadId, worktreePath)` and append `thread.checkpoint-captured` for turn 0 again (now hits the `INSERT OR REPLACE` path) — the baseline should reflect the clean worktree checkout the agent will actually start from, not the main workspace's state at the original thread-creation moment.
5. Return `{ worktreePath }`.
- `thread.create`'s own cwd resolution is also switched to go through `resolveThreadCwd`-equivalent logic (trivially `project.workspaceRoot` today, since a brand-new Thread never has a `worktreePath` yet — this is about not having two divergent cwd-resolution code paths going forward, not a behavior change today).

**Client (`src/web/App.tsx`, `src/web/components/chat-view.tsx`)**:
- `ThreadInfo` gains `worktreePath: string | null`.
- New `handlePromoteToWorktree()` — thin wrapper around `client.sendCommand<{ worktreePath: string }>({ type: "thread.promote-to-worktree", threadId })`, updates `thread.worktreePath` in state on success, surfaces failure via the existing `protocol-error` reducer path (matching `handleSetMode`'s pattern).
- `ChatView` gains a `worktreePath`/`onPromoteToWorktree` prop pair. Renders a "Promote to worktree" control near the mode switcher, shown only when `worktreePath` is null **and** `checkpoints.length <= 1` (no message sent yet — checkpoints are already threaded into `ChatView` from Phase 4, this reuses that same data with no new plumbing). Once `worktreePath` is set, render the colored-border indicator instead (a `border-2 border-<color>` class applied to the view's root container) — matching the UI direction's own "colored-border worktree indicator" wording, and hiding the promote control (it's genuinely no longer relevant, not just disabled).

## Explicitly deferred out of Phase 7

- Auto-removing a worktree when its Thread closes — no "close a Thread" feature exists yet anywhere in the codebase; building one is its own scope, not a worktree-promotion concern. Worktrees created by this phase persist as ordinary directories.
- Promoting a Thread that's already had messages sent (mid-conversation relocation) — confirmed out of scope with the user this session.
- The real Projects→Threads drill-down / Threads-tab list UI — still the separate "multi-project UI" deferred item; the promote control lives in the active Chat view instead.
- Any UI for browsing/managing a Thread's worktree directly (e.g. showing its path, opening it in a file browser) — the colored border is the only indicator story 20 asks for.

## Testing (real collaborators over mocks, per established convention)

- `worktree-store.test.ts`: real temp git repo (same fixture pattern as `checkpoint-store.test.ts`) — `createWorktree` creates a real sibling directory verified via `git worktree list`; a repo with no commits yet fails cleanly (rejected promise / thrown error, not a crash); calling it twice for the same `threadId` fails cleanly (path already exists) rather than silently overwriting.
- `event-store.test.ts`: extend with a real case proving `thread.worktree-promoted` projects into `threads.worktree_path`, and that re-appending `thread.checkpoint-captured` for turn 0 (the `INSERT OR REPLACE` path) correctly replaces the prior ref rather than throwing a primary-key violation.
- `ws-server.test.ts`: the real end-to-end case that actually proves issue #23's core claim — create a project/thread against a real temp repo, promote it, capture a checkpoint from inside the new worktree (via a real subsequent turn), then confirm `git -C <mainWorkspaceRoot> rev-parse refs/argusde/checkpoints/<threadId>/turn/1` resolves correctly from the *main* workspace even though the checkpoint was captured from the *worktree* — proving the shared-object-database claim for real, not by assumption. Also covers the guard cases (promoting twice, promoting after a message was sent) returning clean `ok: false` results.
- `mode-switcher.test.tsx`-style component tests for the new promote control / colored-border rendering in `chat-view.test.tsx` — props in, rendered output out, matching the established pattern for every other Phase 4/5 chat-view addition.
- `test/web-smoke.test.ts`: extend with one more real round trip — create a thread, promote it before sending anything, assert the colored border appears, send a message, assert a real file edit lands in the *worktree* directory (not the original repo checkout) by inspecting the filesystem directly.

## Verification

1. `pnpm run typecheck` and `xvfb-run -a pnpm test` (full suite) — clean, including all new/extended test files above.
2. Manual check: run `argusde serve`, open the web UI against the real `claude-agent-acp`, create a fresh Thread, promote it before sending a message, confirm the colored border appears and a real sibling worktree directory exists on disk (`git worktree list` from the main repo), send a message asking the agent to edit a file, confirm the edit lands in the worktree directory and the main workspace stays untouched, confirm the checkpoint diff (Phase 4 UI) still works correctly for the promoted Thread.
3. Work happens on a branch (`feature/worktree-promotion`), committed incrementally (worktree-store + tests → event-store additions + tests → ws-protocol + ws-server wiring + tests → App.tsx/ChatView UI + tests → web-smoke extension), pushed after each commit, self-reviewed with `/code-review high` before merging (established practice from Phases 1-6), PR opened once complete and green. Plan copied to `docs/plans/phase-7-worktree-promotion.md` per the standing repo convention.
