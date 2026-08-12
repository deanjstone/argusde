# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

**MVP implemented and merged.** ArgusDE is a working Electron app: T3-style single-agent ACP chat with Claude Code, verified end-to-end against the real `claude-agent-acp` bridge (not just tests). Built per [spec #9](https://github.com/deanjstone/argusde/issues/9), landed via [PR #11](https://github.com/deanjstone/argusde/pull/11). See `src/` for the actual implementation: `AcpSession` (utility process), the IPC relay through main, and the chat-state reducer + React UI in the renderer.

## Origin and destination-scoping decisions (locked 2026-08-11)

ArgusDE is a personal, full-control coding-agent desktop client — inspired by, but **not a git fork of**, either [T3 Code](https://github.com/pingdotgg/t3code) or [Orca ADE](https://github.com/stablyai/orca). Both were evaluated hands-on before this: the user runs an actively-maintained fork of T3 Code (`deanjstone/t3code`) day-to-day, and both T3 Code's and Orca's source trees were read directly to understand their architecture. A separate, unrelated evaluation (Hearth, a self-modifying Electron/Rust-Tauri agent client) concluded and was archived the same day — not a precursor to this project, though its self-mod-UI capability may inform future ArgusDE work.

Decisions locked via HITL grilling before charting:

- **Not a fork.** Standalone codebase, free to structurally diverge from both T3 and Orca (e.g. adopt Orca's worktree/fleet model without being constrained by T3's existing per-thread architecture, or vice versa).
- **Stack: Electron.** Matches both inspirations directly; avoids re-solving problems Hearth's Rust/Tauri port already had to work around (e.g. shelling out to a system Node for JS-only ACP adapters) for a project with a much larger target feature set than Hearth's.
- **Platform: desktop only for v1.** No mobile app, no remote/relay access yet — smallest real surface first, same sequencing Hearth used (local dev build before anything else).
- **Motivation: full control / no upstream dependency.** Not chasing a specific feature gap between T3 and Orca — the point is owning the whole stack outright, even where the resulting feature set ends up close to one of them.
- **MVP: T3-style single-agent chat first.** ACP-based chat with one provider (Claude Code) working end-to-end in ArgusDE's own Electron shell is the first real milestone. Orca-style multi-worktree/fleet orchestration is explicitly deferred past MVP, not built in parallel.

## Repo location (locked 2026-08-11)

ArgusDE stays a **standalone repo** (`deanjstone/argusde`) — it does not fold into the `argus` monorepo as `packages/argusde`. Resolved via the wayfinder map's first decision ticket ([argusde#2](https://github.com/deanjstone/argusde/issues/2)); no longer open fog.

## Claude Code integration (locked 2026-08-12)

ArgusDE talks to Claude Code by spawning **`claude-agent-acp`** (npm: `@agentclientprotocol/claude-agent-acp`), not `claude` itself — `claude` has no ACP flag or subcommand, and Anthropic explicitly declined to add one ([anthropics/claude-code#6686](https://github.com/anthropics/claude-code/issues/6686), closed not-planned). `claude-agent-acp` wraps Anthropic's own Claude Agent SDK behind a real ACP stdio server; `AcpSession` needed zero changes to consume it. It's provisioned globally by the sys-admin repo, not bundled as an ArgusDE dependency, since this is a private single-user app. Resolved via wayfinder map [argusde#12](https://github.com/deanjstone/argusde/issues/12); no longer open fog.

## MVP architecture decisions (locked 2026-08-12)

Collapsed from wayfinder map [argusde#1](https://github.com/deanjstone/argusde/issues/1) into [spec #9](https://github.com/deanjstone/argusde/issues/9) and implemented:

- **ACP client**: the official `@agentclientprotocol/sdk`, not hand-rolled and not T3 Code's `effect-acp`.
- **Process architecture**: `AcpSession` runs in a dedicated Electron utility process; the renderer never talks to it directly — everything relays through main (`ipcMain`/`webContents.send` + `contextBridge`).
- **Chat UI**: a custom chat-style surface rendering ACP session updates directly, not a terminal emulator.
- **Build/packaging**: electron-builder.

## Open / not yet resolved

- **Exact provider list beyond Claude Code** — explicitly post-MVP, out of scope until a future multi-provider effort.
- **Branding/theming** — doesn't block anything shipped so far; out of scope for now, picked up whenever it becomes relevant.
