// Standalone ACP agent used only by the main+utility+renderer smoke test.
// Speaks the same minimal ACP surface as src/utility/fake-agent.ts, but over
// real stdio (spawned as a real child process) instead of an in-process
// connection, so the smoke test exercises the actual subprocess-spawning
// path in src/utility/spawn-agent-process.ts.
import { agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const steps = process.env.ARGUSDE_FAKE_AGENT_STEPS ? JSON.parse(process.env.ARGUSDE_FAKE_AGENT_STEPS) : [];
const sessionId = "smoke-session-1";

const app = agent({ name: "smoke-fake-agent" })
  .onRequest(methods.agent.initialize, async () => ({
    protocolVersion: 1,
    agentCapabilities: {},
  }))
  .onRequest(methods.agent.session.new, async () => ({ sessionId }))
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    for (const step of steps) {
      if (step.type === "message") {
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.text } },
        });
      }
    }
    return { stopReason: "end_turn" };
  });

const writable = Writable.toWeb(process.stdout);
const readable = Readable.toWeb(process.stdin);
app.connect(ndJsonStream(writable, readable));
