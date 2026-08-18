# ArgusDE UI/UX test regime — user stories

Long-lived source of truth for what an AFK (autonomous, unsupervised) UI/UX test pass
covers. Each story is independently verifiable and carries a stable ID (`US-<area>.<n>`)
so a test script, a GitHub issue, or a future session can reference it directly without
re-deriving scope.

This is a **QA/verification** document, not a product spec — it describes what must
still be true of the shipped app, not what to build. It's separate from and downstream
of the T3-parity uplift's own build-time user stories (spec [#33](https://github.com/deanjstone/argusde/issues/33)).

## Scope and tooling

Covers both client surfaces (Electron desktop, PWA/browser) at both desktop and mobile
viewport sizes, driven via Playwright (`chromium.launch()` for the PWA, `_electron` for
the desktop shell — matching this repo's existing `test/web-smoke.test.ts` and
`test/electron-smoke.test.ts` conventions). Each story should be checked with:

- **Functional pass**: the described behavior actually happens.
- **Accessibility pass** (`@axe-core/playwright`): no new violations introduced on the
  screen/state the story exercises.
- **Visual pass** (`pixelmatch`/`pngjs`): a screenshot of the state, diffed against a
  saved baseline once one exists, to catch unintended visual regressions.

**Known hard limit, stated once here rather than repeated per story:** headless
Playwright's device emulation uses a *fixed* viewport size. It does not reproduce a
real mobile browser's *dynamic* toolbar collapse/expand behavior — the exact mechanism
behind the `100vh`-vs-`100dvh` bug found 2026-08-15 (see
[`feedback_mobile_viewport_100vh_vs_100dvh`] in project memory). No automated tool can
close this gap; stories that depend on real dynamic-viewport behavior are marked
**[real-device-only]** below and are out of scope for the automated regime — they need
periodic real-phone verification instead.

## US-1: First-run and connection

- **US-1.1** — A brand-new install (no prior Thread, no `localStorage` entry) shows the
  `WorkspaceSetup` screen, not a blank or stuck-loading state, once the WebSocket
  connects.
- **US-1.2** — While the WebSocket is still connecting, a "Connecting…" state is shown,
  not a blank screen or the first-run form prematurely.
- **US-1.3** — If the WebSocket closes/errors after connecting, in-flight commands
  reject cleanly (visible error), not silently hang forever.
- **US-1.4** *(Electron only)* — Electron's native connect screen
  (`src/connect-screen/`) accepts a server URL, shows a clear error for an unreachable
  server, and successfully hands off to the shared web UI on a valid connection.
- **US-1.5** *(Electron only)* — An API-version mismatch between Electron's compiled-in
  `API_VERSION` and the server's reported version shows a clear "update needed" message
  (`src/main/version-check.ts`'s `incompatible` status), not a silent failure or a
  generic connection error.

## US-2: Choosing a workspace folder

- **US-2.1** — First-run defaults to the folder browser (`DirectoryBrowser`), not a bare
  text input — the browser's initial listing is the *server's* home directory and loads
  without an indefinite spinner.
- **US-2.2** — Clicking a listed subfolder navigates into it and lists *its*
  subdirectories; clicking "Up" navigates to the parent. "Up" is disabled exactly at the
  filesystem root.
- **US-2.3** — Dotfiles/dot-directories and plain files never appear as browsable
  entries — directories only.
- **US-2.4** — "or type a path manually" reveals a plain text path input as a fallback,
  and this path is still fully functional end-to-end (not a vestigial dead control).
- **US-2.5** — Selecting a folder that **is** a git repository successfully creates a
  Project and Thread and lands in the Chat tab with an empty conversation.
- **US-2.6** — Selecting a folder that **is not** a git repository fails with a clearly
  visible error message on the *current* screen (not silently, not only inside a Chat
  tab the user never reaches) — regression coverage for the 2026-08-15 silent-failure
  bug.
- **US-2.7** — The same browse/manual/error behavior (US-2.1–2.6) holds identically in
  `ProjectPicker`'s "+ New project" form, not just first-run `WorkspaceSetup`.
- **US-2.8** — Re-selecting a workspace root that already has a Project is idempotent —
  it does not create a duplicate Project.

## US-3: Projects and Threads navigation

- **US-3.1** — The Threads tab, with no project selected, lists every existing Project
  by title; with zero Projects, shows an empty-state message, not a blank area.
- **US-3.2** — Selecting a Project drills into its Thread list; "Back" returns to the
  Project list without losing state.
- **US-3.3** — Selecting an existing Thread loads its real persisted history (not
  another Thread's) and lands on the Chat tab.
- **US-3.4** — A closed Thread is visibly marked "closed" in the Thread list, and its
  history remains browsable (read-only) after selecting it.
- **US-3.5** — Switching between the Chat/Threads/Settings tabs never loses the
  currently-active Thread's state — returning to Chat shows the same conversation, not
  a reset.

## US-4: Chat — sending messages and live updates

- **US-4.1** — Typing a message and pressing Enter (or tapping Send) sends it, clears
  the input, and the message appears in the timeline immediately (optimistic), before
  any agent reply.
- **US-4.2** — A streamed agent reply renders incrementally (message chunks merge into
  one bubble, not one bubble per chunk) and settles into a final complete message on
  turn-complete.
- **US-4.3** — The connection-state banner (top of ChatView) shows the real live state
  (`connecting`/`connected`/`error`) and, on error, the actual error text — not just
  while the app first opens but any time the underlying agent connection drops mid-use.
- **US-4.4** — Sending is disabled while a Thread is closed, with a visible "This thread
  is closed" notice — not a silently-ignored tap.
- **US-4.5** — A tool-call / plan / other non-message timeline item renders with a
  legible title and status, not a raw/undecoded blob.
- **US-4.6** — A permission request pauses the flow with a clearly visible prompt and
  distinct option buttons; selecting an option resolves it and the conversation
  continues without a stuck/duplicate prompt.

## US-5: Checkpoints — timeline, diff, revert

- **US-5.1** — The checkpoint strip appears once at least a turn-0 baseline exists, and
  never for a Thread with only one checkpoint and no turns yet in a way that misleads
  (bare "Start" marker only, no false "Turn" buttons).
- **US-5.2** — Turn numbers in the strip are 1:1 with real completed turns, including a
  turn that made no on-disk changes.
- **US-5.3** — Selecting a turn shows a real diff of exactly that turn's change; "Since
  start" shows the cumulative diff from turn 0 to the latest turn.
- **US-5.4** — The diff view's loading and error states are both visibly distinct from
  its "has content" state — a failed diff fetch never looks identical to "no changes."
- **US-5.5.confirm** — Reverting asks before it overwrites anything. The confirmation is a
  real modal dialog (`alert-dialog`), which is also what proves the CSP nonce works: a Radix
  overlay's scroll lock injects a `<style>` element, and without the nonce it would log a
  violation the regime's zero-console-errors gate fails on ([argusde#113](https://github.com/deanjstone/argusde/issues/113)).
- **US-5.5** — Reverting to an earlier checkpoint actually rewrites the working tree
  (verifiable via a real file's on-disk content), closes the diff panel on success, and
  the strip shows two new checkpoints (an unmarked safety snapshot, then the marked
  revert) — never silently discards state.
- **US-5.6** — A revert attempted while a turn is still in flight is rejected with a
  clear message, not silently ignored or allowed to corrupt state.

## US-6: Worktree promotion

- **US-6.1** — "Promote to worktree" is visible only before any message has been sent in
  a Thread, and disappears once the first message is sent.
- **US-6.2** — Promoting shows a `Promoting…` in-flight state, then a visible amber
  "Running in an isolated worktree" badge plus a colored border around the whole Chat
  view once complete.
- **US-6.3** — A file edit made in a promoted Thread lands in the worktree, not the
  Project's main workspace — independently verifiable on disk.
- **US-6.4** — Promoting a second time, or after a message was already sent, is rejected
  with a clear error, not a silent no-op or a duplicate worktree.

## US-7: Mode switching

- **US-7.1** — The mode switcher is entirely absent when the connected agent advertises
  no modes — no empty/broken dropdown.
- **US-7.2** — When modes exist, the dropdown shows the real current mode selected;
  changing it round-trips to the agent and the UI reflects the confirmed new mode, not
  an optimistic guess that could silently revert.
- **US-7.3** — A mid-session autonomous mode change (agent-driven, not user-driven) is
  reflected in the UI live, without needing a manual refresh.

## US-8: Closing a Thread

- **US-8.1** — "Close thread" is visible only for an open Thread with an active runtime,
  shows a `Closing…` in-flight state, and afterward: the message input is disabled, the
  "closed" notice is visible, and the app lands back on the Threads tab.
- **US-8.2** — Closing a *promoted* Thread actually removes its worktree directory from
  disk (independently verifiable), not just marks it closed in the UI.
- **US-8.3** — After closing, the Thread's history is still browsable read-only via the
  Threads tab — closing never deletes history.
- **US-8.4** — Attempting to close an already-closed Thread is rejected cleanly, not
  a crash or a silent double-teardown.

## US-9: Settings tab

- **US-9.1** — The Settings tab shows the real connected server's API version and the
  current Thread's ID (when one is active) — never a blank/placeholder value while
  actually connected.

## US-10: PWA installability [real-device-only for the install prompt itself]

- **US-10.1** — `manifest.json` is linked and fetchable, with valid icon references — a
  browser's install-eligibility check can actually resolve it.
- **US-10.2** — The service worker registers and activates without error, and is
  deliberately non-caching (a reload always fetches fresh content, never a stale
  cached shell) — see the PWA phase's own design decision.
- **US-10.3** *(real-device-only)* — On a real phone browser, the "Add to Home Screen" /
  install affordance actually appears and results in a standalone-mode launch.

## US-11: Remote access (Tailscale) [real-device-only for the network path itself]

- **US-11.1** — `argusde serve`'s startup output includes both a scannable QR code and
  the plain-text MagicDNS HTTPS URL.
- **US-11.2** — The server only wires Tailscale when bound to `127.0.0.1`/`localhost` —
  a non-default `--host` skips Tailscale wiring rather than failing confusingly.
- **US-11.3** *(real-device-only)* — A device on the same tailnet (not the host machine)
  can reach the app over the printed URL and complete a full first-run + chat round
  trip — this is the story that actually caught both real bugs fixed 2026-08-15, and
  cannot be replaced by same-machine `127.0.0.1` testing.

## US-12: Responsiveness and layout [several sub-items real-device-only]

- **US-12.1** — At a mobile viewport size, the bottom Chat/Threads/Settings tab bar is
  always fully visible, never scrolled off or overlapping content.
- **US-12.2** *(real-device-only)* — On a real mobile browser with a collapsing toolbar,
  the tab bar stays visible as the toolbar shows/hides during scroll — the specific
  class of bug `100dvh` fixed; a fixed-viewport headless check cannot verify this, only
  confirm the CSS property is in use.
- **US-12.3** — No horizontal scrollbar or clipped content appears at common mobile
  widths (360–430px) on any of the app's screens.
- **US-12.4** — At a desktop viewport size, layouts remain usable and are not just a
  stretched mobile layout with excess whitespace.

## US-13: Accessibility

- **US-13.1** — Every interactive control (buttons, inputs, the mode-switcher select)
  has an accessible name — either visible text or an explicit `aria-label` — verifiable
  by `@axe-core/playwright`'s automated scan on every screen in this document.
- **US-13.2** — Color contrast meets WCAG AA on all text/background combinations the
  dark theme uses, including status text (error red, amber warnings, violet accents).
- **US-13.3** — The whole primary flow (browse a folder → create a project → send a
  message → view a diff → revert) is operable via keyboard alone (Tab/Enter/Space), not
  just pointer/touch.
- **US-13.4** — Focus order through the Chat/Threads/Settings tab bar and each screen's
  primary controls is logical, not jumping unpredictably.

## US-14: Error and edge states

- **US-14.1** — Every async action with a failure mode (project create, thread create,
  send message, promote, revert, close, mode switch, directory listing) has a distinct,
  visible failure UI — never a silent no-op indistinguishable from success.
- **US-14.2** — A malformed or unreachable server URL (Electron connect screen) never
  crashes the app — always resolves to a clear error state.
- **US-14.3** — Rapid repeated taps on an async action (e.g. double-tapping "Select this
  folder" or "Send") never produce duplicate Projects/Threads/messages.

---

## Traceability

A future automated run (or manual QA pass) should report results keyed by story ID
(`US-2.6: PASS`, `US-12.2: SKIPPED — real-device-only`, etc.) so gaps and regressions
are diffable across runs, not just narrated in prose. Findings that require a fix
follow this repo's standard convention: a dedicated branch + PR for anything fixed
immediately, or a filed GitHub issue (tagged with the story ID) for anything deferred.

## US-15: Working tree — browsing and preview

Added with spec [#93](https://github.com/deanjstone/argusde/issues/93) phase 4, which made the
Thread's working tree readable in-app.

- **US-15.1** — With a Thread active, the Files tab lists that Thread's working tree — the
  Worktree when it has one, the Project's workspace root otherwise — including files and
  dotfiles, not just directories.
- **US-15.2** — `.git` never appears in the browser. It is machinery rather than content, and
  it sorts first alphabetically, so a regression puts loose objects at the top of the tree.
- **US-15.3** — Opening a text file renders its contents with syntax highlighting, resolved
  server-side and coloured from the theme's tokens.
- **US-15.4** — The bottom tab bar stays reachable in both the tree and the preview state, and
  at mobile width there is an explicit control back to the tree from an open file.
- **US-15.5** — Neither state introduces horizontal page scroll at mobile width.

## US-16: Working tree — search

Added with spec [#93](https://github.com/deanjstone/argusde/issues/93) phase 5.

- **US-16.1** — Searching the Thread's working tree settles into either grouped results or an
  explicit "no matches" state, never an indefinite spinner. The two must be distinguishable —
  a search that found nothing has to say so.
- **US-16.2** — Clicking a result opens that file in the preview with the matching line marked,
  so a result leads somewhere rather than merely reporting a location.
- **US-16.3** — Neither the results list nor an opened match introduces horizontal page scroll
  at mobile width.

## US-17: Working tree — changed files and per-file diffs

Added with spec [#93](https://github.com/deanjstone/argusde/issues/93) phase 6. Distinct from
US-5 (Checkpoints), deliberately: those answer *"what changed between two Turns"*, these answer
*"what has changed right now"*, and the two must never be confused.

- **US-17.1** — The Changes view lists what is currently changed in the Thread's working tree,
  each entry labelled with how it changed.
- **US-17.2** — The branch the working tree is on is shown; a detached worktree reads as
  *detached* rather than as a branch named "HEAD". Exactly one of the two states appears.
- **US-17.3** — Selecting a changed file opens its diff against the live working tree — including
  for an untracked file, which `git diff HEAD` alone returns nothing for.
- **US-17.4** — Neither the list nor an open diff introduces horizontal page scroll at mobile
  width.

## US-18: Composer — image attachments

Added with spec [#93](https://github.com/deanjstone/argusde/issues/93) phase 7, which let the
composer carry image attachments alongside text.

- **US-18.1** — With an agent that advertises image support, attaching a supported image shows a
  thumbnail in the attachment strip, labelled with the file's own name.
- **US-18.2** — Each thumbnail's `Remove <filename>` control takes just that attachment back out
  of the strip; the strip itself disappears once the last attachment is removed.
- **US-18.3** — An attachment the agent side will refuse (unsupported type, oversized, over the
  per-message limit, or an agent that doesn't accept images) shows the refusal reason in a
  `role="alert"` message — never a silent drop.
- **US-18.4** — Neither the attached nor the refused state introduces horizontal page scroll at
  mobile width.

## US-19: Composer — slash-command menu

Added with spec [#93](https://github.com/deanjstone/argusde/issues/93) phase 8, which let the
composer surface the connected agent's own slash commands.

- **US-19.1** — Typing `/` in the composer, with no whitespace after it, opens a menu of the
  agent's commands, each row showing the command's name, a truncated description, and — when the
  command defines one — an italic input hint. An agent that advertises no commands opens no menu
  at all; there is no empty state to see.
- **US-19.2** — Typing more after the `/` narrows the menu to commands whose name or description
  matches what was typed so far.
- **US-19.3** — Clicking a row puts `/name ` in the composer, caret ready for an argument, and
  closes the menu.
- **US-19.5** — The menu is navigable by keyboard as well as by pointer: arrow keys move the
  highlight (wrapping at both ends) and Enter picks the highlighted command rather than sending
  the half-typed name as a message.
- **US-19.4** — The open menu introduces no horizontal page scroll at mobile width.

## US-20: Context meter

Added with spec [#93](https://github.com/deanjstone/argusde/issues/93) phase 9, which surfaced
the agent's own context-window occupancy directly above the composer.

- **US-20.1** — Before the agent has reported any usage, no meter renders at all — no row, no
  bar, nothing at zero. This is also the state of a freshly reopened Thread, whose new session
  starts with an empty context and has not yet reported: absence is the honest statement that
  nothing has been reported, where a 0% bar would be a claim about the context that isn't true.
- **US-20.2** — Once the agent reports usage mid-turn, a compact meter appears in a right-aligned
  row directly above the composer: a progress bar plus a percentage label, both reflecting the
  reported figures. A tooltip on the meter repeats the full used/of/total figures, for the case a
  percentage alone isn't precise enough.
- **US-20.3** — The meter's appearance changes as usage climbs into the higher-pressure bands —
  a distinct look once usage crosses into "warning" and again into "pressure" territory — so the
  same 25%-full bar and a nearly-full one are never visually indistinguishable.
- **US-20.4** — Neither an absent nor a shown meter introduces horizontal page scroll at mobile
  width.

## US-21: Plan panel

Added with spec [#93](https://github.com/deanjstone/argusde/issues/93) phase 10, which surfaced
the agent's own plan as a pill directly above the composer (and above the context-meter row) that
expands into the full step list.

- **US-21.1** — Before the agent has ever reported a plan, no pill renders at all — no row, no
  collapsed placeholder waiting at zero. This is also the state of a freshly reopened Thread,
  whose new session has not yet reported a plan of its own.
- **US-21.2** — Once the agent reports a plan mid-turn, a pill appears showing a `completed/total`
  count (e.g. `1/3`), a small progress bar, and — as its label — the content of whichever step is
  currently `in_progress`.
- **US-21.3** — Clicking the pill expands an ordered list of every step in the plan; each step is
  distinguishable by status (`completed` | `in_progress` | `pending`) rather than all reading
  identically.
- **US-21.4** — Clicking the same pill again collapses the list back down — one control drives
  both directions, not a separate close affordance.
- **US-21.5** — The expanded panel never covers the composer or the bottom tab bar: it grows
  upward into space the transcript gives up, and its bounding box never vertically overlaps
  either the composer's message input or the tab bar's, checked by comparing their real
  `getBoundingClientRect()` geometry rather than inferred from a screenshot. This is the reason
  the panel is a collapsible rather than a modal drawer.
- **US-21.6** — Neither the collapsed pill nor the expanded panel introduces horizontal page
  scroll at mobile width.
