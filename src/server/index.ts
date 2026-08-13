import { EventStore } from "./persistence/event-store.js";
import { CheckpointStore } from "./checkpoint/checkpoint-store.js";
import { startWsServer } from "./ws/ws-server.js";
import { AcpSession } from "../utility/acp-session.js";
import { spawnAgentProcessTransport } from "../utility/spawn-agent-process.js";

export interface StartServerOptions {
  host?: string;
  port: number;
  dbPath: string;
}

export interface ServerHandle {
  port: number;
  close(): Promise<void>;
}

// Mirrors src/utility/index.ts's production wiring: ArgusDE spawns
// claude-agent-acp (not `claude` itself — see that file's comment for the
// full rationale), provisioned globally, not bundled as a dependency.
const agentCommand = process.env.ARGUSDE_AGENT_COMMAND ?? "claude-agent-acp";
const agentArgs = process.env.ARGUSDE_AGENT_ARGS ? (JSON.parse(process.env.ARGUSDE_AGENT_ARGS) as string[]) : [];

/**
 * Composition root: wires persistence, checkpoints, and the WebSocket API
 * together into one running server. Thin glue over already-tested modules
 * (event-store.test.ts, checkpoint-store.test.ts, ws-server.test.ts) — no
 * dedicated test file, same precedent as the existing IPC relay/smoke test
 * split (test/smoke.test.ts).
 */
export async function startServer(options: StartServerOptions): Promise<ServerHandle> {
  const eventStore = new EventStore(options.dbPath);
  const checkpointStore = new CheckpointStore();

  const wsHandle = await startWsServer({
    host: options.host,
    port: options.port,
    eventStore,
    checkpointStore,
    createSession: (_threadId, cwd) =>
      new AcpSession({
        name: "ArgusDE",
        cwd,
        createTransport: () => spawnAgentProcessTransport({ command: agentCommand, args: agentArgs, cwd }),
      }),
  });

  return {
    port: wsHandle.port,
    async close() {
      await wsHandle.close();
      eventStore.close();
    },
  };
}
