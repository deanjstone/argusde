import { AcpSession } from "./acp-session.js";
import { spawnAgentProcessTransport } from "./spawn-agent-process.js";
import type { MainToUtilityMessage, UtilityToMainMessage } from "../shared/ipc-contract.js";

// `claude` itself has no ACP flag or subcommand (confirmed — see argusde#10
// and the research on argusde#13) and Anthropic has declined to add one
// (anthropics/claude-code#6686, closed not-planned). ArgusDE instead spawns
// `claude-agent-acp` (npm: @agentclientprotocol/claude-agent-acp), a bridge
// that wraps Anthropic's own Claude Agent SDK behind a real ACP stdio server
// — decided in argusde#14. It's provisioned globally by the sys-admin repo
// (deanjstone/sys-admin#71), not bundled as an ArgusDE dependency, since
// this is a private single-user app; ArgusDE assumes it's on PATH the same
// way `claude` itself is. Override via ARGUSDE_AGENT_COMMAND /
// ARGUSDE_AGENT_ARGS if that ever needs to change.
const agentCommand = process.env.ARGUSDE_AGENT_COMMAND ?? "claude-agent-acp";
const agentArgs = process.env.ARGUSDE_AGENT_ARGS ? (JSON.parse(process.env.ARGUSDE_AGENT_ARGS) as string[]) : [];
const cwd = process.env.ARGUSDE_SESSION_CWD ?? process.cwd();

const parentPort = process.parentPort;
if (!parentPort) {
  throw new Error("argusde's utility process entry must be started via Electron's utilityProcess.fork");
}

function postToMain(message: UtilityToMainMessage): void {
  parentPort.postMessage(message);
}

const session = new AcpSession({
  name: "ArgusDE",
  cwd,
  createTransport: () => spawnAgentProcessTransport({ command: agentCommand, args: agentArgs, cwd }),
});

session.on("event", (event) => {
  postToMain({ type: "session-event", event });
});

function reportError(err: unknown): void {
  postToMain({
    type: "session-event",
    event: {
      kind: "connection-state",
      state: "error",
      error: err instanceof Error ? err.message : String(err),
    },
  });
}

parentPort.on("message", (e: { data: MainToUtilityMessage }) => {
  const message = e.data;
  switch (message.type) {
    case "send-message":
      void session.sendMessage(message.text).catch(reportError);
      break;
    case "respond-to-permission":
      session.respondToPermission(message.requestId, message.outcome);
      break;
    case "restart-session":
      void session.restartSession().catch(reportError);
      break;
  }
});

process.on("uncaughtException", (err) => {
  console.error("[argusde:utility] uncaughtException", err);
  reportError(err);
});
process.on("unhandledRejection", (err) => {
  console.error("[argusde:utility] unhandledRejection", err);
  reportError(err);
});

void session.start().catch(reportError);
