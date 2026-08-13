import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CheckpointStore } from "./checkpoint-store.js";

let repoDir: string;
let store: CheckpointStore;

function git(args: string[]): string {
  return execFileSync("git", args, { cwd: repoDir, encoding: "utf8" });
}

beforeEach(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-checkpoint-store-"));
  git(["init", "--initial-branch=main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "ArgusDE Test"]);
  fs.writeFileSync(path.join(repoDir, "file.txt"), "hello\n");
  git(["add", "-A"]);
  git(["commit", "-m", "initial commit"]);
  store = new CheckpointStore();
});

afterEach(() => {
  fs.rmSync(repoDir, { recursive: true, force: true });
});

describe("CheckpointStore", () => {
  it("captureBaseline creates a turn-0 ref that resolves to a commit", () => {
    const ref = store.captureBaseline("thread-1", repoDir);

    expect(ref).toBe("refs/argusde/checkpoints/thread-1/turn/0");
    const sha = git(["rev-parse", ref]).trim();
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
  });

  it("captureCheckpoint snapshots uncommitted working-tree changes without touching the real git state", () => {
    store.captureBaseline("thread-1", repoDir);

    fs.writeFileSync(path.join(repoDir, "file.txt"), "hello\nworld\n");
    const ref = store.captureCheckpoint("thread-1", 1, repoDir);

    expect(ref).toBe("refs/argusde/checkpoints/thread-1/turn/1");
    // The real index/working tree must be untouched by the isolated capture
    // (a leading space in porcelain status means "modified in the worktree,
    // not staged" — trimming would eat that space and hide a real bug).
    expect(git(["status", "--porcelain"]).replace(/\n$/, "")).toBe(" M file.txt");
    expect(fs.readFileSync(path.join(repoDir, "file.txt"), "utf8")).toBe("hello\nworld\n");
  });

  it("captureCheckpoint produces a parentless commit each time (full snapshot, not incremental)", () => {
    const baselineRef = store.captureBaseline("thread-1", repoDir);
    fs.writeFileSync(path.join(repoDir, "file.txt"), "hello\nworld\n");
    const turn1Ref = store.captureCheckpoint("thread-1", 1, repoDir);

    const baselineParents = git(["log", "--pretty=%P", "-1", baselineRef]).trim();
    const turn1Parents = git(["log", "--pretty=%P", "-1", turn1Ref]).trim();

    expect(baselineParents).toBe("");
    expect(turn1Parents).toBe("");
  });

  it("diffCheckpoints reports the change between two checkpoints", () => {
    store.captureBaseline("thread-1", repoDir);
    fs.writeFileSync(path.join(repoDir, "file.txt"), "goodbye\n");
    store.captureCheckpoint("thread-1", 1, repoDir);

    const diff = store.diffCheckpoints("thread-1", 0, 1, repoDir);

    expect(diff).toContain("-hello");
    expect(diff).toContain("+goodbye");
  });

  it("scopes refs by threadId so two threads don't collide on the same turn number", () => {
    const refA = store.captureBaseline("thread-a", repoDir);
    const refB = store.captureBaseline("thread-b", repoDir);

    expect(refA).not.toBe(refB);
    expect(git(["rev-parse", refA]).trim()).not.toBe("");
    expect(git(["rev-parse", refB]).trim()).not.toBe("");
  });
});
