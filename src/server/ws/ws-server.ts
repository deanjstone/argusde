import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import type { AcpSession } from "../../utility/acp-session.js";
import type { EventStore, DomainEvent } from "../persistence/event-store.js";
import type { CheckpointStore } from "../checkpoint/checkpoint-store.js";
import { WorktreeStore } from "../worktree/worktree-store.js";
import { ThreadRuntime } from "../session/thread-runtime.js";
import { createStaticFileServer } from "../http/static-server.js";
import { base64ByteLength, refuseAttachmentSet } from "../../shared/attachments.js";
import { NO_PROMPT_CAPABILITIES } from "../../shared/acp-events.js";
import {
  changedFiles as workingTreeChangedFiles,
  currentBranch as workingTreeBranch,
  fileDiff as workingTreeFileDiff,
  listDirectory as listWorkingTreeDirectory,
  readFile as readWorkingTreeFile,
  search as searchWorkingTree,
} from "../workspace/working-tree.js";
import {
  API_VERSION,
  ClientCommandSchema,
  WS_PATH,
  type ClientCommand,
  type DirectoryListing,
  type ServerPush,
} from "../../shared/ws-protocol.js";

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

/**
 * Strips exactly one trailing slash — the realistic free-typed-input
 * variance a project.create dedup check needs to tolerate, not full path
 * canonicalization (resolving "..", symlinks, case-folding), which needs
 * real filesystem access and varies by OS/filesystem — out of scope for a
 * personal single-user app where this covers the common case.
 */
function normalizeWorkspaceRoot(workspaceRoot: string): string {
  return workspaceRoot.length > 1 && workspaceRoot.endsWith("/") ? workspaceRoot.slice(0, -1) : workspaceRoot;
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
        // Idempotent by workspaceRoot — otherwise every resubmission of
        // WorkspaceSetup (or the Threads tab's own "+ New project" form,
        // which surfaces every existing Project right there) for a path
        // that already has one silently creates a duplicate row. Existing
        // project wins as-is (title included) — a duplicate submission
        // doesn't rename it. Normalized before both the lookup and the
        // write (not just the lookup) — both WorkspaceSetup and the "+ New
        // project" form are plain free-typed <Input> fields (only
        // `.trim()`ed client-side), not guaranteed to echo back a prior
        // exact string, so a bare trailing-slash retype is the realistic
        // case this needs to tolerate.
        //
        // Insert-first, not check-then-insert: a lookup followed by a
        // separate write can't detect a second process (a second server
        // instance pointed at the same db file) winning the same race
        // between this process's check and its own write. Attempting the
        // insert directly and falling back to a lookup only on the
        // schema's own UNIQUE constraint failure (idx_projects_workspace_root
        // in schema.ts) makes this atomic regardless of how many processes
        // are writing to the database.
        const workspaceRoot = normalizeWorkspaceRoot(command.workspaceRoot);
        const projectId = randomUUID();
        try {
          eventStore.appendEvent({
            kind: "project.created",
            projectId,
            workspaceRoot,
            title: command.title,
            timestamp: new Date().toISOString(),
          });
          return { projectId };
        } catch (error) {
          if (!(error instanceof Error) || !/UNIQUE constraint failed/i.test(error.message)) throw error;
          const existing = eventStore.getProjectByWorkspaceRoot(workspaceRoot);
          if (!existing) throw error;
          return { projectId: existing.id };
        }
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
          // key, so a failed start can't be un-persisted. Dispose the
          // partially-connected session, then mark the Thread closed
          // (argusde#35) so it doesn't sit around as a permanently
          // unusable-but-open record: requireOpenThread rejects any further
          // command against it with a clear "Thread is closed" error, the
          // client's existing closed-thread UI already renders that
          // cleanly, and its (empty) history stays browsable read-only. No
          // retry-in-place — the client's only recourse is a fresh Thread,
          // same as a normal close.
          await runtime.dispose().catch(() => undefined);
          eventStore.appendEvent({ kind: "thread.closed", threadId, timestamp: new Date().toISOString() });
          throw error;
        }
        runtimes.set(threadId, runtime);
        return { threadId };
      }
      case "thread.send-message": {
        requireOpenThread(command.threadId);
        const runtime = runtimes.get(command.threadId);
        if (!runtime) throw new Error(`Unknown thread: ${command.threadId}`);
        const attachments = command.attachments ?? [];
        if (attachments.length > 0) {
          // The authoritative check (spec #93 phase 7, story 38). The client
          // refuses at attach time too, so the user learns before writing a
          // message around the image — but a client can be stale about what
          // this agent advertised, and a silent drop is exactly what the
          // story forbids. Same shared rules on both sides.
          const refusal = refuseAttachmentSet(
            attachments.map((attachment) => ({
              mimeType: attachment.mimeType,
              byteLength: base64ByteLength(attachment.data),
            })),
            { acceptsImages: runtime.getPromptCapabilities().image },
          );
          if (refusal) throw new Error(refusal);
        }
        await runtime.sendMessage(command.text, attachments);
        return {};
      }
      case "thread.respond-permission": {
        requireOpenThread(command.threadId);
        const runtime = runtimes.get(command.threadId);
        if (!runtime) throw new Error(`Unknown thread: ${command.threadId}`);
        runtime.respondToPermission(command.requestId, command.outcome);
        return {};
      }
      case "thread.set-mode": {
        requireOpenThread(command.threadId);
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
        const diff = await checkpointStore.diffCheckpoints(command.threadId, command.turnA, command.turnB, cwd);
        return { diff };
      }
      case "thread.revert-checkpoint": {
        requireOpenThread(command.threadId);
        if (!eventStore.listCheckpoints(command.threadId).some((c) => c.turn === command.turn)) {
          throw new Error(`Unknown checkpoint: turn ${command.turn}`);
        }
        const runtime = runtimes.get(command.threadId);
        if (!runtime) throw new Error(`Unknown thread: ${command.threadId}`);
        return await runtime.revertToCheckpoint(command.turn);
      }
      case "thread.promote-to-worktree": {
        const thread = requireOpenThread(command.threadId);
        if (thread.worktreePath) throw new Error(`Thread already promoted to a worktree: ${thread.worktreePath}`);
        // Checking checkpoint count instead of this would be racy — a
        // checkpoint only lands once completeTurn() fires on turn-complete,
        // so a message that's been sent but is still in flight (the agent
        // hasn't replied yet) would read as "just the baseline", wrongly
        // allowing promotion to dispose the live session out from under the
        // pending sendMessage() call. thread.message-recorded is persisted
        // synchronously the instant sendMessage() is called, before any
        // await — so this check has no such race window.
        if (eventStore.listEventsForThread(command.threadId).some((e) => e.kind === "thread.message-recorded")) {
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
          // Mirrors thread.create's own fix for the stuck-Thread half of
          // argusde#35: dispose the partially-connected session and mark
          // the Thread closed so it's not left permanently open-but-unusable
          // (requireOpenThread now rejects it cleanly). The worktree
          // directory itself is still left behind on disk — a separate,
          // known resource-leak gap, not solved here either.
          await runtime.dispose().catch(() => undefined);
          eventStore.appendEvent({ kind: "thread.closed", threadId: command.threadId, timestamp: new Date().toISOString() });
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
      case "thread.close": {
        const thread = requireOpenThread(command.threadId);

        const runtime = runtimes.get(command.threadId);
        if (runtime) {
          // Throws (surfacing a clean protocol error) if a turn is still
          // in flight — nothing below runs, so a rejected close leaves
          // nothing half-done.
          await runtime.captureFinalCheckpoint();
          // If dispose() itself throws (e.g. a broken pipe closing an
          // already-exited child process), this handler throws before
          // reaching runtimes.delete()/appending thread.closed — the same
          // class of accepted failure-recovery gap as thread.create's and
          // thread.promote-to-worktree's own dispose-failure paths above
          // (argusde#35), not solved here either.
          await runtime.dispose();
          runtimes.delete(command.threadId);
        } else if (thread.worktreePath) {
          // No live runtime for this Thread — e.g. the server restarted
          // since it was promoted; `runtimes` is never restored on
          // startup. The worktree is about to be permanently destroyed
          // below regardless, so its current on-disk state still needs
          // protecting even without a ThreadRuntime to call
          // captureFinalCheckpoint() on. Computed directly against
          // persistence rather than reusing an in-memory nextTurn counter
          // that doesn't exist here.
          const existing = eventStore.listCheckpoints(command.threadId);
          const nextTurn = existing.length > 0 ? Math.max(...existing.map((c) => c.turn)) + 1 : 0;
          const ref = await checkpointStore.captureCheckpoint(command.threadId, nextTurn, thread.worktreePath);
          eventStore.appendEvent({
            kind: "thread.checkpoint-captured",
            threadId: command.threadId,
            turn: nextTurn,
            ref,
            timestamp: new Date().toISOString(),
          });
        }

        if (thread.worktreePath) {
          const project = eventStore.getProject(thread.projectId);
          if (!project) throw new Error(`Unknown project: ${thread.projectId}`);
          worktreeStore.removeWorktree(project.workspaceRoot, thread.worktreePath, command.threadId);
        }

        eventStore.appendEvent({ kind: "thread.closed", threadId: command.threadId, timestamp: new Date().toISOString() });
        return {};
      }
      case "project.list":
        return eventStore.listProjects();
      case "project.delete": {
        const project = eventStore.getProject(command.projectId);
        if (!project) throw new Error(`Unknown project: ${command.projectId}`);

        // Tear down anything still live for this Project's Threads first.
        // Skipping this would strand an agent subprocess per open Thread
        // with no record left to reach it through — the same leak class as
        // argusde#67, reintroduced by the back door.
        for (const thread of eventStore.listThreads(command.projectId)) {
          const runtime = runtimes.get(thread.id);
          if (runtime) {
            await runtime.dispose().catch(() => undefined);
            runtimes.delete(thread.id);
          }
          // A promoted Thread's worktree is ArgusDE's own scratch directory
          // (a sibling of the workspace, not part of it), so it goes with
          // the records. The workspace root itself is never touched.
          if (thread.worktreePath) {
            try {
              worktreeStore.removeWorktree(project.workspaceRoot, thread.worktreePath, thread.id);
            } catch {
              // Already gone, or the main repo has moved on — the records
              // are still being removed either way, and a stale scratch
              // directory must not block that.
            }
          }
        }

        eventStore.appendEvent({
          kind: "project.deleted",
          projectId: command.projectId,
          timestamp: new Date().toISOString(),
        });
        return {};
      }
      case "thread.list":
        return eventStore.listThreads(command.projectId);
      case "thread.get-history": {
        const thread = requireThread(command.threadId);
        const messages = eventStore
          .listEventsForThread(command.threadId)
          .filter((e): e is Extract<DomainEvent, { kind: "thread.message-recorded" }> => e.kind === "thread.message-recorded")
          .map((e) => ({ messageId: e.messageId, role: e.role, content: e.content, sequence: e.sequence ?? null }));
        // Returned as a second list rather than pre-merged: the client
        // already owns timeline assembly (src/shared/timeline.ts), and both
        // lists carry the same `sequence` key precisely so it can interleave
        // them into one narrative. Messages from before sequencing existed
        // have a null sequence and keep their relative order here.
        const activities = eventStore.listActivities(command.threadId);
        // The mode catalog is never persisted — only ever broadcast live,
        // once, from AcpSession.start(). A Thread whose runtime isn't
        // currently active (a genuine edge case; runtimes are never
        // removed except at server shutdown) degrades to an empty catalog
        // rather than erroring.
        const availableModes = runtimes.get(command.threadId)?.getAvailableModes() ?? [];
        // Same rationale as availableModes above: connection-state is only
        // ever broadcast live, and start()'s own broadcast races ahead of
        // the thread.create response that first tells the client this
        // Thread exists — so a freshly-created Thread's initial "connected"
        // event is otherwise unrecoverable once missed. A Thread with no
        // live runtime degrades to "disconnected" rather than erroring,
        // matching the empty-catalog fallback above.
        const connectionState = runtimes.get(command.threadId)?.getConnectionState() ?? { state: "disconnected", error: undefined };
        // Also live-only, also unrecoverable once its one broadcast is
        // missed — see availableModes above. A Thread with no live runtime
        // reports nothing advertised, which is the honest answer: there is
        // no agent to accept an attachment.
        const promptCapabilities = runtimes.get(command.threadId)?.getPromptCapabilities() ?? NO_PROMPT_CAPABILITIES;
        // Third of the same kind (see availableModes above): pushed once as a
        // session event, so a client that connected later can only learn it
        // here. No live runtime means no agent to run a command, so an empty
        // list is the honest answer rather than an error.
        const availableCommands = runtimes.get(command.threadId)?.getAvailableCommands() ?? [];
        // Null, never zeroes: a Thread with no live runtime — or a live one
        // whose session hasn't reported yet — genuinely has no occupancy to
        // report, and story 50 wants that shown as an absent meter rather
        // than an empty one.
        const usage = runtimes.get(command.threadId)?.getUsage() ?? null;
        // Same treatment as usage, and for the same reason: a plan belongs to
        // a live session's current work, so a client reconnecting mid-turn
        // needs it from here rather than waiting for the next notification.
        const plan = runtimes.get(command.threadId)?.getPlan() ?? null;
        return {
          threadId: thread.id,
          projectId: thread.projectId,
          title: thread.title,
          worktreePath: thread.worktreePath,
          currentModeId: thread.currentModeId,
          closedAt: thread.closedAt,
          availableModes,
          connectionState: connectionState.state,
          connectionError: connectionState.error,
          promptCapabilities,
          availableCommands,
          usage,
          plan,
          messages,
          activities,
          // False for Threads that predate durable activity, so the client
          // can say so instead of rendering an empty timeline that reads as
          // lost data. No backfill is possible — the events were never
          // emitted for those Threads.
          recordsActivity: thread.recordsActivity,
        };
      }
      /**
       * Working-tree reads (spec #93 phase 4). Both are read-only history
       * queries, so plain requireThread via resolveThreadCwd — reading a
       * closed Thread's files has to keep working, same as its transcript.
       *
       * Neither handler does any path work of its own: resolution and
       * containment belong to workspace/working-tree.ts, once, so a future
       * command can't get it subtly differently.
       */
      case "thread.list-directory":
        return listWorkingTreeDirectory(resolveThreadCwd(command.threadId), command.path ?? "");
      case "thread.read-file":
        return readWorkingTreeFile(resolveThreadCwd(command.threadId), command.path);
      case "thread.search":
        return searchWorkingTree(resolveThreadCwd(command.threadId), command.query);
      /**
       * Deliberately separate from thread.list-checkpoints and
       * thread.diff-checkpoints, which keep their commands and behaviour
       * untouched. #93 is emphatic that "what has changed right now" and
       * "what changed between Turn 4 and Turn 7" must never get confused.
       */
      case "thread.changed-files": {
        const cwd = resolveThreadCwd(command.threadId);
        const [files, branch] = await Promise.all([workingTreeChangedFiles(cwd), workingTreeBranch(cwd)]);
        return { files, ...branch };
      }
      case "thread.file-diff":
        return workingTreeFileDiff(resolveThreadCwd(command.threadId), command.path);
      case "fs.list-directory": {
        const target = command.path ?? os.homedir();
        const dirents = await fs.readdir(target, { withFileTypes: true });
        const entries = dirents
          .filter((d) => d.isDirectory() && !d.name.startsWith("."))
          .map((d) => ({ name: d.name, path: path.join(target, d.name) }))
          .sort((a, b) => a.name.localeCompare(b.name));
        const parentPath = path.dirname(target);
        return {
          path: target,
          parentPath: parentPath === target ? null : parentPath,
          entries,
        } satisfies DirectoryListing;
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
   * requireThread, plus rejects a closed Thread — for every command that
   * mutates a Thread (sends a message, changes mode, reverts, promotes, or
   * closes it again). Read-only history queries (list-checkpoints,
   * diff-checkpoints, get-history, list) deliberately stay on plain
   * requireThread — viewing a closed Thread's history must keep working.
   */
  function requireOpenThread(threadId: string): NonNullable<ReturnType<typeof eventStore.getThread>> {
    const thread = requireThread(threadId);
    if (thread.closedAt) throw new Error(`Thread is closed: ${threadId}`);
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
