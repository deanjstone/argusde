# Phase 12: Resume most-recently-active Thread across reload

> Implemented via `feature/resume-last-thread`, in progress.

## Context

Spec [#33](https://github.com/deanjstone/argusde/issues/33) Story 28: "As a user, I want the chat view to default to whichever conversation I was most recently active in, so that reopening ArgusDE drops me back where I left off regardless of which project that conversation belongs to." Every phase since Phase 8 has explicitly deferred "full reload persistence" as a separate, later concern — Phase 11's `hasEverHadThread` flag deliberately only survives within a single page session, not a real browser reload. This is the last of the three previously-identified spec gaps (PWA installability and Thread close both already shipped); closing it completes spec #33's Phase 1–12 sequence.

## Facts gathered this session (not assumed)

- **Zero `localStorage`/`sessionStorage`/`IndexedDB` usage anywhere in `src/web/`** (confirmed via grep) — genuinely greenfield for the web client.
- **`loadThreadHistoryAndBecomeActive(threadId)` (`App.tsx`) already does everything needed to restore a Thread** — `thread.get-history` returns messages, mode/catalog, connection state, `worktreePath`, `closedAt`, all already consumed and fed into `becomeActiveThread`. It works even for a Thread whose server-side `ThreadRuntime` isn't currently active (confirmed by `thread.get-history`'s own handler using plain `requireThread`, not `requireOpenThread`, specifically so history stays browsable after a restart or a close). **This phase needs zero server-side or reducer changes** — purely "remember which threadId, and call this existing function with it early enough."
- **The closest existing persistence precedent in this codebase** is Electron's own `src/main/server-config.ts` (a plain JSON file via raw `fs`, not a library): fail-soft read with a sane default on any error, write-on-success-only (gated on the connection actually succeeding, not on every attempt), and small pure read/write functions taking the storage location as a parameter rather than reaching for a global inside the caller. The web-client design below follows the same shape, adapted to `localStorage`.
- **`becomeActiveThread`** (the one existing "this Thread is now active" chokepoint, already used by every code path — first-run, selecting an existing Thread, creating a Project/Thread) is exactly where the "remember this" write belongs — one call site, not four.
- **No existing Playwright test in this repo asserts `localStorage` or calls `page.reload()`** — `test/web-smoke.test.ts` has the right harness shape to extend (real server, real Chromium `page`), but this establishes the pattern fresh.

## Design

**`src/web/App.tsx`**:
- Two small module-level pure functions (outside the component, matching `server-config.ts`'s shape): `readLastActiveThreadId(): string | null` and `writeLastActiveThreadId(threadId: string): void`, both wrapping `localStorage` calls in `try/catch` (fails soft — `localStorage` can throw in some browser storage/privacy configurations; losing reload-resume is a soft failure, never worth crashing over), plus `clearLastActiveThreadId()` for the stale-reference case below. Key: `"argusde:lastActiveThreadId"`.
- `becomeActiveThread` gets one new line: `writeLastActiveThreadId(info.threadId)` — the single write site for every "become active" path (first-run, select-existing, create-Project, create-Thread all already funnel through here).
- New `const [restoring, setRestoring] = useState(true)` — starts `true` unconditionally (cheap: it resolves to `false` in the same tick `server.welcome` arrives even when there's nothing to restore, so a fresh install sees no extra delay beyond today's existing `!connected` "Connecting…" gate).
- New `attemptSessionRestore()`, called once from inside the WS push handler's existing `case "server.welcome":` (right after `setConnected(true)` — no new `useEffect`/dependency-array needed, since this is the one point the app already knows the connection is live): reads the remembered id; if none, just resolves `restoring` to `false`; if present, calls the existing `loadThreadHistoryAndBecomeActive(id)` — on success it naturally sets `thread`/`hasEverHadThread` (and re-writes the same id, a harmless no-op); on failure (Thread no longer resolves — e.g. a wiped/replaced database) it calls `clearLastActiveThreadId()` so a future reload doesn't keep repeating a futile round trip, then falls through to the existing `!thread && !hasEverHadThread` → `WorkspaceSetup` gate. Either way, `finally` sets `restoring` to `false`.
- Top-level render gate becomes `if (!connected || restoring) { return <Connecting-or-restoring placeholder/>; }` — same placeholder component, text swapped between "Connecting…" and "Restoring your last session…" based on which is true, before the existing `!thread && !hasEverHadThread` check.

## Explicitly deferred / non-goals

- **Cross-tab sync** (a `storage` event listener to keep multiple open tabs' "last active" in sync). Standard last-write-wins `localStorage` semantics are enough — not asked for, and this app's UI direction never promised simultaneous multi-tab editing of the same session.
- **Restoring which *tab* (Chat/Threads/Settings) was active**, or `selectedProjectId`/drill-down position. Story 28 is specifically about the Chat tab defaulting to the last-active Thread — restored sessions always land on the Chat tab (matching `becomeActiveThread`'s own existing `setTab("chat")`).
- **Distinguishing a closed Thread from an open one for restore purposes.** A closed Thread resolves via the exact same `loadThreadHistoryAndBecomeActive` path (it already renders correctly, per Phase 11) — no special-casing needed, and reopening into a closed Thread's read-only history is itself a reasonable "where I left off" outcome, not a bug to guard against.

## Testing (real collaborators over mocks, per established convention)

- `test/web-smoke.test.ts`: two new real E2E cases, each using an isolated `browser.newPage()` (which Playwright gives its own isolated `localStorage` automatically) + isolated repo, matching the established pattern for tests needing controlled state:
  1. Complete first-run setup, send a real message, `page.reload()`, confirm the app lands directly back in the Chat tab with that history intact — WorkspaceSetup never shown again.
  2. Seed a bogus/nonexistent threadId into `localStorage` directly (`page.evaluate`) before ever completing first-run setup, reload, confirm it falls back to WorkspaceSetup cleanly (no hang, no crash) rather than getting stuck showing "Restoring your last session…" forever.
- No server-side or reducer test changes needed — confirmed nothing there is touched by this phase.

## Verification

1. `pnpm run typecheck` and `xvfb-run -a pnpm test` (full suite) — clean.
2. `pnpm run build` (full build) then a manual check against the real `claude-agent-acp`: create a Project/Thread, send a message, reload the page — confirm it lands back in Chat with history intact, not the first-run screen; also manually clear `localStorage` and confirm a reload correctly falls back to first-run setup.
3. Work happens on a branch (`feature/resume-last-thread`), committed incrementally (App.tsx read/write/restore logic → web-smoke tests), pushed after each commit, self-reviewed with `/code-review high` before merging (established practice from Phases 1–11), PR opened once complete and green. Plan copied to `docs/plans/phase-12-resume-last-thread.md` per the standing repo convention.
