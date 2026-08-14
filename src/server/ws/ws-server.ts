import { randomUUID } from "node:crypto";
import http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import type { AcpSession } from "../../utility/acp-session.js";
import type { EventStore } from "../persistence/event-store.js";
import type { CheckpointStore } from "../checkpoint/checkpoint-store.js";
import { WorktreeStore } from "../worktree/worktree-store.js";
import { ThreadRuntime } from "../session/thread-runtime.js";
import { createStaticFileServer } from "../http/static-server.js";
import { API_VERSION, ClientCommandSchema, WS_PATH, type ClientCommand, type ServerPush } from "../../shared/ws-protocol.js";

export interface WsServerOptions {
  host?: string;
  port: number;
  eventStore: EventStore;
  checkpointStore: CheckpointStore;
  /** Stateless git worktree creation for Thread promotion — no test-injectable seams needed (always shells out to real git, same in tests and production), so this defaults to a plain instance if omitted. */
  worktreeStore?: WorktreeStore;
  /** Builds the AcpSession for a newly-created Thread. Production points this at a spawned claude-agent-acp; tests point it at a fixture. */
  createSession: (threadId: string, cwd: string) => AcpSession;
  /** Static assets served at "/" — the built web UI (dist/web). Omit to serve nothing but the WS API (e.g. tests that don't care about HTTP). */
  webDistDir?: string;
}

export interface WsServerHandle {
  port: number;
  close(): Promise<void>;
}

export async function startWsServer(options: WsServerOptions): Promise<WsServerHandle> {
  const { eventStore, checkpointStore, createSession } = options;
  const worktreeStore = options.worktreeStore ?? new WorktreeStore();
  const clients = new Set<WebSocket>();
  const runtimes = new Map<string, ThreadRuntime>();

  const staticHandler = options.webDistDir
    ? createStaticFileServer(options.webDistDir)
    : (_req: http.IncomingMessage, res: http.ServerResponse) => res.writeHead(404).end("Not found");

  const httpServer = http.createServer(staticHandler);
  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => resolve());
  });

  const wss = new WebSocketServer({ server: httpServer, path: WS_PATH });

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

        // A brand-new thread never has a worktreePath yet (just persisted as
        // null above), so this is trivially project.workspaceRoot today —
        // routed through the same resolution resolveThreadCwd already
        // encodes so there's exactly one cwd-resolution code path, not two.
        const cwd = resolveThreadCwd(threadId);
        const session = createSession(threadId, cwd);
        const runtime = new ThreadRuntime({
          threadId,
          cwd,
          session,
          eventStore,
          checkpointStore,
          onEvent: (event) => broadcast({ type: "session.event", threadId, event }),
        });
        try {
          await runtime.start();
        } catch (error) {
          // The Thread's persisted record (and its turn-0 checkpoint) is
          // already durable at this point — thread.created has to precede
          // any checkpoint event to satisfy the checkpoints table's foreign
          // key, so a failed start can't be un-persisted. What we can and
          // must do is not leak the partially-connected session; retrying
          // thread creation for this same threadId isn't supported yet
          // (tracked in argusde#35).
          await runtime.dispose().catch(() => undefined);
          throw error;
        }
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
      case "thread.list-checkpoints": {
        requireThread(command.threadId);
        return eventStore.listCheckpoints(command.threadId);
      }
      case "thread.diff-checkpoints": {
        const cwd = resolveThreadCwd(command.threadId);
        const diff = checkpointStore.diffCheckpoints(command.threadId, command.turnA, command.turnB, cwd);
        return { diff };
      }
      case "thread.promote-to-worktree": {
        const thread = requireThread(command.threadId);
        if (thread.worktreePath) throw new Error(`Thread already promoted to a worktree: ${thread.worktreePath}`);
        if (eventStore.listCheckpoints(command.threadId).length > 1) {
          throw new Error("Cannot promote a thread after its conversation has started");
        }
        const project = eventStore.getProject(thread.projectId);
        if (!project) throw new Error(`Unknown project: ${thread.projectId}`);

        const worktreePath = worktreeStore.createWorktree(project.workspaceRoot, command.threadId);

        // Nothing has happened in this thread yet (guarded above), so
        // disposing the existing runtime and starting a fresh one against
        // the new cwd is safe — no in-flight work is lost. This also
        // re-captures the turn-0 baseline in the worktree's clean checkout
        // (ThreadRuntime.start()'s own existing behavior, unmodified) —
        // the INSERT OR REPLACE projection added for this phase is what
        // lets that second turn-0 write land instead of throwing.
        const oldRuntime = runtimes.get(command.threadId);
        if (oldRuntime) await oldRuntime.dispose();

        const session = createSession(command.threadId, worktreePath);
        const runtime = new ThreadRuntime({
          threadId: command.threadId,
          cwd: worktreePath,
          session,
          eventStore,
          checkpointStore,
          onEvent: (event) => broadcast({ type: "session.event", threadId: command.threadId, event }),
        });
        try {
          await runtime.start();
        } catch (error) {
          // Mirrors thread.create's own accepted failure-recovery gap
          // (argusde#35): a failed promotion leaves this Thread with no
          // active runtime, and the worktree directory itself is left
          // behind on disk — not retried automatically. Same class of
          // rare-failure resource leak, not solved here either.
          await runtime.dispose().catch(() => undefined);
          throw error;
        }
        runtimes.set(command.threadId, runtime);

        eventStore.appendEvent({
          kind: "thread.worktree-promoted",
          threadId: command.threadId,
          worktreePath,
          timestamp: new Date().toISOString(),
        });

        return { worktreePath };
      }
    }
  }

  /** Looks up a persisted Thread record, or throws — the one place "unknown thread" is decided, so every read-only history query stays consistent. */
  function requireThread(threadId: string): NonNullable<ReturnType<typeof eventStore.getThread>> {
    const thread = eventStore.getThread(threadId);
    if (!thread) throw new Error(`Unknown thread: ${threadId}`);
    return thread;
  }

  /**
   * Resolves the working directory checkpoint refs for `threadId` live in —
   * a plain lookup through persistence, not the in-memory `runtimes` map, so
   * a read-only history query works even for a thread whose ThreadRuntime
   * isn't currently active (e.g. after a server restart).
   */
  function resolveThreadCwd(threadId: string): string {
    const thread = requireThread(threadId);
    const project = eventStore.getProject(thread.projectId);
    if (!project) throw new Error(`Unknown project: ${thread.projectId}`);
    return thread.worktreePath ?? project.workspaceRoot;
  }

  wss.on("connection", (client) => {
    clients.add(client);
    send(client, { type: "server.welcome", apiVersion: API_VERSION });

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
    port: (httpServer.address() as { port: number }).port,
    async close() {
      await Promise.all([...runtimes.values()].map((runtime) => runtime.dispose()));
      runtimes.clear();

      // wss.close()'s callback only fires once every currently-connected
      // client disconnects on its own — terminate any still-open clients
      // first so shutdown doesn't hang on one that never does.
      for (const client of clients) client.terminate();
      clients.clear();

      // wss.close() only detaches from the underlying http.Server (it
      // doesn't own it, since it was passed in via `server`) — it must be
      // closed separately or the process would keep listening.
      await new Promise<void>((resolve, reject) => {
        wss.close((err) => (err ? reject(err) : resolve()));
      });
      // httpServer.close()'s callback doesn't fire until every open
      // connection ends — including idle keep-alive sockets left pooled by
      // a browser or fetch's connection reuse, which can sit open for
      // Node's default keepAliveTimeout (5s). Force them closed so
      // shutdown doesn't stall on a connection nobody's actively using.
      httpServer.closeAllConnections();
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
