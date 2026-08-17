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

    const list = git(["worktree", "list", "--porcelain"]);
    expect(list).toContain(worktreePath);
    expect(list).not.toContain("detached");
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

    store.removeWorktree(repoDir, worktreePath);

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

    store.removeWorktree(repoDir, legacyPath);

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

    store.removeWorktree(repoDir, worktreePath);

    expect(fs.existsSync(worktreePath)).toBe(false);
    const list = git(["worktree", "list", "--porcelain"]);
    expect(list).not.toContain(worktreePath);

    // The main repo itself must still be a fully working git checkout —
    // removal must not have touched its own HEAD/index.
    expect(git(["rev-parse", "--verify", "HEAD"]).trim()).toMatch(/^[0-9a-f]{40}$/);
  });

  it("removeWorktree throws a clean, catchable error for a path that was never a real worktree", () => {
    expect(() => store.removeWorktree(repoDir, `${repoDir}-worktrees/never-created`)).toThrow();
  });
});
