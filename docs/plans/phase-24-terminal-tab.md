# Phase 24: The Terminal tab

> Implemented via `feature/terminal-tab`. Ticket: [#128](https://github.com/deanjstone/argusde/issues/128) phase 2. Follows [phase 23](phase-23-terminal-server.md), which built the server half.

## Context

> As a user on a phone, I want a key bar for the keys a soft keyboard does not offer, so that a terminal is genuinely usable without a hardware keyboard.

Stories 4, 7, 11–14, 19–22 and 29 — the visible half of the terminal. Phase 23 already runs the shell; this phase is a *view* of it. No protocol change, so `API_VERSION` stays at **1.6.0**.

## The decision this phase opened with

Phase 23's verification found that `@xterm/xterm` v6 is blocked by this app's CSP: it builds three `<style>` elements and sets their `textContent`, and under `style-src 'self' 'nonce-…'` Chromium applies **none** of those rules — a terminal with no colour and wrong cell metrics, raising no error. All three mitigations #128 originally proposed were ruled out (no nonce option, renderer addons do not avoid it, dynamic content defeats a hash).

Two workable options were put up, and the **nonce-stamping shim** was chosen: `document.createElement` is wrapped for exactly the duration of `terminal.open()` and `fit()`, stamping the document's own per-response nonce on any `<style>` xterm creates. The alternative — a same-origin iframe with its own relaxed CSP — was rejected as a second document and a message channel to keep in sync, for a wart that is smaller and more visible in one place.

The patch is restored in a `finally`, so a throw inside xterm cannot leave the global patched, and it is deliberately *not* installed once at startup: a permanent patch would nonce every style element the app ever creates, which is the blanket exemption the CSP exists to withhold.

## Design

### 1. A fifth tab, next to Files

Both are the Thread's working tree — one read, one run. Full height at both viewports, and the tab bar already lays its children out on equal flex basis.

### 2. The view owns the emulator, never the process

Unmounting disposes xterm and unsubscribes; it does **not** send `terminal.close`. Leaving the tab while a build runs is a no-op on the server, and returning calls `terminal.open` again — which reattaches, replays the scrollback, and resizes to the viewport that is actually here now. That is stories 11–14 with no reconnect protocol of its own.

### 3. Loaded on demand

xterm is ~86 KiB gzipped against an app bundle of ~127 KiB, and the service worker deliberately does not cache (spec #33 phase 10), so a static import would put that on every load of every surface. It is imported dynamically the first time the tab opens: the build emits `xterm-*.js` and `xterm-*.css` as their own chunks, and the main bundle stays where it was.

### 4. The keys a phone does not have

Ctrl is a **one-shot** modifier — armed by the button, consumed by the next keystroke, then released. A sticky modifier would turn the next command into control bytes. Escape, Tab and the four arrows send their sequences directly.

### 5. The trust boundary, stated

Story 29 is a line of text under the terminal, not a dialog: the shell runs as the ArgusDE server user, and the tailnet is what gates reach to it. It is a fact about the surface, not a warning to dismiss.

## Files

- `src/web/lib/style-nonce.ts` (new) — the nonce read and the scoped `createElement` patch
- `src/web/lib/xterm-terminal.ts` (new) — the emulator behind a four-method seam, dynamically imported, themed from the app's own tokens
- `src/web/components/terminal-view.tsx` (new) — the surface: header, replay, key bar, exit banner, privilege line
- `src/web/components/tab-bar.tsx` — the fifth tab
- `src/web/App.tsx` — terminal commands and the output/exit push fan-out
- `src/web/vite-env.d.ts` (new) — Vite's ambient `*.css` module types, for the dynamic stylesheet import
- `docs/testing/ui-ux-user-stories.md`, `scripts/ui-ux-audit/run.mjs` — US-22
- `CONTEXT.md` — Terminal tab, and why xterm needs the nonce

## Testing

**Component** (fake emulator, jsdom): opens at the size it measured; header names cwd and branch; scrollback replayed; truncation said out loud; live output written verbatim including escape sequences; output for a replaced terminal ignored; typing sent; the key bar's bytes; Ctrl arming and release; exit announced with a fresh terminal offered; the privilege line; an open failure shown; nothing opened without a Thread.

**Real browser** (`test/web-smoke.test.ts`): a command typed into the Terminal tab runs and its output appears, xterm's style elements all report `cssRules.length > 0` under the real CSP with zero violations, and — at 390×844 — the emulator, key bar and tab bar stack without overlap, the page never scrolls sideways, and leaving the tab and returning replays the same session.

The CSP assertion was **falsified before being trusted**: with the expected marker changed to one that never appears, the test fails on that exact line after its timeout rather than passing vacuously.

**Audit harness**: US-22.1–22.7 at both viewports, with an axe scan on the surface. Deliberately **no visual baselines** for this block — the header renders a freshly-made temp directory and the body a live shell prompt, so a screenshot diff here could only ever fail.

## Done when

- [x] `pnpm typecheck` clean, `xvfb-run -a pnpm test` green
- [x] Suite does not regress from 663/663 across 41 files — now **686/686 across 43**
- [x] Audit green at both viewports: **179/0 desktop, 167/0 mobile**
- [x] The CSP decision made explicitly, with the rejected option and its reason recorded
- [ ] CI green on the PR
- [ ] Real-phone pass over Tailscale (US-22.8) — headless emulation cannot reproduce a dynamic viewport, so the soft-keyboard case stays open until checked by hand
