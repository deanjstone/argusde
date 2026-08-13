import { randomUUID } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { AcpSession } from "../../utility/acp-session.js";
import type { EventStore } from "../persistence/event-store.js";
import type { CheckpointStore } from "../checkpoint/checkpoint-store.js";
import { ThreadRuntime } from "../session/thread-runtime.js";
import { ClientCommandSchema, type ClientCommand, type ServerPush } from "./protocol.js";

/**
 * Bumped whenever the WS protocol (protocol.ts) changes shape. Electron's
 * native shell (Phase 2) compares this against its own compiled-in expected
 * version and refuses to connect on mismatch — see spec #33's version-skew
 * decision. The server itself doesn't enforce anything here; it just
 * announces its version.
 */
export const SERVER_API_VERSION = "1.0.0";

export interface WsServerOptions {
  host?: string;
  port: number;
  eventStore: EventStore;
  checkpointStore: CheckpointStore;
  /** Builds the AcpSession for a newly-created Thread. Production points this at a spawned claude-agent-acp; tests point it at a fixture. */
  createSession: (threadId: string, cwd: string) => AcpSession;
}

export interface WsServerHandle {
  port: number;
  close(): Promise<void>;
}

export async function startWsServer(options: WsServerOptions): Promise<WsServerHandle> {
  const { eventStore, checkpointStore, createSession } = options;
  const clients = new Set<WebSocket>();
  const runtimes = new Map<string, ThreadRuntime>();

  const wss = new WebSocketServer({ host: options.host, port: options.port });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", reject);
  });

  function broadcast(push: ServerPush): void {
    const payload = JSON.stringify(push);
    for (const client of clients) {
      if (client.readyState === WebSocket.OPEN) client.send(payload);
    }
  }

  function send(client: WebSocket, push: ServerPush): void {
    if (client.readyState === WebSocket.OPEN) client.send(JSON.stringify(push));
  }

  async function handleCommand(command: ClientCommand): Promise<unknown> {
    switch (command.type) {
      case "project.create": {
        const projectId = randomUUID();
        eventStore.appendEvent({
          kind: "project.created",
          projectId,
          workspaceRoot: command.workspaceRoot,
          title: command.title,
          timestamp: new Date().toISOString(),
        });
        return { projectId };
      }
      case "thread.create": {
        const project = eventStore.getProject(command.projectId);
        if (!project) throw new Error(`Unknown project: ${command.projectId}`);

        const threadId = randomUUID();
        eventStore.appendEvent({
          kind: "thread.created",
          threadId,
          projectId: command.projectId,
          title: command.title,
          worktreePath: null,
          timestamp: new Date().toISOString(),
        });

        const session = createSession(threadId, project.workspaceRoot);
        const runtime = new ThreadRuntime({
          threadId,
          cwd: project.workspaceRoot,
          session,
          eventStore,
          checkpointStore,
          onEvent: (event) => broadcast({ type: "session.event", threadId, event }),
        });
        await runtime.start();
        runtimes.set(threadId, runtime);
        return { threadId };
      }
      case "thread.send-message": {
        const runtime = runtimes.get(command.threadId);
        if (!runtime) throw new Error(`Unknown thread: ${command.threadId}`);
        await runtime.sendMessage(command.text);
        return {};
      }
      case "thread.respond-permission": {
        const runtime = runtimes.get(command.threadId);
        if (!runtime) throw new Error(`Unknown thread: ${command.threadId}`);
        runtime.respondToPermission(command.requestId, command.outcome);
        return {};
      }
      case "thread.set-mode": {
        const runtime = runtimes.get(command.threadId);
        if (!runtime) throw new Error(`Unknown thread: ${command.threadId}`);
        await runtime.setMode(command.modeId);
        return {};
      }
    }
  }

  wss.on("connection", (client) => {
    clients.add(client);
    send(client, { type: "server.welcome", apiVersion: SERVER_API_VERSION });

    client.on("message", (data) => {
      void (async () => {
        let raw: unknown;
        try {
          raw = JSON.parse(data.toString());
        } catch {
          send(client, { type: "protocol-error", message: "invalid JSON" });
          return;
        }

        const parsed = ClientCommandSchema.safeParse(raw);
        if (!parsed.success) {
          send(client, { type: "protocol-error", message: parsed.error.message });
          return;
        }

        const command = parsed.data;
        try {
          const result = await handleCommand(command);
          send(client, { type: "command.result", commandId: command.commandId, ok: true, result });
        } catch (error) {
          send(client, {
            type: "command.result",
            commandId: command.commandId,
            ok: false,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      })();
    });

    client.on("close", () => clients.delete(client));
  });

  return {
    port: (wss.address() as { port: number }).port,
    async close() {
      await Promise.all([...runtimes.values()].map((runtime) => runtime.dispose()));
      runtimes.clear();
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
