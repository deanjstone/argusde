# Phase 2b: Electron cutover to the shared web UI

> Implemented via `feature/electron-cutover`, in progress.

## Context

Phases 1 and 2 of spec [#33](https://github.com/deanjstone/argusde/issues/33) built a standalone server (event-sourced persistence, checkpoints, WebSocket API) and a shared, mobile-first web UI it serves over HTTP — verified working in a real browser against the real `claude-agent-acp`, and just used live from an iPhone over Tailscale. Both phases deliberately left Electron's original MVP architecture untouched so the app kept working throughout.

This phase does the cutover spec decision #5 called for: Electron's `BrowserWindow` loads the shared UI via `loadURL` against a configured server, instead of bundling its own renderer. Once that works, the entire MVP-era IPC path it replaces — `IpcRelay`, the utility-process entry point, the old renderer, the old preload bridge — is dead code and gets removed, not left alongside the new path.

**End state**: launch the Electron app with no server running → see a native connect screen (server URL field + Connect button, per spec decision #5) → point it at a running `argusde serve` (local or over Tailscale) → the exact same shared web UI used from a browser/phone now renders inside the Electron window, fully functional. No more bundled renderer, no more `IpcRelay`/utility-process IPC path.

## What's already true (facts gathered before planning, not assumptions)

- `src/main/index.ts` already has a `loadURL` branch (today gated behind `ARGUSDE_DEV_SERVER_URL`, dev-only) — confirms the mechanism, but the `loadFile(dist/renderer/index.html)` fallback and `IpcRelay` wiring both go away this phase.
- `src/preload/index.mts` exposes a single global `argusde` with 4 chat-specific IPC methods (`onSessionEvent`, `sendMessage`, `respondToPermission`, `restartSession`) — all superseded by the shared UI's own `WsClient` (`src/web/ws-client.ts`), which talks straight to the server over a real WebSocket. This preload gets rewritten for a much smaller job: backing the connect screen only.
- `src/main/ipc-relay.ts` forks `src/utility/index.ts` as a utility process running `AcpSession` — nothing in the Phase 1/2 server architecture uses this path (the server runs `AcpSession` in-process via `ThreadRuntime`, not via a forked utility process). Once `IpcRelay` is deleted, `src/utility/index.ts` (the fork entry point) has no caller left and is dead code too. `src/utility/acp-session.ts`, `fake-agent.ts`, and `spawn-agent-process.ts` stay — the server and its tests still use them directly.
- electron-builder's `files: ["dist/**/*"]` glob needs no config change for any of this — it already picks up whatever ends up under `dist/`, with no per-subfolder entries to update or remove.
- Nothing in `tsconfig.node.json`'s `include` needs to change for the utility-process deletion (glob-based, a deleted file just stops matching); `tsconfig.web.json` does need `src/renderer/**/*` dropped once that directory is deleted.

## New/changed module layout

- `src/main/server-config.ts` — reads/writes the persisted server URL as JSON (`{ serverUrl: string }`), no new dependency. Takes the config directory as a parameter (defaults to `app.getPath("userData")`) so it's testable against a real temp directory without a running Electron instance.
- `src/connect-screen/` — new, small, deliberately not React/Vite: `index.html` + `main.js` (plain JS, no build step — copied into `dist/connect-screen/` by the build script). A server-URL input, a Connect button, and an error message area. This is the one piece of UI that isn't server-served, since it has to work before any server is reachable — matching spec decision #5 exactly.
- `src/preload/index.mts` — rewritten to a much smaller bridge for the connect screen only: `getServerUrl()`, `setServerUrl(url)`, `retryConnect()`, `onConnectFailed(listener)`. Exposed as `window.argusdeConnect`. Still attaches to the one `BrowserWindow` regardless of which page is currently loaded (the real web UI ignores it — it doesn't use Electron APIs at all, by design, since it also runs in a plain browser).
- `src/main/index.ts` — rewritten: on startup, resolve the server URL (env var `ARGUSDE_SERVER_URL` override → persisted config → default `http://127.0.0.1:4870/`), attempt `loadURL`. On `did-fail-load`, show the connect screen instead (`loadFile`). The connect screen's "Connect" (via the new preload bridge) persists the entered URL and retries `loadURL`.
- **Deleted**: `src/renderer/` (all of it — `App.tsx`, `components/`, `chat-reducer.ts` + test, `app.css`, `index.html`, `main.tsx`, `window.d.ts`), `src/main/ipc-relay.ts`, `src/utility/index.ts`, `src/shared/ipc-contract.ts`, `vite.config.ts`, `test/smoke.test.ts` (replaced, see Testing).
- `package.json`: drop the renderer's `vite build` step from `build`; add a plain-copy step for `src/connect-screen` → `dist/connect-screen`; repoint the `dev` script at the web UI's dev server (the renderer one it currently starts no longer exists).
- `tsconfig.web.json`: drop the `src/renderer/**/*` include entries (only `src/web/**/*` and `src/shared/**/*` remain).

## Explicitly deferred out of Phase 2b

- Actually wiring `tailscale serve`/the startup QR code into `argusde serve` — still later phases; this phase only makes Electron capable of pointing at whatever URL you give it (including a manually-obtained Tailscale IP, as already demonstrated).
- PWA manifest/service worker, worktree-promotion UI, mode switcher, multi-project UI — unrelated to this cutover, unchanged from Phase 2's deferred list.
- Any visual/UX polish of the connect screen beyond "it works and is legible" — it's meant to be minimal, per spec decision #5, not a design surface.

## Testing (real collaborators over mocks, per established convention)

- `server-config.test.ts`: real temp directory, round-trips `setServerUrl`/`getServerUrl`, confirms a fresh directory defaults sensibly.
- `test/electron-smoke.test.ts` (replaces `test/smoke.test.ts`): launches a real server (`startWsServer` + the fixture agent CLI, `webDistDir` pointing at the real built `dist/web`) on an ephemeral port, then launches the real built Electron app with `ARGUSDE_SERVER_URL` pointed at it, and asserts the window's content is the shared web UI's setup screen (proving Electron correctly loads server-served content) — it does **not** re-drive a full chat round trip, since `test/web-smoke.test.ts` already covers that; this test's job is narrower: "Electron shows what the server serves."
- `test/electron-connect-screen.test.ts`: launches the real built Electron app with `ARGUSDE_SERVER_URL` pointed at an address nothing is listening on, asserts the connect screen renders (input + Connect button) instead of a blank/error page.
- Both Electron tests need a display (real or Xvfb), same requirement as the smoke test they replace.

## Verification

1. `pnpm run typecheck` — updated tsconfigs pass with `src/renderer` gone.
2. `pnpm test` — full suite green, including the two new/replaced Electron tests under `xvfb-run`.
3. Manual check: run `argusde serve`, launch the packaged/dev Electron app with no prior config → see the connect screen → enter the running server's URL → confirm the real shared UI loads and a real chat round trip works inside the Electron window.
4. Manual check: with a server already configured from a prior run, launch Electron directly into a working chat with no connect-screen detour.
5. Work happens on a branch (`feature/electron-cutover`), committed incrementally (server-config → connect screen → preload rewrite → main.ts rewrite → deletions → build script updates → new Electron tests), pushed after each commit, self-reviewed with `/code-review` before merging (established practice from Phases 1 and 2), PR opened once complete and green.

## Outcome

Landed as planned. Notable along the way:

- **Used a background agent for the mechanical cleanup step** (deletions + build/tsconfig updates) while writing the new Electron tests directly in parallel — a genuine, low-risk split since the two touched disjoint file sets. Coordinated by having the agent stage and commit only its specific files (never `git add -A`) and by committing my own test files with `git commit -- <specific paths>` rather than a blanket commit, so neither side's in-progress staged changes leaked into the other's commit.
- **A real bug found via manual verification, not the automated tests**: `loadURL()`'s own promise rejects on failure — a separate signal from the `did-fail-load` event this phase's connect-screen fallback relies on — and was uncaught, producing an unhandled promise rejection warning on every failed connection attempt. Found by driving a real Electron launch against an unreachable URL and reading the raw process output, not by the Playwright-driven assertions (which only check rendered content, not console warnings). Fixed with a defensive `.catch()`.
- **A test-writing pitfall avoided, not hit**: the first manual check attempt used `http://127.0.0.1:1/` as an "unreachable" URL — port 1 is on Chromium's restricted-ports list (`ERR_UNSAFE_PORT`), a different failure mode than a genuine connection refusal. Switched to port 59999 (outside that list) for both the manual check and `test/electron-connect-screen.test.ts`.
- Verified end-to-end three ways: the two new automated tests (`test/electron-smoke.test.ts` against the fixture agent, `test/electron-connect-screen.test.ts` against a genuinely closed port), and a full manual run against the real `claude-agent-acp` covering both scenarios the plan called for — fresh launch (no config) → connect screen → connect → real chat round trip inside Electron, and a second launch reusing the persisted config → straight to the setup screen, no connect-screen detour.
