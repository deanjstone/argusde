# Phase 21: Context meter

> Implemented via `feature/context-meter`, in progress. Ticket: [#124](https://github.com/deanjstone/argusde/issues/124). Spec: [#93](https://github.com/deanjstone/argusde/issues/93) phase 9 — the third of the composer cluster. Follows [phase 20](phase-20-slash-commands.md).

## Context

> As a user in a long session, I want to see how much of the context window is used, so that I can decide when to start a fresh Thread.

Stories 46–50. ACP sends `usage_update` on every turn and ArgusDE drops it on the floor. Deciding when a Thread has run out of room is currently guesswork. `API_VERSION` **1.3.0 → 1.4.0**: the history response gains a field.

## Verified before designing

Probed the real `claude-agent-acp` v0.57.0 with two real turns rather than reading the schema and hoping:

1. **`usage_update` is genuinely sent** — 4 notifications during the first turn, 7 by the end of the second. It arrives *during* a turn, not only at the end, so the meter updates live (story 47) with no extra work.
2. **The shape is `{ used, size, cost? }`** — `used` is tokens *currently in context*, `size` is the window. Exactly what a meter needs, and unlike the `Usage` type on the prompt response (cumulative counters, marked UNSTABLE) it is not experimental.
3. **`size` came back as 1,000,000.** A 1M window changes what this feature is for: after two turns `used` was 54,618 — **5.5%**. A meter designed around "you're nearly full" would spend its whole life at the left edge.
4. **`used` barely moves between turns** (54,618 → 54,643) because cached reads dominate. The number is genuinely about context occupancy, not activity.
5. `cost` is populated with real money (USD 0.31 → 0.51 across two turns). **Out of scope** — this spec says context meter, and cost is a different question with its own privacy shape. Noted here so it is a decision rather than an oversight.
6. A previously-unseen update kind appeared, `session_info_update`. Also out of scope, also recorded rather than silently dropped.

## Scope

**In:** a compact meter fed by `usage_update`, updating live, changing appearance under pressure, and absent entirely when the agent reports nothing.

**Out:** cost display, `session_info_update`, any persistence of usage, and any notion of "compact the context". No `API_VERSION` bump is needed for the wire — but the history response gains a field, so **1.3.0 → 1.4.0**.

## Design

### 1. Usage is deliberately *not* persisted

The natural instinct is to cache it like the mode catalog, prompt capabilities and command list — this would be the fourth rider on that road. It is the wrong call here.

`used` describes the context of a **live agent session**. Reopening a Thread starts a new session with an empty context, so a number carried over from the last one describes something that no longer exists. Showing it would be worse than showing nothing.

So: cached on the runtime *for the current session only* and returned by `thread.get-history` (a client that reconnects mid-session should not have to wait a turn to see it), and cleared whenever the session reconnects — exactly as the command list and capabilities are cleared on `connecting`. A freshly reopened Thread shows no meter until its first turn reports, which is what story 50 asks for.

### 2. Thresholds are proportional, and tuned for a 1M window

With `size` at 1,000,000 and real usage at ~5%, an absolute "nearly full" threshold is meaningless. Story 48 gets proportional bands — comfortable below 75%, warning from 75%, pressure from 90% — using the existing `--warning` and destructive theme tokens rather than new colours.

### 3. Compact, and readable without hovering

Story 49 wants it not to compete with the conversation; story 46 wants the number legible. A tooltip alone fails the phone, where there is nothing to hover — and the phone is the case this app exists for.

So the meter carries its own short label (a percentage) plus an accessible name stating used-of-size, with `tooltip` adding the exact figures for a pointer. The tooltip is an enhancement, never the only route to the number.

### 4. Two traps already paid for

Both recorded on #93 from phase 8, and both apply directly:

- **shadcn primitives cannot take a ref under this project's React 18.** `TooltipTrigger` uses `asChild`, which is exactly the pattern that put phase 8's menu 168px above the viewport. The trigger wraps a plain element, not a shadcn primitive.
- **Radix overlays need an explicit accessible name**, or axe fails the audit as a serious violation. Added when the component is added, not after the audit says so.

## Files

- `src/utility/acp-session.ts` — handle `usage_update`, emit the event
- `src/shared/acp-events.ts` — `SessionUsage`, the new event
- `src/shared/ws-protocol.ts` — usage on history, `API_VERSION` 1.4.0
- `src/server/session/thread-runtime.ts` — cache for the live session, clear on reconnect
- `src/server/ws/ws-server.ts` — history response
- `src/web/chat-state.ts` — `usage`, cleared on `connecting`
- `src/web/components/context-meter.tsx` (new), `chat-view.tsx`
- `test/fixtures/fake-agent-cli.mjs` — drive usage updates, including a mid-turn sequence

## Testing

**Protocol seam**: usage reaches the client mid-turn; a later update replaces an earlier one; history carries it for a client that reconnected; an agent that reports none yields none rather than zeros.

**Reducer**: replaced on update; cleared on a fresh `connecting`, so a restarted session cannot inherit a number describing a context that no longer exists.

**Component**: absent with no usage (story 50) — asserted as *nothing rendered*, not as a zeroed bar; the percentage shown; each pressure band entered at its boundary and not before; an accessible name carrying used-of-size without hovering.

**Real browser**: the meter appears after a turn and the tooltip opens with zero CSP violations — a third Radix component exercising #113's nonce.

**Audit harness** both viewports with new US-20 stories.

## Done when

- [ ] `pnpm typecheck` clean, `xvfb-run -a pnpm test` green, **and CI green on the PR**
- [ ] Full suite must not regress from 592/592 across 38 files
- [ ] Verified once against the real `claude-agent-acp`, not only the fixture
</content>
</invoke>
