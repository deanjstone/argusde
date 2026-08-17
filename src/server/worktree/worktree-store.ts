import { execFileSync } from "node:child_process";

/**
 * Names the branch a promoted Thread's worktree is created on.
 *
 * The Thread id rather than its title: ids are `randomUUID`, so always
 * ref-valid, whereas titles are free text (at first run the title is
 * literally the workspace path) and slugifying user text into a ref name
 * buys collisions for a cosmetic gain. The `argusde/` prefix makes the whole
 * set enumerable with `git branch --list 'argusde/*'` and keeps them clear
 * of the user's own branch names. See docs/plans/phase-15-*.md for the
 * fuller reasoning.
 *
 * **Only for naming a branch this code is about to create.** Never to
 * answer "what branch is this worktree on" — a Thread promoted before spec
 * #93 phase 3 is detached and has no branch, so a reader has to ask git.
 */
export function branchNameFor(threadId: string): string {
  return `argusde/thread-${threadId}`;
}

/** Mirrors checkpoint-store.ts's own option of the same name: a non-zero exit is an answer here, not a failure. */
interface GitOptions {
  allowFailure?: boolean;
}

function git(cwd: string, args: string[], options: GitOptions = {}): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8" });
  } catch (error) {
    if (options.allowFailure) return null;
    throw error;
  }
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
    const branch = branchNameFor(threadId);
    const branchExisted = git(workspaceRoot, ["rev-parse", "--verify", "-q", `refs/heads/${branch}`], { allowFailure: true }) !== null;

    try {
      // HEAD named explicitly rather than left implicit. With `-b` and no
      // start point, a repository with no commits makes git infer
      // `--orphan` and cheerfully produce a worktree on an unborn branch
      // with *no files in it* — the agent would get an empty directory that
      // looks like the project. `--detach` failed cleanly there ("invalid
      // reference: HEAD"), and naming HEAD keeps that.
      git(workspaceRoot, ["worktree", "add", "-b", branch, worktreePath, "HEAD"]);
    } catch (error) {
      // `worktree add -b` is not atomic. Git validates the branch first, so
      // when the *path* is what blocks it the branch has already been
      // created by the time it fails — a plain rethrow would permanently
      // burn this Thread's branch name and make every retry fail for a
      // second, unrelated reason. `--detach` left nothing behind on this
      // path; neither should this.
      //
      // Deliberately only removes a branch *this call* created. If it
      // already existed (the more common failure, since git checks the
      // branch first) it is the user's, and deleting it would be exactly
      // the data loss this phase exists to prevent.
      if (!branchExisted) git(workspaceRoot, ["branch", "-D", branch], { allowFailure: true });
      throw error;
    }
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
   * worktree remove` already leaves branches alone, so that needs no code —
   * which is why there's a test asserting the commit is still reachable via
   * the branch afterwards, rather than trusting it.
   */
  removeWorktree(workspaceRoot: string, worktreePath: string, threadId: string): void {
    this.rescueDetachedCommits(workspaceRoot, worktreePath, threadId);
    git(workspaceRoot, ["worktree", "remove", "--force", worktreePath]);
  }

  /**
   * Gives a *legacy* detached worktree's commits a branch to survive on,
   * immediately before it is removed.
   *
   * Spec #93's requirement that removal "must no longer be able to discard
   * commits" is unqualified, but branch backing only helps worktrees created
   * after it. One promoted by an earlier build is still detached, so
   * removing it still orphans anything committed in it — the exact loss the
   * phase exists to stop. Story 32 says nothing rewrites those worktrees,
   * and nothing does: this fires once, at removal, and only ever *creates* a
   * ref.
   *
   * Silent about its own failures on purpose. Every step is best-effort
   * salvage on a path whose actual job is removal — a worktree that can't be
   * inspected is one `git worktree remove` is about to reject anyway, and
   * that error is the one worth surfacing, not a rescue attempt's.
   */
  private rescueDetachedCommits(workspaceRoot: string, worktreePath: string, threadId: string): void {
    const head = git(worktreePath, ["rev-parse", "HEAD"], { allowFailure: true })?.trim();
    if (!head) return;

    // A worktree created by this phase already has a branch holding its
    // commits; only a detached one needs rescuing.
    const detached = git(worktreePath, ["symbolic-ref", "-q", "HEAD"], { allowFailure: true }) === null;
    if (!detached) return;

    // Nothing to rescue when some other ref already reaches this commit —
    // the overwhelmingly common case, since a worktree where the agent
    // never committed still sits on the commit it was promoted from. Adding
    // a branch there would be litter, not safety.
    const reachable = (git(workspaceRoot, ["for-each-ref", "--contains", head, "--count=1"], { allowFailure: true }) ?? "").trim() !== "";
    if (reachable) return;

    git(workspaceRoot, ["branch", branchNameFor(threadId), head], { allowFailure: true });
  }
}

function worktreePathFor(workspaceRoot: string, threadId: string): string {
  return `${workspaceRoot}-worktrees/${threadId}`;
}
