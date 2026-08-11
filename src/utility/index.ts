import { AcpSession } from "./acp-session.js";
import { spawnAgentProcessTransport } from "./spawn-agent-process.js";
import type { MainToUtilityMessage, UtilityToMainMessage } from "../shared/ipc-contract.js";

// TODO(unresolved, see argusde issue tracker): `--acp` was a guess and is
// confirmed wrong — `claude --help` (CLI v2.1.228) has no ACP flag or
// subcommand at all. AcpSession itself is built and tested against a fake
// in-process agent (see acp-session.test.ts) per the spec, so it's correct
// against the protocol; only this CLI invocation is unverified. Override via
// ARGUSDE_AGENT_COMMAND / ARGUSDE_AGENT_ARGS once the real invocation (or
// required CLI version) is confirmed.
const agentCommand = process.env.ARGUSDE_AGENT_COMMAND ?? "claude";
const agentArgs = process.env.ARGUSDE_AGENT_ARGS ? (JSON.parse(process.env.ARGUSDE_AGENT_ARGS) as string[]) : ["--acp"];
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
