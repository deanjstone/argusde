import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { WebSocketServer } from "ws";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventStore } from "../server/persistence/event-store.js";
import { CheckpointStore } from "../server/checkpoint/checkpoint-store.js";
import { AcpSession } from "../utility/acp-session.js";
import { spawnAgentProcessTransport } from "../utility/spawn-agent-process.js";
import { startWsServer, type WsServerHandle } from "../server/ws/ws-server.js";
import { WsClient } from "./ws-client.js";
import type { ServerPush } from "../shared/ws-protocol.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureCliPath = path.resolve(__dirname, "../../test/fixtures/fake-agent-cli.mjs");

let repoDir: string;
let dbDir: string;
let eventStore: EventStore;
let checkpointStore: CheckpointStore;
let server: WsServerHandle;
let client: WsClient;

function git(args: string[]): void {
  execFileSync("git", args, { cwd: repoDir });
}

beforeEach(async () => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-ws-client-repo-"));
  git(["init", "--initial-branch=main"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "ArgusDE Test"]);
  fs.writeFileSync(path.join(repoDir, "file.txt"), "hello\n");
  git(["add", "-A"]);
  git(["commit", "-m", "initial commit"]);

  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-ws-client-db-"));
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

  client = new WsClient({ url: `ws://127.0.0.1:${server.port}/ws` });
}, 20_000);

afterEach(async () => {
  delete process.env.ARGUSDE_FAKE_AGENT_STEPS;
  client.close();
  await server.close();
  eventStore.close();
  fs.rmSync(repoDir, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
}, 20_000);

describe("WsClient", () => {
  it("waitUntilOpen resolves once connected, and onPush receives the server.welcome", async () => {
    const pushes: ServerPush[] = [];
    client.onPush((push) => pushes.push(push));

    await client.waitUntilOpen();

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pushes).toContainEqual({ type: "server.welcome", apiVersion: expect.any(String) });
  }, 15_000);

  it("sendCommand resolves with the command's result on success", async () => {
    await client.waitUntilOpen();

    const result = await client.sendCommand<{ projectId: string }>({
      type: "project.create",
      workspaceRoot: repoDir,
      title: "Test Project",
    });

    expect(result.projectId).toEqual(expect.any(String));
    expect(eventStore.getProject(result.projectId)).toMatchObject({ workspaceRoot: repoDir, title: "Test Project" });
  }, 15_000);

  it("sendCommand rejects with an Error when the server replies ok: false", async () => {
    await client.waitUntilOpen();

    await expect(
      client.sendCommand({ type: "thread.send-message", threadId: "does-not-exist", text: "hi" }),
    ).rejects.toThrow(/Unknown thread/);
  }, 15_000);

  it("drives a full project -> thread -> message flow, receiving streamed session.event pushes via onPush", async () => {
    await client.waitUntilOpen();

    const pushes: ServerPush[] = [];
    client.onPush((push) => pushes.push(push));

    const { projectId } = await client.sendCommand<{ projectId: string }>({
      type: "project.create",
      workspaceRoot: repoDir,
      title: "Test Project",
    });
    const { threadId } = await client.sendCommand<{ threadId: string }>({
      type: "thread.create",
      projectId,
      title: "Fix the bug",
    });
    await client.sendCommand({ type: "thread.send-message", threadId, text: "what's broken?" });

    await new Promise<void>((resolve, reject) => {
      const start = Date.now();
      const check = () => {
        if (
          pushes.some(
            (p) =>
              p.type === "session.event" &&
              p.threadId === threadId &&
              p.event.kind === "message-chunk" &&
              p.event.content.type === "text" &&
              p.event.content.text === "the fix is ready",
          )
        ) {
          return resolve();
        }
        if (Date.now() - start > 10_000) return reject(new Error("timed out waiting for the streamed reply"));
        setTimeout(check, 20);
      };
      check();
    });
  }, 20_000);

  it("onPush's returned unsubscribe function stops delivering further pushes", async () => {
    await client.waitUntilOpen();

    const pushes: ServerPush[] = [];
    const unsubscribe = client.onPush((push) => pushes.push(push));
    unsubscribe();

    await client.sendCommand({ type: "project.create", workspaceRoot: repoDir, title: "Test Project" });

    expect(pushes).toEqual([]);
  }, 15_000);

  it(
    "rejects a pending sendCommand instead of hanging forever when the socket closes before a reply arrives",
    async () => {
      // A dedicated server+client pair — closing the server is the point of
      // this test, and the outer afterEach already closes the shared one.
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
      const dedicatedClient = new WsClient({ url: `ws://127.0.0.1:${dedicatedServer.port}/ws` });
      await dedicatedClient.waitUntilOpen();

      // Close the underlying server connection out from under this in-flight
      // command — simulating a server restart / network drop, not a clean
      // client-initiated close().
      const pending = dedicatedClient.sendCommand({ type: "project.create", workspaceRoot: repoDir, title: "Test Project" });
      await dedicatedServer.close();

      await expect(pending).rejects.toThrow();
      dedicatedClient.close();
    },
    15_000,
  );

  it(
    "sending on an already-closed socket rejects with a readable message, not a raw WebSocket exception",
    async () => {
      // The raw failure here is a DOMException reading "WebSocket is already
      // in CLOSING or CLOSED state." — which App.tsx renders verbatim to the
      // user, leaking an implementation detail with no hint of what to do.
      await client.waitUntilOpen();
      client.close();
      await new Promise((resolve) => setTimeout(resolve, 50));

      const rejection = await client
        .sendCommand({ type: "project.create", workspaceRoot: repoDir, title: "Test Project" })
        .then(() => undefined)
        .catch((error: Error) => error);

      expect(rejection).toBeInstanceOf(Error);
      expect(rejection!.message).not.toMatch(/CLOSING or CLOSED/i);
      expect(rejection!.message).toMatch(/connection/i);
      // Tells the user what to do about it, rather than only what broke.
      expect(rejection!.message).toMatch(/reload|reconnect|running/i);
    },
    15_000,
  );

  it(
    "a command that fails to send does not leak a pending entry that can never settle",
    async () => {
      await client.waitUntilOpen();
      client.close();
      await new Promise((resolve) => setTimeout(resolve, 50));

      await client.sendCommand({ type: "project.list" }).catch(() => undefined);

      // A second failure must reject just as cleanly — a stale entry left
      // behind by the first would be rejected again by a later close sweep,
      // producing an unhandled rejection.
      await expect(client.sendCommand({ type: "project.list" })).rejects.toThrow(/connection/i);
    },
    15_000,
  );

  /**
   * The iOS failure in argusde#133. A socket iOS has quietly killed still
   * reads as OPEN from JavaScript, so `send()` succeeds into nothing and the
   * command's promise is registered as pending with nothing left to settle
   * it. Every test below drives that exact shape: a server that accepts the
   * connection and then answers nothing at all.
   */
  describe("a socket that looks open but answers nothing", () => {
    let silentServer: WebSocketServer;
    let silentClient: WsClient;

    beforeEach(async () => {
      silentServer = new WebSocketServer({ port: 0, path: "/ws" });
      await new Promise<void>((resolve) => silentServer.once("listening", () => resolve()));
      const { port } = silentServer.address() as AddressInfo;
      silentClient = new WsClient({ url: `ws://127.0.0.1:${port}/ws` });
      await silentClient.waitUntilOpen();
    });

    afterEach(async () => {
      silentClient.close();
      await new Promise<void>((resolve) => silentServer.close(() => resolve()));
    });

    it("rejects a command that is never answered, rather than leaving it pending forever", async () => {
      const rejection = await silentClient
        .sendCommand({ type: "project.list" }, { timeoutMs: 60 })
        .then(() => undefined)
        .catch((error: Error) => error);

      expect(rejection).toBeInstanceOf(Error);
      // Says what happened and what to do, in the register of the
      // already-closed-socket message next to it.
      expect(rejection!.message).toMatch(/connection/i);
      expect(rejection!.message).toMatch(/reload|reconnect|running/i);
    }, 15_000);

    it("reports the connection as lost once a command times out, so a dead socket stops looking healthy", async () => {
      const lost: string[] = [];
      silentClient.onConnectionLost((message) => lost.push(message));

      await silentClient.sendCommand({ type: "project.list" }, { timeoutMs: 60 }).catch(() => undefined);

      expect(lost).toHaveLength(1);
      expect(lost[0]).toMatch(/connection/i);
    }, 15_000);

    it("reports the connection as lost from its own heartbeat, with no command of the user's to hang first", async () => {
      const lost = new Promise<string>((resolve) => silentClient.onConnectionLost(resolve));

      silentClient.startHeartbeat({ intervalMs: 10, timeoutMs: 60 });

      await expect(lost).resolves.toMatch(/connection/i);
    }, 15_000);

    it("leaves a command with no timeout waiting — an agent turn legitimately takes minutes", async () => {
      let settled = false;
      const pending = silentClient.sendCommand({ type: "project.list" });
      void pending.then(
        () => (settled = true),
        () => (settled = true),
      );

      await new Promise((resolve) => setTimeout(resolve, 150));

      expect(settled).toBe(false);
    }, 15_000);
  });

  it("reports the connection as lost when the socket actually closes, not only when a command is in flight", async () => {
    await client.waitUntilOpen();
    const lost = new Promise<string>((resolve) => client.onConnectionLost(resolve));

    client.close();

    await expect(lost).resolves.toMatch(/connection/i);
  }, 15_000);

  it("does not reject a command that answered inside its timeout", async () => {
    await client.waitUntilOpen();

    await expect(client.sendCommand({ type: "project.list" }, { timeoutMs: 10_000 })).resolves.toBeDefined();
  }, 15_000);
});
