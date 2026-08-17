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

## What review changed

Two reviews ran: one adversarial security pass on the containment boundary, one spec + standards pass. Between them they found **one critical defect, four real security defects, and a vacuous test.** All fixed.

### Critical: `--primary-bright` was never defined

The token was mapped in `@theme inline` and **never assigned** — my edit had silently failed to match its anchor. `text-primary-bright` was therefore invalid-at-computed-value-time, so the colour fell back to inherited near-white and the violet accent was simply gone from the active tab, the activity card's expand control, and resource links.

**The axe pass was green *because of* the bug** — inherited near-white has plenty of contrast. A clean check hiding a defect, exactly the failure this project has a memory note about. The re-verification now asserts the computed colour in a real browser (`oklch(0.75 0.16 293)`) and that the custom property is non-empty, not merely that axe is happy. Every edit script in this phase's later passes asserts its anchors matched.

### Four security defects, all found empirically

The security pass ran the full battery — `..` variants, encoded forms, mixed separators, absolute and Windows-style paths, symlink chains to depth 41, null bytes, prefix-sibling directories — and **containment held against all of them**. What it did find:

1. **A symlinked root leaked the real path and broke the module's own invariant.** `toRelative` measured against the *presented* root rather than the real one, so with a symlinked workspace path (`/tmp` is one on macOS) every emitted path came back `..`-prefixed, `parentPath` at the root was `".."` instead of `null`, and the real directory name was disclosed — the module handing clients paths its own check would then refuse.
2. **A FIFO in the working tree parked a libuv threadpool thread forever.** `looksBinary` opened the path *before* any kind check, and `open()` on a FIFO never returns. Four such requests starve every filesystem operation the server can make. Now only regular files are read, checked before anything opens them; directories and devices get a clean refusal too.
3. **`.git` hiding was listing-only.** `.git/config` was readable, and it routinely holds a remote URL with a credential in it. Half-hiding it was incoherent — either it's in the browsable tree or it isn't — so reads inside it are refused now. Other dotfiles stay readable deliberately: `.env` is the user's own file in their own repository, and the client *is* that user.
4. **The lexical path was returned, not the validated one** — so a symlink swapped between check and read redirected the read, demonstrated deterministically. The agent is a concurrent writer in this exact tree, so it isn't hypothetical. `resolveWithin` now returns the resolved path. That doesn't make the sequence atomic (only `openat`/`O_NOFOLLOW` would) but it removes the check-one-path-then-read-another gap.

Plus **fs errors were leaking absolute server paths**: `ws-server` relays `error.message` verbatim, so a plain `ENOENT` handed back the server's filesystem layout. Restated with only the relative path the client already sent.

### What the security pass established that is *not* a bug

**The working tree root is client-controlled, by design.** `project.create` takes an arbitrary `workspaceRoot`, and `fs.list-directory` exists specifically to browse the server's filesystem to pick one. So story 16's control is **per-Thread confinement, not a filesystem sandbox**: it stops a crafted `path` escaping the Thread's tree, and it does not — cannot — stop the user pointing a Project at `/`. That is coherent for a single-user app where the client is the user, but it should be said plainly rather than left for someone to mistake later.

**Windows is unverified.** Alternate data streams, `\\?\` and UNC prefixes, reserved device names (`CON`/`NUL`), 8.3 short names, and `path.win32.relative`'s case-insensitivity all deserve a check on Windows and none are testable on Linux. Low priority given [#99](https://github.com/deanjstone/argusde/issues/99) — Windows is becoming a rarely-booted fallback.

### From the spec/standards pass

- **The Done-when audit item genuinely was not met.** No audit story opened the Files tab; the "106/0" was entirely pre-existing stories. Added **US-15.1–15.5** to the harness and to `docs/testing/ui-ux-user-stories.md`, covering the listing, `.git` being hidden, the preview rendering, the tab bar surviving both states with a back control at mobile width, and no horizontal scroll.
- **Containment is now tested over the wire too**, which is where #93 says the primary seam is. Five escape shapes, both commands, plus the no-absolute-path-in-errors assertion.
- **A vacuous test**: the one over-the-wire token assertion checked `t.color !== null`, always true for `{content, kind}` — it was testing the abandoned hex design. It now asserts a `keyword` kind is present and that more than one kind came back, so an all-`plain` payload fails.
- **`readFile` blanked a language it had actually resolved** when tokenising failed, telling the UI "unknown language" when the truth was "known language, grammar didn't load".
- **`ui/scroll-area.tsx` deleted.** Installed by the CLI, then documented as unusable under the CSP — leaving it invited phases 5 and 6 to import something that breaks the whole app.
- **The CSP rationale was restated at six sites.** One canonical statement now lives next to `CONTENT_SECURITY_POLICY` in `static-server.ts`, spelling out all three things it rules out; the other five cross-reference it.
- Also: `tokenise`'s catch now logs rather than swallowing silently; the duplicated load/error/finally triad in `file-browser.tsx` and the repeated client guard in `App.tsx` are extracted; `--syntax-punctuation` no longer duplicates `--syntax-comment`; a test name that mentioned colours the server no longer sends is corrected.

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
- `src/server/http/static-server.ts` — the canonical statement of what `style-src 'self'` rules out for UI code
- `docs/testing/ui-ux-user-stories.md` — US-15

## Verification

- `pnpm typecheck` clean, both projects.
- Full suite green under `xvfb-run`: **408/408 across 31 files**, up from 350/350 across 28.
- **Audit harness both viewports: 115 pass / 0 fail (desktop), 103 pass / 0 fail (mobile)**, including the five new US-15 Files-tab stories. Zero axe violations, no horizontal scroll at 390px, zero console errors. Four baselines newly recorded for the Files tab; two re-recorded for the directory-browser migration.
- **The accent token verified as actually rendering**, not merely as axe-clean — see the critical finding below for why that distinction earned its own check.
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
