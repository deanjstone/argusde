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
| total matches | 500 | files × matchesPerFile would otherwise allow 2000, ~600KB at the line bound |
| line characters | 300 | a minified file's single line can be megabytes — the payload bound that actually matters |
| wall clock | 10s | `git grep` over a huge tree is unbounded work a client can ask for; a timeout returns the partial output **flagged** rather than discarding it |

Caps are applied while parsing rather than afterwards — the point of a cap is not to hold the whole result set in memory first.

**Story 19: a result leads somewhere.** `FilePreview` gains an optional `highlightLine`, marks that line and centres it in view. A prop rather than state, so the preview keeps no notion of search. Centred rather than merely scrolled to, because a match pinned to the viewport edge shows none of the surrounding code, which is the whole reason for opening it.

**Search lives in the Files tab**, not a fifth tab: search and browse are two ways at the same tree. Results replace the listing while a query is active; clearing returns to browsing. Built from `input-group`, `item`, `empty`, `badge`, `spinner`.

**No `scroll-area`, no computed inline styles** — phase 16 found the former breaks the entire app under this project's `style-src 'self'` CSP, and #93's component table names it for search results specifically. This is the phase that correction existed for.

## Two things found by running it rather than testing it

- **jsdom has no `scrollIntoView`.** The highlight effect threw an unhandled `TypeError` in the component tests. Called optionally now: scrolling is a nicety, and an unhandled error from a convenience is a poor trade.
- **On mobile, search is inside the collapsible tree pane.** With a file open, the Files tab is master-detail and the tree — which holds the search field — is hidden, so the audit's search story crashed on an invisible field. That is correct product behaviour (you return to the list to search, as in any master-detail app, via the control story 15 already requires), so the fix was in the audit's flow. It also revealed that **one throwing story aborted the entire audit pass**, losing every story after it — the block is now fail-soft, since the audit is an operational tool.

## A third thing found by probing Node rather than reading its docs

The `catch` in `search` originally handled two cases: exit code 1, and `killed`. Checking what `execFile` actually reports turned up **three** distinct shapes:

| Cause | What Node reports |
|---|---|
| no matches | `code: 1` (a *number*) |
| timeout | `killed: true`, `signal: SIGTERM`, `code: null` |
| output over `maxBuffer` | `code: "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"` (a *string*), `killed: undefined` |

So a search whose output exceeded 32MB fell through to the generic `Search failed` — discarding results git had already produced, and telling the user nothing they could act on. Both cut-short cases now return their partial output flagged. The string-vs-number code also justifies the strict `=== 1` compare, which would otherwise look like fussiness.

That branch has a test, and the test was made to *prove* it: `truncated.files` is normally set by the file cap, which the parser only trips once it has seen 100 files — so "flagged truncated while returning fewer files than the cap" is reachable only through the cut-short branch. Confirmed red against the un-fixed code (with exactly that unhelpful `Search failed`) before being kept.

## What review changed

A two-axis pass (spec fidelity, plus correctness/security of the new server code) found **three real bugs** and several honesty gaps. All fixed.

### Three bugs, all empirically demonstrated

1. **A multi-line query matched every line in the repository.** `git grep -e` splits its pattern on newlines into an OR of patterns, and an empty one among them matches everything — verified: a newline-only query returned all 4 lines of a 4-line repo, and produced megabytes of output in a real one. The shipped UI trims, which masked it, but `thread.search` takes a `z.string()` straight off the wire. Now rejected outright rather than silently searching for part of what was asked: `git grep` cannot express a multi-line literal at all, so answering with the first line would answer a different question.
2. **`truncated.files` was set unconditionally when git was cut off.** My own reasoning — "a cut-off stream means more was out there" — was true but attached to the wrong flag: it means "more *files* matched", and in a one-file repository that is simply false, and the badge repeats the lie to the user. A new `truncated.output` carries the honest claim; `files` and `matches` now say only what the parser actually found. As a bonus this made the cut-short test *sharper*, since `output` is reachable through no other path.
3. **A filename containing a newline corrupted the path.** The parser split records on `\n` before locating fields, so `we\nird.ts` came back as `ird.ts` — a path that does not exist, cannot be opened, and silently replaced the real hit. Rewritten as a forward scanner that locates each field by its own delimiter; only the *content* field is newline-terminated, which is safe because content is always one line.

### Honesty gaps

- **The ticket's `total matches: 500` cap did not exist.** I had substituted a per-line bound for it and the plan doc quietly rewrote the table. Both now exist: the per-line bound is real and needed, *and* the total cap is implemented and tested.
- **Two near-vacuous tests.** "Treats a flag-like query as a query" asserted only `totalMatches: 0` — which every wrong behaviour also returns; it now puts `--untracked` in a file and requires it to be found. And the promoted-Worktree case grepped for a string that existed only in an unrelated temp directory, so it could not have failed; it now writes *different* content to each tree and checks which comes back, at the protocol seam.
- **`US-16.1` passed on results *or* no-matches**, making it unable to fail — while the story it encodes is precisely that the two are distinguishable. It now requires results (which the audit fixture guarantees) and the absence of the no-matches state. The fail-soft `catch` also re-recorded `US-16.1`, so a throw could overwrite a real verdict; it records under its own id now.
- **The "no absolute path" assertion covered results but not errors**, which the ticket asked for explicitly.
- **`App.tsx` still carried `neutral-*` literals** — raised in phase 16's review too, and exempted then on the grounds that this phase only threads data through it. Cheaper to migrate than to keep explaining, so it is done.
- A stray `probe-search.mjs` was committed at the repo root. Removed.

Also verified sound by that pass, and worth recording so it is not re-derived: no argument injection (`-e`, no shell); missing git, a non-git directory, a corrupt HEAD and a repo with no commits all degrade to a generic failure with no path leak; symlinks are not followed; a working tree inside a larger repository stays scoped to its own directory; unicode case-folding works; and NUL bytes and 200KB queries reject harmlessly.

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

- `pnpm typecheck` clean; full suite **452/452 across 32 files**, up from 410/410 across 31.
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
