import { spawn } from "node:child_process";
import { Readable, Writable } from "node:stream";
import { ndJsonStream, type Stream } from "@agentclientprotocol/sdk";

export interface SpawnAgentProcessOptions {
  command: string;
  args?: string[];
  cwd?: string;
}

/**
 * Spawns the coding-agent CLI as a child process and wraps its stdio as an
 * ACP `Stream`. This is the one place AcpSession's `createTransport` is
 * backed by a real subprocess instead of an in-process fake agent (tests use
 * `createFakeAgent` from fake-agent.ts instead of this function).
 */
export function spawnAgentProcessTransport(options: SpawnAgentProcessOptions): Stream {
  const child = spawn(options.command, options.args ?? [], {
    cwd: options.cwd,
    stdio: ["pipe", "pipe", "inherit"],
  });

  if (!child.stdin || !child.stdout) {
    throw new Error(`Failed to spawn '${options.command}': stdio pipes unavailable`);
  }

  const writable = Writable.toWeb(child.stdin) as WritableStream<Uint8Array>;
  const readable = Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>;
  return ndJsonStream(writable, readable);
}
