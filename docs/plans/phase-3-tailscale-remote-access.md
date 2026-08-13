# Phase 3: Tailscale serve + startup QR code

> Implemented via `feature/tailscale-remote-access`, in progress.

## Context

Phases 1, 2, and 2b of spec [#33](https://github.com/deanjstone/argusde/issues/33) built the standalone server, the shared web UI, and Electron's cutover to load that UI directly. Remote access itself — the actual "reach my server from my phone" story that motivated the uplift's remote-access decision (#4/#13-15) — has only been demonstrated manually: `argusde serve` was hand-wired to a Tailscale-bound instance and reached from an iPhone by typing in a Tailscale IP.

This phase automates that: `argusde serve` wires up `tailscale serve` itself and prints a scannable QR code + MagicDNS URL on startup, so connecting from a phone is "scan the code," not "find and type the Tailscale IP."

**End state**: running `argusde serve` on a machine with Tailscale installed and running automatically publishes the server on the tailnet via `tailscale serve`, and prints the MagicDNS HTTPS URL plus a terminal QR code encoding it. On a machine without Tailscale (or not logged in), `argusde serve` still works exactly as today for local/LAN use, with a one-line notice instead of a hard failure. On shutdown (Ctrl-C), the Tailscale mapping this run created is cleanly removed — no orphaned config left behind.

## Facts gathered this session (not assumptions)

- `src/server/cli.ts` already has the shape this hooks into: `parseServeArgs`, a `main()` that calls `startServer(...)`, prints one status line, and installs `SIGINT`/`SIGTERM` handlers that call `server.close()`. Default host is already `127.0.0.1` (`DEFAULT_HOST`), which matters — see the port-bind-collision note below.
- Confirmed live on this dev machine: `tailscale` CLI is installed, authenticated, and running (`tailscale status --json` → `BackendState: "Running"`, `Self.DNSName: "lnv-lgn5-wsl.tail00500e.ts.net."`, note the trailing dot). `tailscale serve status --json` already has three real mappings in use on this machine (443, 8384, 8787 — unrelated live services) — confirms the new ArgusDE mapping must use its own distinct port, never touch `443` or assume it's free.
- Found (and user approved clearing, see below) a **stale** mapping: `443 → 127.0.0.1:3773`, nothing actually listening on 3773 anymore — leftover from this session's earlier manual Tailscale demo.
- `tailscale serve --help` confirms the CLI shape needed: `tailscale serve --bg --https=<port> <local-port-or-url>` to publish, and the `off`/`clear` family to tear down — exact teardown invocation (`--https=<port> off` vs `clear <service>`) gets nailed down empirically in the first implementation step against this machine's real, authenticated `tailscale` (never against a mock), since the CLI's own `--help` text doesn't spell out the exact `off` syntax.
- Relevant existing memory: `tailscale serve --https=<port>` needs the **local** service bound to `127.0.0.1`, not `0.0.0.0`, on that same port, or tailscaled silently fails to claim the tailnet listener (TLS resets, no clear error). `argusde serve`'s own default host already satisfies this — the risk is only if a user overrides `--host` to something else while Tailscale wiring is also active.
- No QR-code dependency exists yet in `package.json`. Picking `qrcode-terminal` (pure JS, zero deps, one job: render an ASCII QR to a string/stdout) over the heavier `qrcode` package, which this use case doesn't need (no image/PNG output required).

## Design

**New module `src/server/remote/tailscale.ts`** — thin wrapper, dependency-injectable exec (matches the existing `createSession`/`createTransport` injection pattern in `src/server/index.ts`, so tests never need a real `tailscale` binary):
- `checkTailscaleStatus(exec?)` → `{ available: false }` | `{ available: true, dnsName: string }`. Runs `tailscale status --json`; `available` requires both a successful exec and `BackendState === "Running"`; `dnsName` is `Self.DNSName` with the trailing dot stripped. Any exec failure (binary missing, not logged in, malformed JSON) resolves `{ available: false }` rather than throwing — Tailscale being absent must never break local `argusde serve` usage.
- `enableServe(port, exec?)` → runs `tailscale serve --bg --https=<port> <port>`, exposing the tailnet HTTPS listener on the **same** port number as the local server (keeps the URL predictable: same port pre- and post-Tailscale).
- `disableServe(port, exec?)` → tears down only that one port's mapping (never `reset`/`clear` with no scope — those would wipe this machine's *other* live mappings on 443/8384/8787).

**`cli.ts` changes:**
- New `--no-tailscale` flag (parsed alongside `--host`/`--port`) — explicit escape hatch to skip Tailscale entirely even when available, so a user can force pure local/LAN use without ArgusDE ever touching their tailscale config.
- After `startServer(...)` succeeds: if `--no-tailscale` wasn't passed AND `host` is `127.0.0.1`/`localhost` (the port-bind-collision guard — skip silently-but-loggedly otherwise) AND `checkTailscaleStatus()` reports available, call `enableServe(port)`, print `Remote access via Tailscale: https://<dnsName>:<port>/`, and render the QR code for that URL via `qrcode-terminal`. If `enableServe` itself fails, log a warning and continue — never let Tailscale wiring take down local serving.
- If Tailscale isn't available (or skipped), print one line noting it (`Tailscale not detected — remote access unavailable. Run "tailscale up" to enable it.`) and continue exactly as today.
- Shutdown handler: if this run enabled a Tailscale mapping, call `disableServe(port)` before `server.close()`/`process.exit(0)`.

## Explicitly deferred out of Phase 3

- The version-compatibility handshake (spec story 17) — a separate, independently-scoped deferred item, not part of this phase.
- Surfacing the QR/URL anywhere in the Electron connect screen or web UI itself — this phase is CLI/terminal-only, matching story 15's literal ask ("`argusde serve` to print a scannable QR code").
- Worktree promotion UI, mode-switcher UI, multi-project UI, the PWA — unchanged from prior phases' deferred lists.

## Testing (real collaborators over mocks, per established convention)

- `tailscale.test.ts`: unit tests against an injected fake exec — covers not-installed, installed-but-not-running, running (parses `dnsName` correctly, including the trailing-dot strip), `enableServe`/`disableServe` constructing the expected argv, and exec failures resolving/rejecting in a way callers can safely swallow.
- `cli.test.ts` (existing file) gains coverage for: `--no-tailscale` skips wiring; a non-default `--host` skips wiring; shutdown calls `disableServe` only when a mapping was actually enabled this run. Achieved via the same exec-injection the unit tests use — no real `tailscale` binary needed for the automated suite.
- One **real** manual verification on this dev machine (mirrors how `claude-agent-acp` got a real end-to-end check in Phase 1): run the actual built `argusde serve`, confirm a real mapping appears in `tailscale serve status --json`, confirm the printed URL is reachable from another device, confirm Ctrl-C tears the mapping back down cleanly, and confirm the *other* live mappings (8384, 8787) are untouched throughout.

## Verification

1. `pnpm run typecheck` and `pnpm test` (full suite) — clean, including the new `tailscale.test.ts` and `cli.test.ts` additions.
2. Manual check on this machine: `argusde serve` with real Tailscale → QR + URL printed, `tailscale serve status --json` shows the new mapping, URL reachable from a phone, Ctrl-C cleans it up.
3. Manual check: `argusde serve --no-tailscale` → no Tailscale mapping touched, server still works locally.
4. First implementation step (before any code): with the user's already-given approval, run `tailscale serve --https=443 off` to clear the dead `443 → 3773` mapping left over from this session's earlier manual demo — confirmed via `tailscale serve status --json` showing only 8384/8787 remaining.
5. Work happens on a branch (`feature/tailscale-remote-access`), committed incrementally (tailscale module + tests → cli.ts wiring → cli tests), pushed after each commit, self-reviewed with `/code-review` before merging (established practice from Phases 1/2/2b), PR opened once complete and green. Plan copied to `docs/plans/phase-3-tailscale-remote-access.md` per the standing repo convention.

## Outcome

Landed as planned, with real fixes from a `/code-review high` self-review pass before merging (established practice, see prior phases). All six findings were real:

- **Signal handlers registered too late.** `SIGINT`/`SIGTERM` were installed *after* the (awaited) Tailscale status-check/enable subprocess calls — an early Ctrl-C during that window had no listener yet, so Node's default handler killed the process immediately: no graceful `server.close()`, and if `enableServe` had already succeeded, its mapping was never torn down. Fixed by moving handler registration to immediately after the server starts, before any Tailscale wiring — `tailscaleEnabled`/`shuttingDown` are closed over by reference, so the handler always sees the current state regardless of when it fires.
- **No timeout on the `tailscale` subprocess calls.** A hung `tailscaled` could block startup/shutdown indefinitely. Fixed by replacing the bare `promisify(execFile)` wrapper with a `createExec(binary, timeoutMs = 5000)` factory that passes `execFile`'s own `timeout` option — tested against a real `sleep` subprocess outliving a short timeout (real collaborator, not a mock, per this repo's convention) rather than trying to fake a hang.
- **Silent `catch {}` in `checkTailscaleStatus`.** Directly violated the global "never silent `catch (e) {}`" rule — a user who's simply not logged in got the same generic message as someone with no Tailscale at all, no diagnostic trail. Fixed with a `console.warn` logging the real reason before returning `{ available: false }`.
- **No collision guard against a pre-existing, unrelated `tailscale serve` mapping on the same port.** `enableServe` would have silently overwritten another service's mapping if `--port` happened to collide, and `disableServe` would then tear down *that* service's entry on shutdown — real risk on a personal multi-service machine (this dev machine already has 2 unrelated live mappings). Fixed with a new `hasExistingMapping(port)` check before ever calling `enableServe`, failing **safe** (treats an unverifiable status query as "assume a conflict") — manually verified by pre-creating a real mapping on a free port and confirming `argusde serve` on that same port detected it, skipped wiring, and left it untouched.
- **The loopback-host safety invariant lived only in `cli.ts`'s `shouldEnableTailscale`, not inside `enableServe` itself** — the review noted `tailscale.test.ts` itself already called `enableServe` with no host check, proving it was bypassable. Fixed by giving `enableServe` its own `host` parameter and rejecting non-loopback hosts before ever touching `exec` — the invariant now travels with the function, `shouldEnableTailscale` in `cli.ts` remains as a friendlier fast-path.
- **A doc-comment overclaimed parity** with `src/server/index.ts`'s `createSession`/`createTransport` injection pattern (those are *required* params with no default; `exec` here has a real default) — reworded to describe the actual, opposite-in-one-respect relationship.

Verified after fixes: full suite green (113 tests, 17 files, up from 103/17 immediately post-implementation), typecheck clean, and every fix re-verified manually against this machine's real, authenticated Tailscale — including the collision guard (pre-created a real mapping on a free port, confirmed it was detected and left untouched) and a full happy-path run (mapping appears, real cert resolves with HTTP 200, Ctrl-C tears it down cleanly, the other two live mappings on this machine untouched throughout).

One implementation-time discovery not anticipated in the plan: a first-time `tailscale serve` mapping on a brand-new port doesn't get a usable HTTPS cert instantly — the very first request can hit a TLS-level error for a few seconds while the cert provisions, even though the mapping itself is already correctly configured. Not a bug in this code; noted here so a future "it didn't work" report checks timing before assuming a regression.
