import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Runs `tailscale <args...>`, injectable so tests never need a real
 * `tailscale` binary — matches this codebase's existing pattern of
 * injecting createSession/createTransport at the server's composition root.
 */
export type TailscaleExec = (args: string[]) => Promise<{ stdout: string }>;

async function defaultExec(args: string[]): Promise<{ stdout: string }> {
  return execFileAsync("tailscale", args);
}

export type TailscaleStatus = { available: false } | { available: true; dnsName: string };

/**
 * Never throws — a missing binary, a logged-out daemon, or unexpected
 * output all resolve to `{ available: false }` so Tailscale being absent
 * can never break local `argusde serve` usage.
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
  } catch {
    return { available: false };
  }
}

/**
 * Publishes `port` on the tailnet via `tailscale serve`, proxying to the
 * same port number locally — keeps the URL predictable (same port pre- and
 * post-Tailscale). Requires the local server to be bound to 127.0.0.1, not
 * 0.0.0.0, on this same port, or tailscaled silently fails to claim the
 * tailnet listener (see the port-bind-collision gotcha this mirrors).
 */
export async function enableServe(port: number, exec: TailscaleExec = defaultExec): Promise<void> {
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
