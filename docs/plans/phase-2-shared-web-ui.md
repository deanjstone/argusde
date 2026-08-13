# Phase 2: Shared web UI + server HTTP serving (functional parity chat, in a browser)

> Implemented via `feature/shared-web-ui`, in progress.

## Context

Spec [#33](https://github.com/deanjstone/argusde/issues/33) calls for a shared, mobile-first, shadcn-based UI served by the standalone server (Phase 1, merged) and used identically by the PWA and Electron. That's still too much for one phase — it bundles UI scaffolding, server HTTP-serving, an Electron cutover, and several deferred features (worktree-promotion UI, mode switcher, multi-project UI, Tailscale wiring) into one change.

This plan scopes **Phase 2 only**: get a real, functional chat working end-to-end through the new architecture, reachable in a plain browser — proving the "server serves the UI" model works — **without touching Electron at all**. The current Electron MVP keeps working completely unchanged throughout this phase, exactly like Phase 1. Wiring Electron to load this UI via `loadURL` and retiring the old `src/renderer`/`src/preload`/`IpcRelay`/`utilityProcess` path is **Phase 2b**, a separate follow-up once this is proven. Checkpoint timeline UI, worktree indicators, the mode switcher, multi-project UI, and Tailscale `serve` wiring are all further phases on top of this base — deliberately not attempted here.

**End state of Phase 2**: run `argusde serve`, open `http://<host>:<port>/` in a browser, enter a workspace path, and chat with the real agent through the new WebSocket protocol — message streaming, permission prompts, and connection status all working, styled with a mobile-first shadcn-based UI matching the chosen prototype direction's bottom tab bar (Chat/Threads/Settings), even though only the Chat tab is fully functional this phase.

## What's already true (facts gathered before planning, not assumptions)

- The WS server (`src/server/ws/ws-server.ts`) currently calls `new WebSocketServer({ host, port })` with **no** explicit `http.Server` — the `ws` package creates one implicitly. Serving static files on the same port requires creating an explicit `http.Server` first and passing `{ server }` (plus a `path: "/ws"` filter, so normal page GETs aren't mistaken for upgrade requests) instead of `{ port }`.
- The protocol (`src/server/ws/protocol.ts`) already has everything Phase 2 needs — `project.create`, `thread.create`, `thread.send-message`, `thread.respond-permission` — **no new server-side commands required**.
- Nothing in the repo has Tailwind, PostCSS, or shadcn set up anywhere — this is a from-scratch scaffold, not an extension of existing config.
- The current renderer's components (`MessageList`, `ChatInput`, `ContentBlockView`, `PermissionPrompt`, `ConnectionStatus`) and `chat-reducer.ts` are useful *reference* for props/behavior, but per spec decision #5 the new UI is a rebuild on shadcn primitives, not an adapted copy — and `chat-reducer.ts`'s event shape doesn't match the new protocol anyway (it has no `threadId`/`session.event` wrapper concept, and nothing for `server.welcome`/`command.result`/`protocol-error`).
- Electron's `src/main/index.ts` already has a `loadURL` code path (today gated behind `ARGUSDE_DEV_SERVER_URL`, dev-only) — confirms the mechanism Phase 2b will lean on, but that's out of scope here.

## New module layout

- `src/web/` — new Vite + React + Tailwind + shadcn app, its own `vite.config.web.ts` (`root: "src/web"`, `outDir: "../../dist/web"`), completely separate from `vite.config.ts`/`src/renderer` (which stays untouched for the still-live Electron MVP).
  - `src/web/main.tsx`, `src/web/App.tsx` — entry + root component.
  - `src/web/ws-client.ts` — a small WS client wrapper: connects, sends `ClientCommand`s with a generated `commandId`, resolves the matching `command.result`, and exposes an event stream for `session.event`/`protocol-error` pushes. This is the new-protocol equivalent of what `window.argusde` (Electron's preload bridge) does today — but talking real WebSocket, not IPC.
  - `src/web/chat-state.ts` — a reducer adapted from `chat-reducer.ts`'s *logic* (message/tool-call merging, connection state) but rebuilt against the real `AcpSessionEvent` unwrapped from `session.event.event`, plus new cases for `server.welcome`/`command.result`/`protocol-error`. Not a copy-paste — a fresh reducer for the new shape.
  - `src/web/components/ui/` — shadcn primitives (scaffolded via the shadcn CLI or hand-written to match its standard Vite+React output — `components.json`, `lib/utils.ts`, the handful of primitives actually used: button, input, card, tabs or similar for the bottom nav).
  - `src/web/components/` — app-level components: `ChatView` (message list + input + permission prompt + connection badge, mobile-first), `TabBar` (bottom Chat/Threads/Settings nav per the chosen prototype direction), `WorkspaceSetup` (the first-run "enter a workspace path" form shown before any Project/Thread exists — there's no project-picker UI yet since multi-project UI is a later phase, so this is the minimum viable "how do I even start chatting" flow).
  - App flow: on load, if no thread exists yet, show `WorkspaceSetup` (a path input + "Start" button) → sends `project.create` then `thread.create` → once a thread exists, show the tab bar shell with `ChatView` under the Chat tab. Threads tab shows just the one active thread (no creation/switching UI). Settings tab shows static connection info (server URL apiVersion from `server.welcome`) — no editable fields yet, that's Electron-side Phase 2b territory.
- `src/server/http/static-server.ts` — small hand-rolled static file server (no new dependency — `node:http`/`node:fs`/`node:path`, a mime-type lookup for the handful of extensions a Vite build produces, and basic path-traversal safety) serving `dist/web`.
- `src/server/ws/ws-server.ts` — modified: create the `http.Server` explicitly, mount the static server on it for all non-WS-upgrade GET requests, pass `{ server, path: "/ws" }` to `WebSocketServer`. `WsServerHandle`'s `port`/`close()` behavior stays the same.
- `src/server/cli.ts` / `src/server/index.ts` — modified minimally: `startServer` needs to know where the built web assets live (`dist/web`) to pass to the static server.

## New dependencies

- `tailwindcss` + `@tailwindcss/vite` (Tailwind v4's Vite plugin — no separate PostCSS config file needed) as devDependencies, scoped to `src/web`'s build only.
- shadcn primitives are copied source, not an npm package — their usual peer deps (`class-variance-authority`, `clsx`, `tailwind-merge`, `lucide-react`, plus whichever `@radix-ui/*` packages the chosen primitives need) get added as regular dependencies of `src/web` (still just root `package.json`, no workspace split).
- No new dependency for static file serving (hand-rolled, per above) — matches this repo's established "minimal dependencies" bias (already chose `ws` over `socket.io`, `better-sqlite3` over an ORM).

## Explicitly deferred out of Phase 2

- **All of Electron** — `main/index.ts`, `preload/`, `IpcRelay`, `utilityProcess`, and the old `src/renderer` stay exactly as they are, fully functional. Phase 2b wires Electron's `loadURL` to this new UI, adds the native connect-screen fallback, and only then retires the old renderer/preload/IPC path.
- Checkpoint timeline strip, worktree indicator, mode switcher — all need either new WS query commands (checkpoint listing) or UI wiring for things this phase doesn't touch (worktree promotion, `thread.set-mode`). Visual/functional additions on top of this base, not required to prove the architecture.
- Multi-project UI (Projects→Threads drill-down) — Phase 2's Threads tab is a stub showing the single created thread, not a real project switcher.
- Tailscale `serve` wiring + startup QR code — still Phase 2/3 per the original spec sequencing; `argusde serve` keeps binding to a plain host/port.

## Testing (test-first, per repo + spec convention: real collaborators over mocks)

- `static-server.test.ts`: serves a real temp directory of fixture files over a real HTTP request (`fetch` against a real listening server), asserting correct content + mime type + a 404 for a missing path + no path-traversal escape.
- `ws-server.test.ts` (extend existing): a real HTTP GET against the server's root path returns the built web UI's `index.html` (or a fixture stand-in for `dist/web` in tests, matching how existing tests already avoid depending on a full `pnpm run build`), and the WS upgrade still works correctly now that it shares the `http.Server` with static serving.
- `src/web/chat-state.test.ts`: pure reducer tests (synthetic `ServerPush` sequences in, `ChatState` out) — same style as the existing `chat-reducer.test.ts`.
- `src/web/components/*.test.tsx`: props-in/rendered-output-out component tests for `ChatView`, `TabBar`, `WorkspaceSetup` — no WS involved, per the spec's testing decision.
- One E2E test (`test/web-smoke.test.ts` or similar): Playwright's **browser** context (not Electron launch, since this UI has nothing to do with Electron yet) against a real running server + the existing fixture agent CLI — enter a workspace path, send a message, see the streamed reply rendered. This is the seam the spec explicitly calls out ("real browser context... exercising a full message round trip").

## Verification

1. `pnpm run typecheck` — extend `tsconfig.web.json`'s include (or add a parallel config) to cover `src/web/**/*.{ts,tsx}`; `tsconfig.node.json`/`tsconfig.test.json` to cover `src/server/http/**/*.ts`.
2. `pnpm test` — new unit/component tests pass, existing suite (including the Electron smoke test) stays green untouched.
3. Manual end-to-end check: `pnpm run build:web && pnpm run serve`, open `http://127.0.0.1:<port>/` in a real browser, enter a real workspace path, chat with the real `claude-agent-acp`, confirm streaming + a permission prompt round-trip if the agent requests one.
4. Work happens on a branch (`feature/shared-web-ui`), committed incrementally per module (static server → ws-server HTTP integration → web app scaffold + shadcn setup → ws-client → chat-state reducer → components → E2E test), pushed after each commit, self-reviewed with `/code-review` before merging (per this session's confirmed practice), PR opened once Phase 2 is complete and green.

## Outcome

Landed as planned, with a few adjustments discovered along the way:

- **`protocol.ts` moved to `src/shared/`** (from `src/server/ws/`) before writing `ws-client.ts` — it's a genuine client-server contract, and importing it from `src/web` across into `src/server` wasn't clean given the tsconfig split. Not anticipated in the original plan, but a one-line-of-reasoning fix once hit.
- **shadcn primitives ended up leaner than "the CLI's output"**: hand-written `Button`/`Input` using plain Tailwind utility classes + `cn()`, skipping `class-variance-authority`, `@radix-ui/react-slot`, and `lucide-react` — none were earning their keep for a two-component set at this phase's scope. Same structural pattern (forwardRef, typed variant props), fewer dependencies.
- **Component testing infrastructure didn't exist yet** — added `@testing-library/react`, `jsdom`, `@testing-library/jest-dom`, and a shared `test-setup.ts` (vitest isn't in `globals` mode, so testing-library's auto-cleanup detection never fires without an explicit `afterEach(cleanup)`).
- **Real bugs found via TDD, not just the happy path**: `chat-state.ts`'s `user-message-sent` case initially reused the "merge with last message of this role" heuristic (correct for streaming agent replies with no `messageId`) for locally-sent user messages too — two separately-sent messages would have silently concatenated into one timeline entry. Caught by a dedicated regression test before it ever reached a browser.
- **One real bug found only in manual browser verification, not the automated suite**: `WorkspaceSetup`'s `h-full` never resolved to anything, since `html`/`body`/`#root` had no explicit height for it to cascade from — the page rendered correctly in content but only filled the top portion of the viewport. Fixed via a small global CSS addition. A reminder that component tests (jsdom, no real layout engine) don't catch layout/CSS bugs — only an actual rendered browser does.
- **`tsconfig.test.json` was silently never covering `test/**/*.ts` at all** (pre-existing gap, not introduced this phase) — discovered when adding `test/web-smoke.test.ts` and wiring it into `pnpm run typecheck`'s coverage. Fixed by overriding `rootDir` for that noEmit-only project.
- End-to-end verified twice: once against the fixture agent (automated `test/web-smoke.test.ts`, a real server + real Playwright browser context), and once manually against the real `claude-agent-acp` (real tool use — `find` + `Read` — streamed back and rendered correctly across all three tabs).
- **Self-review before merge** (`/code-review high`, per the confirmed practice from Phase 1) found and fixed 6 more real issues: a malformed-URL request could crash the whole server process (`decodeURIComponent` uncaught); `WsClient.sendCommand()` hung forever if the socket closed before a reply arrived; `close()` could stall on lingering idle keep-alive HTTP connections; a permission-response send failure was silently swallowed instead of surfacing; the CLI's startup log printed a URL missing the `/ws` path; and `chat-state.ts` turned out to duplicate `chat-reducer.ts`'s timeline-merge logic byte-for-byte, extracted to `src/shared/timeline.ts`. Most fixes are test-first (reproduced red, fixed green); the keep-alive stall is a defensive fix applied on Node's documented `close()` semantics even though it didn't reproduce cleanly in this environment.
