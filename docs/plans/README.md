# Plans

Implementation plans produced via Claude Code's plan mode (`EnterPlanMode`/`ExitPlanMode`) for non-trivial work in this repo, kept here for history — not just in the local `~/.claude/plans/` scratch file, which isn't checked in and gets overwritten by the next plan.

Each file is the plan as approved before implementation started, with an `## Outcome` section appended once the work lands, noting anything that changed from the plan (bugs found in review, scope adjustments, etc.).

Current sequence — the T3-Code-parity uplift ([spec #33](https://github.com/deanjstone/argusde/issues/33)):

- [Phase 1: server foundation](phase-1-server-foundation.md) — event-sourced persistence, checkpoints, WebSocket API. Merged [#34](https://github.com/deanjstone/argusde/pull/34).
- [Phase 2: shared web UI](phase-2-shared-web-ui.md) — server-served UI, functional parity chat in a browser. Merged [#37](https://github.com/deanjstone/argusde/pull/37).
- [Phase 2b: Electron cutover](phase-2b-electron-cutover.md) — Electron loads the shared UI via loadURL, retires the old renderer/IPC path. Merged [#38](https://github.com/deanjstone/argusde/pull/38).
- [Phase 3: Tailscale serve + startup QR code](phase-3-tailscale-remote-access.md) — `argusde serve` wires up `tailscale serve` and prints a scannable QR code on startup. Merged [#40](https://github.com/deanjstone/argusde/pull/40).
- [Phase 4: Checkpoint diff + timeline UI](phase-4-checkpoint-diff-ui.md) — surfaces checkpoint diffing and a timeline strip in the chat view. Merged [#42](https://github.com/deanjstone/argusde/pull/42).
- [Phase 5: Mode switcher UI](phase-5-mode-switcher-ui.md) — surfaces the agent's mode catalog and lets the user switch modes from the chat view. Merged [#43](https://github.com/deanjstone/argusde/pull/43).
- [Phase 6: Version compatibility handshake](phase-6-version-handshake.md) — Electron's native shell refuses to connect to an incompatible server, showing a clear update message. Merged [#44](https://github.com/deanjstone/argusde/pull/44).
- [Phase 7: Worktree promotion UI](phase-7-worktree-promotion.md) — promote a fresh Thread to an isolated git worktree, with a colored-border indicator. Merged [#45](https://github.com/deanjstone/argusde/pull/45).
- [Phase 8: Multi-project UI](phase-8-multi-project-ui.md) — real Projects→Threads drill-down, switching the active chat between existing Threads. Merged [#48](https://github.com/deanjstone/argusde/pull/48).
- [Phase 9: Checkpoint revert](phase-9-checkpoint-revert.md) — restore a Thread's workspace to an earlier checkpoint, captured forward as a new checkpoint rather than truncating history. Merged [#49](https://github.com/deanjstone/argusde/pull/49).
- [Phase 10: PWA installability](phase-10-pwa-installability.md) — manifest, icons, and a deliberately non-caching service worker so the shared web UI can be installed on a phone. Merged [#50](https://github.com/deanjstone/argusde/pull/50).
- [Phase 11: Thread close + worktree auto-cleanup](phase-11-thread-close.md) — close a Thread, tear down its live session, and clean up its worktree from disk. Merged [#51](https://github.com/deanjstone/argusde/pull/51).
- [Phase 12: Resume most-recently-active Thread across reload](phase-12-resume-last-thread.md) — remember the last-active Thread in localStorage, skip first-run setup on a reload. Merged [#52](https://github.com/deanjstone/argusde/pull/52).

Next sequence — the daily-driver uplift ([spec #93](https://github.com/deanjstone/argusde/issues/93)), whose own phase numbering starts fresh at 0; files here keep this directory's running count:

- [Phase 13: Durable activity](phase-13-durable-activity.md) — spec #93 phase 1. Tool calls recorded as domain events and replayed from history, so reopening a Thread shows what the agent did, not only what it said.
- [Phase 14: Activity rendering in the timeline](phase-14-activity-timeline-ui.md) — spec #93 phase 2. The visible half: activity cards with truncation and expand, the pre-feature notice, and the chat transcript migrated onto real shadcn primitives and theme tokens.
- [Phase 15: Branch-backed worktrees](phase-15-branch-backed-worktrees.md) — spec #93 phase 3. A promoted Thread's worktree is created on a real branch, so commits the agent makes in it survive the Thread being closed.
- [Phase 16: File browser and file preview](phase-16-file-browser.md) — spec #93 phase 4. Browse and read the Thread's working tree in-app, with server-side syntax highlighting and path containment enforced in one place.
- [Phase 17: Workspace search](phase-17-workspace-search.md) — spec #93 phase 5. `git grep` over the Thread's working tree, grouped results with every cap reported, and a result that opens the file at its matching line.
- [Phase 18: Changed files and per-file diffs](phase-18-changed-files.md) — spec #93 phase 6. What is changed in the working tree right now, with per-file diffs against it, kept deliberately distinct from Checkpoint diffing.
- [Phase 19: Image attachments](phase-19-image-attachments.md) — spec #93 phase 7. Attach, send, persist and replay images on a message, capability-gated against what the agent actually advertised.
- [Phase 20: Slash-command menu](phase-20-slash-commands.md) — spec #93 phase 8. Discover and insert the agent's own advertised commands from a `/` menu in the composer, filtered and replayed the same way the mode catalog is.
- [Phase 21: Context meter](phase-21-context-meter.md) — spec #93 phase 9. A compact, live-updating meter of the agent session's context usage in the composer, never persisted across a reconnect.
