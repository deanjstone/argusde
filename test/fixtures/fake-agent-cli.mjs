// Standalone ACP agent used only by the main+utility+renderer smoke test.
// Speaks the same minimal ACP surface as src/utility/fake-agent.ts, but over
// real stdio (spawned as a real child process) instead of an in-process
// connection, so the smoke test exercises the actual subprocess-spawning
// path in src/utility/spawn-agent-process.ts.
import { agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const steps = process.env.ARGUSDE_FAKE_AGENT_STEPS ? JSON.parse(process.env.ARGUSDE_FAKE_AGENT_STEPS) : [];
const modes = process.env.ARGUSDE_FAKE_AGENT_MODES ? JSON.parse(process.env.ARGUSDE_FAKE_AGENT_MODES) : undefined;
const sessionId = "smoke-session-1";

const app = agent({ name: "smoke-fake-agent" })
  .onRequest(methods.agent.initialize, async () => ({
    protocolVersion: 1,
    agentCapabilities: {},
  }))
  .onRequest(methods.agent.session.new, async () => ({ sessionId, modes }))
  // No current_mode_update notification here — matches the real
  // claude-agent-acp, which confirms a client-requested session/set_mode
  // via its response only. AcpSession.setMode() synthesizes the
  // mode-changed confirmation itself; this fixture must not paper over
  // that with a notification the real agent doesn't send.
  .onRequest(methods.agent.session.setMode, async () => ({}))
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    for (const step of steps) {
      if (step.type === "message") {
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.text } },
        });
      }

      // Asks the client for permission and waits for the real answer, so a
      // caller can drive the prompt's full round trip — not just its
      // appearance. The real claude-agent-acp only does this when its
      // permission mode calls for it, which the audit's live agent never
      // does.
      if (step.type === "permission-request") {
        const response = await client.request(methods.client.session.requestPermission, {
          sessionId: params.sessionId,
          toolCall: { toolCallId: step.toolCallId ?? "tc-permission-1", title: step.title ?? "Write a file" },
          options: step.options ?? [
            { optionId: "allow", name: "Allow", kind: "allow_once" },
            { optionId: "reject", name: "Reject", kind: "reject_once" },
          ],
        });
        // Echoed back so a test can prove the *chosen* option reached the
        // agent, rather than only that the prompt disappeared.
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "agent_message_chunk",
            content: { type: "text", text: `PERMISSION-OUTCOME:${JSON.stringify(response.outcome ?? response)}` },
          },
        });
      }

      // An agent-driven mode change — the one case AcpSession can't
      // synthesize, since it isn't answering a client request.
      if (step.type === "autonomous-mode-change") {
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: "current_mode_update", currentModeId: step.modeId },
        });
      }

      // Drops the agent connection mid-turn, without the client having asked
      // for anything — models the agent process dying under a live thread.
      if (step.type === "exit") {
        process.exit(step.code ?? 1);
      }
    }
    return { stopReason: "end_turn" };
  });

const writable = Writable.toWeb(process.stdout);
const readable = Readable.toWeb(process.stdin);
app.connect(ndJsonStream(writable, readable));
