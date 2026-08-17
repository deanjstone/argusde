# Phase 17: Workspace search across the Thread's working tree

> Implemented via `feature/workspace-search`. Ticket: [#108](https://github.com/deanjstone/argusde/issues/108). Spec: [#93](https://github.com/deanjstone/argusde/issues/93) phase 5. Follows [phase 16](phase-16-file-browser.md), which built the module and the browser this extends.

## Context

> As a user, I want to search the Thread's working tree for a string, so that I can find the code the agent is talking about without asking it to look again.

Stories 17–21. The second half of the working-tree reading surface; phase 6 adds changed files and per-file diffs on the same foundation. No `API_VERSION` bump.

## Design as built

**`git grep`, through the existing module.** #93 asks that search *"shells out to the repository's own tooling so ignore rules come for free"*. That means git specifically, not ripgrep: git is already a hard requirement of this app (worktrees, checkpoint refs, revert), whereas ripgrep is a separate binary with no guarantee of being on **the server** — the machine that matters, not the developer's. `search` lives in `working-tree.ts` beside `listDirectory` and `readFile`, so working-tree resolution and containment stay in one place.

Non-git roots cannot reach it: Thread creation captures a baseline checkpoint and fails with *"not a git repository"*, so every working tree that exists is one. Confirmed rather than assumed — the audit's own `US-2.6` asserts that failure is surfaced.

**Four flags, three of them load-bearing.** All verified against real repositories before being relied on:

| Flag | Why it is not optional |
|---|---|
| `--untracked` | `git grep` searches **tracked files only** by default, so a file the agent just created and hasn't committed is invisible — precisely the file you search for when reviewing its work. Ignore rules still apply, so `node_modules/` stays out either way, which is story 20 for free |
| `--null` | the default `path:line:content` is genuinely ambiguous for a filename containing a colon; this yields `path\0line\0content` |
| `-I` | without it a binary file emits `Binary file x.bin matches` — no line number, nothing a parser can use |
| `-e` | carries the query, so one beginning with `-` is a query rather than a flag |

**Exit code 1 means "no matches".** `execFile` rejects on any non-zero exit, so 1 has to be told apart from ≥2 or every empty search surfaces as a failure. This is the mechanism behind story 21 rather than an edge case, and it has a test asserting the *result* rather than the absence of a throw.

**Matching is literal (`-F`) and case-insensitive (`-i`).** Story 17 says "search … for a string", so a regex is a different feature; case-insensitive is the more useful default for finding code the agent mentioned. Recorded as a choice, not a fact.

**Four caps, each reported separately** — #93: *"Results are capped and the cap is reported."* A silently truncated result set reads as a complete one, which is worse than a slow search, so the UI names which cap bit rather than implying completeness.

| Bound | Value | Why |
|---|---|---|
| matches per file | 20 | a file with 400 hits tells you nothing a file with 20 doesn't |
| files | 100 | enough to judge relevance, bounded for a phone |
| line characters | 300 | a minified file's single line can be megabytes — the payload bound that actually matters |
| wall clock | 10s | `git grep` over a huge tree is unbounded work a client can ask for; a timeout returns the partial output **flagged** rather than discarding it |

Caps are applied while parsing rather than afterwards — the point of a cap is not to hold the whole result set in memory first.

**Story 19: a result leads somewhere.** `FilePreview` gains an optional `highlightLine`, marks that line and centres it in view. A prop rather than state, so the preview keeps no notion of search. Centred rather than merely scrolled to, because a match pinned to the viewport edge shows none of the surrounding code, which is the whole reason for opening it.

**Search lives in the Files tab**, not a fifth tab: search and browse are two ways at the same tree. Results replace the listing while a query is active; clearing returns to browsing. Built from `input-group`, `item`, `empty`, `badge`, `spinner`.

**No `scroll-area`, no computed inline styles** — phase 16 found the former breaks the entire app under this project's `style-src 'self'` CSP, and #93's component table names it for search results specifically. This is the phase that correction existed for.

## Two things found by running it rather than testing it

- **jsdom has no `scrollIntoView`.** The highlight effect threw an unhandled `TypeError` in the component tests. Called optionally now: scrolling is a nicety, and an unhandled error from a convenience is a poor trade.
- **On mobile, search is inside the collapsible tree pane.** With a file open, the Files tab is master-detail and the tree — which holds the search field — is hidden, so the audit's search story crashed on an invisible field. That is correct product behaviour (you return to the list to search, as in any master-detail app, via the control story 15 already requires), so the fix was in the audit's flow. It also revealed that **one throwing story aborted the entire audit pass**, losing every story after it — the block is now fail-soft, since the audit is an operational tool.

## Files

- `src/server/workspace/working-tree.ts` — `search`, `SEARCH_LIMITS`, the grep-output parser
- `src/shared/ws-protocol.ts` — `thread.search`, `SearchResults`
- `src/server/ws/ws-server.ts` — one handler
- `src/web/components/workspace-search.tsx` (new)
- `src/web/components/file-browser.tsx` — the field, and results-versus-tree
- `src/web/components/file-preview.tsx` — `highlightLine`
- `src/web/App.tsx` — the round trip
- `scripts/ui-ux-audit/run.mjs`, `docs/testing/ui-ux-user-stories.md` — US-16

## Verification

- `pnpm typecheck` clean; full suite **445/445 across 32 files**, up from 410/410 across 31.
- **Audit harness both viewports: 121 pass / 0 fail (desktop), 109 pass / 0 fail (mobile)**, with four new US-16 baselines. Zero axe violations, no horizontal scroll at 390px.
- **Driven in a real browser at 390×844**, which is where the uncommitted-file case was actually proved:

```
files with matches: [ 'src/committed.ts', 'src/uncommitted.ts' ]
ignored dependency excluded: true
uncommitted file found:   true
opened at the matching line: "2const retryHandler = 2;"
cleared back to browsing ✓
no horizontal scroll at 390px: true | tab bar: true
console errors: none
```

- The working-tree module's existing 34 tests still pass; its setup now `git init`s the root, because every real working tree is a repository and search depends on that.

## Explicitly deferred

- **Regex search, case-sensitivity and scope controls.** Story 17 asks for a string; each of these is a separate, additive feature.
- **Replace.** Reads only — #93's "the UI shows state, the agent changes it".
- **Search across Threads or Projects.** Every working-tree command is Thread-scoped by design.
- **Debounced as-you-type search.** Submit-driven, so one keystroke cannot start a 10-second `git grep`.
