import { execFile } from "node:child_process";

/** Runs `<binary> <args...>`, killing it if it outlives `timeoutMs`. */
export type TailscaleExec = (args: string[]) => Promise<{ stdout: string }>;

/**
 * Real DI style used elsewhere in this codebase (e.g. createSession/
 * createTransport in src/server/index.ts) for testability — but unlike
 * those required parameters, `exec` defaults to a real subprocess call so
 * production call sites in cli.ts don't need to pass one explicitly.
 *
 * A timeout is required (not left to the caller/OS default) — a hung
 * `tailscale`/`tailscaled` must never block `argusde serve`'s startup or
 * shutdown indefinitely.
 */
export function createExec(binary: string, timeoutMs = 5000): TailscaleExec {
  return (args: string[]) =>
    new Promise((resolve, reject) => {
      execFile(binary, args, { timeout: timeoutMs }, (error, stdout) => {
        if (error) reject(error);
        else resolve({ stdout });
      });
    });
}

const defaultExec = createExec("tailscale");

export type TailscaleStatus = { available: false } | { available: true; dnsName: string };

/**
 * Never throws — a missing binary, a logged-out daemon, or unexpected
 * output all resolve to `{ available: false }` so Tailscale being absent
 * can never break local `argusde serve` usage. The underlying reason is
 * still logged (never a silent `catch {}`) so a user who's simply not
 * logged in isn't left with zero diagnostic trail.
 */
export async function checkTailscaleStatus(exec: TailscaleExec = defaultExec): Promise<TailscaleStatus> {
  try {
    const { stdout } = await exec(["status", "--json"]);
    const parsed = JSON.parse(stdout) as { BackendState?: string; Self?: { DNSName?: string } };
    if (parsed.BackendState !== "Running" || typeof parsed.Self?.DNSName !== "string") {
      return { available: false };
    }
    // tailscaled's DNSName is FQDN-style with a trailing dot; URLs built from
    // it read better without one.
    return { available: true, dnsName: parsed.Self.DNSName.replace(/\.$/, "") };
  } catch (err) {
    console.warn(`Tailscale status check failed: ${(err as Error).message}`);
    return { available: false };
  }
}

/**
 * Checks whether `port` already has a `tailscale serve` mapping configured
 * — from ArgusDE's own prior run or an unrelated service. Fails **safe**
 * (returns `true`, "assume a conflict") when the status query itself can't
 * be answered, rather than fail-open — the caller uses this to avoid ever
 * silently overwriting someone else's mapping, so an unverifiable state
 * must not be treated as "clear to proceed".
 */
export async function hasExistingMapping(port: number, exec: TailscaleExec = defaultExec): Promise<boolean> {
  try {
    const { stdout } = await exec(["serve", "status", "--json"]);
    const parsed = JSON.parse(stdout) as { TCP?: Record<string, unknown> };
    return Object.prototype.hasOwnProperty.call(parsed.TCP ?? {}, String(port));
  } catch (err) {
    console.warn(`Tailscale serve status check failed, assuming ${port} may already be in use: ${(err as Error).message}`);
    return true;
  }
}

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost"]);

/**
 * Publishes `port` on the tailnet via `tailscale serve`, proxying to the
 * same port number locally — keeps the URL predictable (same port pre- and
 * post-Tailscale).
 *
 * `host` must be the loopback address the local server actually bound to —
 * validated here, not just by the caller (cli.ts's `shouldEnableTailscale`
 * makes the same check before ever calling this, but that guard alone is
 * easy for a future caller to bypass; enforcing it inside `enableServe`
 * itself means the invariant travels with the function). A non-loopback
 * host means tailscaled can't claim its own tailnet-interface listener on
 * this port — see the port-bind-collision gotcha this mirrors.
 */
export async function enableServe(port: number, host: string, exec: TailscaleExec = defaultExec): Promise<void> {
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new Error(`enableServe requires a loopback host (127.0.0.1 or localhost), got "${host}"`);
  }
  await exec(["serve", "--bg", `--https=${port}`, String(port)]);
}

/**
 * Turns off only the mapping for `port` — never `reset`/`clear` with no
 * scope, which would wipe out any other tailscale serve mappings already
 * configured on this machine for unrelated services.
 */
export async function disableServe(port: number, exec: TailscaleExec = defaultExec): Promise<void> {
  await exec(["serve", `--https=${port}`, "off"]);
}
