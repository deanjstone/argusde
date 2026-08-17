# Phase 16: File browser and file preview, rooted at the Thread's working tree

> Implemented via `feature/file-browser`. Ticket: [#104](https://github.com/deanjstone/argusde/issues/104). Spec: [#93](https://github.com/deanjstone/argusde/issues/93) phase 4. Follows phases [13](phase-13-durable-activity.md), [14](phase-14-activity-timeline-ui.md) and [15](phase-15-branch-backed-worktrees.md).

## Context

> I cannot read my own repository from inside the app… Reviewing agent output means leaving for an editor, which on a phone means there is nowhere to leave to, precisely where ArgusDE is supposed to be strongest.

The second of #93's three headline problems, and the first half of the working-tree cluster. Search (phase 5) and changed files (phase 6) build on the server module this establishes. Stories 10–16. No `API_VERSION` bump — `1.1.0` from phase 1 is the single bump the spec allots.

## Design as built

**One module owns working-tree reads.** `src/server/workspace/working-tree.ts` resolves the Thread's root (Worktree when promoted, workspace root otherwise) and exposes `listDirectory` and `readFile`, both taking a path relative to that root. Containment lives in `resolveWithin` and every operation goes through it, once, as #93 requires. The two command handlers in `ws-server.ts` are one line each.

**Containment defeats symlinks, not just `..`.** A purely lexical check waves through a link inside the repository pointing at `/etc` — no `..`, every segment inside the root. Both the root *and* the resolved target are realpathed before comparison (the root too, since it may itself sit under a symlinked path). Containment is segment-aware, so `/repo-evil` is not "inside" `/repo`. And a refusal never names a server-side absolute path: the client only ever sees relative paths, so telling it where the tree lives would turn a rejected read into a probe for the server's filesystem layout.

**Three size bands, not one cap.** ≤64 KiB tokenised; 64–256 KiB returned as plain lines flagged *not highlighted*; >256 KiB refused. One cap would either tokenise a quarter-megabyte file into megabytes of JSON aimed at a phone, or refuse files that read perfectly well uncoloured. **Binary is sniffed before size** (NUL in the first 8 KiB, git's heuristic), so a 400 KiB archive reads as *binary* rather than the less useful *too large*.

**`.git` is the one hidden entry.** Dotfiles are deliberately shown — `.github/`, `.gitignore`, `.env.example` are all things you open when reviewing agent work. `.git` is not content; it is repository internals plus ArgusDE's own checkpoint refs, and alphabetically it lists *first*, so the browser opened on an invitation to page through loose objects. Found by driving the real browser, not by a test.

**Master-detail on a phone.** The tree gets the whole screen until a file is opened, then the file does, with an explicit way back. Side by side from `md` up. The first attempt split the panes at every width; at 390px that gave each about a third of a usable height and made neither good — visible immediately in the real-browser screenshot.

## Where syntax highlighting runs, and why it does not ship colours

**Highlighting runs on the server** (decided with the user against a client-side highlighter and against deferring highlighting). `shiki` 4.4.3 tokenises in the Node process; the client renders spans. The web bundle gains nothing and no phone downloads TextMate grammars — which matters because "usable from my phone over Tailscale" is what justifies this whole spec.

Verified against the real package rather than its docs: an **unknown language throws** rather than falling back, so the resolved language is checked against `bundledLanguages` first, with plain lines as the fallback; 346 languages load lazily on a long-lived singleton.

**Tokens carry a semantic kind, not a colour** — and that changed mid-implementation, because the first version shipped hex and could not work:

The web UI is served under `style-src 'self'` (`static-server.ts`), which blocks **inline `style` attributes**. Per-token `style={{ color }}` was silently doing nothing. So the server now buckets TextMate scopes into ten kinds (`keyword`, `string`, `comment`, `type`, …) and `index.css` owns the colours as theme tokens. That is strictly better on three counts: it satisfies CSP, it is what `CLAUDE.md` asks for anyway ("theme through the CSS variables… not per-component colour classes" — a colour baked into a payload is the same mistake one layer out), and a short kind costs far less on the wire than a hex string per token.

## Three things the CSP broke, and one it exposed

The CSP is a deliberate control on an app that renders agent output and is reachable over Tailscale. It was not weakened.

1. **`scroll-area` is unusable here.** Radix's version injects an inline `<style>` element, blocked outright — which broke the *entire app*: every E2E browser test failed, because the first-run screen contains the directory browser. Replaced with plain `overflow-y-auto` containers in all three places. **This is a correction to #93's component table**, which lists `scroll-area` for the file browser, search results and the changed-files list — phases 5 and 6 will hit the same wall.
2. **Per-token inline colours** — see above.
3. **`style={{ gridTemplateColumns }}`** on the tab bar, my own first fix for its hardcoded `grid-cols-3`. Now flex with `flex-1` children, which needs no runtime value at all.

The CSP also **exposed a latent contrast bug across three components**. `text-primary` measures **3.35:1** on the app background — below WCAG AA — because phase 14 deliberately darkened `--primary` so near-white text would read *on top of* it. A surface colour and a text colour pull in opposite directions and cannot be the same token. Added `--primary-bright` (same hue, 7.3:1 on the background and 5.6:1 on a muted card) and used it for all three text uses: the active tab, the activity card's expand control, and resource links. The audit caught it on nine stories.

## Files

- `src/server/workspace/working-tree.ts` (new) — resolution, containment, listing, reading, size bands
- `src/server/workspace/highlight.ts` (new) — shiki singleton, language resolution, scope→kind bucketing
- `src/shared/ws-protocol.ts` — two commands, `WorkingTreeListing`, `FilePreview`, `SyntaxKind`/`SyntaxToken`
- `src/server/ws/ws-server.ts` — two handlers
- `src/web/components/file-browser.tsx`, `file-preview.tsx` (new)
- `src/web/components/content-block.tsx`, `activity-card.tsx`, `tab-bar.tsx`, `directory-browser.tsx` — accent token, Files tab, migration
- `src/web/index.css` — syntax colour tokens, `--primary-bright`
- `scripts/ui-ux-audit/run.mjs` — US-13.4 derives the tab order from the DOM instead of hardcoding it
- `CONTEXT.md` — **Working tree** glossary entry

## Verification

- `pnpm typecheck` clean, both projects.
- Full suite green under `xvfb-run`: **401/401 across 31 files**, up from 350/350 across 28.
- **Audit harness both viewports: 106 pass / 0 fail (desktop), 94 pass / 0 fail (mobile).** Zero axe violations, no horizontal scroll at 390px, zero console errors. Two baselines re-recorded for the directory-browser migration.
- **Driven in a real browser at 390×844** against a running server, which is where three of this phase's findings came from:

```
files tab lists tree ✓  entries: [ 'src/', '.gitignore', 'logo.png' ]
navigated into src ✓
language badge: typescript
keyword token actually coloured: {"text":"const","colour":"oklch(0.75 0.18 293)"}
back to tree from file ✓
binary identified ✓
no horizontal scroll at 390px: true | tab bar intact: true
console errors: none
```

- Nine containment cases pass, including the symlink-out-of-tree case a lexical check would miss.
- `directory-browser.test.tsx` and `tab-bar.test.tsx` pass **unchanged** — both are migrated surfaces.

## Explicitly deferred

- **Search** (phase 5) and **changed files / per-file diffs** (phase 6) — they extend this module.
- **Editing.** Reads only. #93's governing principle is "the UI shows state, the agent changes it".
- **A directory tree that stays expanded across navigation.** One level at a time with a breadcrumb, which is what survives a 390px column.
