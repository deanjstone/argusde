# Phase 8: Multi-project UI

> Implemented via `feature/multi-project-ui`, in progress.

## Context

Spec [#33](https://github.com/deanjstone/argusde/issues/33) decision #10 and the UI direction section call for the Threads tab to be a real Projects→Threads drill-down (Project picker → that Project's Threads → a Thread switches the active Chat) — "one server hosts multiple Projects simultaneously," no separate top-level Projects tab. Every phase since Phase 1 has left this as an explicit stub: the Threads tab today just echoes the single active thread's title (`App.tsx`), and the client has no concept of more than one thread at a time — `handleWorkspaceSubmit` is the *only* code path that ever sets the active thread, and it always creates a brand-new Project+Thread, with no way to switch to (or even list) an existing one.

**Confirmed via this session's research** (not assumed): the server-side multi-tenancy this needs already exists — `EventStore.listProjects()`/`listThreads(projectId)` are implemented and unused by any WS handler, and a Thread's `ThreadRuntime`/`AcpSession` stays live in the `runtimes` map for the server process's whole lifetime (nothing ever calls `runtimes.delete()` except server shutdown) — so switching to an existing Thread created earlier in the same server run needs **no** new runtime-management logic, only a way for the client to learn what exists and load a Thread's history into the UI. The one real gap: only `thread.message-recorded` events are persisted (`DomainEvent`'s six kinds, confirmed exhaustive via every `appendEvent(` call site) — tool-call history is *never* persisted, so switching to an old Thread can replay its messages but not its historical tool-call cards. This is accepted as an inherent, documented limitation, not solved here.

**Confirmed with the user before planning**: this phase includes creating new Projects/Threads from within the drill-down too (not read-only browse-only), so the Threads tab can fully replace the one-shot first-launch flow going forward.

**A real correctness gap this phase must close, not just add UI around**: today, `App.tsx`'s WS push handler applies *every* incoming `session.event` to `chatState` unconditionally, regardless of which Thread it's for — harmless today only because exactly one Thread has ever existed client-side at a time. Once a second Thread can run in the background (nothing stops creating one via `thread.create` even before this phase), its streamed events would silently bleed into whatever Thread is currently being viewed. This phase adds the missing `threadId` filter as a required fix, not an enhancement — shipping thread-switching without it would make the bug trivially reproducible.

**End state**: the Threads tab shows a Project picker (with a "New Project" action); selecting a Project shows its Threads (with a "New Thread" action and a "Back" action); selecting a Thread switches the active Chat to it, replaying its persisted message history, mode, and worktree state. A background Thread's live events never bleed into whatever Thread is currently active.

## Facts gathered this session (not assumptions)

- **`EventStore.listProjects()`/`listThreads(projectId)`** already exist and are fully correct — thin WS wrappers, no new persistence logic needed.
- **`EventStore.listEventsForThread(threadId)`** already exists, returns the full ordered `DomainEvent[]` — filtering it to `thread.message-recorded` events is sufficient to reconstruct a Thread's message timeline (`{messageId, role, content}` maps directly to `TimelineMessage`, confirmed shape-compatible in `src/shared/timeline.ts`).
- **The mode catalog (`availableModes`) is never persisted** — only ever broadcast live once, from `AcpSession.start()`, to whichever clients happen to be connected *at that moment*. A client switching to a Thread whose runtime started earlier in the server's lifetime has no way to learn its available modes from persistence alone. Fix: cache the last-known `availableModes` in `ThreadRuntime` itself (updated whenever a `mode-changed` event carrying a catalog passes through — already exactly once per Thread today, at `start()`), exposed via a getter — an in-memory-only fix, no new persistence, no dependency on uncertain SDK live-query behavior.
- **`ChatViewProps` needs no new props** — thread-switching is entirely an `App.tsx`-level concern (reload `chatState`/`checkpoints`/`thread`, re-render the same `ChatView`), matching the established "App.tsx is the one composition root, every child is presentational/props-driven" pattern already used for checkpoints/mode/worktree.
- **No reusable list/card UI primitive exists** (`src/web/components/ui/` has only `button.tsx`/`input.tsx`) — the picker screens are genuinely new markup, following the plain-div styling already used for the `tab === "settings"` block.
- **The existing WS push handler's `useEffect` has `[]` deps** — a naive `push.threadId === thread?.threadId` check inside it would read a *stale* `thread` (always the mount-time value) due to the classic stale-closure trap. Needs a ref (matching the existing `diffRequestRef` precedent), not the `thread` state value directly.

## Design

**`src/shared/ws-protocol.ts`**: three new commands, following the exact existing convention (`type` literal, `commandId`, flat payload fields) —
- `{ type: "project.list"; commandId }` → result `ProjectRecord[]`.
- `{ type: "thread.list"; commandId; projectId: string }` → result `ThreadRecord[]`.
- `{ type: "thread.get-history"; commandId; threadId: string }` → result bundling everything needed to fully rehydrate the client in one round trip: `{ threadId, projectId, title, worktreePath, currentModeId, availableModes: SessionModeSummary[], messages: Array<{ messageId: string; role: "user" | "agent"; content: ChatContentBlock[] }> }`.

**`src/server/session/thread-runtime.ts`**: caches the last-known mode catalog — `private lastKnownModes: SessionModeSummary[] = []`, updated inside `handleEvent`'s existing `mode-changed` case whenever `event.availableModes` is present; new `getAvailableModes(): SessionModeSummary[]` getter.

**`src/server/ws/ws-server.ts`**: three new `handleCommand` cases —
- `project.list` → `eventStore.listProjects()`.
- `thread.list` → `eventStore.listThreads(command.projectId)`.
- `thread.get-history` → `requireThread`, filter `eventStore.listEventsForThread(threadId)` to `thread.message-recorded`, pull `availableModes` from `runtimes.get(threadId)?.getAvailableModes() ?? []` (a Thread with no live runtime — a genuine edge case given runtimes are never deleted except at shutdown — degrades to an empty catalog, not an error).

**`src/web/chat-state.ts`**: new `ChatEvent` kind `{ kind: "history-loaded"; messages: Array<{messageId, role, content}>; currentModeId: string | null; availableModes: SessionModeSummary[] }` and a matching reducer case that *replaces* `state.timeline` wholesale (mapped straight to `TimelineMessage[]`), sets `currentModeId`/`availableModes`, and resets `pendingPermissionRequest`/`agentStatus` to their initial values — a full "this is a different conversation now" reset, deliberately not reusing `appendOrMergeMessage`'s single-append semantics. `connectionState`/`connectionError`/`apiVersion` are connection-level, not thread-level, and stay untouched.

**`src/web/App.tsx`** — the bulk of the new orchestration:
- `ThreadInfo` gains `projectId: string` (missing today — the active thread's own project affiliation isn't tracked at all).
- **Cross-thread event-bleed fix**: a new `activeThreadIdRef = useRef<string | null>(null)`, kept in sync via a small `useEffect(() => { activeThreadIdRef.current = thread?.threadId ?? null }, [thread])`. The WS push handler's `session.event` case (and the `turn-complete` → `refreshCheckpoints` call inside it) both gate on `push.threadId === activeThreadIdRef.current` before touching `chatState`/`checkpoints` — a background Thread's events are received (the connection is shared) but silently dropped for UI purposes if they're not for the currently-active Thread.
- New `projects: ProjectRecord[]`, `selectedProjectId: string | null`, `threadsInProject: ThreadRecord[]` state — fetched via `project.list`/`thread.list` on demand (when the Threads tab is opened, or a project is selected), not proactively cached.
- New `handleSelectThread(threadId)`: calls `thread.get-history`, sets `thread` (including `projectId`), dispatches `history-loaded`, resets `diff`/`activeTurn` to their empty states, calls `refreshCheckpoints(threadId)`, clears `selectedProjectId`, switches `tab` to `"chat"`.
- New `handleCreateProject(workspaceRoot)` / `handleCreateThread(title)`: thin wrappers around the already-existing `project.create`/`thread.create` commands (the same ones `handleWorkspaceSubmit` already uses), routed through the same `handleSelectThread`-style "become the active thread" finish.

**New `src/web/components/project-picker.tsx`**: presentational — `projects: ProjectRecord[]`, `onSelectProject(id)`, `onCreateProject(workspaceRoot)`. A list of projects plus an inline "New Project" form (workspace-path input, matching `WorkspaceSetup`'s existing input pattern).

**New `src/web/components/thread-list.tsx`**: presentational — `threads: ThreadRecord[]`, `onSelectThread(id)`, `onCreateThread(title)`, `onBack()`. A list of threads plus an inline "New Thread" form and a back action.

**`src/web/App.tsx`**'s `tab === "threads"` block: renders `<ProjectPicker>` when `selectedProjectId === null`, else `<ThreadList>` for that project — this drill-down state lives in `App.tsx` itself, matching how `tab` navigation is already owned there.

## Explicitly deferred out of Phase 8

- Historical tool-call cards on a reloaded Thread's history — never persisted server-side; only messages replay.
- Reattaching to a Thread after a server restart (its `ThreadRuntime` genuinely gone, not just backgrounded) — the `runtimes` map is always fully populated for the phase's stated scope (same server process); cold-start reattachment is its own, larger feature.
- Cross-page-reload persistence of "which Thread was last active" — nothing else in the app persists across a full page reload today either (mode, worktree, checkpoints all reset); this phase doesn't add that either. "Most recently active" per spec's UI direction is satisfied within a single page session by construction (the Chat tab always renders whatever `thread` currently is, regardless of which tab is being viewed).
- Renaming/archiving/deleting Projects or Threads — out of scope, not asked for.

## Testing (real collaborators over mocks, per established convention)

- `ws-server.test.ts`: real end-to-end cases for `project.list`/`thread.list`/`thread.get-history` against a real temp repo — including the mode-catalog-from-a-live-runtime path (create a thread whose fixture agent advertises modes, fetch history, confirm `availableModes` comes back correctly), and the cross-thread isolation case done at the protocol level (two threads, events for one don't appear when the other's history is fetched).
- `thread-runtime.test.ts`: extend with a case proving `getAvailableModes()` returns the cached catalog after `start()`, and stays correct (doesn't get wiped) across a subsequent `mode-changed` event that carries no catalog (a real mid-session change, matching Phase 5's existing distinction).
- `project-picker.test.tsx` / `thread-list.test.tsx`: component-level, matching `mode-switcher.test.tsx`'s established pattern — list rendering, selection callbacks, creation-form submission, empty-state rendering.
- `test/web-smoke.test.ts`: one new real end-to-end case — create a second Thread (via a second `browser.newPage()`, matching the existing worktree-promotion test's isolation pattern, since the shared page's Thread already has history by this point in the file), switch to it from the Threads tab on a *fresh* page, confirm its own history renders and the other Thread's content does not — this is the test that actually proves the cross-thread event-bleed fix works, not just that the UI renders.

## Verification

1. `pnpm run typecheck` and `xvfb-run -a pnpm test` (full suite) — clean, including all new/extended test files above.
2. Manual check: run `argusde serve`, open the web UI against the real `claude-agent-acp`, create two Projects each with a Thread, send messages in both, switch between them via the Threads tab, confirm each Thread's own history (and only its own) renders correctly, confirm creating a new Project/Thread from the drill-down works and becomes the active chat.
3. Work happens on a branch (`feature/multi-project-ui`), committed incrementally (ws-protocol + ThreadRuntime mode cache + ws-server commands + tests → chat-state reducer + tests → App.tsx orchestration + cross-thread fix → ProjectPicker/ThreadList components + tests → web-smoke extension), pushed after each commit, self-reviewed with `/code-review high` before merging (established practice from Phases 1-7), PR opened once complete and green. Plan copied to `docs/plans/phase-8-multi-project-ui.md` per the standing repo convention.
