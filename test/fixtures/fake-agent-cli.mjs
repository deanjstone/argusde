// Standalone ACP agent used only by the main+utility+renderer smoke test.
// Speaks the same minimal ACP surface as src/utility/fake-agent.ts, but over
// real stdio (spawned as a real child process) instead of an in-process
// connection, so the smoke test exercises the actual subprocess-spawning
// path in src/utility/spawn-agent-process.ts.
import { agent, methods, ndJsonStream } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

const steps = process.env.ARGUSDE_FAKE_AGENT_STEPS ? JSON.parse(process.env.ARGUSDE_FAKE_AGENT_STEPS) : [];
const modes = process.env.ARGUSDE_FAKE_AGENT_MODES ? JSON.parse(process.env.ARGUSDE_FAKE_AGENT_MODES) : undefined;
// What this agent claims it can be prompted with. Defaults to nothing
// advertised — the same shape a text-only agent really has — so a test
// wanting image support has to say so, and the capability gate (spec #93
// phase 7) is exercised in both directions.
const promptCapabilities = process.env.ARGUSDE_FAKE_AGENT_PROMPT_CAPABILITIES
  ? JSON.parse(process.env.ARGUSDE_FAKE_AGENT_PROMPT_CAPABILITIES)
  : undefined;
// The command list this agent pushes shortly after session start, mirroring
// the real claude-agent-acp (which sends available_commands_update unprompted
// and offers the list nowhere else). Unset means an agent that advertises
// none — the case story 45 is about.
const availableCommands = process.env.ARGUSDE_FAKE_AGENT_COMMANDS
  ? JSON.parse(process.env.ARGUSDE_FAKE_AGENT_COMMANDS)
  : undefined;
const sessionId = "smoke-session-1";

const app = agent({ name: "smoke-fake-agent" })
  .onRequest(methods.agent.initialize, async () => ({
    protocolVersion: 1,
    agentCapabilities: promptCapabilities ? { promptCapabilities } : {},
  }))
  .onRequest(methods.agent.session.new, async ({ client }) => {
    if (availableCommands) {
      // Deliberately after the response rather than part of it: the real
      // bridge pushes this as a notification once the session exists, and a
      // client that assumed it arrived with session/new would be wrong.
      void Promise.resolve().then(() =>
        client.notify(methods.client.session.update, {
          sessionId,
          update: { sessionUpdate: "available_commands_update", availableCommands },
        }),
      );
    }
    return { sessionId, modes };
  })
  // No current_mode_update notification here — matches the real
  // claude-agent-acp, which confirms a client-requested session/set_mode
  // via its response only. AcpSession.setMode() synthesizes the
  // mode-changed confirmation itself; this fixture must not paper over
  // that with a notification the real agent doesn't send.
  .onRequest(methods.agent.session.setMode, async () => ({}))
  .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
    // Echoes the shape of what actually arrived, so a test can assert an
    // image *reached the agent* rather than merely that sending it raised
    // no error — the difference between covering spec #93 phase 7 and
    // covering nothing at all. Opt-in: every other test in this suite
    // asserts on transcript text, and an unconditional extra chunk would
    // land in the middle of it.
    const received = Array.isArray(params.prompt) ? params.prompt : [params.prompt];
    if (process.env.ARGUSDE_FAKE_AGENT_ECHO_PROMPT) await client.notify(methods.client.session.update, {
      sessionId: params.sessionId,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: {
          type: "text",
          text: `PROMPT-BLOCKS:${JSON.stringify(
            received.map((block) =>
              typeof block === "string"
                ? { type: "text" }
                : block.type === "image"
                  ? { type: "image", mimeType: block.mimeType, dataLength: block.data.length }
                  : { type: block.type },
            ),
          )}\n`,
        },
      },
    });

    for (const step of steps) {
      if (step.type === "message") {
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: step.text } },
        });
      }

      // A tool call and its later update — the two notifications durable
      // activity is projected from (spec #93 phase 1). Kept as separate
      // steps rather than one combined "tool call with a result" so a test
      // can interleave prose between them and prove the recorded ordering
      // matches what actually streamed.
      if (step.type === "tool-call") {
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call",
            toolCallId: step.toolCallId,
            title: step.title,
            kind: step.kind,
            status: step.status ?? "pending",
          },
        });
      }

      if (step.type === "tool-call-update") {
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: {
            sessionUpdate: "tool_call_update",
            toolCallId: step.toolCallId,
            status: step.status,
            content: step.content,
          },
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

      // The agent's command set changing mid-session (spec #93 story 44) —
      // the whole list again, not a delta.
      if (step.type === "commands-changed") {
        await client.notify(methods.client.session.update, {
          sessionId: params.sessionId,
          update: { sessionUpdate: "available_commands_update", availableCommands: step.commands },
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
