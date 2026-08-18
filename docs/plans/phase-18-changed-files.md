# Phase 18: Changed files and per-file working-tree diffs

> Implemented via `feature/changed-files`. Ticket: [#114](https://github.com/deanjstone/argusde/issues/114). Spec: [#93](https://github.com/deanjstone/argusde/issues/93) phase 6 — the last of the working-tree cluster. Follows [phase 17](phase-17-workspace-search.md).

## Context

> As a user, I want to see the files currently changed in the Thread's working tree, so that I can review the agent's work in progress before it is checkpointed.

Checkpoint diffing already answered *"what changed between Turn 4 and Turn 7"*. This answers the different question — *"what has changed right now"* — which is the one you ask while the agent is still working. Stories 22–28. No `API_VERSION` bump.

## Design as built

**`git status --porcelain=v2 -z`, not v1.** Verified against a real repository rather than chosen from memory: v1 renders a rename as `R  old -> new` and *quotes* any path containing a space or special character, so it is ambiguous for exactly the paths that break parsers. v2 with `-z` never quotes and delimits every field with NUL.

**A rename record carries two NUL-terminated paths** where every other record carries one:

```
1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>                ordinary — one path
2 <XY> …                           <score> <path>\0<orig>   rename   — two
? <path>                                                    untracked
```

Splitting on NUL and treating each field as a record therefore **silently swallows the entry after a rename** as that rename's origin. Same class of bug as phase 5's newline-in-filename, and it has its own test: a rename followed by two further changes, all three of which must survive.

`--untracked-files=all` for the same reason phase 5 needed `git grep --untracked` — the file the agent just created is the one you most want to see.

**Per-file diffs, and the untracked trap.** `git diff HEAD -- <path>` covers staged and unstaged alike, which is what *"right now"* means. But it returns **nothing at all for an untracked file** — verified — and a newly created file is the most common thing an agent produces. Listing it as changed and then showing an empty diff would be worse than not listing it, so those go through `git diff --no-index -- /dev/null <path>`.

**Diff lines carry a *kind*, not a colour**, and the theme owns the palette — the same arrangement phase 4 arrived at for syntax tokens, for the same two reasons: a per-line colour needs an inline style attribute the CSP blocks, and colour belongs in the theme. New `--diff-added`/`--diff-removed`/`--diff-hunk` tokens, each checked for contrast against its own background (8.6:1, 6.2:1, 8.8:1 in dark).

**Branch (story 28) is read from git, never derived** from the Thread id — phase 3's explicit warning, because a Worktree promoted before branch backing has none. Verified: `rev-parse --abbrev-ref HEAD` returns the literal string `HEAD` for a detached worktree, so that case reports `detached` rather than a branch by that name.

**Kept distinct from Checkpoint diffing** (stories 25–26). Separate commands, a separate component sharing no code with `diff-view.tsx`, the view named *Changes* rather than *Diff*, and a "working tree" badge on the diff itself. Checkpoint listing, diffing and revert are untouched, and their tests pass unchanged.

## Corrections to #93's component table, both already established

- **`scroll-area` is unusable** — Radix injects an inline `<style>` the CSP blocks; it broke the whole app in phase 4. Plain `overflow-y-auto`.
- **`alert-dialog` was not gambled on.** Every Radix overlay locks body scroll through the same injected-`<style>` mechanism, so the revert confirmation keeps the inline expand-in-place pattern the project picker already uses — CSP-clean, accessible, consistent. Filed as [#113](https://github.com/deanjstone/argusde/issues/113), because it also threatens `command`, `tooltip` and `drawer` in phases 8–10 and deserves a decision of its own rather than a hurried one inside a feature phase.

## Files

- `src/server/workspace/working-tree.ts` — `changedFiles`, `fileDiff`, `currentBranch`, the porcelain scanner
- `src/shared/ws-protocol.ts` — two commands, `ChangedFile`, `DiffLine`, `FileDiff`, `WorkingTreeChanges`
- `src/server/ws/ws-server.ts` — two handlers
- `src/web/components/changed-files.tsx`, `working-tree-diff.tsx` (new)
- `src/web/components/file-browser.tsx` — the third view
- `src/web/components/diff-view.tsx`, `checkpoint-strip.tsx` — migrated onto theme tokens
- `src/web/index.css` — diff tokens
- `scripts/ui-ux-audit/run.mjs`, `docs/testing/ui-ux-user-stories.md` — US-17
- `CONTEXT.md` — **Changed files** glossary entry

## Verification

- `pnpm typecheck` clean; full suite **485/485 across 34 files**, up from 457/457 across 32.
- **Audit both viewports: 129 / 0 desktop, 109 / 0 mobile**, with four new US-17 baselines. Zero axe violations, no horizontal scroll at 390px.
- The diff-view and checkpoint-strip token migration produced **no visual diff beyond threshold** — the migration was faithful, not merely green.
- Checkpoint listing, diffing, revert and close tests pass **unchanged**.
- **Driven in a real browser at 390×844**, which is where the untracked-diff case was actually proved:

```
changed files: [ 'renamed.ts from old.ts renamed', 'src/mod.ts modified', 'created.ts new' ]
branch badge: main
untracked file diff non-empty: true
added line coloured from a token: {"text":"+const TWO = 22;","colour":"oklch(0.82 0.14 150)"}
no horizontal scroll at 390px: true | tab bar: true
console errors: none
```

## One existing assertion changed

`diff-view.test.tsx` asserted `className` contained `text-green` — a Tailwind palette literal, which is exactly what this phase's migration replaces. Retargeted at `text-diff-added`. Same finding shape as phase 2's `border-(amber|emerald|violet)` assertion: the behaviour is unchanged, only the spelling of the colour moved onto a token.

## Explicitly deferred

- **Git porcelain of any kind** — #93: *"Branch and dirty state are displayed, never mutated. The agent is the porcelain."*
- **Staging, discarding, or per-hunk operations** — same rule.
- **A dialog for the revert confirmation** — pending [#113](https://github.com/deanjstone/argusde/issues/113).
