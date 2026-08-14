# Phase 6: Version compatibility handshake

> Implemented via `feature/version-handshake`, in progress.

## Context

Spec [#33](https://github.com/deanjstone/argusde/issues/33)'s client/server version-skew decision: because the shared web UI is always served fresh from the server (no client-side UI bundle to go stale), the only remaining version-skew risk is Electron's native shell — the connect screen plus the `loadURL`-driven connection to a configured server — talking to a server whose API has moved on (or vice versa: an old server, a newer Electron build). The design is a simple handshake: the server already announces its API version on every WS connect (`server.welcome`); Electron's native shell needs to compare that against its own compiled-in expected version and refuse to proceed with a clear "update ArgusDE" message on mismatch, instead of loading a UI that may not speak the same protocol.

**End state**: launching Electron against a server whose `apiVersion` doesn't match Electron's own compiled-in expected version shows the connect screen with an explicit incompatibility message (naming both versions) instead of silently loading a UI that might misbehave. A matching version loads exactly as today — no behavior change for the common case.

## Facts gathered this session (not assumptions)

- **The server already announces its version on every connect** — `SERVER_API_VERSION = "1.0.0"` (`src/server/ws/ws-server.ts:18`) is sent as `{ type: "server.welcome", apiVersion }` the moment any WS client connects (`ws-server.ts:139`). Nothing new needed server-side beyond relocating this constant (see below) — it already fully implements "the server announces its API version as part of the WebSocket connection handshake."
- **The shared web UI already receives and displays it** — `chat-state.ts`'s `apiVersion` field is populated on the `welcome` event and shown on the Settings tab. This is the *browser* client's own visibility into the version, unrelated to what this phase adds.
- **What's actually missing is narrower than "add a handshake"**: only the Electron *native shell* — `src/main/index.ts` — needs to check compatibility, and only it, since post-Phase-2b Electron has no native WS client of its own anymore; it just `loadURL`s the shared web UI, which then makes its own ordinary WS connection exactly like a browser would. The check has to happen as a step *before* committing to `loadURL`, using a short-lived throwaway WS connection from the main process — there's no other point in the current flow where Electron's native code sees the server's `server.welcome` message at all.
- **`SERVER_API_VERSION` currently lives in `ws-server.ts`**, which imports `ws`, `http`, `AcpSession`, `EventStore`, etc. — importing that file from Electron's main process to reach a single string constant would drag the whole server module graph (including `better-sqlite3`'s native binding) into the Electron main bundle. It needs to move to `src/shared/ws-protocol.ts` (already the dependency-light, browser-and-server-safe home for `WS_PATH` and `CheckpointRecord`, for exactly this reason) — `ws-server.ts` then imports it from there instead of declaring it.
- **`ws` is already a direct dependency** (`package.json`, not dev-only) — Electron's main process can use it directly for the throwaway pre-check connection without adding anything.
- **The existing connect-screen failure plumbing already supports an arbitrary message string** — `showConnectScreen(window, failureMessage: string)` (`src/main/index.ts`) just forwards whatever string it's given via `IPC_CONNECT_FAILED` to the connect screen's `onConnectFailed` listener. A version-mismatch message needs no protocol change, just a different string down the same existing path used for ordinary connection failures.
- **The existing `did-fail-load` failure path must stay the fallback for "can't determine the version at all"** (server down, wrong URL, network error) — this phase only adds a *new*, more specific failure mode (version mismatch) alongside the existing generic one, not a replacement for it.

## Design

**`src/shared/ws-protocol.ts`**: move `SERVER_API_VERSION` here (rename to `API_VERSION` since it's no longer server-only) as the single shared source of truth both sides compile against.

**`src/server/ws/ws-server.ts`**: import `API_VERSION` from the shared module instead of declaring its own constant; behavior at the WS layer is unchanged (still sent in `server.welcome`).

**New `src/main/version-check.ts`**: a small, injectable-for-testing module (same DI pattern as `src/server/remote/tailscale.ts`'s `exec` injection) —
- `checkApiVersion(serverUrl: string, expectedVersion: string, timeoutMs = 5000): Promise<VersionCheckResult>`, where `VersionCheckResult` is a discriminated union: `{ status: "compatible" }` | `{ status: "incompatible"; serverVersion: string; expectedVersion: string }` | `{ status: "unknown" }` (connection failed, timed out, or the response was malformed — deliberately *not* an error the caller has to catch; "unknown" means "let the normal loadURL attempt proceed and explain its own failure").
- Implementation: converts `serverUrl` to a `ws(s)://.../ws` URL (mirrors the `wsProtocol` derivation already done in `src/web/App.tsx`), opens a real `ws` `WebSocket`, waits for the first message, expects `server.welcome`, compares `apiVersion` to `expectedVersion`, always closes the socket, and resolves (never rejects) — a bounded timeout guards against a server that accepts the TCP connection but never sends `server.welcome`.

**`src/main/index.ts`**: `attemptConnect` becomes async — before calling `window.loadURL(url)` for a real (non-connect-screen) server URL, call `checkApiVersion(url, API_VERSION)`:
- `"compatible"` or `"unknown"` → proceed to `loadURL(url)` exactly as today (the `did-fail-load` handler already in place covers the "unknown" case's eventual real failure, if any).
- `"incompatible"` → skip `loadURL` entirely and call `showConnectScreen(window, ...)` directly with a message naming both versions (e.g. `"ArgusDE (vX) can't connect to this server (vY) — please update ArgusDE."`), reusing the exact same connect-screen path the existing failure case already uses.

## Explicitly deferred out of Phase 6

- Any auto-update or self-replace mechanism — spec decision is explicit that this handshake is refuse-and-tell-the-user only.
- Any version check for the browser/PWA client (already covered — it just displays whatever `apiVersion` it received, no refuse-to-connect behavior is specified for it, and none is added here).
- Worktree promotion UI, multi-project UI, the PWA — unchanged from prior phases' deferred lists.

## Testing (real collaborators over mocks, per established convention)

- `version-check.test.ts`: real `ws` `WebSocketServer` test doubles (no mocking of the `ws` module) —
  - A real minimal WS server sending `{ type: "server.welcome", apiVersion: "1.0.0" }` → `checkApiVersion(url, "1.0.0")` resolves `{ status: "compatible" }`.
  - Same server, checked against `"2.0.0"` → resolves `{ status: "incompatible", serverVersion: "1.0.0", expectedVersion: "2.0.0" }`.
  - A real, actually-started `startWsServer` instance (proving this works against the *real* production server code, not just a hand-rolled double) → `checkApiVersion` against its real `API_VERSION` resolves `"compatible"`.
  - Nothing listening on the target port → resolves `{ status: "unknown" }` (never rejects).
  - A server that accepts the connection but never sends anything → resolves `{ status: "unknown" }` after the timeout (short timeout used in this test to keep it fast).
- `test/electron-connect-screen.test.ts`: extend with a real case — start a real `startWsServer`-backed server but connect a real, minimal WS server double advertising a mismatched `apiVersion` in front of it (or, simpler: a second, bare `ws` `WebSocketServer` standing in as "the server" for this one test, matching `version-check.test.ts`'s pattern) at the URL Electron is pointed at, launch the real built Electron app, assert the connect screen renders with a message naming both versions instead of the generic "Couldn't reach" text.
- `test/electron-smoke.test.ts`: no changes needed — it already exercises the compatible-version path implicitly (real server, real matching `API_VERSION`), and continuing to pass proves this phase didn't regress the common case.

## Verification

1. `pnpm run typecheck` and `xvfb-run -a pnpm test` (full suite) — clean, including the new `version-check.test.ts` and the extended Electron test.
2. Manual check: run `argusde serve`, launch the real built Electron app against it → connects normally (compatible case, unchanged from today). Then temporarily point Electron at a stubbed server announcing a different `apiVersion` and confirm the connect screen shows the specific incompatibility message.
3. Work happens on a branch (`feature/version-handshake`), committed incrementally (shared constant move → version-check module + tests → main/index.ts wiring → electron-connect-screen test extension), pushed after each commit, self-reviewed with `/code-review high` before merging (established practice from Phases 1-5), PR opened once complete and green. Plan copied to `docs/plans/phase-6-version-handshake.md` per the standing repo convention.
