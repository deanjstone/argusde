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
- [Phase 6: Version compatibility handshake](phase-6-version-handshake.md) — Electron's native shell refuses to connect to an incompatible server, showing a clear update message. In progress on `feature/version-handshake`.
