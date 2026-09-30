---
title: ADR-001 — ArgusDE supersedes code-relay as the remote agent console
status: accepted
date: 2026-09-30
---

# ADR-001: ArgusDE supersedes code-relay as the remote agent console

## Context

`CLAUDE.md` chartered ArgusDE as "desktop only for v1. No mobile app, no remote/relay access yet". The code moved past that. Spec [#33](https://github.com/deanjstone/argusde/issues/33), which follows the uplift's remote-access decision (#4, #13–15), made the standalone server and one shared web UI the architecture. Later phases built the remote surface on top of it:

- Tailscale serve with a startup QR code (`docs/plans/phase-3-tailscale-remote-access.md`, `src/server/remote/tailscale.ts`)
- PWA installability, "the PWA as the mobile answer" (`phase-10`)
- A phone-reachable terminal tab and an iOS soft-keyboard fix (#130, #132)

That work was never recorded against the charter, so the charter told agents to avoid work the repo was actively doing.

It also overlapped argus `apps/code-relay`, a "provider-agnostic PWA remote console for AI coding agents". There were now two mobile/remote agent consoles, and neither mentioned the other. The scope-creep audit raised this in [#135](https://github.com/deanjstone/argusde/issues/135) on 2026-09-28.

Three options were considered:
- ArgusDE supersedes code-relay.
- Both coexist, with ArgusDE limited to remote access for its own threads.
- ArgusDE narrows back to desktop and code-relay remains the remote answer.

## Decision

ArgusDE is the remote and mobile agent console. The v1 charter is amended from "desktop only" to "desktop first, with remote access to the same server over the tailnet and an installable PWA". Remote work continues here.

argus `apps/code-relay` is superseded. It takes no new feature work, and its README names ArgusDE as the successor. Retiring it (removing the package and its release track, after checking that nothing still depends on its Telegram bot) is tracked in [argus#450](https://github.com/deanjstone/argus/issues/450), not done by this ADR.

The reasons:
- ArgusDE already has the pieces a remote console needs, built on one server and one UI: live threads, terminal, checkpoints and plan panel.
- code-relay's provider-agnostic scope is the part ArgusDE deliberately does not chase ("not chasing a specific feature gap"). Two consoles would split the effort for no gain.

## Consequences

- The `CLAUDE.md` charter line changes in the same PR as this ADR, so agents stop treating remote/PWA work as out of scope.
- Remote access stays **tailnet-only**. The Tailscale phase uses `tailscale serve`, never `funnel`. Any future relay or public exposure would need its own decision.
- code-relay's capabilities that ArgusDE lacks (the herdr-scoped Telegram bot, and any provider other than Claude Code) are not ported by default. argus#450 decides whether any of them is still needed before code-relay is removed.
- Remote access is now a supported surface, so its security posture (auth on the served UI, the terminal tab's reach) is in scope for future reviews in a way it was not under the desktop-only charter.
