# ArgusDE Domain Glossary

Vocabulary adopted for the T3-Code-parity uplift (see wayfinder map: ArgusDE → T3 Code feature parity). Scoped to a single provider (Claude Code) — no multi-provider abstraction.

## Project and workspace

**Project** — the top-level workspace record. Has a `workspaceRoot` (base filesystem path), a title, and one or more Threads.

**Thread** — the durable unit of a single conversation and its workspace history within a Project. Holds messages, activities, and Checkpoints. Replaces the MVP's single implicit chat session — a Project can hold several concurrent Threads.

**Worktree** — a git worktree used as an isolated workspace for a Thread. A Thread with a worktree runs there instead of in the Project's main working tree; a Thread without one runs in the main working tree directly.

## Thread timeline

**Turn** — one user-to-assistant work cycle inside a Thread: starts at user input, ends when follow-up work (e.g. checkpointing) settles.

**Activity** — a user-visible log item attached to a Thread for non-message events (approvals, tool actions, failures). Durable since spec #93 phase 1: each one is recorded as a `thread.activity-recorded` event and projected into its own table, so reopening a Thread replays what the agent did and not only what it said. Currently one per ACP tool call, keyed by the tool call's own id so its later updates merge onto the same Activity.

**Sequence** — the per-Thread ordering key shared by messages and Activities, assigned when an item *began* rather than when it was persisted. It is what lets history replay merge the two into one narrative: an agent's reply is only persisted once its Turn completes, after every tool call in that Turn, so persistence order alone would replay a Turn as "said everything, then did everything".

## Checkpointing

**Checkpoint** — a saved snapshot of a Thread's workspace at a particular Turn, enabling diff-against-earlier-turn and revert. Storage mechanism (e.g. hidden git ref, as in T3) is not yet decided for ArgusDE.

**Checkpoint diff** — the patch between two Checkpoints for a Thread.

## Remote access

**Serve mode** — running ArgusDE's backend reachable from another device (as opposed to a purely local single-machine Electron app). Exact process-architecture shape (Electron-native vs a split server process) is not yet decided.

**Pairing** — the flow by which a remote client (PWA, another ArgusDE instance) authenticates to and connects with a running Serve-mode instance.

## Open naming questions

- Whether ArgusDE keeps "Project"/"Thread" as user-facing terms or renames them is not yet decided — parked as fog, not blocking.
