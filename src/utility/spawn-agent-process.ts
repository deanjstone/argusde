import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";

export interface SpawnAgentProcessOptions {
  command: string;
  args?: string[];
  cwd?: string;
  /**
   * Environment for the agent process. Omit to inherit this process's own —
   * passing a partial object would *replace* the environment rather than
   * extend it, so callers that need an addition should spread `process.env`.
   */
  env?: NodeJS.ProcessEnv;
}

/**
 * An ACP `Stream` that also owns the subprocess behind it.
 *
 * Closing the ACP connection only closes the child's stdio; the real
 * claude-agent-acp keeps running regardless, so the transport has to be
 * able to kill what it spawned. Without this, every closed Thread left an
 * agent process (plus its own Claude Agent SDK child) alive forever, and a
 * long session slowly ate the machine's memory until the server died.
 */
export interface DisposableStream extends Stream {
  /** Terminates the spawned child process. Safe to call more than once. */
  dispose(): void;
}

/** Narrows a transport to one that owns a killable subprocess. In-process test agents don't. */
export function isDisposableStream(transport: unknown): transport is DisposableStream {
  return typeof (transport as DisposableStream | undefined)?.dispose === "function";
}

/**
 * Spawns the coding-agent CLI as a child process and wraps its stdio as an
 * ACP `Stream`. This is the one place AcpSession's `createTransport` is
 * backed by a real subprocess instead of an in-process fake agent (tests use
 * `createFakeAgent` from fake-agent.ts instead of this function).
 */
export function spawnAgentProcessTransport(options: SpawnAgentProcessOptions): DisposableStream {
  const child = spawn(options.command, options.args ?? [], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "inherit"],
  });

  if (!child.stdin || !child.stdout) {
    throw new Error(`Failed to spawn '${options.command}': stdio pipes unavailable`);
  }

  const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(writable, readable);

  return Object.assign(stream, {
    dispose(): void {
      // Already reaped — nothing to signal, and killing a recycled pid
      // would be actively harmful.
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill("SIGTERM");
    },
  });
}
