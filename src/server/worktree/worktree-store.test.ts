import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WorktreeStore } from "./worktree-store.js";

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
  it("creates a real sibling worktree directory, checked out detached at HEAD", () => {
    const worktreePath = store.createWorktree(repoDir, "thread-1");

    expect(worktreePath).toBe(`${repoDir}-worktrees/thread-1`);
    expect(fs.existsSync(worktreePath)).toBe(true);
    expect(fs.readFileSync(path.join(worktreePath, "file.txt"), "utf8")).toBe("hello\n");

    const list = git(["worktree", "list", "--porcelain"]);
    expect(list).toContain(worktreePath);
    expect(list).toContain("detached");
  });

  it("shares the same object database — a commit made in the worktree is visible from the main repo", () => {
    const worktreePath = store.createWorktree(repoDir, "thread-1");
    fs.writeFileSync(path.join(worktreePath, "file.txt"), "hello\nworld\n");
    git(["add", "-A"], worktreePath);
    const sha = git(["commit", "-m", "edit from worktree"], worktreePath) && git(["rev-parse", "HEAD"], worktreePath).trim();

    expect(git(["cat-file", "-e", sha])).toBe(""); // resolves cleanly from the main repo, no error
  });

  it("throws a clean, catchable error when the workspace has no commits yet (no HEAD)", () => {
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
});
