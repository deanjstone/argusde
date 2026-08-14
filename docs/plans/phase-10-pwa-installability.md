# Phase 10: PWA installability

> Implemented via `feature/pwa-installability`.

## Context

Spec [#33](https://github.com/deanjstone/argusde/issues/33)'s "UI delivery & sharing" section and User Story 3 both name the PWA as the mobile answer — "the standalone server serves one shared UI build... used identically by the PWA and by Electron," "As a user, I want to open the ArgusDE PWA on my phone and see the exact same interface I'd see on desktop." Confirmed via a fresh repo survey (this session): there is no manifest.json/webmanifest, no service worker, and no app icon anywhere in the repo — it's a plain server-served SPA with zero installability story today. Every phase from 4 through 9 has listed this as deferred/out-of-scope; Phase 9 was the last one to explicitly push it further out. This phase closes it.

## Facts gathered this session (not assumed)

- **`vite.config.web.ts`** (13 lines): `root: "src/web"`, `base: "./"`, plugins `[react(), tailwindcss()]`, `build.outDir: "../../dist/web"`. No `public/` directory currently exists under `src/web/` — Vite's convention copies anything placed there straight into `outDir` unprocessed, which is exactly what a manifest + service worker + icon files need (no build-time transformation).
- **`src/web/index.html`** (12 lines): bare `<head>` with just charset/viewport/title — no manifest link, no theme-color, no icon links at all. `viewport-fit=cover` is already set (good — needed for iOS safe-area handling in standalone mode).
- **`src/web/main.tsx`** (7 lines): the entire React entry point — creates the root and renders `<App />`. This is where service-worker registration belongs (matching "setup happens in TS, not inline HTML script" — the only precedent this repo has for entry-point wiring).
- **`src/server/http/static-server.ts`**: hand-rolled static file server (no dependency, matching this repo's existing "no ORM, no socket.io" minimalism). Its `MIME_TYPES` map **already includes** `.json → application/json`, `.svg`, `.png`, `.ico`, `.js` — a `manifest.json` and `sw.js` need **zero changes** here. It also sets no `Cache-Control` headers on anything today (deliberately out of scope to touch — see Design below).
- **No app icon or logo exists anywhere in the repo** — not in `src/`, not in the Electron connect-screen (`src/connect-screen/index.html`, which has no logo either, just text + the `#7c3aed`/`#8b5cf6` purple accent colors), not in `electron-builder`'s config (no `icon` key set at all). One will need to be created from scratch; the connect-screen's purple is the only existing brand-color signal to anchor it to.
- **A real design constraint from spec #33 itself, not just a preference**: the client/server version-compatibility section explicitly states the web UI has no version-skew risk to solve "because the UI is always served fresh from the server (no client-side UI bundle to go stale)" — that's *why* Phase 6's version handshake only needed to cover Electron's native shell. A service worker that precaches/serves a stale JS bundle would directly break this stated invariant (a PWA could keep serving old, API-incompatible code after the server moves on). This phase's service worker must not cache the app bundle at all — installability only, no offline/precache behavior.
- **ImageMagick (`convert`, `/usr/bin/convert`) is available on this machine** — no `sharp`/`vite-plugin-pwa`/other new npm dependency needed to rasterize a hand-drawn SVG icon down to the PNG sizes a manifest needs.

## Design

**No `vite-plugin-pwa` or any new dependency.** Given the constraint above (must NOT do offline precaching) and this repo's established "hand-roll it, minimal dependencies" convention (static server, WS layer, checkpoint git plumbing all avoid frameworks where a small direct implementation suffices), a manifest + a deliberately-inert service worker is simpler and safer than pulling in a workbox-based plugin whose entire value proposition (precache generation, cache versioning) is exactly what must be avoided here.

**`src/web/public/manifest.json`** (new, copied verbatim into `dist/web/manifest.json` by Vite's `public/` convention): standard web app manifest — `name`/`short_name: "ArgusDE"`, `start_url: "/"`, `display: "standalone"`, `background_color`/`theme_color` matching the connect-screen's dark theme (`#0a0a0a`), and an `icons` array pointing at the new icon set below (192, 512, and a 512 maskable variant).

**`src/web/public/icons/`** (new): a small flat SVG icon (rounded-square, `#7c3aed` purple background — matching the existing connect-screen accent — with a simple light glyph), rasterized via the system's `convert` (ImageMagick) into `icon-192.png`, `icon-512.png`, `icon-maskable-512.png` (extra padding for Android's maskable safe-zone), `apple-touch-icon.png` (180×180), and `favicon.ico`. Generated once during implementation and committed as static assets — no build-time generation step, no new dependency.

**`src/web/public/sw.js`** (new): intentionally trivial — `install`/`activate` handlers that just `self.skipWaiting()`/`self.clients.claim()`, and a `fetch` handler that does pure pass-through (`event.respondWith(fetch(event.request))`, no `caches.open`/`caches.match` anywhere). Its only job is to exist and register, which is what some browsers' install-eligibility checks look for — it deliberately does no caching, so it can never serve a stale bundle after a server update.

**`src/web/index.html`**: add `<link rel="manifest" href="/manifest.json">`, `<meta name="theme-color" content="#0a0a0a">`, `<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">`, `<link rel="icon" href="/icons/favicon.ico">`.

**`src/web/main.tsx`**: register the service worker, guarded and fire-and-forget (matching how every other WS/network call in this codebase already logs-and-continues on failure rather than crashing the UI):
```ts
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => console.error("Service worker registration failed:", error));
  });
}
```

**Electron**: no special-casing needed — it loads the same server-served HTML via `loadURL` (spec's explicit "one shared UI build, no per-platform fork" principle), so it picks up the manifest link and SW registration automatically. Registering a no-op passthrough SW inside Electron's renderer is harmless.

## Explicitly deferred / non-goals

- **No offline support or offline fallback page.** This is a real-time WebSocket chat client — there's nothing useful to do without a server connection, so no offline caching strategy is built, matching the version-skew constraint above.
- **Resuming the most-recently-active Thread across a reload/relaunch** — a separate, already-repeatedly-deferred spec gap (Phase 8 onward), not folded into this phase. Installing the PWA works fine without it; reopening just re-runs the existing first-load flow, same as a plain browser reload does today.
- **Thread close + worktree auto-cleanup, and the two follow-up issues from Phase 8** ([#46](https://github.com/deanjstone/argusde/issues/46), [#47](https://github.com/deanjstone/argusde/issues/47)) — unrelated, untouched here.
- **No `Cache-Control` header changes to `static-server.ts`** — orthogonal performance work, and touching it risks exactly the staleness bug this phase is designed to avoid; left alone.

## Testing (real collaborators over mocks, per established convention)

- Extend `src/server/http/static-server.test.ts` with a case confirming `manifest.json` and `sw.js` are served with the correct existing MIME types (proves the new static files are reachable through the real static-file server, not just present on disk).
- Extend `test/web-smoke.test.ts` with one new real E2E case: after loading the served UI in a real browser, confirm `document.querySelector('link[rel="manifest"]')` resolves to a fetchable, valid-JSON manifest with the expected required fields, and that `navigator.serviceWorker.register(...)` (or the page's own registration via `main.tsx`) actually resolves/activates in the real Chromium engine — the two concrete, checkable installability signals, without trying to simulate the non-deterministic `beforeinstallprompt` browser UI itself.

## Verification

1. `pnpm run typecheck` and `xvfb-run -a pnpm test` (full suite, including the new cases above) — clean.
2. `pnpm run build` (the full build, not just `build:web` — per Phase 9's own Outcome note about this exact gotcha) then manually open the served UI in a real browser and check DevTools' Application panel: manifest parses with no warnings, service worker shows as activated, icons render at the listed sizes.
3. Recommended manual step for the user (not something I can fully verify myself): with the server reachable via Tailscale (Phase 3), open it on a real phone and confirm the browser's "Add to Home Screen"/install prompt appears and the installed icon/splash match.
4. Work happens on a branch (`feature/pwa-installability`), committed incrementally (icon generation → manifest + HTML/main.tsx wiring → service worker → tests), pushed after each commit, self-reviewed with `/code-review high` before merging (established practice from Phases 1–9), PR opened once complete and green. Plan copied to `docs/plans/phase-10-pwa-installability.md` per the standing repo convention.

## Outcome

Shipped as designed, with zero deviation from the plan and zero new dependencies. The icon set was generated once via the system's ImageMagick (`convert`), not a project dependency — a flat rounded-square `#7c3aed` icon with a light "A" glyph, matching the Electron connect-screen's existing purple accent (the only prior brand-color signal anywhere in the repo), plus a separately-padded maskable variant for Android's safe-zone requirement.

`static-server.ts` needed zero changes — its existing `MIME_TYPES` map already covered `.json` and `.js`, confirmed before writing any code rather than assumed. `vite.config.web.ts` also needed zero changes — Vite's `public/` convention copies `manifest.json`/`sw.js`/`icons/` into `dist/web/` unprocessed automatically, confirmed via a real `pnpm run build:web` before committing to the approach.

The service worker (`sw.js`) does no caching whatsoever, by design — install/activate/fetch handlers only, every request a pure pass-through to the network. This directly protects a real invariant spec #33 states explicitly (the web UI has no version-skew risk to solve "because the UI is always served fresh from the server," which is *why* Phase 6's version handshake only needed to cover Electron's native shell) — a caching service worker would have quietly broken that guarantee by potentially serving a stale, API-incompatible bundle after a server update.

Verification: full suite green (`pnpm run typecheck` + `xvfb-run -a pnpm test`, 210 tests across 24 files, including a new real E2E case proving the manifest resolves/parses correctly and the service worker reaches "activated" state in a real Chromium engine — not just that the registration call resolved), plus a full `pnpm run build` (not just `build:web`, per Phase 9's own Outcome note about that exact gotcha) and a real standalone server + real browser manual check confirming every asset (manifest, icons, favicon, service worker) is reachable with correct content types and the manifest's own internal icon paths resolve correctly regardless of how the HTML's own `<link>` tags got rewritten by Vite's `base: "./"` config. `/code-review high` self-review completed before merge (see PR for findings/fixes, if any).

**Recommended follow-up for the user, not something verifiable from this environment**: open the server via Tailscale on a real phone and confirm the browser's install prompt appears and the installed icon/splash screen render correctly — headless/automated checks can confirm every installability *precondition* (manifest validity, service worker activation, icon reachability) but not the actual OS-level install-prompt UI itself.

Deferred items (no offline support, resume-most-recently-active-thread across reload, `Cache-Control` header changes) remain out of scope, unchanged from the plan above.
