import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";
import { agent, methods } from "@agentclientprotocol/sdk";
import { EventStore } from "../persistence/event-store.js";
import { CheckpointStore } from "../checkpoint/checkpoint-store.js";
import { AcpSession } from "../../utility/acp-session.js";
import { spawnAgentProcessTransport } from "../../utility/spawn-agent-process.js";
import { startWsServer, type WsServerHandle } from "./ws-server.js";
import type { ServerPush } from "./protocol.js";

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
});
