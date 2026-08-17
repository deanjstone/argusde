# Phase 15: Branch-backed worktrees, so agent commits survive Thread close

> Implemented via `feature/branch-backed-worktrees`. Ticket: [#101](https://github.com/deanjstone/argusde/issues/101). Spec: [#93](https://github.com/deanjstone/argusde/issues/93) phase 3. Follows [phase 13](phase-13-durable-activity.md) and [phase 14](phase-14-activity-timeline-ui.md).

## Context

A Thread's Worktree was created on a **detached HEAD** and force-removed when the Thread closed. File content survived in Checkpoints, but **commit objects did not** — nothing referenced them, so anything the agent committed inside that Worktree became unreachable the moment the Thread closed. Spec #93 names this as the quieter fourth problem behind the whole daily-driver push.

Server-only, migrates no surface, no schema change, no protocol change, no `API_VERSION` bump. Stories 29–32.

## Design as built

**Creation** moves from `git worktree add --detach <path>` to `git worktree add -b <branch> <path> HEAD`. `createWorktree`'s signature is unchanged — it still returns the path — so the promotion handler in `ws-server.ts` needed no edit.

**Branch name: `argusde/thread-<threadId>`**, from a new exported `branchNameFor(threadId)`. The Thread id rather than its title, because story 30 wants the name to let you find the work from a terminal and the id is the only candidate that is simultaneously predictable (it is shown in the app's Settings tab, giving a two-way path between UI and git), groupable (`git branch --list 'argusde/*'` enumerates every Thread branch and the prefix keeps them clear of the user's own), and always ref-valid (ids are `randomUUID`). A slug of the title would read better, but titles are free text — at first run the title is literally the workspace path — and slugifying user text into a ref name buys collisions and invalid-ref errors for a cosmetic gain.

**Derive the branch name only when creating, never when reading.** A Worktree promoted before this phase is detached and has no branch at all, so anything that later *displays* the branch (story 28, phase 6) must ask git what the working tree is actually on. Computing it from the Thread id would confidently name a branch that does not exist. Recorded in `CONTEXT.md` as well as in the function's own comment, because it is the kind of thing a later phase will get wrong by default.

**Removal is unchanged.** `git worktree remove --force` already leaves branches alone, so story 31 needed no code — which is exactly why it got a test asserting the commit is reachable *via the branch* afterwards, rather than trusting it. `--force` stays, and its justification is now stronger: checkpoint history was already durable in refs independent of any working copy, and from this phase so are commits.

## The trap that made this more than a one-word change

`git worktree add -b <branch> <path>` with **no explicit start point** does not fail in a repository with no commits. Modern git prints `No possible source branch, inferring '--orphan'` and *succeeds*, producing a worktree on an unborn branch containing **none of the project's files** — the agent would get an empty directory that looks like the project. `--detach` used to fail cleanly there with `invalid reference: HEAD`.

Caught by an existing test (`throws a clean, catchable error when the workspace has no commits yet`) going red for the *opposite* reason to the one expected — it stopped throwing. Fixed by naming `HEAD` explicitly as the start point: unresolvable in an empty repo, identical to the old behaviour everywhere else. Verified both directions by hand against real git before trusting it.

That existing test is now the regression guard for it, and its name says what it is guarding rather than just what it asserts.

## Files

- `src/server/worktree/worktree-store.ts` — `-b … HEAD` instead of `--detach`, plus `branchNameFor`
- `src/server/worktree/worktree-store.test.ts` — the four stories
- `src/server/ws/ws-server.test.ts` — promote → commit → close → still reachable, over the real WS API
- `CONTEXT.md` — **Worktree** now says it is branch-backed, and warns against deriving the branch on read

## Verification

- `pnpm typecheck` clean, both projects.
- Full suite green under `xvfb-run`: **346/346 across 28 files**, up from 342/342.
- **Verified against a real running server**, which is the ticket's headline requirement and not something the unit tests can stand in for. Promoted a Thread, committed inside its Worktree, closed the Thread, then looked at the repo the way a terminal would:

```
branch in worktree: argusde/thread-b1f23125-6aa5-4131-be44-b82158d2c888
commit made in worktree: 42e22ba9e7
worktree dir gone after close: true

$ git branch --list 'argusde/*'
  argusde/thread-b1f23125-6aa5-4131-be44-b82158d2c888

$ git log --oneline -1 <branch>
42e22ba agent's commit

commit still reachable via branch: true
file content preserved on branch: true
```

- The promotion, thread-close, and worktree-removal regression tests pass unchanged.
- No audit-harness run: this phase touches no UI surface, so there is nothing for its axe scan or visual diff to catch.

## One existing assertion changed, with justification

`worktree-store.test.ts` asserted the new worktree was `detached`. That is precisely the behaviour this phase retires, so the assertion had to invert — a legitimate rewrite rather than a warning sign. It now asserts the worktree is on `branchNameFor(threadId)` and *not* detached.

## Explicitly deferred

- **Surfacing the branch in the UI** — story 28, which belongs to the working-tree cluster (phase 6).
- **Branch pruning.** Story 31 makes branches outlive their Worktrees deliberately, so they accumulate one per promoted Thread. That is the point, not an oversight — but it is unbounded growth, the same shape of question #93 already defers for activity retention, and how it should be handled depends on how many promoted Threads there turn out to be in practice.
- **Known, accepted failure mode:** a repository that already has a branch literally named `argusde` cannot also have `argusde/thread-…`, since git stores refs as paths. `git worktree add -b` fails cleanly there, matching this store's existing throw-rather-than-paper-over posture.
