import {
  agent,
  methods,
  type AgentApp,
  type AgentConnection,
  type ToolCallStatus,
  type ToolCallContent,
  type PermissionOption,
} from "@agentclientprotocol/sdk";

export type FakeAgentStep =
  | { type: "message"; text: string; messageId?: string }
  | { type: "thought"; text: string }
  | { type: "tool-call"; toolCallId: string; title: string; status?: ToolCallStatus }
  | {
      type: "tool-call-update";
      toolCallId: string;
      status?: ToolCallStatus;
      content?: ToolCallContent[];
    }
  | {
      type: "request-permission";
      toolCallId: string;
      options: PermissionOption[];
    }
  | { type: "mode-change"; modeId: string }
  | { type: "crash"; message?: string };

export interface FakeAgentOptions {
  sessionId?: string;
  steps?: FakeAgentStep[];
  /** Mirrors the real SDK's NewSessionResponse.modes field — omit to simulate an agent that doesn't advertise modes at all. */
  modes?: {
    currentModeId: string;
    availableModes: Array<{ id: string; name: string; description?: string }>;
  };
}

/**
 * A minimal in-process ACP agent used only in tests. Speaks the ACP wire
 * protocol at the level `AcpSession` depends on: initialize, session/new,
 * session/prompt (streaming session/update notifications and permission
 * requests), and session/cancel.
 */
export function createFakeAgent(options: FakeAgentOptions = {}): AgentApp {
  const sessionId = options.sessionId ?? "fake-session-1";
  const steps = options.steps ?? [];
  let activeConnection: AgentConnection | undefined;

  return agent({ name: "fake-agent" })
    .onConnect((connection) => {
      activeConnection = connection;
    })
    .onRequest(methods.agent.initialize, async () => ({
      protocolVersion: 1,
      agentCapabilities: {},
    }))
    .onRequest(methods.agent.session.new, async () => ({
      sessionId,
      modes: options.modes,
    }))
    .onRequest(methods.agent.session.setMode, async ({ params, client }) => {
      await client.notify(methods.client.session.update, {
        sessionId: params.sessionId,
        update: { sessionUpdate: "current_mode_update", currentModeId: params.modeId },
      });
      return {};
    })
    .onRequest(methods.agent.session.prompt, async ({ params, client }) => {
      for (const step of steps) {
        switch (step.type) {
          case "message":
            await client.notify(methods.client.session.update, {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_message_chunk",
                content: { type: "text", text: step.text },
                messageId: step.messageId,
              },
            });
            break;
          case "thought":
            await client.notify(methods.client.session.update, {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "agent_thought_chunk",
                content: { type: "text", text: step.text },
              },
            });
            break;
          case "tool-call":
            await client.notify(methods.client.session.update, {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "tool_call",
                toolCallId: step.toolCallId,
                title: step.title,
                status: step.status ?? "pending",
              },
            });
            break;
          case "tool-call-update":
            await client.notify(methods.client.session.update, {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "tool_call_update",
                toolCallId: step.toolCallId,
                status: step.status,
                content: step.content,
              },
            });
            break;
          case "request-permission":
            await client.request(methods.client.session.requestPermission, {
              sessionId: params.sessionId,
              toolCall: { toolCallId: step.toolCallId },
              options: step.options,
            });
            break;
          case "mode-change":
            await client.notify(methods.client.session.update, {
              sessionId: params.sessionId,
              update: {
                sessionUpdate: "current_mode_update",
                currentModeId: step.modeId,
              },
            });
            break;
          case "crash": {
            const error = new Error(step.message ?? "simulated agent crash");
            activeConnection?.close(error);
            throw error;
          }
        }
      }
      return { stopReason: "end_turn" };
    });
}
