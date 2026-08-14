import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import http from "node:http";
import { WebSocket } from "ws";
import { agent, methods } from "@agentclientprotocol/sdk";
import { EventStore } from "../persistence/event-store.js";
import { CheckpointStore } from "../checkpoint/checkpoint-store.js";
import { AcpSession } from "../../utility/acp-session.js";
import { spawnAgentProcessTransport } from "../../utility/spawn-agent-process.js";
import { startWsServer, type WsServerHandle } from "./ws-server.js";
import type { ServerPush } from "../../shared/ws-protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureCliPath = path.resolve(__dirname, "../../../test/fixtures/fake-agent-cli.mjs");

let repoDir: string;
let dbDir: string;
let eventStore: EventStore;
let checkpointStore: CheckpointStore;
let server: WsServerHandle;
let client: WebSocket;
let received: ServerPush[];

function git(args: string[]): void {
  execFileSync("git", args, { cwd: repoDir });
}

function waitFor(predicate: (messages: ServerPush[]) => boolean, timeoutMs = 10_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const check = () => {
      if (predicate(received)) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`waitFor timed out; received: ${JSON.stringify(received)}`));
      setTimeout(check, 20);
    };
    check();
  });
}

async function send(command: Record<string, unknown>): Promise<Extract<ServerPush, { type: "command.result" }>> {
  client.send(JSON.stringify(command));
  await waitFor((messages) => messages.some((m) => m.type === "command.result" && m.commandId === command.commandId));
  const result = received.find((m) => m.type === "command.result" && m.commandId === command.commandId);
  return result as Extract<ServerPush, { type: "command.result" }>;
}

beforeEach(async () => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-ws-server-repo-"));
  git(["init", "--initial-branch=main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "ArgusDE Test"]);
  fs.writeFileSync(path.join(repoDir, "file.txt"), "hello\n");
  git(["add", "-A"]);
  git(["commit", "-m", "initial commit"]);

  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-ws-server-db-"));
  eventStore = new EventStore(path.join(dbDir, "argusde.sqlite"));
  checkpointStore = new CheckpointStore();

  process.env.ARGUSDE_FAKE_AGENT_STEPS = JSON.stringify([{ type: "message", text: "the fix is ready" }]);

  server = await startWsServer({
    host: "127.0.0.1",
    port: 0,
    eventStore,
    checkpointStore,
    createSession: (_threadId, cwd) =>
      new AcpSession({
        name: "argusde-server-test",
        cwd,
        createTransport: () => spawnAgentProcessTransport({ command: process.execPath, args: [fixtureCliPath], cwd }),
      }),
  });

  received = [];
  client = new WebSocket(`ws://127.0.0.1:${server.port}/ws`);
  // Attach the message listener before awaiting "open" — the server sends
  // server.welcome immediately on connection, which can otherwise race
  // ahead of a listener registered only after "open" resolves.
  client.on("message", (data) => {
    received.push(JSON.parse(data.toString()) as ServerPush);
  });
  await new Promise<void>((resolve, reject) => {
    client.once("open", () => resolve());
    client.once("error", reject);
  });
}, 20_000);

afterEach(async () => {
  delete process.env.ARGUSDE_FAKE_AGENT_STEPS;
  client.close();
  await server.close();
  eventStore.close();
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
  // Sibling to repoDir, not inside it — deleted separately for tests that
  // promoted a thread to a real worktree.
  fs.rmSync(`${repoDir}-worktrees`, { recursive: true, force: true });
}, 20_000);

describe("ws-server", () => {
  it(
    "sends a server.welcome message with an apiVersion on connect",
    async () => {
      await waitFor((messages) => messages.some((m) => m.type === "server.welcome"));
      const welcome = received.find((m) => m.type === "server.welcome");
      expect(welcome).toMatchObject({ type: "server.welcome", apiVersion: expect.any(String) });
    },
    20_000,
  );

  it("drives a full project -> thread -> message round trip, streaming the reply back over the same connection", async () => {
    const projectResult = await send({ type: "project.create", commandId: "c1", workspaceRoot: repoDir, title: "Test Project" });
    expect(projectResult.ok).toBe(true);
    const { projectId } = projectResult.ok ? (projectResult.result as { projectId: string }) : { projectId: "" };
    expect(projectId).toEqual(expect.any(String));
    expect(eventStore.getProject(projectId)).toMatchObject({ workspaceRoot: repoDir, title: "Test Project" });

    const threadResult = await send({ type: "thread.create", commandId: "c2", projectId, title: "Fix the bug" });
    expect(threadResult.ok).toBe(true);
    const { threadId } = threadResult.ok ? (threadResult.result as { threadId: string }) : { threadId: "" };
    expect(threadId).toEqual(expect.any(String));

    // Baseline checkpoint (turn 0) should already be captured by the time thread.create's command.result comes back.
    expect(eventStore.listCheckpoints(threadId).map((c) => c.turn)).toEqual([0]);

    const messageResult = await send({ type: "thread.send-message", commandId: "c3", threadId, text: "what's broken?" });
    expect(messageResult.ok).toBe(true);

    await waitFor((messages) =>
      messages.some(
        (m) =>
          m.type === "session.event" &&
          m.threadId === threadId &&
          m.event.kind === "message-chunk" &&
          m.event.content.type === "text" &&
          m.event.content.text === "the fix is ready",
      ),
    );

    expect(eventStore.listCheckpoints(threadId).map((c) => c.turn)).toEqual([0, 1]);
  }, 20_000);

  it("project.create is idempotent by workspaceRoot — a second call for the same path returns the existing project, not a duplicate", async () => {
    const firstResult = await send({ type: "project.create", commandId: "dp1", workspaceRoot: repoDir, title: "First title" });
    const { projectId: firstId } = firstResult.ok ? (firstResult.result as { projectId: string }) : { projectId: "" };

    const secondResult = await send({ type: "project.create", commandId: "dp2", workspaceRoot: repoDir, title: "Second title" });
    expect(secondResult.ok).toBe(true);
    const { projectId: secondId } = secondResult.ok ? (secondResult.result as { projectId: string }) : { projectId: "" };

    expect(secondId).toBe(firstId);
    expect(eventStore.listProjects().filter((p) => p.workspaceRoot === repoDir)).toHaveLength(1);
    // The original title is kept — a duplicate submission doesn't silently rename the existing project.
    expect(eventStore.getProject(firstId)?.title).toBe("First title");
  }, 20_000);

  it("lists checkpoints and diffs two of them via the WS API, reflecting a real filesystem change", async () => {
    const projectResult = await send({ type: "project.create", commandId: "cp1", workspaceRoot: repoDir, title: "P" });
    const { projectId } = projectResult.ok ? (projectResult.result as { projectId: string }) : { projectId: "" };
    const threadResult = await send({ type: "thread.create", commandId: "cp2", projectId, title: "T" });
    const { threadId } = threadResult.ok ? (threadResult.result as { threadId: string }) : { threadId: "" };

    await send({ type: "thread.send-message", commandId: "cp3", threadId, text: "first turn" });
    await waitFor((messages) => messages.some((m) => m.type === "session.event" && m.threadId === threadId && m.event.kind === "turn-complete"));

    // Modify the file directly (not through the fixture agent, which only
    // streams text) — isolates "checkpoint capture reflects real filesystem
    // state" from anything the agent itself does.
    fs.writeFileSync(path.join(repoDir, "file.txt"), "hello\nworld\n");

    await send({ type: "thread.send-message", commandId: "cp4", threadId, text: "second turn" });
    await waitFor(
      (messages) =>
        messages.filter((m) => m.type === "session.event" && m.threadId === threadId && m.event.kind === "turn-complete").length === 2,
    );

    const listResult = await send({ type: "thread.list-checkpoints", commandId: "cp5", threadId });
    expect(listResult.ok).toBe(true);
    const checkpoints = listResult.ok ? (listResult.result as { turn: number }[]) : [];
    expect(checkpoints.map((c) => c.turn)).toEqual([0, 1, 2]);

    const diffResult = await send({ type: "thread.diff-checkpoints", commandId: "cp6", threadId, turnA: 1, turnB: 2 });
    expect(diffResult.ok).toBe(true);
    const { diff } = diffResult.ok ? (diffResult.result as { diff: string }) : { diff: "" };
    expect(diff).toContain("file.txt");
    expect(diff).toContain("+world");
  }, 20_000);

  it("reverts a thread's workspace to an earlier checkpoint, capturing the restore forward as a new checkpoint", async () => {
    const projectResult = await send({ type: "project.create", commandId: "rv1", workspaceRoot: repoDir, title: "P" });
    const { projectId } = projectResult.ok ? (projectResult.result as { projectId: string }) : { projectId: "" };
    const threadResult = await send({ type: "thread.create", commandId: "rv2", projectId, title: "T" });
    const { threadId } = threadResult.ok ? (threadResult.result as { threadId: string }) : { threadId: "" };

    await send({ type: "thread.send-message", commandId: "rv3", threadId, text: "first turn" });
    await waitFor((messages) => messages.some((m) => m.type === "session.event" && m.threadId === threadId && m.event.kind === "turn-complete"));

    fs.writeFileSync(path.join(repoDir, "file.txt"), "hello\nworld\n");
    await send({ type: "thread.send-message", commandId: "rv4", threadId, text: "second turn" });
    await waitFor(
      (messages) =>
        messages.filter((m) => m.type === "session.event" && m.threadId === threadId && m.event.kind === "turn-complete").length === 2,
    );

    const revertResult = await send({ type: "thread.revert-checkpoint", commandId: "rv5", threadId, turn: 1 });
    expect(revertResult.ok).toBe(true);
    // Two new checkpoints, not one: a safety snapshot of whatever was
    // about to be overwritten (turn 3, unmarked), then the actual restored
    // state (turn 4, marked) — nothing is ever silently discarded.
    expect(revertResult.ok ? revertResult.result : null).toEqual({ newTurn: 4 });

    expect(fs.readFileSync(path.join(repoDir, "file.txt"), "utf8")).toBe("hello\n");

    const listResult = await send({ type: "thread.list-checkpoints", commandId: "rv6", threadId });
    const checkpoints = listResult.ok ? (listResult.result as { turn: number; revertedToTurn: number | null }[]) : [];
    expect(checkpoints.map((c) => ({ turn: c.turn, revertedToTurn: c.revertedToTurn }))).toEqual([
      { turn: 0, revertedToTurn: null },
      { turn: 1, revertedToTurn: null },
      { turn: 2, revertedToTurn: null },
      { turn: 3, revertedToTurn: null },
      { turn: 4, revertedToTurn: 1 },
    ]);
  }, 20_000);

  it("refuses to revert to an unknown checkpoint turn", async () => {
    const projectResult = await send({ type: "project.create", commandId: "rv7", workspaceRoot: repoDir, title: "P" });
    const { projectId } = projectResult.ok ? (projectResult.result as { projectId: string }) : { projectId: "" };
    const threadResult = await send({ type: "thread.create", commandId: "rv8", projectId, title: "T" });
    const { threadId } = threadResult.ok ? (threadResult.result as { threadId: string }) : { threadId: "" };

    const revertResult = await send({ type: "thread.revert-checkpoint", commandId: "rv9", threadId, turn: 99 });
    expect(revertResult.ok).toBe(false);
  }, 20_000);

  it(
    "refuses to revert while a turn is still in flight (message sent, not yet complete)",
    async () => {
      let releasePrompt: (() => void) | undefined;
      const slowAgent = agent({ name: "slow-agent" })
        .onRequest(methods.agent.initialize, async () => ({ protocolVersion: 1, agentCapabilities: {} }))
        .onRequest(methods.agent.session.new, async () => ({ sessionId: "slow-session" }))
        .onRequest(
          methods.agent.session.prompt,
          () =>
            new Promise((resolve) => {
              releasePrompt = () => resolve({ stopReason: "end_turn" });
            }),
        );

      const slowServer = await startWsServer({
        host: "127.0.0.1",
        port: 0,
        eventStore,
        checkpointStore,
        createSession: (_threadId, cwd) => new AcpSession({ name: "argusde-slow-test", cwd, createTransport: () => slowAgent }),
      });
      const slowClient = new WebSocket(`ws://127.0.0.1:${slowServer.port}/ws`);
      const slowReceived: ServerPush[] = [];
      slowClient.on("message", (data) => slowReceived.push(JSON.parse(data.toString()) as ServerPush));
      await new Promise<void>((resolve, reject) => {
        slowClient.once("open", () => resolve());
        slowClient.once("error", reject);
      });

      async function slowSend(command: Record<string, unknown>) {
        slowClient.send(JSON.stringify(command));
        await new Promise<void>((resolve, reject) => {
          const start = Date.now();
          const check = () => {
            if (slowReceived.some((m) => m.type === "command.result" && m.commandId === command.commandId)) return resolve();
            if (Date.now() - start > 10_000) return reject(new Error("timed out waiting for command.result"));
            setTimeout(check, 20);
          };
          check();
        });
        return slowReceived.find((m) => m.type === "command.result" && m.commandId === command.commandId) as Extract<
          ServerPush,
          { type: "command.result" }
        >;
      }

      try {
        const projectResult = await slowSend({ type: "project.create", commandId: "sl1", workspaceRoot: repoDir, title: "P" });
        const { projectId } = projectResult.ok ? (projectResult.result as { projectId: string }) : { projectId: "" };
        const threadResult = await slowSend({ type: "thread.create", commandId: "sl2", projectId, title: "T" });
        const { threadId } = threadResult.ok ? (threadResult.result as { threadId: string }) : { threadId: "" };

        slowClient.send(JSON.stringify({ type: "thread.send-message", commandId: "sl3", threadId, text: "hello" }));
        await new Promise((resolve) => setTimeout(resolve, 100));

        const revertResult = await slowSend({ type: "thread.revert-checkpoint", commandId: "sl4", threadId, turn: 0 });
        expect(revertResult.ok).toBe(false);

        releasePrompt?.();
        await new Promise((resolve) => setTimeout(resolve, 100));
      } finally {
        slowClient.close();
        await slowServer.close();
      }
    },
    20_000,
  );

  it("promotes a fresh thread to a real worktree, relocates its session, and shares checkpoint refs with the main repo", async () => {
    const projectResult = await send({ type: "project.create", commandId: "wt1", workspaceRoot: repoDir, title: "P" });
    const { projectId } = projectResult.ok ? (projectResult.result as { projectId: string }) : { projectId: "" };
    const threadResult = await send({ type: "thread.create", commandId: "wt2", projectId, title: "T" });
    const { threadId } = threadResult.ok ? (threadResult.result as { threadId: string }) : { threadId: "" };

    const promoteResult = await send({ type: "thread.promote-to-worktree", commandId: "wt3", threadId });
    expect(promoteResult.ok).toBe(true);
    const { worktreePath } = promoteResult.ok ? (promoteResult.result as { worktreePath: string }) : { worktreePath: "" };
    expect(worktreePath).toBe(`${repoDir}-worktrees/${threadId}`);
    expect(fs.existsSync(worktreePath)).toBe(true);

    // A subsequent turn's checkpoint is captured from inside the worktree
    // (the relocated runtime's new cwd) — proving the session actually
    // moved, not just the persisted record.
    fs.writeFileSync(path.join(worktreePath, "file.txt"), "hello\nfrom the worktree\n");
    await send({ type: "thread.send-message", commandId: "wt4", threadId, text: "go" });
    await waitFor((messages) => messages.some((m) => m.type === "session.event" && m.threadId === threadId && m.event.kind === "turn-complete"));

    // The checkpoint ref written from inside the worktree must resolve from
    // the *main* repo too — the shared-object-database claim this whole
    // feature depends on, proven for real rather than assumed.
    const ref = "refs/argusde/checkpoints/" + threadId + "/turn/1";
    expect(() => execFileSync("git", ["rev-parse", ref], { cwd: repoDir })).not.toThrow();
  }, 20_000);

  it("refuses to promote a thread a second time", async () => {
    const projectResult = await send({ type: "project.create", commandId: "wt5", workspaceRoot: repoDir, title: "P" });
    const { projectId } = projectResult.ok ? (projectResult.result as { projectId: string }) : { projectId: "" };
    const threadResult = await send({ type: "thread.create", commandId: "wt6", projectId, title: "T" });
    const { threadId } = threadResult.ok ? (threadResult.result as { threadId: string }) : { threadId: "" };

    await send({ type: "thread.promote-to-worktree", commandId: "wt7", threadId });
    const secondAttempt = await send({ type: "thread.promote-to-worktree", commandId: "wt8", threadId });
    expect(secondAttempt.ok).toBe(false);
  }, 20_000);

  it("refuses to promote a thread once a message has already been sent", async () => {
    const projectResult = await send({ type: "project.create", commandId: "wt9", workspaceRoot: repoDir, title: "P" });
    const { projectId } = projectResult.ok ? (projectResult.result as { projectId: string }) : { projectId: "" };
    const threadResult = await send({ type: "thread.create", commandId: "wt10", projectId, title: "T" });
    const { threadId } = threadResult.ok ? (threadResult.result as { threadId: string }) : { threadId: "" };

    await send({ type: "thread.send-message", commandId: "wt11", threadId, text: "hi" });
    await waitFor((messages) => messages.some((m) => m.type === "session.event" && m.threadId === threadId && m.event.kind === "turn-complete"));

    const promoteResult = await send({ type: "thread.promote-to-worktree", commandId: "wt12", threadId });
    expect(promoteResult.ok).toBe(false);
  }, 20_000);

  it(
    "refuses to promote a thread while a turn is still in flight (message sent, not yet complete) — not just after it finishes",
    async () => {
      // A checkpoint only lands once completeTurn() fires on turn-complete —
      // checking checkpoint count alone would still read "just the
      // baseline" while a turn is mid-flight, wrongly allowing promotion to
      // dispose the live session out from under the pending sendMessage()
      // call. This dedicated server's agent never resolves session/prompt
      // until the test manually releases it, so the race window is real and
      // controllable rather than assumed.
      let releasePrompt: (() => void) | undefined;
      const slowAgent = agent({ name: "slow-agent" })
        .onRequest(methods.agent.initialize, async () => ({ protocolVersion: 1, agentCapabilities: {} }))
        .onRequest(methods.agent.session.new, async () => ({ sessionId: "slow-session" }))
        .onRequest(
          methods.agent.session.prompt,
          () =>
            new Promise((resolve) => {
              releasePrompt = () => resolve({ stopReason: "end_turn" });
            }),
        );

      const slowServer = await startWsServer({
        host: "127.0.0.1",
        port: 0,
        eventStore,
        checkpointStore,
        createSession: (_threadId, cwd) => new AcpSession({ name: "argusde-slow-test", cwd, createTransport: () => slowAgent }),
      });
      const slowClient = new WebSocket(`ws://127.0.0.1:${slowServer.port}/ws`);
      const slowReceived: ServerPush[] = [];
      slowClient.on("message", (data) => slowReceived.push(JSON.parse(data.toString()) as ServerPush));
      await new Promise<void>((resolve, reject) => {
        slowClient.once("open", () => resolve());
        slowClient.once("error", reject);
      });
      const slowWaitFor = (predicate: (m: ServerPush[]) => boolean, timeoutMs = 10_000) =>
        new Promise<void>((resolve, reject) => {
          const start = Date.now();
          const check = () => {
            if (predicate(slowReceived)) return resolve();
            if (Date.now() - start > timeoutMs) return reject(new Error(`slowWaitFor timed out; received: ${JSON.stringify(slowReceived)}`));
            setTimeout(check, 20);
          };
          check();
        });
      const slowSend = async (command: Record<string, unknown>) => {
        slowClient.send(JSON.stringify(command));
        await slowWaitFor((messages) => messages.some((m) => m.type === "command.result" && m.commandId === command.commandId));
        return slowReceived.find((m) => m.type === "command.result" && m.commandId === command.commandId) as Extract<
          ServerPush,
          { type: "command.result" }
        >;
      };

      try {
        const projectResult = await slowSend({ type: "project.create", commandId: "s1", workspaceRoot: repoDir, title: "P" });
        const { projectId } = projectResult.ok ? (projectResult.result as { projectId: string }) : { projectId: "" };
        const threadResult = await slowSend({ type: "thread.create", commandId: "s2", projectId, title: "T" });
        const { threadId } = threadResult.ok ? (threadResult.result as { threadId: string }) : { threadId: "" };

        // Fire-and-forget: don't await this one, since session/prompt won't
        // resolve until we release it below — this is the whole point.
        slowClient.send(JSON.stringify({ type: "thread.send-message", commandId: "s3", threadId, text: "go" }));
        await new Promise<void>((resolve) => {
          const check = () => (releasePrompt ? resolve() : setTimeout(check, 5));
          check();
        });

        const promoteResult = await slowSend({ type: "thread.promote-to-worktree", commandId: "s4", threadId });
        expect(promoteResult.ok).toBe(false);

        releasePrompt!();
        await slowWaitFor((messages) => messages.some((m) => m.type === "command.result" && m.commandId === "s3"));
      } finally {
        slowClient.close();
        await slowServer.close();
      }
    },
    20_000,
  );

  it("closes a non-worktree thread — disposes its session, captures a final checkpoint, and a subsequent send-message fails clearly", async () => {
    const projectResult = await send({ type: "project.create", commandId: "cl1", workspaceRoot: repoDir, title: "P" });
    const { projectId } = projectResult.ok ? (projectResult.result as { projectId: string }) : { projectId: "" };
    const threadResult = await send({ type: "thread.create", commandId: "cl2", projectId, title: "T" });
    const { threadId } = threadResult.ok ? (threadResult.result as { threadId: string }) : { threadId: "" };

    await send({ type: "thread.send-message", commandId: "cl3", threadId, text: "hi" });
    await waitFor((messages) => messages.some((m) => m.type === "session.event" && m.threadId === threadId && m.event.kind === "turn-complete"));

    fs.writeFileSync(path.join(repoDir, "file.txt"), "hello\nuncaptured edit before close\n");

    const closeResult = await send({ type: "thread.close", commandId: "cl4", threadId });
    expect(closeResult.ok).toBe(true);

    // The final safety checkpoint (turn 2: baseline=0, first turn=1) must
    // have captured the uncaptured edit before the runtime was torn down.
    const listResult = await send({ type: "thread.list-checkpoints", commandId: "cl5", threadId });
    const checkpoints = listResult.ok ? (listResult.result as { turn: number }[]) : [];
    expect(checkpoints.map((c) => c.turn)).toEqual([0, 1, 2]);
    const diff = checkpointStore.diffCheckpoints(threadId, 1, 2, repoDir);
    expect(diff).toContain("+uncaptured edit before close");

    const sendAfterClose = await send({ type: "thread.send-message", commandId: "cl6", threadId, text: "still there?" });
    expect(sendAfterClose.ok).toBe(false);
  }, 20_000);

  it("closes a promoted thread — the worktree directory is actually removed from disk", async () => {
    const projectResult = await send({ type: "project.create", commandId: "cl7", workspaceRoot: repoDir, title: "P" });
    const { projectId } = projectResult.ok ? (projectResult.result as { projectId: string }) : { projectId: "" };
    const threadResult = await send({ type: "thread.create", commandId: "cl8", projectId, title: "T" });
    const { threadId } = threadResult.ok ? (threadResult.result as { threadId: string }) : { threadId: "" };

    const promoteResult = await send({ type: "thread.promote-to-worktree", commandId: "cl9", threadId });
    const { worktreePath } = promoteResult.ok ? (promoteResult.result as { worktreePath: string }) : { worktreePath: "" };
    expect(fs.existsSync(worktreePath)).toBe(true);

    const closeResult = await send({ type: "thread.close", commandId: "cl10", threadId });
    expect(closeResult.ok).toBe(true);

    expect(fs.existsSync(worktreePath)).toBe(false);
  }, 20_000);

  it(
    "closing a promoted thread with no live runtime (e.g. after a server restart) still captures a final checkpoint before removing the worktree",
    async () => {
      const projectResult = await send({ type: "project.create", commandId: "cl21", workspaceRoot: repoDir, title: "P" });
      const { projectId } = projectResult.ok ? (projectResult.result as { projectId: string }) : { projectId: "" };
      const threadResult = await send({ type: "thread.create", commandId: "cl22", projectId, title: "T" });
      const { threadId } = threadResult.ok ? (threadResult.result as { threadId: string }) : { threadId: "" };

      const promoteResult = await send({ type: "thread.promote-to-worktree", commandId: "cl23", threadId });
      const { worktreePath } = promoteResult.ok ? (promoteResult.result as { worktreePath: string }) : { worktreePath: "" };
      expect(fs.existsSync(worktreePath)).toBe(true);

      fs.writeFileSync(path.join(worktreePath, "file.txt"), "hello\nnever checkpointed by a real turn\n");

      // A second server, sharing the same eventStore/checkpointStore, whose
      // own `runtimes` map starts empty — the same "no live runtime for a
      // persisted, promoted Thread" state a real server restart produces
      // (confirmed: nothing restores `runtimes` on startup).
      const restartedServer = await startWsServer({
        host: "127.0.0.1",
        port: 0,
        eventStore,
        checkpointStore,
        createSession: (_threadId, cwd) =>
          new AcpSession({
            name: "argusde-server-test",
            cwd,
            createTransport: () => spawnAgentProcessTransport({ command: process.execPath, args: [fixtureCliPath], cwd }),
          }),
      });
      const restartedClient = new WebSocket(`ws://127.0.0.1:${restartedServer.port}/ws`);
      const restartedReceived: ServerPush[] = [];
      restartedClient.on("message", (data) => restartedReceived.push(JSON.parse(data.toString()) as ServerPush));
      await new Promise<void>((resolve, reject) => {
        restartedClient.once("open", () => resolve());
        restartedClient.once("error", reject);
      });
      const restartedSend = async (command: Record<string, unknown>) => {
        restartedClient.send(JSON.stringify(command));
        await new Promise<void>((resolve, reject) => {
          const start = Date.now();
          const check = () => {
            if (restartedReceived.some((m) => m.type === "command.result" && m.commandId === command.commandId)) return resolve();
            if (Date.now() - start > 10_000) return reject(new Error("timed out waiting for command.result"));
            setTimeout(check, 20);
          };
          check();
        });
        return restartedReceived.find((m) => m.type === "command.result" && m.commandId === command.commandId) as Extract<
          ServerPush,
          { type: "command.result" }
        >;
      };

      try {
        const closeResult = await restartedSend({ type: "thread.close", commandId: "cl24", threadId });
        expect(closeResult.ok).toBe(true);

        expect(fs.existsSync(worktreePath)).toBe(false);

        // The marker edit must have been captured as a checkpoint BEFORE
        // the worktree (its only copy) was destroyed — not silently lost.
        const listResult = await restartedSend({ type: "thread.list-checkpoints", commandId: "cl25", threadId });
        const checkpoints = listResult.ok ? (listResult.result as { turn: number }[]) : [];
        expect(checkpoints.map((c) => c.turn)).toEqual([0, 1]);
        const diff = checkpointStore.diffCheckpoints(threadId, 0, 1, repoDir);
        expect(diff).toContain("+never checkpointed by a real turn");
      } finally {
        restartedClient.close();
        await restartedServer.close();
      }
    },
    20_000,
  );

  it("refuses to close an already-closed thread", async () => {
    const projectResult = await send({ type: "project.create", commandId: "cl11", workspaceRoot: repoDir, title: "P" });
    const { projectId } = projectResult.ok ? (projectResult.result as { projectId: string }) : { projectId: "" };
    const threadResult = await send({ type: "thread.create", commandId: "cl12", projectId, title: "T" });
    const { threadId } = threadResult.ok ? (threadResult.result as { threadId: string }) : { threadId: "" };

    await send({ type: "thread.close", commandId: "cl13", threadId });
    const secondClose = await send({ type: "thread.close", commandId: "cl14", threadId });
    expect(secondClose.ok).toBe(false);
  }, 20_000);

  it("read-only commands keep working on a closed thread — history stays browsable", async () => {
    const projectResult = await send({ type: "project.create", commandId: "cl15", workspaceRoot: repoDir, title: "P" });
    const { projectId } = projectResult.ok ? (projectResult.result as { projectId: string }) : { projectId: "" };
    const threadResult = await send({ type: "thread.create", commandId: "cl16", projectId, title: "T" });
    const { threadId } = threadResult.ok ? (threadResult.result as { threadId: string }) : { threadId: "" };

    await send({ type: "thread.send-message", commandId: "cl17", threadId, text: "hi" });
    await waitFor((messages) => messages.some((m) => m.type === "session.event" && m.threadId === threadId && m.event.kind === "turn-complete"));
    await send({ type: "thread.close", commandId: "cl18", threadId });

    const historyResult = await send({ type: "thread.get-history", commandId: "cl19", threadId });
    expect(historyResult.ok).toBe(true);
    const history = historyResult.ok ? (historyResult.result as { messages: unknown[] }) : { messages: [] };
    expect(history.messages.length).toBeGreaterThan(0);

    const listResult = await send({ type: "thread.list-checkpoints", commandId: "cl20", threadId });
    expect(listResult.ok).toBe(true);
  }, 20_000);

  it(
    "refuses to close a thread while a turn is still in flight",
    async () => {
      let releasePrompt: (() => void) | undefined;
      const slowAgent = agent({ name: "slow-agent" })
        .onRequest(methods.agent.initialize, async () => ({ protocolVersion: 1, agentCapabilities: {} }))
        .onRequest(methods.agent.session.new, async () => ({ sessionId: "slow-session" }))
        .onRequest(
          methods.agent.session.prompt,
          () =>
            new Promise((resolve) => {
              releasePrompt = () => resolve({ stopReason: "end_turn" });
            }),
        );

      const slowServer = await startWsServer({
        host: "127.0.0.1",
        port: 0,
        eventStore,
        checkpointStore,
        createSession: (_threadId, cwd) => new AcpSession({ name: "argusde-slow-test", cwd, createTransport: () => slowAgent }),
      });
      const slowClient = new WebSocket(`ws://127.0.0.1:${slowServer.port}/ws`);
      const slowReceived: ServerPush[] = [];
      slowClient.on("message", (data) => slowReceived.push(JSON.parse(data.toString()) as ServerPush));
      await new Promise<void>((resolve, reject) => {
        slowClient.once("open", () => resolve());
        slowClient.once("error", reject);
      });
      const slowWaitFor = (predicate: (m: ServerPush[]) => boolean, timeoutMs = 10_000) =>
        new Promise<void>((resolve, reject) => {
          const start = Date.now();
          const check = () => {
            if (predicate(slowReceived)) return resolve();
            if (Date.now() - start > timeoutMs) return reject(new Error(`slowWaitFor timed out; received: ${JSON.stringify(slowReceived)}`));
            setTimeout(check, 20);
          };
          check();
        });
      const slowSend = async (command: Record<string, unknown>) => {
        slowClient.send(JSON.stringify(command));
        await slowWaitFor((messages) => messages.some((m) => m.type === "command.result" && m.commandId === command.commandId));
        return slowReceived.find((m) => m.type === "command.result" && m.commandId === command.commandId) as Extract<
          ServerPush,
          { type: "command.result" }
        >;
      };

      try {
        const projectResult = await slowSend({ type: "project.create", commandId: "s5", workspaceRoot: repoDir, title: "P" });
        const { projectId } = projectResult.ok ? (projectResult.result as { projectId: string }) : { projectId: "" };
        const threadResult = await slowSend({ type: "thread.create", commandId: "s6", projectId, title: "T" });
        const { threadId } = threadResult.ok ? (threadResult.result as { threadId: string }) : { threadId: "" };

        slowClient.send(JSON.stringify({ type: "thread.send-message", commandId: "s7", threadId, text: "go" }));
        await new Promise<void>((resolve) => {
          const check = () => (releasePrompt ? resolve() : setTimeout(check, 5));
          check();
        });

        const closeResult = await slowSend({ type: "thread.close", commandId: "s8", threadId });
        expect(closeResult.ok).toBe(false);

        releasePrompt!();
        await slowWaitFor((messages) => messages.some((m) => m.type === "command.result" && m.commandId === "s7"));
      } finally {
        slowClient.close();
        await slowServer.close();
      }
    },
    20_000,
  );

  it("lists projects and lists a project's threads via the WS API", async () => {
    const projectResult = await send({ type: "project.create", commandId: "pl1", workspaceRoot: repoDir, title: "P" });
    const { projectId } = projectResult.ok ? (projectResult.result as { projectId: string }) : { projectId: "" };
    const thread1Result = await send({ type: "thread.create", commandId: "pl2", projectId, title: "First" });
    const { threadId: threadId1 } = thread1Result.ok ? (thread1Result.result as { threadId: string }) : { threadId: "" };
    const thread2Result = await send({ type: "thread.create", commandId: "pl3", projectId, title: "Second" });
    const { threadId: threadId2 } = thread2Result.ok ? (thread2Result.result as { threadId: string }) : { threadId: "" };

    const projectsResult = await send({ type: "project.list", commandId: "pl4" });
    expect(projectsResult.ok).toBe(true);
    const projects = projectsResult.ok ? (projectsResult.result as { id: string }[]) : [];
    expect(projects.map((p) => p.id)).toContain(projectId);

    const threadsResult = await send({ type: "thread.list", commandId: "pl5", projectId });
    expect(threadsResult.ok).toBe(true);
    const threads = threadsResult.ok ? (threadsResult.result as { id: string; title: string }[]) : [];
    expect(threads.map((t) => t.id).sort()).toEqual([threadId1, threadId2].sort());
    expect(threads.map((t) => t.title).sort()).toEqual(["First", "Second"]);
  }, 20_000);

  it("thread.get-history returns a thread's persisted messages, mode catalog, and worktree state", async () => {
    const projectResult = await send({ type: "project.create", commandId: "gh1", workspaceRoot: repoDir, title: "P" });
    const { projectId } = projectResult.ok ? (projectResult.result as { projectId: string }) : { projectId: "" };
    const threadResult = await send({ type: "thread.create", commandId: "gh2", projectId, title: "T" });
    const { threadId } = threadResult.ok ? (threadResult.result as { threadId: string }) : { threadId: "" };

    await send({ type: "thread.send-message", commandId: "gh3", threadId, text: "what's broken?" });
    await waitFor((messages) => messages.some((m) => m.type === "session.event" && m.threadId === threadId && m.event.kind === "turn-complete"));

    const historyResult = await send({ type: "thread.get-history", commandId: "gh4", threadId });
    expect(historyResult.ok).toBe(true);
    const history = historyResult.ok
      ? (historyResult.result as {
          threadId: string;
          projectId: string;
          title: string;
          worktreePath: string | null;
          currentModeId: string | null;
          availableModes: unknown[];
          messages: { role: string; content: unknown[] }[];
        })
      : null;

    expect(history?.threadId).toBe(threadId);
    expect(history?.projectId).toBe(projectId);
    expect(history?.title).toBe("T");
    expect(history?.worktreePath).toBeNull();
    expect(history?.messages.map((m) => m.role)).toEqual(["user", "agent"]);
    expect(history?.messages[0]?.content).toEqual([{ type: "text", text: "what's broken?" }]);
    expect(history?.messages[1]?.content).toEqual([{ type: "text", text: "the fix is ready" }]);
  }, 20_000);

  it("thread.get-history includes the connected runtime's last-known connection state, not just its mode/message history", async () => {
    const projectResult = await send({ type: "project.create", commandId: "cs1", workspaceRoot: repoDir, title: "P" });
    const { projectId } = projectResult.ok ? (projectResult.result as { projectId: string }) : { projectId: "" };
    const threadResult = await send({ type: "thread.create", commandId: "cs2", projectId, title: "T" });
    const { threadId } = threadResult.ok ? (threadResult.result as { threadId: string }) : { threadId: "" };

    const historyResult = await send({ type: "thread.get-history", commandId: "cs3", threadId });
    expect(historyResult.ok).toBe(true);
    const history = historyResult.ok ? (historyResult.result as { connectionState: string; connectionError: string | undefined }) : null;
    expect(history?.connectionState).toBe("connected");
    expect(history?.connectionError).toBeUndefined();
  }, 20_000);

  it("thread.get-history includes the mode catalog cached from a still-live runtime, even though it's never persisted", async () => {
    process.env.ARGUSDE_FAKE_AGENT_MODES = JSON.stringify({
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Default" },
        { id: "plan", name: "Plan" },
      ],
    });
    try {
      const projectResult = await send({ type: "project.create", commandId: "gh5", workspaceRoot: repoDir, title: "P" });
      const { projectId } = projectResult.ok ? (projectResult.result as { projectId: string }) : { projectId: "" };
      const threadResult = await send({ type: "thread.create", commandId: "gh6", projectId, title: "T" });
      const { threadId } = threadResult.ok ? (threadResult.result as { threadId: string }) : { threadId: "" };

      const historyResult = await send({ type: "thread.get-history", commandId: "gh7", threadId });
      expect(historyResult.ok).toBe(true);
      const availableModes = historyResult.ok ? (historyResult.result as { availableModes: { id: string }[] }).availableModes : [];
      expect(availableModes.map((m) => m.id)).toEqual(["default", "plan"]);
    } finally {
      delete process.env.ARGUSDE_FAKE_AGENT_MODES;
    }
  }, 20_000);

  it("a Thread's live events don't bleed into another Thread's history — cross-thread isolation at the protocol level", async () => {
    const projectResult = await send({ type: "project.create", commandId: "ci1", workspaceRoot: repoDir, title: "P" });
    const { projectId } = projectResult.ok ? (projectResult.result as { projectId: string }) : { projectId: "" };
    const threadAResult = await send({ type: "thread.create", commandId: "ci2", projectId, title: "A" });
    const { threadId: threadIdA } = threadAResult.ok ? (threadAResult.result as { threadId: string }) : { threadId: "" };
    const threadBResult = await send({ type: "thread.create", commandId: "ci3", projectId, title: "B" });
    const { threadId: threadIdB } = threadBResult.ok ? (threadBResult.result as { threadId: string }) : { threadId: "" };

    await send({ type: "thread.send-message", commandId: "ci4", threadId: threadIdA, text: "hello from A" });
    await waitFor((messages) => messages.some((m) => m.type === "session.event" && m.threadId === threadIdA && m.event.kind === "turn-complete"));

    const historyB = await send({ type: "thread.get-history", commandId: "ci5", threadId: threadIdB });
    expect(historyB.ok).toBe(true);
    const messagesB = historyB.ok ? (historyB.result as { messages: unknown[] }).messages : [];
    expect(messagesB).toEqual([]);
  }, 20_000);

  it(
    "replies with ok: false and an error message for a command referencing an unknown thread",
    async () => {
      const result = await send({ type: "thread.send-message", commandId: "c1", threadId: "does-not-exist", text: "hi" });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toEqual(expect.any(String));
    },
    20_000,
  );

  it(
    "thread.create replies ok: false and disposes the session when the agent fails to start, without crashing the server",
    async () => {
      const failingServer = await startWsServer({
        host: "127.0.0.1",
        port: 0,
        eventStore,
        checkpointStore,
        createSession: (_threadId, cwd) =>
          new AcpSession({
            name: "argusde-server-test",
            cwd,
            createTransport: () =>
              agent({ name: "failing-agent" }).onRequest(methods.agent.initialize, async () => {
                throw new Error("simulated agent startup failure");
              }),
          }),
      });
      const failingClient = new WebSocket(`ws://127.0.0.1:${failingServer.port}/ws`);
      const failingReceived: ServerPush[] = [];
      failingClient.on("message", (data) => failingReceived.push(JSON.parse(data.toString()) as ServerPush));
      await new Promise<void>((resolve, reject) => {
        failingClient.once("open", () => resolve());
        failingClient.once("error", reject);
      });

      failingClient.send(JSON.stringify({ type: "project.create", commandId: "p1", workspaceRoot: repoDir, title: "P" }));
      await waitFor(() => failingReceived.some((m) => m.type === "command.result" && m.commandId === "p1"));
      const projectCreateResult = failingReceived.find(
        (m) => m.type === "command.result" && m.commandId === "p1",
      ) as Extract<ServerPush, { type: "command.result" }>;
      const projectId = projectCreateResult.ok ? (projectCreateResult.result as { projectId: string }).projectId : undefined;

      failingClient.send(JSON.stringify({ type: "thread.create", commandId: "t1", projectId, title: "T" }));
      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const check = () => {
          if (failingReceived.some((m) => m.type === "command.result" && m.commandId === "t1")) return resolve();
          if (Date.now() - start > 5000) return reject(new Error("timed out"));
          setTimeout(check, 20);
        };
        check();
      });

      const threadResult = failingReceived.find((m) => m.type === "command.result" && m.commandId === "t1") as Extract<
        ServerPush,
        { type: "command.result" }
      >;
      // The ACP SDK wraps a thrown handler error as a generic JSON-RPC error
      // rather than propagating the original message text — just assert the
      // command failed cleanly with some error, not the exact wording.
      expect(threadResult.ok).toBe(false);
      if (!threadResult.ok) expect(threadResult.error).toEqual(expect.any(String));

      // The server itself must still be responsive after the failed thread.create.
      failingClient.send(JSON.stringify({ type: "project.create", commandId: "p2", workspaceRoot: repoDir, title: "P2" }));
      await new Promise<void>((resolve, reject) => {
        const start = Date.now();
        const check = () => {
          if (failingReceived.some((m) => m.type === "command.result" && m.commandId === "p2")) return resolve();
          if (Date.now() - start > 5000) return reject(new Error("timed out"));
          setTimeout(check, 20);
        };
        check();
      });

      failingClient.terminate();
      await failingServer.close();
    },
    15_000,
  );

  it(
    "close() resolves even when a connected client never closes itself first",
    async () => {
      // wss.close()'s callback only fires once every currently-connected
      // client has disconnected — close() must terminate lingering clients
      // itself rather than waiting on them to leave voluntarily.
      const danglingServer = await startWsServer({
        host: "127.0.0.1",
        port: 0,
        eventStore,
        checkpointStore,
        createSession: (_threadId, cwd) =>
          new AcpSession({
            name: "argusde-server-test",
            cwd,
            createTransport: () => spawnAgentProcessTransport({ command: process.execPath, args: [fixtureCliPath], cwd }),
          }),
      });
      const danglingClient = new WebSocket(`ws://127.0.0.1:${danglingServer.port}/ws`);
      await new Promise<void>((resolve, reject) => {
        danglingClient.once("open", () => resolve());
        danglingClient.once("error", reject);
      });

      // Intentionally never call danglingClient.close() — this is the case
      // that used to hang.
      await danglingServer.close();
    },
    5_000,
  );

  it("returns 404 for HTTP requests when no webDistDir is configured, without affecting the WS API", async () => {
    const res = await fetch(`http://127.0.0.1:${server.port}/`);
    expect(res.status).toBe(404);

    // The WS connection from beforeEach must still be perfectly usable.
    const result = await send({ type: "project.create", commandId: "http1", workspaceRoot: repoDir, title: "P" });
    expect(result.ok).toBe(true);
  });

  it(
    "serves the configured webDistDir over plain HTTP on the same port the WS API uses",
    async () => {
      const webDistDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-web-dist-"));
      fs.writeFileSync(path.join(webDistDir, "index.html"), "<!doctype html><title>ArgusDE</title>");

      const staticServer = await startWsServer({
        host: "127.0.0.1",
        port: 0,
        eventStore,
        checkpointStore,
        webDistDir,
        createSession: (_threadId, cwd) =>
          new AcpSession({
            name: "argusde-server-test",
            cwd,
            createTransport: () => spawnAgentProcessTransport({ command: process.execPath, args: [fixtureCliPath], cwd }),
          }),
      });

      try {
        const res = await fetch(`http://127.0.0.1:${staticServer.port}/`);
        expect(res.status).toBe(200);
        expect(await res.text()).toContain("<title>ArgusDE</title>");

        // The WS upgrade must still work on /ws on the very same port.
        const wsClient = new WebSocket(`ws://127.0.0.1:${staticServer.port}/ws`);
        const gotWelcome = await new Promise<boolean>((resolve, reject) => {
          wsClient.once("message", (data) => {
            const msg = JSON.parse(data.toString());
            resolve(msg.type === "server.welcome");
          });
          wsClient.once("error", reject);
        });
        expect(gotWelcome).toBe(true);
        wsClient.terminate();
      } finally {
        await staticServer.close();
        fs.rmSync(webDistDir, { recursive: true, force: true });
      }
    },
    15_000,
  );

  it(
    "close() doesn't stall on a lingering idle keep-alive HTTP connection",
    async () => {
      // Dedicated server — this test closes it itself, and the outer
      // afterEach already closes the shared one.
      const dedicatedServer = await startWsServer({
        host: "127.0.0.1",
        port: 0,
        eventStore,
        checkpointStore,
        createSession: (_threadId, cwd) =>
          new AcpSession({
            name: "argusde-server-test",
            cwd,
            createTransport: () => spawnAgentProcessTransport({ command: process.execPath, args: [fixtureCliPath], cwd }),
          }),
      });

      // A keep-alive agent leaves its socket open (idle, pooled for reuse)
      // after the response completes — exactly what a browser or fetch's
      // connection pooling does for a static-asset request.
      const keepAliveAgent = new http.Agent({ keepAlive: true });
      try {
        await new Promise<void>((resolve, reject) => {
          const req = http.request({ host: "127.0.0.1", port: dedicatedServer.port, path: "/", agent: keepAliveAgent }, (res) => {
            res.resume();
            res.on("end", () => resolve());
          });
          req.on("error", reject);
          req.end();
        });

        const start = Date.now();
        await dedicatedServer.close();
        const elapsedMs = Date.now() - start;

        // Node's default keepAliveTimeout is 5000ms — without forcing the
        // idle connection closed, close() waits close to that. A healthy
        // close should be near-instant.
        expect(elapsedMs).toBeLessThan(2000);
      } finally {
        keepAliveAgent.destroy();
      }
    },
    10_000,
  );
});
