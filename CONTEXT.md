# ArgusDE Domain Glossary

Vocabulary adopted for the T3-Code-parity uplift (see wayfinder map: ArgusDE → T3 Code feature parity). Scoped to a single provider (Claude Code) — no multi-provider abstraction.

## Project and workspace

**Project** — the top-level workspace record. Has a `workspaceRoot` (base filesystem path), a title, and one or more Threads.

**Thread** — the durable unit of a single conversation and its workspace history within a Project. Holds messages, activities, and Checkpoints. Replaces the MVP's single implicit chat session — a Project can hold several concurrent Threads.

**Worktree** — a git worktree used as an isolated workspace for a Thread. A Thread with a worktree runs there instead of in the Project's main working tree; a Thread without one runs in the main working tree directly. Created on a real branch, `argusde/thread-<threadId>`, since spec #93 phase 3 — the branch outlives the Worktree, so closing a Thread never discards commits the agent made in it. Worktrees promoted before that change are on a detached HEAD and have no branch; nothing rewrites them, so the branch a Worktree is on must be read from git rather than derived from the Thread id.

**Working tree** — the directory a Thread's agent actually operates in: its Worktree when it has one, the Project's `workspaceRoot` otherwise. User-facing since spec #93 phase 4, which made it browsable and readable in-app. Every working-tree command is Thread-scoped and every path in one is *relative to the working tree*, so a client never holds — or can ask for — an absolute server path.

**Changed files** — what differs between a Thread's working tree and its last commit *right now*, with a change kind per entry (added, modified, deleted, renamed, untracked). User-facing since spec #93 phase 6. Deliberately distinct from a **Checkpoint diff**, which compares two Turns: the two answer different questions and the UI keeps them apart.

## Thread timeline

**Turn** — one user-to-assistant work cycle inside a Thread: starts at user input, ends when follow-up work (e.g. checkpointing) settles.

**Activity** — a user-visible log item attached to a Thread for non-message events (approvals, tool actions, failures). Durable since spec #93 phase 1: each one is recorded as a `thread.activity-recorded` event and projected into its own table, so reopening a Thread replays what the agent did and not only what it said. Currently one per ACP tool call, keyed by the tool call's own id so its later updates merge onto the same Activity.

**Sequence** — the per-Thread ordering key shared by messages and Activities, assigned when an item *began* rather than when it was persisted. It is what lets history replay merge the two into one narrative: an agent's reply is only persisted once its Turn completes, after every tool call in that Turn, so persistence order alone would replay a Turn as "said everything, then did everything".

## Composer

**Attachment** — an image sent alongside a user message's text; images are the only attachable content. Offered only when the connected agent advertised `promptCapabilities.image` at ACP `initialize` — absent or malformed capabilities read as "text only", and a message carrying attachments is refused with a stated reason when the agent hasn't advertised the capability, never silently dropped. Since spec #93 phase 7: the client downscales the image to a 1568px longest edge and caps it at 1 MiB, at most 4 per message, because it is persisted verbatim onto the user's own message and replayed on every history load — so reopening a Thread shows what the agent was actually given, not a placeholder.

**Command** — one entry in the agent's own advertised command list, reached by typing `/` in the composer. Discovery only: ArgusDE never executes a command itself. Picking one inserts `/name ` into the composer and the user sends it as an ordinary message; the *agent* parses the leading slash — verified against the real `claude-agent-acp`, which answers an unknown command with `Unknown command: …` rather than as prose. The list arrives as an unprompted ACP session notification after session start, is cached on the Thread's runtime, and is replayed by `thread.get-history` — the same road the mode catalog and prompt capabilities take. It can arrive again mid-session, and a later list *replaces* the previous one rather than merging, so a command the agent dropped stops being offered. An agent that advertises none gets no menu at all. Since spec #93 phase 8.

## Checkpointing

**Checkpoint** — a saved snapshot of a Thread's workspace at a particular Turn, enabling diff-against-earlier-turn and revert. Storage mechanism (e.g. hidden git ref, as in T3) is not yet decided for ArgusDE.

**Checkpoint diff** — the patch between two Checkpoints for a Thread.

## Remote access

**Serve mode** — running ArgusDE's backend reachable from another device (as opposed to a purely local single-machine Electron app). Exact process-architecture shape (Electron-native vs a split server process) is not yet decided.

**Pairing** — the flow by which a remote client (PWA, another ArgusDE instance) authenticates to and connects with a running Serve-mode instance.

## Open naming questions

- Whether ArgusDE keeps "Project"/"Thread" as user-facing terms or renames them is not yet decided — parked as fog, not blocking.
