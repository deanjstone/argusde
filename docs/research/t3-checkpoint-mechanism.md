# T3 Code Checkpoint Mechanism — Research Brief

Ticket: [deanjstone/argusde#24](https://github.com/deanjstone/argusde/issues/24) (child of wayfinder map [deanjstone/argusde#20](https://github.com/deanjstone/argusde/issues/20))

Source repo read: `deanjstone/t3code` (fork of `pingdotgg/t3code`), `main` branch, read via
`gh api repos/deanjstone/t3code/git/trees/main?recursive=true` and
`gh api repos/deanjstone/t3code/contents/<path>?ref=main` on 2026-08-13.

**Location correction**: the encyclopedia-referenced file names (`CheckpointStore.ts`,
`CheckpointReactor.ts`, `CheckpointDiffQuery.ts`, `Diffs.ts`, `RuntimeReceiptBus.ts`) do exist,
but not under `packages/effect-codex-app-server`. They live under `apps/server/src/`:

- `apps/server/src/checkpointing/CheckpointStore.ts`
- `apps/server/src/checkpointing/CheckpointDiffQuery.ts`
- `apps/server/src/checkpointing/Diffs.ts`
- `apps/server/src/checkpointing/Utils.ts`
- `apps/server/src/checkpointing/Errors.ts`
- `apps/server/src/orchestration/Layers/CheckpointReactor.ts` (the ~800-line implementation)
- `apps/server/src/orchestration/Services/CheckpointReactor.ts` (the service interface/tag)
- `apps/server/src/orchestration/Services/RuntimeReceiptBus.ts` (interface/tag)
- `apps/server/src/orchestration/Layers/RuntimeReceiptBus.ts` (implementation, not read in detail)
- `apps/server/src/vcs/GitVcsDriver.ts` — **this is where the actual git plumbing lives**, not
  in the `checkpointing/` folder. `CheckpointStore` is a thin dispatcher that resolves the
  active VCS driver and delegates to `driver.checkpoints` (`VcsCheckpointOps`), which for Git
  is implemented in `GitVcsDriver.ts`.
- `apps/server/src/persistence/Services/ProjectionCheckpoints.ts` /
  `apps/server/src/persistence/Layers/ProjectionCheckpoints.ts` — SQL-backed read-model
  repository for checkpoint metadata (not the git refs themselves).
- `apps/server/src/persistence/Migrations/003_CheckpointDiffBlobs.ts` — a separate,
  apparently-unused-by-the-read-path SQL table for caching diff text blobs.

---

## 1. Hidden-git-ref mechanism: ref namespace, commit contents, commit timing

**Ref namespace** — defined in `apps/server/src/checkpointing/Utils.ts:4-9`:

```ts
export const CHECKPOINT_REFS_PREFIX = "refs/t3/checkpoints";

export function checkpointRefForThreadTurn(threadId: ThreadId, turnCount: number): CheckpointRef {
  return CheckpointRef.make(
    `${CHECKPOINT_REFS_PREFIX}/${Encoding.encodeBase64Url(threadId)}/turn/${turnCount}`,
  );
}
```

So each checkpoint ref is `refs/t3/checkpoints/<base64url(threadId)>/turn/<turnCount>` — one
hidden ref per (thread, turn-count) pair. Being under `refs/t3/...` (not `refs/heads/...` or
`refs/tags/...`), these refs are invisible to normal `git branch`/`git tag`/`git log --all`
listings but are ordinary refs `git update-ref`/`git rev-parse` can address directly.

**What gets committed** — full workspace snapshot, not a diff. Implemented in
`apps/server/src/vcs/GitVcsDriver.ts:651-730` (`checkpoints.captureCheckpoint`):

1. Resolves the git common dir (`git rev-parse --git-common-dir`, line 639-648) and creates a
   throwaway index file path `t3-checkpoint-index-<uuid>` inside it (line 654-657).
2. Sets `GIT_INDEX_FILE` to that temp path plus fixed author/committer identity
   (`T3 Code <t3code@users.noreply.github.com>`) in the process env for all subsequent git
   calls in this operation (line 658-665) — this isolates the checkpoint commit from the
   user's real staging area entirely.
3. If `HEAD` exists, seeds the temp index from it: `git read-tree HEAD` (line 671-680).
4. Stages the **entire current working tree** into that temp index: `git add -A -- .`
   (line 682-687) — this is a full snapshot of tracked+untracked (respecting `.gitignore`)
   files, not an incremental diff.
5. `git write-tree` to get a tree object, then `git commit-tree <tree> -m "t3 checkpoint
   ref=<checkpointRef>"` to create a commit object (line 689-722) — this commit is created
   directly via plumbing, with no parent linkage to prior checkpoints or to `HEAD` (no `-p`
   flag passed), so each checkpoint commit is a standalone root-ish commit object referencing
   only its own tree.
6. `git update-ref <checkpointRef> <commitOid>` writes the hidden ref to point at that commit
   (line 724-728).
7. The temp index file is removed in an `Effect.ensuring` cleanup regardless of success/failure
   (line 667-669, 729).

**Timing** — the commit is made synchronously inside the `captureCheckpoint` call, which is
invoked from two points in the turn lifecycle (see §2): once as a "pre-turn baseline" before a
turn's work begins, and once as the "post-turn" checkpoint after the turn completes. Both calls
run the full capture sequence above; there is no separate "baseline" vs "turn-end" code path —
they call the identical `captureCheckpoint` operation with different `checkpointRef` turn
counts (`turn/<N-1>` style baseline vs `turn/<N>` completion,
`apps/server/src/orchestration/Layers/CheckpointReactor.ts:234-253`).

---

## 2. What triggers a checkpoint capture during a Turn

All triggering logic lives in `apps/server/src/orchestration/Layers/CheckpointReactor.ts`,
inside two event dispatchers: `processRuntimeEvent` (provider/runtime events, lines 783-808)
and `processDomainEvent` (orchestration-domain events, lines 740-781). The reactor is started
via `Effect.forkScoped` (lines 836, 850) as background worker fibers.

**Pre-turn baseline capture** — fired from two independent triggers, both idempotent (skip if
the baseline ref already exists via `hasCheckpointRef`, lines 507-513 / 589-595):

- `ensurePreTurnBaselineFromTurnStart` (line 479-527), fired on the provider-runtime
  `"turn.started"` event (`processRuntimeEvent`, line 786-789).
- `ensurePreTurnBaselineFromDomainTurnStart` (line 549-608), fired on the orchestration-domain
  events `"thread.turn-start-requested"` or `"thread.message-sent"` (filtered to
  `role: "user"`, non-streaming, `turnId: null` — i.e. the very first user message of a new
  turn) (`processDomainEvent`, line 741-744).

Both compute `currentTurnCount` from existing checkpoints, build
`checkpointRefForThreadTurn(threadId, currentTurnCount)`, and call `captureCheckpoint` if that
ref doesn't already exist — this is the checkpoint that represents workspace state *before* the
turn's tool calls run.

**Post-turn capture** — two triggers converge on the shared `captureAndDispatchCheckpoint`
helper (line 218-349):

- `captureCheckpointFromTurnCompletion` (line 352-415), fired on the provider-runtime
  `"turn.completed"` event (`processRuntimeEvent`, line 791-807).
- `captureCheckpointFromPlaceholder` (line 425+), fired on the orchestration-domain
  `"thread.turn-diff-completed"` event when its `status` is `"missing"` (`processDomainEvent`,
  line 767-780) — this replaces a placeholder checkpoint row (inserted earlier by a separate
  `ProviderRuntimeIngestion` component from a `turn.diff.updated` Codex-runtime event) with a
  real git-ref-based one.

A code comment at line 762-766 explains *why* both exist: `"the providerService.streamEvents
PubSub does not reliably deliver turn.completed runtime events to this reactor (shared
subscription), so reacting to the domain event is the reliable path."` — i.e. redundant trigger
paths compensate for unreliable event delivery on a shared PubSub subscription, not a
deliberate two-stage design.

`captureAndDispatchCheckpoint` (line 218-349) is the actual capture-and-record sequence run by
both post-turn triggers:
1. Computes `fromCheckpointRef` (previous turn count) and `targetCheckpointRef` (this turn
   count) via `checkpointRefForThreadTurn`.
2. Calls `checkpointStore.captureCheckpoint` for `targetCheckpointRef` (the git commit, §1).
3. Refreshes the file-picker workspace index (line 257).
4. Calls `checkpointStore.diffCheckpoints(fromCheckpointRef, targetCheckpointRef)` and parses
   the resulting unified diff into a per-file added/removed-line summary via
   `parseTurnDiffFilesFromUnifiedDiff` (`checkpointing/Diffs.ts`, using the `@pierre/diffs`
   npm package's `parsePatchFiles`).
5. Dispatches the domain event `"thread.turn.diff.complete"` into the orchestration engine
   (line 301-313) — this is what actually persists the checkpoint metadata row via the
   event-sourced projection (`ProjectionCheckpointRepository.upsert`, not called directly here;
   presumably applied by a projector subscribed to that domain event, not read in this pass).
6. Publishes two `RuntimeReceiptBus` receipts (`checkpoint.diff.finalized`,
   `turn.processing.quiesced`) — these are explicitly documented
   (`RuntimeReceiptBus.ts:1-14`) as **test/harness-only synchronization signals**, not part of
   the production event model.
7. Dispatches a `"thread.activity.append"` domain event so a "Checkpoint captured" activity
   entry shows in the thread's timeline UI.

**Revert** — a third trigger, `handleRevertRequested` (line 610-738), fires on the
orchestration-domain `"thread.checkpoint-revert-requested"` event. It calls
`checkpointStore.restoreCheckpoint` (not detailed above; see `GitVcsDriver.ts:737-771`), which
runs `git restore --source <commit> --worktree --staged -- .` then `git clean -fd -- .` then
(if `HEAD` exists) `git reset --quiet -- .` — i.e. it forcibly overwrites the working tree and
index to match the checkpoint commit and removes untracked files not present in it. It then
deletes checkpoint refs for turns after the reverted-to turn count
(`checkpointStore.deleteCheckpointRefs`, line 705-717) and dispatches
`"thread.revert.complete"`.

---

## 3. Baseline vs incremental diffing

Two states are compared: **checkpoint-vs-checkpoint** (turn N-1 vs turn N), never
checkpoint-vs-working-tree. `diffCheckpoints` is implemented via direct git plumbing, not a
custom diff engine — `GitVcsDriver.ts:773-834`:

```
git diff --patch --no-color --no-ext-diff --no-textconv \
  [--ignore-all-space] \
  <fromRevision>^{commit} <toCheckpointRef>^{commit}
```

capped at `CHECKPOINT_DIFF_MAX_OUTPUT_BYTES = 10_000_000` (line 272) bytes of output.

Two call sites use this with different semantics, both defined in
`apps/server/src/checkpointing/CheckpointDiffQuery.ts`:

- `getTurnDiff` (line 82-187) — diffs one turn against the immediately preceding turn
  (`fromTurnCount` → `toTurnCount`, usually adjacent), used for "what changed this turn".
  `fromTurnCount = 0` resolves to the turn-0 baseline ref rather than a real prior turn.
- `getFullThreadDiff` (line 189-283) — always diffs from turn 0 (the very first baseline) to a
  given `toTurnCount`, i.e. cumulative diff across the whole thread so far, reusing the same
  `diffCheckpoints` plumbing with `fromCheckpointRef = checkpointRefForThreadTurn(threadId, 0)`.

Both resolve checkpoint refs by reading thread/turn metadata from
`ProjectionSnapshotQuery` (the SQL read-model, not git) to map turn counts to `checkpointRef`
strings, then call `CheckpointStore.diffCheckpoints`, which (via `resolveCheckpoints` in
`CheckpointStore.ts:102-115`) delegates to the active VCS driver's `checkpoints.diffCheckpoints`
— i.e. `GitVcsDriver.ts`'s `git diff` invocation above. There is no working-tree-vs-checkpoint
diff path in the code read (live/uncommitted changes are handled by a separate, non-checkpoint
`getDiffPreview` VCS driver capability referenced in `VcsDriver.ts`, not investigated here).

The `Diffs.ts` module (`checkpointing/Diffs.ts`) is not itself a diff engine — it only
post-processes the unified diff text returned by `git diff` into per-file add/delete line
counts using the third-party `@pierre/diffs` package's `parsePatchFiles`, for use in UI
summaries (file lists, additions/deletions badges).

---

## 4. What T3's checkpoint feature depends on (factual, not a recommendation)

Documenting T3's actual dependency footprint for this feature, as input to a separate,
not-yet-resolved ArgusDE design decision:

- **A VCS driver abstraction layer** (`apps/server/src/vcs/VcsDriver.ts`) — `CheckpointStore`
  never calls git directly; it resolves a `VcsDriver` from a `VcsDriverRegistry` per-cwd and
  calls an *optional* `driver.checkpoints` capability (`VcsCheckpointOps`). Only
  `GitVcsDriver.ts` implements it in the code read. This means the checkpoint feature is coupled
  to T3's multi-VCS-driver architecture (drivers can lack checkpoint support and the caller
  handles that via `VcsUnsupportedOperationError`, `CheckpointStore.ts:107-112`), not just to
  git.
- **Effect-TS specific constructs throughout**: `Context.Service` for DI-style service tags,
  `Layer.effect` for wiring, `Effect.fn` for traced/named effectful functions,
  `Effect.forkScoped` for background worker fibers, `Effect.gen` generator syntax,
  `Schema` (effect/Schema) for runtime-validated domain types (`CheckpointRef`, turn counts,
  etc.), and `effect/unstable/sql/SqlClient` for the migration/projection layer. The whole
  feature is written against Effect's service/layer/effect model, not plain async/await or a
  generic DI container.
- **An event-sourced orchestration engine and domain-event model**: checkpoint capture is
  triggered by, and itself dispatches, typed domain events
  (`"thread.turn-start-requested"`, `"thread.message-sent"`, `"thread.turn-diff-completed"`,
  `"thread.checkpoint-revert-requested"`, `"thread.turn.diff.complete"`,
  `"thread.activity.append"`, `"thread.revert.complete"`) through an `orchestrationEngine`
  dispatch/subscribe mechanism (referenced but not itself opened in this pass). Checkpoint
  metadata persistence (`ProjectionCheckpointRepository.upsert`) is implied to happen via a
  projector reacting to the `"thread.turn.diff.complete"` event, not via a direct write call
  from the reactor — i.e. checkpoints are a read-model projection over an event store, not a
  directly-written table.
- **A SQL persistence/projection layer**: `ProjectionCheckpointRepository` stores checkpoint
  *metadata* (thread id, turn id, turn count, checkpoint ref string, status, per-file
  add/delete summary, assistant message id, completed-at) as SQL rows keyed by
  `(threadId, checkpointTurnCount)` — separate from and in addition to the git refs, which
  store the actual snapshot content. A companion migration
  (`003_CheckpointDiffBlobs.ts`) defines a `checkpoint_diff_blobs` cache table keyed by
  `(thread_id, from_turn_count, to_turn_count)`, though its write/read call sites were not
  located in this pass.
- **A dual/redundant event-trigger design driven by an unreliable shared PubSub**: both
  provider-runtime events and orchestration-domain events independently trigger the same
  baseline/capture logic, explicitly to compensate for `"the providerService.streamEvents
  PubSub does not reliably deliver turn.completed runtime events to this reactor (shared
  subscription)"` (`CheckpointReactor.ts:762-766`). This redundancy is itself a piece of
  T3-specific infrastructure debt/workaround, not an inherent property of the checkpoint
  concept.
- **A test-only receipt/synchronization bus** (`RuntimeReceiptBus`) — explicitly documented as
  existing only so integration tests can await exact checkpoint-lifecycle milestones
  (baseline captured, diff finalized, turn quiesced) rather than polling persisted state.
- **Third-party diff-parsing library** `@pierre/diffs` (used via `parsePatchFiles` in
  `Diffs.ts`) for turning a unified diff into per-file line-count summaries for UI display —
  this is a UI-summary convenience layer on top of raw `git diff` output, not part of the core
  capture/diff/restore mechanism, which is plain git plumbing (`read-tree`, `add`,
  `write-tree`, `commit-tree`, `update-ref`, `diff`, `restore`, `clean`, `reset`,
  `rev-parse`).
- **A worktree/multi-project workspace resolution layer**: `resolveCheckpointCwd`
  (`CheckpointReactor.ts:183-213`) picks the checkpoint's git cwd from either the active
  provider session's runtime cwd or the thread's configured worktree/project workspace root,
  and requires `isGitWorkspace(cwd)` to be true before any checkpoint operation runs at all
  — i.e. checkpointing is silently skipped for non-git workspaces.

The core git plumbing itself (temp `GIT_INDEX_FILE`, `read-tree`/`add -A`/`write-tree`/
`commit-tree`/`update-ref` to build an untracked/orphan-ish commit at a hidden ref, and plain
`git diff <ref>^{commit} <ref>^{commit}` for comparison, and `git restore`/`clean`/`reset` for
revert) does not require Effect-TS, an event-sourced engine, or the VCS-driver abstraction —
those are the layers T3 wraps around it, not properties of the git mechanism itself.

---

## Sources

- `apps/server/src/checkpointing/Utils.ts:4-9` — ref namespace constant and
  `checkpointRefForThreadTurn`.
- `apps/server/src/checkpointing/CheckpointStore.ts:16-171` — service interface + dispatcher
  that delegates to the active VCS driver's checkpoint ops.
- `apps/server/src/vcs/VcsDriver.ts:1-80` — `VcsCheckpointOps` interface, `VcsDriver` service
  shape with optional `checkpoints` capability.
- `apps/server/src/vcs/GitVcsDriver.ts:599-864` — git implementation of
  `captureCheckpoint`, `hasCheckpointRef`, `restoreCheckpoint`, `diffCheckpoints`,
  `deleteCheckpointRefs`; `CHECKPOINT_DIFF_MAX_OUTPUT_BYTES` at line 272.
- `apps/server/src/orchestration/Layers/CheckpointReactor.ts:183-849` — trigger wiring:
  `resolveCheckpointCwd` (183-213), `captureAndDispatchCheckpoint` (218-349),
  `captureCheckpointFromTurnCompletion` (352-415), `captureCheckpointFromPlaceholder`
  (425+), `ensurePreTurnBaselineFromTurnStart` (479-527),
  `refreshLocalGitStatusFromTurnCompletion` (529-547),
  `ensurePreTurnBaselineFromDomainTurnStart` (549-608), `handleRevertRequested`
  (610-738), `processDomainEvent` (740-781), `processRuntimeEvent` (783-808),
  worker fiber forks (836, 850).
- `apps/server/src/orchestration/Services/CheckpointReactor.ts:1-41` — reactor service
  interface/tag.
- `apps/server/src/orchestration/Services/RuntimeReceiptBus.ts:1-67` — test/harness-only
  receipt bus, explicitly documented as non-production (comment lines 1-14).
- `apps/server/src/checkpointing/CheckpointDiffQuery.ts:1-292` — `getTurnDiff` (82-187),
  `getFullThreadDiff` (189-283), both delegating to `CheckpointStore.diffCheckpoints`.
- `apps/server/src/checkpointing/Diffs.ts:1-27` — `parseTurnDiffFilesFromUnifiedDiff` using
  `@pierre/diffs`'s `parsePatchFiles`.
- `apps/server/src/persistence/Services/ProjectionCheckpoints.ts:1-96` — SQL projection
  repository interface for checkpoint metadata (`ProjectionCheckpoint` schema, upsert /
  listByThreadId / getByThreadAndTurnCount / deleteByThreadId).
- `apps/server/src/persistence/Migrations/003_CheckpointDiffBlobs.ts:1-23` — companion
  `checkpoint_diff_blobs` SQL cache table migration.

Not opened in this pass (out of scope for the 4 questions above, noted for completeness):
`apps/server/src/persistence/Layers/ProjectionCheckpoints.ts` (SQL implementation),
`apps/server/src/orchestration/Layers/RuntimeReceiptBus.ts` (bus implementation),
the `orchestrationEngine`/event-store core itself, `ProjectionSnapshotQuery`, and
`VcsDriverRegistry`.
