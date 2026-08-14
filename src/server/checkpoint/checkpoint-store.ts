import { execFile, execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Git-ref-based checkpoint snapshots, per spec #33 — the same core
 * mechanism T3 Code uses (verified against its real source, see
 * docs/research/t3-checkpoint-mechanism.md on the research/checkpoint-approach
 * branch), stripped of T3's Effect-TS/event-sourcing wrapper.
 *
 * Each checkpoint is a full, parentless snapshot commit built through an
 * isolated GIT_INDEX_FILE so it never touches the real working tree, index,
 * or HEAD. Refs live at refs/argusde/checkpoints/<threadId>/turn/<n>; turn 0
 * is always the baseline captured at Thread creation.
 */
export class CheckpointStore {
  async captureBaseline(threadId: string, cwd: string): Promise<string> {
    return this.captureCheckpoint(threadId, 0, cwd);
  }

  async captureCheckpoint(threadId: string, turn: number, cwd: string): Promise<string> {
    const ref = refFor(threadId, turn);
    const tmpIndex = path.join(os.tmpdir(), `argusde-checkpoint-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    try {
      const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
      const hasHead = (await gitAsync(cwd, env, ["rev-parse", "--verify", "-q", "HEAD"], { allowFailure: true })) !== null;
      if (hasHead) {
        await gitAsync(cwd, env, ["read-tree", "HEAD"]);
      }
      await gitAsync(cwd, env, ["add", "-A", "--", "."]);
      const treeSha = (await gitAsync(cwd, env, ["write-tree"])).trim();
      const commitSha = (await gitAsync(cwd, env, ["commit-tree", treeSha, "-m", `argusde checkpoint: thread ${threadId} turn ${turn}`])).trim();
      await gitAsync(cwd, env, ["update-ref", ref, commitSha]);
      return ref;
    } finally {
      fs.rmSync(tmpIndex, { force: true });
    }
  }

  async diffCheckpoints(threadId: string, turnA: number, turnB: number, cwd: string): Promise<string> {
    const refA = refFor(threadId, turnA);
    const refB = refFor(threadId, turnB);
    return gitAsync(cwd, process.env, ["diff", `${refA}^{commit}`, `${refB}^{commit}`]);
  }

  /**
   * Rewrites the REAL working tree and index to exactly match an earlier
   * checkpoint — unlike capture, this can't isolate itself behind a
   * GIT_INDEX_FILE, since mutating the real workspace is the entire point.
   * `read-tree -u --reset` replaces the index and working tree wholesale
   * (deleting paths absent from the target tree, not just updating ones
   * present in it), which plain `checkout <ref> -- .` would not do.
   */
  restoreCheckpoint(threadId: string, turn: number, cwd: string): void {
    const ref = refFor(threadId, turn);
    const exists = git(cwd, process.env, ["rev-parse", "--verify", "-q", `${ref}^{commit}`], { allowFailure: true }) !== null;
    if (!exists) throw new Error(`Unknown checkpoint ref: ${ref}`);

    git(cwd, process.env, ["read-tree", "-u", "--reset", `${ref}^{commit}`]);
    // read-tree only reconciles paths that were already in the real index —
    // a file created after the target checkpoint but never `git add`ed for
    // real (every capture stages into an isolated GIT_INDEX_FILE, never the
    // real one) is untracked from the real index's perspective the whole
    // time, so read-tree has no reason to touch it. Safe to sweep with
    // clean -fd (no -x, matching capture's own gitignore-respecting `add
    // -A`): anything present at the target checkpoint was itself captured
    // via the same full-tree `add -A`, so it's never wrongly swept here.
    git(cwd, process.env, ["clean", "-fd"]);
  }
}

function refFor(threadId: string, turn: number): string {
  return `refs/argusde/checkpoints/${threadId}/turn/${turn}`;
}

function git(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  options: { allowFailure: true },
): string | null;
function git(cwd: string, env: NodeJS.ProcessEnv, args: string[]): string;
function git(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  options?: { allowFailure: true },
): string | null {
  try {
    return execFileSync("git", args, { cwd, env, encoding: "utf8" });
  } catch (error) {
    if (options?.allowFailure) return null;
    throw error;
  }
}

function gitAsync(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  options: { allowFailure: true },
): Promise<string | null>;
function gitAsync(cwd: string, env: NodeJS.ProcessEnv, args: string[]): Promise<string>;
async function gitAsync(
  cwd: string,
  env: NodeJS.ProcessEnv,
  args: string[],
  options?: { allowFailure: true },
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, { cwd, env, encoding: "utf8" });
    return stdout;
  } catch (error) {
    if (options?.allowFailure) return null;
    throw error;
  }
}
