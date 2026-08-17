# Phase 13: Durable activity — event, table, store, projection, history replay

> Implemented via `feature/durable-activity`. Ticket: [#95](https://github.com/deanjstone/argusde/issues/95). Spec: [#93](https://github.com/deanjstone/argusde/issues/93) phase 1.

Numbered 13 to continue this directory's sequence — it is *phase 1* of spec #93, which starts its own numbering fresh. Spec #93's phase 0 (shadcn adoption, PR #94) landed without a plan doc.

## Context

Reopening a Thread replayed messages and nothing else. Tool calls were forwarded live over the WebSocket and never persisted — `ThreadRuntime.handleEvent` only persisted `message-chunk` (assembled at turn-complete) and `mode-changed` — so a Thread revisited the next morning read as if the agent had talked but never touched anything. Spec #93's first story cluster; this is the server half, with rendering deferred to its phase 2.

Server-only by design: when this landed the app looked identical, and `thread.get-history` simply returned an extra array nobody read yet.

## Design as built

**Domain event.** `thread.activity-recorded` on `EventStore`'s `DomainEvent` union, carrying `activityId` (the ACP `toolCallId`), `sequence`, `turn`, `toolKind`, `status`, `summary`, `detail`, `data`, `dataTruncated`. Shape derives from ACP's `ToolCallSummary`/`ToolCallUpdateSummary` rather than being invented. `toolKind`, not `kind`, because `kind` is the union's own discriminator. No `tone` column — nothing renders one.

**Table and projection.** A new `activities` table keyed on `(thread_id, activity_id)`, so a `tool_call_update` upserts onto the row its `tool_call` created — the same shape `upsertToolCall` already uses for the live timeline. `COALESCE(excluded.x, activities.x)` is what makes an omitted field mean "unchanged" rather than "cleared", matching ACP, which replaces a tool call's content collection only when it actually sends one. `sequence` is deliberately absent from the update clause: an activity's place on the timeline is where it began. `data`/`data_truncated` are nullable and NULL is meaningful — "this update reported no content at all".

**Bounds** (`activity-bounds.ts`) — picked against *this* UI, not inherited from T3's desktop-tuned 120/180, and this is the record of that choice:

| Field | Bound | Why |
|---|---|---|
| `summary` | 100 chars | the card headline; ~2 lines at 390px before it stops being one |
| `detail` | 400 chars | the expanded body; ~10 lines on a phone, enough to judge a result |
| `data` | 16 KiB JSON | ACP results can carry whole file contents; over the cap whole blocks are dropped from the end so the stored value stays parseable, and `dataTruncated` says it happened |

Truncation runs in `boundEvent`, *before* `appendEvent` inserts — the append-only log is the thing that grows forever, so bounding only the projection would leave the cap half-working. Keeping it inside `appendEvent` preserves the store's single-write-path rule while leaving every boundary case reachable from a plain store test.

**Ordering.** One per-Thread `sequence`, allocated in `ThreadRuntime` when an item *begins*: user messages at `sendMessage`, activities on first sighting of their `toolCallId` (updates reuse it), and agent messages **at their first chunk** in `accumulateAgentChunk` rather than at turn-complete. That last one is the whole point — an agent's reply is persisted after every tool call in its turn, so append order alone replays a turn as "said everything, then did everything". `thread.message-recorded` gained an optional `sequence`; legacy messages have none and keep their relative append order, which costs nothing because a Thread old enough to lack sequences has no activities to interleave. The counter is re-seeded from `EventStore.getNextSequence()` on construction so a rebuilt runtime doesn't collide with persisted history.

Sequencing at the first chunk is necessary but not sufficient: `accumulateAgentChunk` also has to **segment** the agent's prose the way the live timeline does. claude-agent-acp sends no message ids, so every anonymous chunk in a turn was landing in one pending entry — meaning prose sent *after* a tool call merged back into the prose sent before it and inherited its earlier sequence. The live view splits there (`appendOrMergeMessage`'s `continuesLast` check stops continuing once a tool call is the last timeline item), so replay diverged from what the user had actually watched. A new segment now opens whenever a tool call is seen for the first time, and at every turn boundary. Updates to an already-recorded tool call don't split, matching `upsertToolCall`, which merges in place and moves nothing.

**Pre-feature Threads.** `threads.records_activity` via the established `addColumnIfMissing` idiom, set to 1 by the `thread.created` projection from now on. Rows written by an earlier build stay NULL → `recordsActivity: false`, which is the only way to tell "this Thread genuinely did nothing" from "nobody was recording". No backfill is possible — the events were never emitted.

**Protocol.** `thread.get-history` gained `activities` and `recordsActivity`, and every message now carries `sequence` (null for legacy). Both lists ship separately rather than pre-merged: the client already owns timeline assembly (`src/shared/timeline.ts`), and the shared key is there precisely so it can interleave them. `API_VERSION` → `1.1.0`, the single bump spec #93 allots for its whole run; phases 2–10 don't bump again.

**Non-blocking.** Recording happens in `handleEvent`'s switch, i.e. after the event has already been forwarded to `onEvent` — persistence never sits between the agent and the client's stream.

## Files

- `src/server/persistence/activity-bounds.ts` (new) — bounds, truncation, detail flattening
- `src/server/persistence/schema.ts` — `activities` table, `records_activity` column
- `src/server/persistence/event-store.ts` — event, `boundEvent`, projection, `listActivities`, `getNextSequence`, row→record flattening, `project.deleted` cascade
- `src/server/session/thread-runtime.ts` — sequence allocation, `recordActivity`
- `src/server/ws/ws-server.ts` — `thread.get-history` payload
- `src/shared/ws-protocol.ts` — `ActivityRecord`, `ThreadRecord.recordsActivity`, `API_VERSION`
- `test/fixtures/fake-agent-cli.mjs` — `tool-call` / `tool-call-update` steps
- `CONTEXT.md` — **Activity** updated, **Sequence** added

## Verification

- `pnpm typecheck` clean (both projects).
- Full suite green under `xvfb-run`: **321/321 across 27 files**, up from 293/293 across 26 — 28 new tests, no existing test deleted or weakened. Three existing assertions grew a `recordsActivity` field because the shared `ThreadRecord` shape genuinely gained one.
- Checkpoint strip, checkpoint diffing, revert, and thread-close tests pass untouched.
- Driven against a real running server: a Thread taken through a turn of prose → tool call → prose → tool call, then re-fetched via `thread.get-history`, replays in that order.

## What review changed

`/spec-review` (standards and spec-fidelity axes in parallel) found one real defect and several cleanups, all fixed before merge:

- **The prose-segmentation bug above.** The spec axis caught that the protocol test had been written prose → tool → tool rather than the ticket's prose → tool → prose → tool, and that the missing step was missing because the case was broken. Both tests now drive the full shape.
- A dead `isNew` branch in `recordActivity` whose `?? []` could never fire (`ToolCallSummary.content` is non-optional) — removed along with the cast propping it up.
- `THREAD_COLUMNS` renamed `THREAD_SELECT`; it holds a `SELECT`, not a column list.
- Two comments that overstated what the code did (`recordActivity`'s "absent fields left absent", and `ThreadRuntime`'s class doc still claiming tool calls aren't persisted).

Two findings were considered and deliberately not acted on, with reasons recorded in-code: story 7's push-before-write assertion stays at the `onEvent` seam rather than the protocol seam (across a real socket the assertion is vacuous — an async push always loses to a synchronous write regardless of code order), and `data`/`data_truncated` stay nullable against the ticket's literal `NOT NULL`, because NULL is what lets the upsert tell "reported no content" from "reported empty".

## Explicitly deferred

- **All rendering** — the timeline merge, truncation-expand UI, and the pre-feature notice are spec #93 phase 2. Nothing in `src/web/` changed here, so no surface needed a shadcn migration.
- **Activity retention** — pruning, archival, compaction. Per-row bounds don't bound a Thread's growth over time; out of scope in #93.
- **Restoring `nextTurn` across a runtime rebuild.** A second `ThreadRuntime` over a Thread that already has checkpoints restarts its turn counter at 1 and collides on the checkpoints primary key. Pre-existing, unreachable today (promotion is the only rebuild path and is only allowed before the first message), found while writing the restart test here — filed separately rather than fixed in this phase.
