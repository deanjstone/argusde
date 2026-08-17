import { execFileSync } from "node:child_process";

/**
 * Names the branch a promoted Thread's worktree is created on.
 *
 * `argusde/thread-<threadId>` — the Thread id rather than its title, because
 * story 30 wants the name to let you find the work from a terminal, and the
 * id is the only candidate that is predictable (it's shown in the app's
 * Settings tab, so there's a two-way path between the UI and git),
 * groupable (`git branch --list 'argusde/*'` lists every Thread branch),
 * and always ref-valid (ids are randomUUID, i.e. hex and hyphens). A slug
 * of the title would read better, but titles are free text — at first run
 * the title is literally the workspace path — and slugifying user text into
 * a ref name buys collisions and invalid-ref errors for a cosmetic gain.
 *
 * Derive this only when *creating* a worktree, never when reading one's
 * state. A Thread promoted before spec #93 phase 3 has a detached worktree
 * and no branch at all, so anything that displays the branch has to ask git
 * what the working tree is actually on — computing it from the Thread id
 * would confidently name a branch that doesn't exist.
 */
export function branchNameFor(threadId: string): string {
  return `argusde/thread-${threadId}`;
}

/**
 * Git worktree creation for Thread promotion, per spec #33 / issue #23's
 * worktree lifecycle decision. A worktree lives as a sibling directory next
 * to its Project's workspace root (never nested inside it). Shares the same
 * underlying git object database and refs/ namespace as the main workspace
 * (that's the whole point — a checkpoint captured from inside the worktree
 * is equally visible from the main workspace, and vice versa).
 *
 * Checked out on a real branch since spec #93 phase 3. It used to be
 * detached at HEAD, on the reasoning that checkpoint refs are this
 * codebase's durable history mechanism and branches were therefore just
 * bookkeeping. That held for file *content* and not for commits: a detached
 * HEAD leaves anything the agent committed unreferenced the moment the
 * worktree is removed, so closing a Thread discarded committed work while
 * appearing to preserve it.
 */
export class WorktreeStore {
  createWorktree(workspaceRoot: string, threadId: string): string {
    const worktreePath = worktreePathFor(workspaceRoot, threadId);
    // HEAD named explicitly rather than left implicit. With `-b` and no
    // start point, a repository with no commits makes git infer `--orphan`
    // and cheerfully produce a worktree on an unborn branch with *no files
    // in it* — the agent would get an empty directory that looks like the
    // project. `--detach` used to fail cleanly there ("invalid reference:
    // HEAD"), and naming HEAD keeps that: unresolvable in an empty repo,
    // identical to the old behaviour in every other case.
    //
    // Fails rather than reusing an existing branch of the same name — the
    // same "throw instead of silently overwriting" posture the
    // duplicate-path case already had.
    execFileSync("git", ["worktree", "add", "-b", branchNameFor(threadId), worktreePath, "HEAD"], { cwd: workspaceRoot });
    return worktreePath;
  }

  /**
   * Run from the main workspace, not the worktree being removed — you
   * can't rmdir the cwd you're standing in. `--force` matches this
   * codebase's posture elsewhere (checkpoint revert's `read-tree --reset`):
   * checkpoint history is durable in git refs independent of any working
   * copy, so git's own "worktree has local modifications" safety check
   * isn't protecting anything that isn't already recoverable.
   *
   * Deliberately does *not* delete the branch, which is what makes closing
   * a Thread non-destructive against committed work (story 31). `git
   * worktree remove` already leaves branches alone, so this needs no code —
   * which is exactly why it has a test asserting the commit is still
   * reachable via the branch afterwards, rather than trusting it.
   */
  removeWorktree(workspaceRoot: string, worktreePath: string): void {
    execFileSync("git", ["worktree", "remove", "--force", worktreePath], { cwd: workspaceRoot });
  }
}

function worktreePathFor(workspaceRoot: string, threadId: string): string {
  return `${workspaceRoot}-worktrees/${threadId}`;
}
