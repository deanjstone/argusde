# Phase 22: Plan pill and expanding panel

> Implemented via `feature/plan-panel`, in progress. Ticket: [#126](https://github.com/deanjstone/argusde/issues/126). Spec: [#93](https://github.com/deanjstone/argusde/issues/93) phase 10 — the last of the composer cluster. Follows [phase 21](phase-21-context-meter.md).

## Context

> As a user, I want a progress pill above the composer showing how far through its plan the agent is, so that I always know where we are without opening anything.

Stories 51–59, plus the three surfaces this spec parked for whichever phase reached them last — mode switcher, thread list, and project picker. ACP has been sending the agent's plan since the MVP and the reducer's `plan` case has been `return state` the whole time — this spec names it as the literal starting point. The agent has been telling ArgusDE what it intends to do, and ArgusDE has been throwing it away. `API_VERSION` **1.4.0 → 1.5.0**: the history response gains a field.

## Verified before designing

Probed the real `claude-agent-acp` v0.57.0 with a prompt that drives its task-list tool, rather than trusting that the MVP's unused code path still corresponds to something:

1. **`plan` is genuinely emitted** — 7 notifications in a single turn, interleaved with tool calls, so the panel is live (story 56) with no extra work.
2. **Every notification carries the complete plan**, not a delta — the entry count grew 1 → 1 → 2 → 2 → 3 → 3 → 3 as the agent built it. A later plan therefore *replaces* the previous one, which is exactly what story 57 asks for and what the reducer should do.
3. **Statuses observed: `pending` and `in_progress`.** `completed` exists in the schema and will appear on a turn that finishes work; all three get styling.
4. **`priority` was `"medium"` for every entry, every time.** Claude Code does not vary it in practice, and none of stories 51–59 mention it. It is carried on the wire and **deliberately not rendered** — styling by a field that never changes is decoration pretending to be information.
5. **Entry content is short** — 41–44 characters in the sample. The pill can name the in-progress step without aggressive truncation, though it still needs a cap.
6. Plan entries carry **no stable id**, so "update in place" is replacement by position, not reconciliation by key.

## Scope

**In:** the pill, the expanding panel, live updates, replacement semantics, and no pill at all when there is no plan. Plus the three surfaces #93 parked — mode switcher, thread list, and project picker — which this spec says go in with phase 10 if no earlier phase opened them, and none did.

**Out:** plan editing, plan history, and anything that treats the plan as durable. No `API_VERSION` bump beyond the history field this adds — **1.4.0 → 1.5.0**.

## Design

### 1. The plan is session-scoped, like usage — not persisted

Phase 9 established the distinction and it applies here unchanged. A plan describes what a *live session* is currently doing. Cached on the runtime for the current session and returned by `thread.get-history` (a client reconnecting mid-turn should not have to wait for the next notification), cleared on `connecting`, never written to the event store.

This spec's own "only the latest plan is shown" points the same way.

### 2. Collapsible, not drawer

#93's table offers `collapsible` **or** `drawer`. It has to be `collapsible`: a drawer is modal, and story 54 requires the composer to stay answerable while the plan is open. Non-modal also sidesteps the trap recorded on #122 — a modal `aria-hidden`s the page behind it, which silently breaks any test synchronising on an element disappearing.

The panel sits between transcript and composer in the same flex column, so it takes its height from what the transcript gives up and can never cover the composer or the tab bar. No scrim, per prototype #90 — *"a panel that lands on the input is a panel you have to dismiss before you can answer the agent"*.

### 3. The pill answers the question without being opened

Completed-of-total, a meter, and the name of the in-progress step (stories 51, 52). Tapping toggles — the same control opens and closes it (story 59).

### 4. Statuses are distinguishable, not merely labelled

Completed, in-progress and pending each get their own treatment from the theme's tokens (story 55). The in-progress step is the one the resting pill names, so the panel and the pill agree by construction.

### 5. The three parked surfaces

Mode switcher, thread list and project picker still carry `neutral-*` and other colour literals (2, 9 and 15 occurrences). They move onto theme tokens and shadcn primitives. **Behaviour is preserved** — #93 is explicit that a migration changing what a control does is a bug, with accessibility the one allowed improvement.

### 6. Traps already paid for

- shadcn primitives cannot take a ref under this project's React 18 — wrapper elements, never `asChild` on a shadcn component (#122).
- Every Radix overlay needs an explicit accessible name or axe fails the audit (#122). `collapsible` is not an overlay, but the trigger still needs `aria-expanded`/`aria-controls`, which Radix provides.
- `scroll-area` is available again if the panel wants it (#113's correction, shipped in #125) — it needs Radix handed the CSP nonce. Not adopted here; plain `overflow-y-auto` is already proven in this codebase.

## Files

- `src/server/session/thread-runtime.ts`, `src/server/ws/ws-server.ts` — cache for the live session, expose on history
- `src/shared/ws-protocol.ts` — plan on history, `API_VERSION` 1.5.0
- `src/web/chat-state.ts` — the `plan` case stops returning state unchanged
- `src/web/components/plan-panel.tsx` (new), `chat-view.tsx`
- `src/web/components/mode-switcher.tsx`, `thread-list.tsx`, `project-picker.tsx` — migration
- `test/fixtures/fake-agent-cli.mjs` — drive plans, including a revision

## Testing

**Protocol seam**: a plan reaches the client mid-turn; a revision replaces rather than appends; history carries the latest for a reconnecting client; a Thread with no plan reports none.

**Reducer**: replaced on update; cleared on a fresh `connecting`.

**Component**: no pill without a plan (story 58) — asserted as nothing rendered; the pill names the in-progress step and the completed count; tapping expands and tapping again closes (stories 53, 59); the three statuses are distinguishable by more than text; a plan whose steps are all complete still reads correctly.

**Regression, explicitly**: every existing mode-switcher, thread-list and project-picker test passes **unchanged**. That is the bar for the migration.

**Real browser**: the panel opens above a real composer and covers neither it nor the tab bar (story 54) — asserted on geometry, not on a screenshot.

**Audit harness** both viewports with new US-21 stories, plus re-recorded baselines for the three migrated surfaces.

## Done when

- [ ] `pnpm typecheck` clean, `xvfb-run -a pnpm test` green, **and CI green on the PR**
- [ ] Full suite must not regress from 612/612 across 39 files
- [ ] Verified once against the real `claude-agent-acp`, not only the fixture

