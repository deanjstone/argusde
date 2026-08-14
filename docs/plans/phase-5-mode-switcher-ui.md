# Phase 5: Mode switcher UI

> Implemented via `feature/mode-switcher-ui`, in progress.

## Context

Spec [#33](https://github.com/deanjstone/argusde/issues/33) decision #9 and stories 24-25 want the user to switch an agent's session mode (e.g. Claude Code's `default`/`plan`/`acceptEdits`/`bypassPermissions`) from the UI, showing only whatever modes the connected agent actually advertises. Phase 1 already added most of the plumbing — `AcpSession.setMode()`, the `mode-changed` `AcpSessionEvent`, `ThreadRuntime` persisting `thread.mode-changed`, and the `thread.set-mode` WS command already exists and is fully wired server-side. What's missing is narrower than it looks: the client never learns the mode *catalog* (which modes exist, only that one is currently active), and there's no UI at all.

**End state**: on connecting to a Thread, the chat view knows the agent's current mode and the full list of modes it supports, and shows a compact switcher (e.g. "Plan ▾") the user can use to change modes — calling the real ACP `session/set_mode` through the WS command that already exists. If the connected agent doesn't advertise modes at all, no switcher renders (never a broken/empty control).

## Facts gathered this session (not assumptions)

- **The `thread.set-mode` WS command and its full server-side handling already exist and are untouched by this phase** (`src/shared/ws-protocol.ts`, `src/server/ws/ws-server.ts`'s `thread.set-mode` case, `ThreadRuntime.setMode()` at `src/server/session/thread-runtime.ts:73`, `AcpSession.setMode()` at `src/utility/acp-session.ts:252`) — this already calls the real ACP `session/set_mode` method. Nothing to build here.
- **What's actually missing is the mode *catalog*, not the switch mechanism.** `AcpSession.start()` (`src/utility/acp-session.ts:151`) calls `connection.agent.buildSession(cwd).start()` and stores the result as `this.activeSession`, but never reads `this.activeSession.modes` — confirmed via the SDK's own type declarations (`node_modules/@agentclientprotocol/sdk`'s `types.gen.d.ts`) that `ActiveSession.modes` is a getter returning `SessionModeState | null | undefined` = `{ currentModeId, availableModes: SessionMode[] }`, where `SessionMode = { id, name, description? }`. This is populated from the real `session/new` response's optional `modes` field — Claude Code's real agent advertises this today (confirmed by spec decision #9's own research, "expected to mirror Claude Code's default/plan/acceptEdits/bypassPermissions modes").
- **The existing `mode-changed` `AcpSessionEvent`** (`src/shared/acp-events.ts:70`, currently `{ kind: "mode-changed"; modeId: string }`) is only ever emitted from `current_mode_update` notifications (`acp-session.ts:198-200`) — a *change* signal, never the initial catalog. It needs one more field (`availableModes`, optional) and one more emission site (once at session start, if the agent advertised modes).
- **The client already receives every `mode-changed` event live** — `ThreadRuntime`'s `handleEvent` (`thread-runtime.ts:85-86`) forwards every `AcpSessionEvent` to `onEvent` before persisting anything, and `ws-server.ts`'s `onEvent` callback broadcasts it as a `session.event` push immediately. So once `AcpSession` emits the initial mode-changed event during `start()`, no new WS command is needed to deliver it — it arrives the same way a streamed message chunk does, before `thread.create`'s own `command.result` even returns (already-established, order-tolerant pattern this codebase relies on elsewhere).
- **`chat-state.ts`'s reducer currently no-ops on `mode-changed`** (`case "plan": case "mode-changed": return state;`, `src/web/chat-state.ts:78-79`) — this is the only reducer change needed to start tracking mode state.
- **The fake agent used in tests** (`src/utility/fake-agent.ts`) already has a `session.setMode` request handler that notifies `current_mode_update` (confirms the *change* path is already tested), but its `session.new` handler returns a bare `{ sessionId }` with no `modes` — needs a `modes` option added to `FakeAgentOptions` so a real end-to-end test can exercise the *catalog* path too, matching this repo's "real over mocked" convention (the SDK's own `NewSessionResponse.modes` field, not a hand-rolled stand-in).

## Design

**`src/shared/acp-events.ts`**: extend the `mode-changed` variant:
```ts
| { kind: "mode-changed"; modeId: string; availableModes?: Array<{ id: string; name: string; description?: string }> }
```

**`src/utility/acp-session.ts`**: in `start()`, right after `this.activeSession = await connection.agent.buildSession(...).start();`, read `this.activeSession.modes`; if present, emit the mode-changed event with both `modeId` and `availableModes` (mapped from `SessionMode[]`). The existing `current_mode_update` handler stays as-is (mid-session changes only ever carry the new `modeId`, never a changed catalog — matches the ACP spec's `CurrentModeUpdate` shape, which has no `availableModes` field).

**`src/utility/fake-agent.ts`**: add an optional `modes?: { currentModeId: string; availableModes: Array<{id,name,description?}> }` to `FakeAgentOptions`, passed through in the `session.new` handler's response (`{ sessionId, modes: options.modes }`) — mirrors the real SDK response shape exactly, no invented protocol.

**`src/web/chat-state.ts`**: add `currentModeId: string | undefined` and `availableModes: Array<{id,name,description?}>` to `ChatState`. Split the `mode-changed` case out of the current no-op: always update `currentModeId`; update `availableModes` only when the event carries it (mid-session change events don't, and mustn't clobber the catalog learned at session start).

**New `src/web/components/mode-switcher.tsx`**: small presentational component — a compact control (native `<select>` is the simplest, most accessible choice for a short, closed list; matches this repo's minimal-primitives approach, no new dependency) listing `availableModes` by name, current selection driven by `currentModeId`, calling `onSetMode(modeId)`. Renders nothing if `availableModes` is empty (agent doesn't support modes) — same "render nothing until there's something to show" pattern already used by `CheckpointStrip`/`DiffView`.

**`src/web/components/chat-view.tsx`**: render `ModeSwitcher` in the header area (next to/below the connection-status line, above the checkpoint strip) — compact, always-visible, matching spec decision's "per-Thread switcher" without needing a separate screen. New optional props (`currentModeId`, `availableModes`, `onSetMode`), same optional-with-safe-default pattern as the Phase 4 checkpoint props.

**`src/web/App.tsx`**: `handleSetMode(modeId)` — thin wrapper calling `client.sendCommand({ type: "thread.set-mode", threadId, modeId })` (already-existing command), matching `handleRespondPermission`'s existing error-surfacing pattern (dispatch a `protocol-error` on failure). No new state needed beyond what's already in `chatState` (mode fields added above) — no separate `useState` the way checkpoints needed, since mode is purely event-driven through the existing reducer.

## Explicitly deferred out of Phase 5

- Worktree promotion UI, multi-project UI, the version-compatibility handshake, the PWA — unchanged from prior phases' deferred lists.
- Any mode-specific behavioral changes to the UI itself (e.g. dimming the input in a read-only mode) — out of scope; this phase only wires the switch, not mode-aware UI behavior.

## Testing (real collaborators over mocks, per established convention)

- `acp-session.test.ts`: extend with a real case — construct the fake agent with `modes` configured, start a session, assert the very first emitted event is `mode-changed` with the expected `modeId` and `availableModes`. A second case confirms `setMode()` still round-trips through `current_mode_update` correctly (regression coverage for the existing path).
- `chat-state.test.ts`: reducer-level cases — an initial mode-changed event (with `availableModes`) populates both fields; a later mode-changed event (without `availableModes`, matching a real mid-session `current_mode_update`) updates `currentModeId` only and leaves the existing `availableModes` list untouched.
- `mode-switcher.test.tsx`: component-level, matching `checkpoint-strip.test.tsx`'s style — renders nothing with an empty `availableModes`; renders one option per mode with the current one selected; calls `onSetMode` with the chosen id on change.
- `test/web-smoke.test.ts`: extend the existing real-browser round trip once more — configure the fixture agent (via the new fake-agent `modes` option, reached through the same `ARGUSDE_FAKE_AGENT_STEPS`-style env-var plumbing `test/fixtures/fake-agent-cli.mjs` already uses) with two modes, assert the switcher renders both, select the second, assert a real `current_mode_update` round trip changes the selection.

## Verification

1. `pnpm run typecheck` and `xvfb-run -a pnpm test` (full suite) — clean, including all new/extended test files above.
2. Manual check: run `argusde serve`, open the web UI against the real `claude-agent-acp`, confirm the switcher shows Claude Code's real modes, confirm switching modes actually changes agent behavior (e.g. `plan` mode declining to edit files) and the switcher reflects the change.
3. Work happens on a branch (`feature/mode-switcher-ui`), committed incrementally (acp-events + AcpSession + fake-agent → chat-state reducer → ModeSwitcher component → ChatView/App.tsx wiring → web-smoke extension), pushed after each commit, self-reviewed with `/code-review high` before merging (established practice from Phases 1-4), PR opened once complete and green. Plan copied to `docs/plans/phase-5-mode-switcher-ui.md` per the standing repo convention.
