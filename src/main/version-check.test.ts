import { describe, it, expect, afterEach } from "vitest";
import { WebSocketServer } from "ws";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { checkApiVersion } from "./version-check.js";
import { API_VERSION, WS_PATH } from "../shared/ws-protocol.js";
import { EventStore } from "../server/persistence/event-store.js";
import { CheckpointStore } from "../server/checkpoint/checkpoint-store.js";
import { AcpSession } from "../utility/acp-session.js";
import { spawnAgentProcessTransport } from "../utility/spawn-agent-process.js";
import { startWsServer, type WsServerHandle } from "../server/ws/ws-server.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const fixtureCliPath = path.resolve(__dirname, "../../test/fixtures/fake-agent-cli.mjs");

let wss: WebSocketServer | undefined;
let realServer: WsServerHandle | undefined;

afterEach(async () => {
  wss?.close();
  wss = undefined;
  await realServer?.close();
  realServer = undefined;
});

/** A bare WS server sending a fixed server.welcome payload — no real ArgusDE server needed for these cases. */
function startFakeWelcomeServer(apiVersion: string): Promise<number> {
  return new Promise((resolve) => {
    wss = new WebSocketServer({ host: "127.0.0.1", port: 0, path: WS_PATH }, () => {
      const address = wss!.address()!;
      resolve(typeof address === "string" ? 0 : address.port);
    });
    wss.on("connection", (client) => {
      client.send(JSON.stringify({ type: "server.welcome", apiVersion }));
    });
  });
}

describe("checkApiVersion", () => {
  it("resolves compatible when the server's apiVersion matches", async () => {
    const port = await startFakeWelcomeServer("1.0.0");
    await expect(checkApiVersion(`http://127.0.0.1:${port}/`, "1.0.0")).resolves.toEqual({ status: "compatible" });
  });

  it("resolves incompatible with both versions named when they don't match", async () => {
    const port = await startFakeWelcomeServer("1.0.0");
    await expect(checkApiVersion(`http://127.0.0.1:${port}/`, "2.0.0")).resolves.toEqual({
      status: "incompatible",
      serverVersion: "1.0.0",
      expectedVersion: "2.0.0",
    });
  });

  it("resolves compatible against a real startWsServer instance's real API_VERSION", async () => {
    const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-version-check-db-"));
    const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "argusde-version-check-repo-"));
    execFileSync("git", ["init", "--initial-branch=main"], { cwd: repoDir });
    const eventStore = new EventStore(path.join(dbDir, "argusde.sqlite"));
    try {
      realServer = await startWsServer({
        host: "127.0.0.1",
        port: 0,
        eventStore,
        checkpointStore: new CheckpointStore(),
        createSession: (_threadId, cwd) =>
          new AcpSession({
            name: "argusde-version-check-test",
            cwd,
            createTransport: () => spawnAgentProcessTransport({ command: process.execPath, args: [fixtureCliPath], cwd }),
          }),
      });

      await expect(checkApiVersion(`http://127.0.0.1:${realServer.port}/`, API_VERSION)).resolves.toEqual({
        status: "compatible",
      });
    } finally {
      eventStore.close();
      fs.rmSync(dbDir, { recursive: true, force: true });
      fs.rmSync(repoDir, { recursive: true, force: true });
    }
  });

  it("resolves unknown, never rejects, when nothing is listening", async () => {
    // A port nothing in this suite ever listens on — a real connection
    // refusal, not a mock.
    await expect(checkApiVersion("http://127.0.0.1:59997/", "1.0.0")).resolves.toEqual({ status: "unknown" });
  });

  it("resolves unknown after the timeout when the server accepts the connection but never sends anything", async () => {
    wss = new WebSocketServer({ host: "127.0.0.1", port: 0, path: WS_PATH });
    await new Promise<void>((resolve) => wss!.once("listening", resolve));
    const address = wss.address()!;
    const port = typeof address === "string" ? 0 : address.port;
    // Deliberately no "connection" handler — the socket opens but nothing
    // is ever sent.

    await expect(checkApiVersion(`http://127.0.0.1:${port}/`, "1.0.0", 200)).resolves.toEqual({ status: "unknown" });
  }, 2_000);
});
