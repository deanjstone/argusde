# Phase 14: Activity rendering in the timeline, truncation, pre-feature notice

> Implemented via `feature/activity-timeline`. Ticket: [#98](https://github.com/deanjstone/argusde/issues/98). Spec: [#93](https://github.com/deanjstone/argusde/issues/93) phase 2. Continues [phase 13](phase-13-durable-activity.md), which is spec #93's phase 1.

## Context

Phase 13 made activity durable but nothing rendered it: `thread.get-history` already returned an `activities` array and a `recordsActivity` flag, and the client dropped both. Reopening a Thread still showed only messages — the exact problem spec #93 opened with.

This phase is the half the user can see, and it carries the spec's first real shadcn migration: the chat transcript and the tool-call card are the surfaces it touches, so they come out of it on real primitives and theme tokens. No protocol change, no `API_VERSION` bump.

## Design as built

**History → reducer.** `loadThreadHistoryAndBecomeActive` reads `activities` and `recordsActivity` and threads both through `becomeActiveThread` into `history-loaded`. `ChatState.recordsActivity` defaults to **true** — a Thread with no history loaded yet is recording, and an empty timeline must not be explained away as a limitation unless the server said so. App.tsx's local `ThreadHistoryMessage` moved to `ws-protocol.ts`, where the rest of the wire shapes live.

**One interleaved timeline.** `mergeHistoryTimeline` in `src/shared/timeline.ts`, the home of the timeline vocabulary already shared between reducers. Messages with a null `sequence` (recorded before phase 1) are *partitioned* to the front in their original order rather than sorted with a sentinel — they have no position relative to an activity, and a sentinel would invent one. A replayed activity becomes a plain `TimelineToolCall`, not a new item type, so one card renders live and replayed alike; it gains one field, `dataTruncated`.

**`ActivityRecord.detail` is deliberately not consumed.** Using the server's pre-bounded 400-char preview for the collapsed card would give replayed activities a different preview length from live ones, which have no `detail` — reintroducing the live-vs-replay divergence phase 13's review already had to fix once. Display truncation is client-side and uniform at **240 characters** (`ACTIVITY_PREVIEW_CHARS`), shorter than the server's bound so a collapsed card stays compact: roughly six lines at 390px. `detail` remains a bounded, parse-free preview for a future compact activity list; nothing reads it today, which is worth stating rather than leaving dangling.

**Activity card** (`activity-card.tsx`) from `Item`/`Badge`/`Collapsible`: title, status badge (`failed` → `destructive`, so a refused call is distinguishable at a glance), a clamped preview, and an expand control that appears only when there is more to show. `dataTruncated` adds a note that the result was cut at *capture* time, so expanding a capped payload isn't mistaken for full recovery.

**Pre-feature notice** via `Marker` when `recordsActivity` is false.

**Transcript migration** onto `Message`/`Bubble` and `MessageScroller`, with every `neutral-*`/`violet-*`/`amber-*`/`red-*` literal in `chat-view.tsx` moved onto theme tokens. A `--warning` token pair was added to `index.css` for the worktree indicator, which had no counterpart in shadcn's default set.

## Three deviations from the spec's component table, each with evidence

The spec's table was verified against the live registry rather than taken on trust. All 26 named components exist; three things it says did not survive contact.

1. **`questionnaire` is the wrong component for the permission prompt.** The registry component is a multi-step form wizard — `QuestionnaireProgress`, `QuestionnairePrevious`, `QuestionnaireSkip`, `QuestionnaireNext`, `QuestionnaireSubmit`. An ACP permission request is a one-shot choice among N options. Built from `Item` + `Button` + tokens instead: real primitives and real tokens, without forcing a wizard's semantics onto a prompt.

2. **`message-scroller`'s spacer had to be neutralised.** `@shadcn/react`'s `MessageScroller.Content` injects an unconditional spacer div (measured at 493px) so the newest turn pins to the *top* of the viewport — the Claude.ai/ChatGPT pattern. It is a real pattern but not ArgusDE's, and on a short Thread it left most of the screen deliberately blank while clipping the top of the conversation; the audit's `US-4.5-tool-call-mobile` screenshot is what surfaced it. `defaultScrollPosition="end"` does not remove the spacer (it only changes where the initial scroll lands, which with a spacer is *worse*), so the fix is `spacerClassName="!h-0 !mt-0"`. Verified rather than assumed: after six streaming turns the viewport measured `scrollTop 2355 + clientH 609 === scrollHeight 2964` — pinned to the end exactly.

3. **The registry's `IconPlaceholder` import is a non-issue.** `message-scroller.json` and `questionnaire.json` both import `IconPlaceholder` from `@/app/(create)/components/icon-placeholder`, a path that only exists in the shadcn site's own repo — but **the CLI rewrites it on install**, producing a `lucide-react` import that typechecks clean with no hand-patching. #98's description claimed otherwise from reading the registry JSON; corrected on the ticket.

`message-scroller` was kept despite (2) because the transcript had **no scroll anchoring at all** before this — a streaming reply scrolled out from under the reader. One documented override buys that, plus a scroll-to-bottom control. It is the only thing pulling `@shadcn/react` (0.3.0), the project's first 0.x runtime dependency.

## A real accessibility regression, found and fixed

The migration put white text on the `--primary` token for the first time (the user's own message bubble). shadcn's dark-mode `--primary` is a lighter violet than the `bg-violet-600` the hand-rolled bubble used, and the pair measured **4.21:1 — below WCAG AA**. axe caught it on three stories.

Fixed by setting the dark `--primary` to `oklch(0.541 0.281 293.009)` — the same value the light theme already carried, and the exact violet-600 the bubble used before the migration. **5.46:1.** So the fix both clears the violation and makes the migration *more* faithful to what the user saw before. It applies to every primary button too, which had the same latent mismatch.

## Files

- `src/shared/timeline.ts` — `mergeHistoryTimeline`, `TimelineToolCall.dataTruncated`
- `src/shared/ws-protocol.ts` — `ThreadHistoryMessage`
- `src/web/chat-state.ts` — activities + `recordsActivity` through `history-loaded`
- `src/web/App.tsx` — read both from `thread.get-history`
- `src/web/components/activity-card.tsx` (new)
- `src/web/components/chat-view.tsx` — transcript migration, notice, tokens, permission prompt
- `src/web/components/ui/` — `message`, `bubble`, `message-scroller`, `item`, `collapsible`, `badge`, `marker`, `separator` via the CLI
- `src/web/index.css` — `--warning` pair, dark `--primary` contrast fix

## Verification

- `pnpm typecheck` clean, both projects.
- Full suite green under `xvfb-run`: **339/339 across 28 files**, up from 321/321 across 27. Run three times; the first run had one flake under audit load, the next two were clean.
- **UI/UX audit harness, both viewports, against a real server: 106 pass / 0 fail (desktop), 94 pass / 0 fail (mobile).** Zero axe violations, no horizontal scroll at 390px, zero console errors.
- `US-6.2`/`6.3`/`6.4` failed once as a cluster mid-session and passed on re-run — live-agent flake under load, not a regression.
- Eleven visual baselines re-recorded deliberately; the before/after is in this commit's diff. Desktop diffs were confined to the two cards actually redesigned; the wider mobile set is the darkened violet and token-driven borders, which move a larger share of pixels at 390px.
- E2E: a Thread driven through a tool call, reloaded, and asserted to still show it (`web-smoke.test.ts`, mobile viewport).

## One existing assertion changed, with justification

`chat-view.test.tsx`'s worktree-border test asserted `/border-(amber|emerald|violet)-\d+/` — a Tailwind *palette literal*, which is precisely what this migration replaces. Retargeted at `/border-warning/`. The user-visible behaviour ("a promoted thread is bordered in a colour the default state doesn't use") is unchanged; only the spelling of the colour moved onto a token. Every other assertion in that file passes untouched.

## Explicitly deferred

- **Scroll anchoring beyond what `MessageScroller` gives** — no custom behaviour added.
- **Mode switcher, thread list, project picker migrations** — spec #93 assigns them to whichever phase first opens them; this one doesn't.
- **`ActivityRecord.detail` consumption** — see above.
