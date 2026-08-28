# Phase 25: Terminal output as agent context

> Implemented via `feature/terminal-capture`. Ticket: [#128](https://github.com/deanjstone/argusde/issues/128) phase 3 — the last phase of the terminal spec. Follows [phase 24](phase-24-terminal-tab.md).

## Context

> As a user, I want to hand a command's output to the agent in one gesture, so that showing it a failure does not mean select-copy-paste on a phone.

Stories 23–28. The quieter half of #88's decision: a terminal that only ran commands would compete with the agent, and this is what makes it feed the agent instead.

**No protocol change** — `API_VERSION` stays **1.6.0**. The emulator already holds the text, so capture is entirely client-side and there is nothing to ask the server for. The phase-1 protocol sketch listed a `capture` command; it turned out not to be needed, and adding one would have meant a round trip to fetch text the browser was already holding.

## Design

### 1. Two explicit gestures, never one that decides

*Send output to agent* takes the terminal's recent output; *Send selection* takes what is highlighted. Story 28 forbids guessing, and there is a concrete reason it would have to guess: without shell integration (OSC 133 prompt marks) a terminal genuinely cannot know where the last command began. "Recent output" is what the buffer can honestly offer, and the user picks which gesture they meant. A capture gesture with nothing behind it says so rather than falling back to the other one.

### 2. One gesture end to end

Capturing sets the chip on the composer *and* switches to the Chat tab. The alternative — leaving a chip waiting on a tab you would have to remember — is not one gesture, it is two with a delay in between.

### 3. Bounded, and truncation stated twice

400 lines and 16 KiB, keeping the tail: the end of a log is the part that says what went wrong. When it truncates, the chip says so and *the message the agent receives says so* — otherwise the agent reasons about "the whole output" while holding a fragment, which is worse than being given less.

### 4. It travels as message text

A fenced block under the user's own words, sent through the existing `thread.send-message`. That is what puts it on the user's own message in the transcript (story 26) with no new persistence path and nothing to replay specially on history load.

The fence is grown longer than the longest backtick run inside the captured text. Terminal output routinely contains backticks — a README being catted, a shell error quoting a command — and a fixed three-backtick fence would close the block early and leak the rest of the log into the message as prose.

## Files

- `src/web/lib/terminal-capture.ts` (new) — bounds, normalisation, and the message format
- `src/web/lib/xterm-terminal.ts` — `getSelection()` and `readRecentOutput()` on the handle
- `src/web/components/terminal-view.tsx` — the two capture controls and the empty-capture note
- `src/web/components/composer.tsx` — the removable chip, and formatting on send
- `src/web/components/chat-view.tsx`, `src/web/App.tsx` — the capture crossing from one tab to the other
- `docs/testing/ui-ux-user-stories.md`, `scripts/ui-ux-audit/run.mjs` — US-23

## Testing

**Unit**: tail-keeping at both caps, blank-tail trimming, empty captures reported as empty, the fenced format, the truncation notice in the message, and the grown fence — asserted by splitting the message on the fence and expecting exactly three parts.

**Component**: the terminal view's two gestures and its refusal to substitute one for the other; the composer's chip, its label and line count, sending with and without words, the truncation notice reaching the message, removal, and clearing after a send.

**Real browser**: the whole crossing — run a command, capture it, land on the composer, send with a question, and read both the question and the captured line back off the transcript, then confirm the chip is gone. This test **caught a real bug**: the capture was reaching `App` but not being passed down to `ChatView`, so the chip never rendered. The component suites were green throughout — only the end-to-end path could see it.

**Audit harness**: US-23.1–23.5 at both viewports, with an axe scan on the composer carrying a chip. US-23.6 (a gesture with nothing behind it) stays in the component suite: provoking an empty selection in a driven browser is less reliable than asserting it directly.

## Done when

- [x] `pnpm typecheck` clean, `xvfb-run -a pnpm test` green
- [x] Suite does not regress from 686/686 across 43 files — now **707/707 across 44**
- [x] Audit green at both viewports: **185/0 desktop, 173/0 mobile**
- [ ] CI green on the PR
- [ ] Real-phone pass over Tailscale — still outstanding from phase 24 (US-22.8), and worth doing on this flow too, since "select-copy-paste on a phone" is the thing this phase exists to replace
