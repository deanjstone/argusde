# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

**Planning stage.** This repo currently holds only the wayfinder map and its decision tickets — no application code yet. Read the map issue (linked below once charted) for current frontier state before assuming anything here is stale.

## Origin and destination-scoping decisions (locked 2026-08-11)

ArgusDE is a personal, full-control coding-agent desktop client — inspired by, but **not a git fork of**, either [T3 Code](https://github.com/pingdotgg/t3code) or [Orca ADE](https://github.com/stablyai/orca). Both were evaluated hands-on before this: the user runs an actively-maintained fork of T3 Code (`deanjstone/t3code`) day-to-day, and both T3 Code's and Orca's source trees were read directly to understand their architecture. A separate, unrelated evaluation (Hearth, a self-modifying Electron/Rust-Tauri agent client) concluded and was archived the same day — not a precursor to this project, though its self-mod-UI capability may inform future ArgusDE work.

Decisions locked via HITL grilling before charting:

- **Not a fork.** Standalone codebase, free to structurally diverge from both T3 and Orca (e.g. adopt Orca's worktree/fleet model without being constrained by T3's existing per-thread architecture, or vice versa).
- **Stack: Electron.** Matches both inspirations directly; avoids re-solving problems Hearth's Rust/Tauri port already had to work around (e.g. shelling out to a system Node for JS-only ACP adapters) for a project with a much larger target feature set than Hearth's.
- **Platform: desktop only for v1.** No mobile app, no remote/relay access yet — smallest real surface first, same sequencing Hearth used (local dev build before anything else).
- **Motivation: full control / no upstream dependency.** Not chasing a specific feature gap between T3 and Orca — the point is owning the whole stack outright, even where the resulting feature set ends up close to one of them.
- **MVP: T3-style single-agent chat first.** ACP-based chat with one provider (Claude Code) working end-to-end in ArgusDE's own Electron shell is the first real milestone. Orca-style multi-worktree/fleet orchestration is explicitly deferred past MVP, not built in parallel.

## Open / not yet resolved

- **Repo location is genuinely undecided.** This standalone repo (`deanjstone/argusde`) was created only as a placeholder to hold the wayfinder map and planning issues — it is **not** a commitment to staying standalone. The alternative (folding into the `argus` monorepo as `packages/argusde`, following the precedent `ccbot` set: standalone repo first, consolidated into `apps/ccbot` later) is still on the table and should be resolved as its own decision ticket before or during early implementation, not assumed either way.
- Everything below MVP scope (ACP client library choice vs. hand-rolled, IPC architecture, terminal backend, exact provider list beyond Claude Code, build/release tooling, branding/theming) is unresolved — see the map issue's frontier for current open tickets.
