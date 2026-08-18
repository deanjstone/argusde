# Phase 19: Image attachments end to end

> Implemented via `feature/image-attachments`, in progress. Ticket: [#119](https://github.com/deanjstone/argusde/issues/119). Spec: [#93](https://github.com/deanjstone/argusde/issues/93) phase 7 — the first of the composer cluster. Follows [phase 18](phase-18-changed-files.md).

## Context

> As a user on a phone, I want to attach a screenshot to a message, so that I can show the agent what I am looking at instead of describing it.

Stories 33–38. The composer is a plain text box while ACP already carries image content in both directions. The transcript can *render* an image block today (`content-block.tsx` has done so since phase 2) — there is simply no way to put one there. `API_VERSION` **1.1.0 → 1.2.0**: the command shape and the history response both gain a field.

## Verified before designing

Two things #93 flagged as unconfirmed, both checked against the real `claude-agent-acp` (v0.57.0) rather than assumed:

1. **The bridge advertises image support.** `initialize` returns `agentCapabilities.promptCapabilities: { image: true, embeddedContext: true }`. No `audio`. So the capability gate story 38 asks for has a real signal behind it.
2. **An image block actually reaches the model.** Prompted the live bridge with a generated 64×64 solid-magenta PNG and asked for one word; it answered `Magenta`. Wire frames were logged to confirm the block was sent as `{"type":"image","mimeType":"image/png","data":…}` and not silently stripped. Ran it in both block orderings (image-first and text-first) — both work. One run out of four returned `NO_IMAGE`; that was a flat-colour test image and model non-determinism, not a transport failure, since the same ordering succeeded on a repeat.

The SDK's own `prompt()` already accepts `string | ContentBlock | ContentBlock[]`, so #93's "sole narrowing point" is exactly where it says it is: `AcpSession.sendMessage`.

## Scope

**In:** image attachments end to end — pick, paste, thumbnail, remove, send, persist, replay — capability-gated with a stated reason when refused, and the composer migrated onto `input-group`/`attachment`.

**Out:** non-image attachments. #93 allows text resources as a fallback "if any land"; none do in this phase. No blob embedded resources (research #86's concern is moot here — nothing needs them). No slash commands, meter or plan panel: those are phases 8–10.

## Design

### 1. Capabilities travel the same road the mode catalog does

`promptCapabilities` is only ever available on the `initialize` response, exactly like the mode catalog is only available on session start. It gets the same treatment, which is already proven in this codebase:

- `AcpSession` captures it and emits `{ kind: "agent-capabilities", capabilities }`.
- `ThreadRuntime` keeps `lastKnownCapabilities` and `thread.get-history` returns it, so a client that connects after the event has passed still knows.
- Absent or malformed → every capability `false`, which reads as "this agent takes text only". Absent capability means absent affordance, matching #93's rule for the context meter.

### 2. Wire shape: `text` + `attachments`, not a block array

`thread.send-message` gains `attachments?: { mimeType, data }[]` rather than replacing `text: string` with a block array.

`AcpSession.sendMessage` **does** widen to content blocks — that is the narrowing point #93 names, and it is where the widening belongs. But the *command* is not the same seam: keeping `text` leaves a text-only message byte-identical on the wire, keeps every existing call site and test honest, and lets the schema say precisely what is attachable in this phase (images, nothing else) instead of accepting any block and validating after.

Only `image/png`, `image/jpeg`, `image/webp`, `image/gif` are accepted — Anthropic's supported set. Anything else is refused by name.

### 3. Refusal is server-authoritative and client-early

Story 38 forbids a silent drop. Both ends enforce:

- **Server** refuses a message carrying attachments when the thread's agent has not advertised `image`, and refuses an unsupported mime type or an over-cap image. This is the authoritative check — a client can be stale.
- **Client** refuses at attach time with the same reasons, so the user learns before composing a message around an image that was never going to arrive.

### 4. Size: downscale in the client, cap on both sides

A phone screenshot is 1080×2400 and 1–2 MB; a phone photo is several times that. Persisted verbatim into the events table, every one of those is replayed on every `thread.get-history` — over Tailscale, on the device the feature exists for.

So the client downscales to a **1568 px longest edge** (Anthropic downscales past that anyway, so nothing is lost) and re-encodes to JPEG when the source is over that bound or over the byte cap. Post-processing cap: **1 MiB per image, 4 images per message**, enforced independently by the server. An image that cannot be brought under the cap is refused with the reason, not truncated.

Re-encoding an animated GIF to JPEG drops the animation. Accepted: this is a screenshot-attachment feature, and the alternative is refusing large GIFs outright.

### 5. The user's own message carries the blocks (story 37)

`ThreadRuntime.sendMessage` persists the same `[{text}, ...images]` it sends, so `thread.message-recorded` already holds what the agent was given and replay needs no new path. `content-block.tsx` renders image blocks today, and the CSP already allows `img-src 'self' data:`.

**`blob:` is not in that CSP**, so `URL.createObjectURL` thumbnails would be silently blank. Thumbnails use the same `data:` URI as the send payload — one representation, no second encoding path, and no CSP surprise. (Same class of trap as phase 4's `scroll-area`.)

### 6. Component migration

The composer moves onto `input-group` (already installed) and `attachment` (registry `add`; its only dependency is `button`, and it uses `Slot` rather than a Radix overlay — so #113 does **not** gate this phase).

## Files

- `src/utility/acp-session.ts` — capture `promptCapabilities`; `sendMessage(blocks)`
- `src/shared/acp-events.ts` — `AgentPromptCapabilities`, the new event
- `src/shared/ws-protocol.ts` — `attachments` on the command, capabilities on history, `API_VERSION` 1.2.0
- `src/server/session/thread-runtime.ts` — capability cache, block assembly, persistence
- `src/server/ws/ws-server.ts` — validation and refusal
- `src/web/lib/image-attachment.ts` (new) — pure accept/refuse + target-size rules, and the browser encoder
- `src/web/components/composer.tsx` (new) — extracted from `chat-view.tsx`, which phases 8–10 all add to
- `src/web/App.tsx`, `src/web/chat-state.ts` — capabilities through the reducer
- `test/fixtures/fake-agent-cli.mjs` — configurable capabilities, and echo what it received

## Testing

**Pure seam:** accept/refuse decisions and target dimensions as a table — supported type, unsupported type, over-cap, at-cap, too many, needs-downscale, already-small. No canvas involved.

**Protocol seam**, real server and fake agent: an image reaches the agent (the fixture echoes what it received, so the assertion is on arrival, not on absence of error); a message with attachments to a text-only agent is refused with a reason naming the reason; an unsupported mime type is refused; an over-cap image is refused; history replays the image on the user's own message; capabilities appear in `thread.get-history`.

**Component seam:** attach shows a thumbnail; remove clears it; refusal renders its reason; send passes attachments to `onSend`; no attach control at all when the agent lacks the capability.

**Real browser** (`test/web-smoke.test.ts`): paste an image into the composer, see the thumbnail, send, and see it in the transcript — the one place the actual canvas encode path runs, and the only way story 34 is genuinely covered.

**Audit harness** both viewports with new US-18 stories for the composer's attached state.

## Done when

- [ ] `pnpm typecheck` clean, `xvfb-run -a pnpm test` green, **and CI green on the PR**
- [ ] Full suite must not regress from 490/490 across 34 files
- [ ] Verified once against the real `claude-agent-acp`, not only the fixture
