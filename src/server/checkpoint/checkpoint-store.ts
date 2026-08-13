import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
  captureBaseline(threadId: string, cwd: string): string {
    return this.captureCheckpoint(threadId, 0, cwd);
  }

  captureCheckpoint(threadId: string, turn: number, cwd: string): string {
    const ref = refFor(threadId, turn);
    const tmpIndex = path.join(os.tmpdir(), `argusde-checkpoint-index-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`);

    try {
      const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
      const hasHead = git(cwd, env, ["rev-parse", "--verify", "-q", "HEAD"], { allowFailure: true }) !== null;
      if (hasHead) {
        git(cwd, env, ["read-tree", "HEAD"]);
      }
      git(cwd, env, ["add", "-A", "--", "."]);
      const treeSha = git(cwd, env, ["write-tree"]).trim();
      const commitSha = git(cwd, env, ["commit-tree", treeSha, "-m", `argusde checkpoint: thread ${threadId} turn ${turn}`]).trim();
      git(cwd, env, ["update-ref", ref, commitSha]);
      return ref;
    } finally {
      fs.rmSync(tmpIndex, { force: true });
    }
  }

  diffCheckpoints(threadId: string, turnA: number, turnB: number, cwd: string): string {
    const refA = refFor(threadId, turnA);
    const refB = refFor(threadId, turnB);
    return git(cwd, process.env, ["diff", `${refA}^{commit}`, `${refB}^{commit}`]);
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
