# Phase 20: Slash-command menu

> Implemented via `feature/slash-commands`, in progress. Ticket: [#122](https://github.com/deanjstone/argusde/issues/122). Spec: [#93](https://github.com/deanjstone/argusde/issues/93) phase 8 — the second of the composer cluster. Follows [phase 19](phase-19-image-attachments.md).

## Context

> As a user, I want typing `/` in the composer to show the agent's own command list, so that I can reach my Claude Code commands and skills without remembering their names.

Stories 39–45. ACP has been pushing the agent's own command list on every session, unprompted, right after session start — and ArgusDE has been dropping it on the floor. The user's own skills are unreachable from this app unless they remember the exact name and type it blind. `API_VERSION` **1.2.0 → 1.3.0**: the history response gains a field.

## Verified before designing

Probed the real `claude-agent-acp` v0.57.0 rather than reasoning from the schema:

1. **The bridge pushes `available_commands_update` unprompted, right after session start** — before any prompt is sent. It is *not* on the `session/new` response, so it travels the same road as the mode catalog and `promptCapabilities`: broadcast once, cached on the runtime, replayed to a client that connected later.
2. **It sent 122 commands.** Filtering (story 41) is load-bearing, not a nicety, and the menu needs a height cap. A design that renders the list unfiltered is unusable on the machine this app is actually for.
3. **Descriptions are long** — several hundred characters each, many ending in a literal `(user)` marker. They cannot be rendered raw in a menu row; one clamped line is the only workable shape.
4. **`input` is null for 107 of 122.** The 15 that have one carry `{ hint: string }` — e.g. `handoff` → *"What will the next session be used for?"*.
5. **The agent side genuinely parses a slash command out of a plain text prompt.** Sending `/zzz-not-a-real-command-9137` as ordinary text came back `Unknown command: /zzz-not-a-real-command-9137` — not a conversational reply. This is what makes #93's "insert into the composer and let the user send it" mechanism work at all; without it the whole phase would be decorative.

## Scope

**In:** discovery and insertion — the menu, its filtering, keyboard and touch selection, the input hint, mid-session updates, and no menu at all for an agent that advertises none.

**Out:** templating, argument parsing, a client-authored command catalogue, and any client-side execution. #93 is explicit that this is **discovery only** and that T3's richer templating UI is T3-authored and not copied. Selecting a command inserts text; the user sends it like any other message.

`API_VERSION` **1.2.0 → 1.3.0** — the history response gains a field.

## Design

### 1. A third rider on the road modes and capabilities already take

`available_commands_update` is a session notification, cached on `ThreadRuntime`, and returned by `thread.get-history`. That is now the third thing with exactly this shape, and the pattern is settled: broadcast once, unrecoverable if missed, so the runtime holds it and history replays it.

One difference from the mode catalog: this one **can legitimately arrive again mid-session** (story 44). ACP sends the complete list each time, so an update *replaces* rather than merges — a command the agent dropped has to disappear.

### 2. What the wire carries

`{ name, description, inputHint: string | null }` — the hint flattened out of ACP's `input: { hint }`, because the only input kind ACP defines is unstructured, and a nested optional object for one string would make every consumer unwrap it.

### 3. When the menu opens

When the composer's text **starts with `/` and has no whitespace yet** — i.e. while the command name is still being typed. `/rev` filters; `/review my diff` does not reopen the menu, because at that point the user is writing the argument, which is exactly the case story 43 is about.

Absent commands, absent menu (story 45) — the same rule the capability gate follows in phase 7 and the mode switcher follows already.

### 4. Components

shadcn `command` inside a `popover` — both Radix overlays, both unblocked by #113's nonce, and **both to be verified in a real browser under the real CSP** rather than assumed to work now. #113 established the distinction that matters: an injected `<style>` element is fine, an inline `style` attribute is not.

A caution recorded on #113 applies directly here: while a Radix modal is open, the rest of the document is `aria-hidden`, so any `getByRole` locator behind it reports itself detached. Popover is non-modal by default, but any test that synchronises on an element disappearing near this menu needs checking.

### 5. Rendering 122 rows

Name is the primary text; description is clamped to a single line beside it. The list gets a max height and scrolls — with plain `overflow-y-auto`, since `scroll-area` remains ruled out (#113: it styles through an attribute, which no nonce covers).

## Files

- `src/utility/acp-session.ts` — handle the notification, emit the event
- `src/shared/acp-events.ts` — `AgentCommand`, the new event
- `src/shared/ws-protocol.ts` — commands on history, `API_VERSION` 1.3.0
- `src/server/session/thread-runtime.ts` — cache and expose
- `src/server/ws/ws-server.ts` — history response
- `src/web/chat-state.ts` — `availableCommands`, replace-on-update, reset on reconnect
- `src/web/components/command-menu.tsx` (new) and `composer.tsx`
- `test/fixtures/fake-agent-cli.mjs` — drive commands, including a mid-session change

## Testing

**Protocol seam**, real server and fake agent: commands reach the client; a mid-session update replaces the list rather than appending; an agent advertising none yields an empty list, not an error; history carries them for a client that connected late.

**Reducer**: replace-not-merge; cleared on a fresh `connecting`.

**Component**: `/` opens the menu; typing filters; a description too long to fit is clamped rather than wrapping the row; keyboard selection (story 42) and pointer selection both insert `/name `; the input hint is shown for a command that has one; no menu at all when the list is empty; `/foo bar` leaves the menu closed.

**Real browser**: the menu opens under the real CSP with **zero console violations** — the first Radix *popover* in this app, so #113's nonce is being exercised by a second, different component rather than only the one it shipped with.

**Audit harness** both viewports with new US-19 stories.

## Done when

- [ ] `pnpm typecheck` clean, `xvfb-run -a pnpm test` green, **and CI green on the PR**
- [ ] Full suite must not regress from 561/561 across 37 files
- [ ] Verified once against the real `claude-agent-acp`, not only the fixture
