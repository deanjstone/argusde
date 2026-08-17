import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorktreeStore, branchNameFor } from "./worktree-store.js";

let repoDir: string;
let store: WorktreeStore;

function git(args: string[], cwd = repoDir): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" });
}

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-worktree-store-"));
  git(["init", "--initial-branch=main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "ArgusDE Test"]);
  fs.writeFileSync(path.join(repoDir, "file.txt"), "hello\n");
  git(["add", "-A"]);
  git(["commit", "-m", "initial commit"]);
  store = new WorktreeStore();
});

afterEach(() => {
  // git worktree add registers the sibling dir with the main repo's
  // administrative area — remove it properly before deleting either
  // directory, or a stray .git/worktrees entry can leak across test runs.
  try {
    git(["worktree", "remove", "--force", `${repoDir}-worktrees/thread-1`]);
  } catch {
    // not every test creates the worktree — nothing to clean up
  }
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(`${repoDir}-worktrees`, { recursive: true, force: true });
});

describe("WorktreeStore", () => {
  it("creates a real sibling worktree directory on a branch named for its Thread", () => {
    // Replaces an assertion that this worktree is "detached" — that is the
    // behaviour spec #93 phase 3 deliberately retires, because a detached
    // HEAD is what made the agent's commits unreachable on Thread close.
    const worktreePath = store.createWorktree(repoDir, "thread-1");

    expect(worktreePath).toBe(`${repoDir}-worktrees/thread-1`);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(fs.readFileSync(path.join(worktreePath, "file.txt"), "utf8")).toBe("hello\n");

    expect(git(["rev-parse", "--abbrev-ref", "HEAD"], worktreePath).trim()).toBe(branchNameFor("thread-1"));

    expect(git(["worktree", "list", "--porcelain"])).toContain(worktreePath);
  });

  it("names the branch so it can be found from a terminal — prefixed and grouped, never bare", () => {
    store.createWorktree(repoDir, "thread-1");

    // A realistic id, since that's what the shape has to read well for —
    // Thread ids are randomUUID in production, not "thread-1".
    expect(branchNameFor("6c1f7e2a-0b53-4d19-9a77-2f8e1d4c5b60")).toBe("argusde/thread-6c1f7e2a-0b53-4d19-9a77-2f8e1d4c5b60");

    // The prefix is what makes every Thread branch enumerable at once and
    // keeps them clear of the user's own branch names.
    expect(git(["branch", "--list", "argusde/*"])).toContain(branchNameFor("thread-1"));
  });

  it("keeps a commit made in the worktree reachable after the worktree is removed", () => {
    // The whole point of the phase. Under `--detach` this commit had nothing
    // referencing it once the worktree went, so closing a Thread silently
    // discarded committed work: file content survived in Checkpoints, the
    // commit objects did not.
    const worktreePath = store.createWorktree(repoDir, "thread-1");
    fs.writeFileSync(path.join(worktreePath, "file.txt"), "hello\nfrom the agent\n");
    git(["add", "-A"], worktreePath);
    git(["commit", "-m", "the agent's own commit"], worktreePath);
    const sha = git(["rev-parse", "HEAD"], worktreePath).trim();

    store.removeWorktree(repoDir, worktreePath, "thread-1");

    // Reachable *via the branch*, not merely still in the object database —
    // an unreferenced object is a garbage-collection candidate, which is
    // the thing that made this data loss rather than an inconvenience.
    expect(git(["rev-parse", branchNameFor("thread-1")]).trim()).toBe(sha);
    expect(git(["log", "--format=%s", "-1", branchNameFor("thread-1")]).trim()).toBe("the agent's own commit");
  });

  it("still removes a worktree that predates branch backing — an existing detached one is not broken by the upgrade", () => {
    // Stands in for a Worktree an older build created. Nothing rewrites
    // these (spec #93: "existing detached Worktrees keep working"), so the
    // removal path has to stay indifferent to how the worktree was made.
    const legacyPath = `${repoDir}-worktrees/thread-1`;
    git(["worktree", "add", "--detach", legacyPath]);
    expect(git(["worktree", "list", "--porcelain"])).toContain("detached");

    store.removeWorktree(repoDir, legacyPath, "thread-1");

    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(git(["worktree", "list", "--porcelain"])).not.toContain(legacyPath);
  });

  it("shares the same object database — a commit made in the worktree is visible from the main repo", () => {
    const worktreePath = store.createWorktree(repoDir, "thread-1");
    fs.writeFileSync(path.join(worktreePath, "file.txt"), "hello\nworld\n");
    git(["add", "-A"], worktreePath);
    const sha = git(["commit", "-m", "edit from worktree"], worktreePath) && git(["rev-parse", "HEAD"], worktreePath).trim();

    expect(git(["cat-file", "-e", sha])).toBe(""); // resolves cleanly from the main repo, no error
  });

  it("throws a clean, catchable error when the workspace has no commits yet (no HEAD), rather than producing an empty orphan worktree", () => {
    // Guards a real trap in `git worktree add -b`: with no explicit start
    // point, git infers `--orphan` in a repo with no commits and succeeds,
    // handing the agent a worktree containing none of the project's files.
    // createWorktree names HEAD explicitly to keep this a clean failure.
    const emptyRepoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-worktree-store-empty-"));
    git(["init", "--initial-branch=main"], emptyRepoDir);
    try {
      expect(() => store.createWorktree(emptyRepoDir, "thread-1")).toThrow();
    } finally {
      fs.rmSync(emptyRepoDir, { recursive: true, force: true });
    }
  });

  it("throws a clean, catchable error rather than silently overwriting when called twice for the same threadId", () => {
    store.createWorktree(repoDir, "thread-1");
    expect(() => store.createWorktree(repoDir, "thread-1")).toThrow();
  });

  it("removeWorktree deletes the directory and deregisters it from the main repo's administrative area", () => {
    const worktreePath = store.createWorktree(repoDir, "thread-1");
    expect(fs.existsSync(worktreePath)).toBe(true);

    store.removeWorktree(repoDir, worktreePath, "thread-1");

    expect(fs.existsSync(worktreePath)).toBe(false);
    const list = git(["worktree", "list", "--porcelain"]);
    expect(list).not.toContain(worktreePath);

    // The main repo itself must still be a fully working git checkout —
    // removal must not have touched its own HEAD/index.
    expect(git(["rev-parse", "--verify", "HEAD"]).trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("removeWorktree throws a clean, catchable error for a path that was never a real worktree", () => {
    expect(() => store.removeWorktree(repoDir, `${repoDir}-worktrees/never-created`, "thread-1")).toThrow();
  });
  describe("failure leaves nothing behind", () => {
    it("does not burn the Thread's branch name when the path is what blocks creation", () => {
      // `worktree add -b` is not atomic: git validates the branch first, so
      // when the *path* is the blocker it has already created the branch by
      // the time it fails. Without cleanup the name is permanently taken and
      // every retry fails for a second, unrelated reason — where `--detach`
      // left nothing behind at all.
      const worktreePath = store.createWorktree(repoDir, "thread-1");
      store.removeWorktree(repoDir, worktreePath, "thread-1");
      // The branch survives removal (that's the point of the phase), so
      // delete it to isolate the path as the sole blocker.
      git(["branch", "-D", branchNameFor("thread-1")]);
      fs.mkdirSync(worktreePath, { recursive: true });
      fs.writeFileSync(path.join(worktreePath, "in-the-way.txt"), "occupied\n");

      expect(() => store.createWorktree(repoDir, "thread-1")).toThrow();

      expect(git(["branch", "--list", branchNameFor("thread-1")]).trim()).toBe("");
    });

    it("never deletes a branch it did not create, even when creation fails", () => {
      // If the branch already existed, it is the user's — the more common
      // failure, since git checks the branch before the path. Cleaning that
      // up would be exactly the data loss this phase exists to prevent.
      git(["branch", branchNameFor("thread-1")]);
      const sha = git(["rev-parse", branchNameFor("thread-1")]).trim();

      expect(() => store.createWorktree(repoDir, "thread-1")).toThrow();

      expect(git(["rev-parse", branchNameFor("thread-1")]).trim()).toBe(sha);
    });
  });

  describe("worktrees that predate branch backing", () => {
    it("rescues a legacy detached worktree's commits onto a branch before removing it", () => {
      // Branch backing only helps worktrees created after it. Spec #93's
      // "removal must no longer be able to discard commits" is unqualified,
      // so a detached worktree an older build made still has to be safe to
      // close — otherwise the guarantee has a hole exactly where the
      // existing data lives.
      const legacyPath = `${repoDir}-worktrees/thread-1`;
      git(["worktree", "add", "--detach", legacyPath]);
      fs.writeFileSync(path.join(legacyPath, "file.txt"), "committed before the upgrade\n");
      git(["add", "-A"], legacyPath);
      git(["commit", "-m", "legacy agent commit"], legacyPath);
      const sha = git(["rev-parse", "HEAD"], legacyPath).trim();

      store.removeWorktree(repoDir, legacyPath, "thread-1");

      expect(git(["rev-parse", branchNameFor("thread-1")]).trim()).toBe(sha);
      expect(git(["log", "--format=%s", "-1", branchNameFor("thread-1")]).trim()).toBe("legacy agent commit");
    });

    it("adds no branch for a legacy worktree that never committed — a rescue nobody needs is just litter", () => {
      const legacyPath = `${repoDir}-worktrees/thread-1`;
      git(["worktree", "add", "--detach", legacyPath]);

      store.removeWorktree(repoDir, legacyPath, "thread-1");

      // Its HEAD is still the commit it was promoted from, which main
      // already reaches — nothing was at risk.
      expect(git(["branch", "--list", "argusde/*"]).trim()).toBe("");
    });
  });
});
