import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnAgentProcessTransport } from "./spawn-agent-process.js";

const FIXTURE = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../test/fixtures/stubborn-agent-cli.mjs");

function isAlive(pid: number): boolean {
  try {
    // Signal 0 performs the permission/existence check without delivering
    // a signal — throws ESRCH once the process is really gone.
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(predicate: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return predicate();
}

async function readPid(pidFile: string): Promise<number> {
  await waitFor(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, "utf8").length > 0);
  return Number(fs.readFileSync(pidFile, "utf8"));
}

describe("spawnAgentProcessTransport", () => {
  // Each test needs its own directory for the child's pid file. Tracked and
  // removed in afterEach — without it every run left another
  // argusde-spawn-test-* directory behind in the system temp dir forever.
  const tempDirs: string[] = [];

  function makePidFile(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-spawn-test-"));
    tempDirs.push(dir);
    return path.join(dir, "pid");
  }

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("dispose() terminates the spawned agent process, even one that ignores stdin EOF", async () => {
    const pidFile = makePidFile();
    const transport = spawnAgentProcessTransport({ command: process.execPath, args: [FIXTURE, pidFile] });

    const pid = await readPid(pidFile);
    expect(Number.isInteger(pid)).toBe(true);
    expect(isAlive(pid)).toBe(true);

    transport.dispose();

    // The whole point: the process is really gone from the OS, not merely
    // detached from a closed stream.
    expect(await waitFor(() => !isAlive(pid))).toBe(true);
  });

  it("dispose() is safe to call twice", async () => {
    const pidFile = makePidFile();
    const transport = spawnAgentProcessTransport({ command: process.execPath, args: [FIXTURE, pidFile] });

    const pid = await readPid(pidFile);
    transport.dispose();
    expect(await waitFor(() => !isAlive(pid))).toBe(true);

    // A second dispose must not throw — thread.close's teardown path and
    // the server's own shutdown sweep can both reach the same runtime.
    expect(() => transport.dispose()).not.toThrow();
  });
});
