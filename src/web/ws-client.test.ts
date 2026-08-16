import { describe, it, expect, beforeEach, afterEach } from "vitest";
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
});
