import { execFileSync } from "node:child_process";

/**
 * Git worktree creation for Thread promotion, per spec #33 / issue #23's
 * worktree lifecycle decision. A worktree lives as a sibling directory next
 * to its Project's workspace root (never nested inside it), checked out
 * detached at HEAD — no branch bookkeeping, since checkpoint refs (not
 * branches) are this codebase's durable history mechanism. Shares the same
 * underlying git object database and refs/ namespace as the main workspace
 * (that's the whole point — a checkpoint captured from inside the worktree
 * is equally visible from the main workspace, and vice versa).
 */
export class WorktreeStore {
  createWorktree(workspaceRoot: string, threadId: string): string {
    const worktreePath = worktreePathFor(workspaceRoot, threadId);
    execFileSync("git", ["worktree", "add", "--detach", worktreePath], { cwd: workspaceRoot });
    return worktreePath;
  }
}

function worktreePathFor(workspaceRoot: string, threadId: string): string {
  return `${workspaceRoot}-worktrees/${threadId}`;
}
