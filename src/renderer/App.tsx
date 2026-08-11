import { useEffect, useReducer } from "react";
import { chatReducer, initialChatState } from "./chat-reducer.js";
import { MessageList } from "./components/MessageList.js";
import { PermissionPrompt } from "./components/PermissionPrompt.js";
import { ChatInput } from "./components/ChatInput.js";
import { ConnectionStatus } from "./components/ConnectionStatus.js";
import type { PermissionOutcome } from "../shared/acp-events.js";

export function App() {
  const [state, dispatch] = useReducer(chatReducer, initialChatState);

  useEffect(() => {
    return window.argusde.onSessionEvent((event) => dispatch(event));
  }, []);

  function handleSend(text: string): void {
    dispatch({ kind: "user-message-sent", text });
    void window.argusde.sendMessage(text);
  }

  function handlePermissionResponse(requestId: string, outcome: PermissionOutcome): void {
    dispatch({ kind: "permission-responded", requestId });
    void window.argusde.respondToPermission(requestId, outcome);
  }

  return (
    <div className="app">
      <ConnectionStatus
        state={state.connectionState}
        error={state.connectionError}
        onRestart={() => void window.argusde.restartSession()}
      />
      <MessageList timeline={state.timeline} agentStatus={state.agentStatus} />
      {state.pendingPermissionRequest && (
        <PermissionPrompt request={state.pendingPermissionRequest} onRespond={handlePermissionResponse} />
      )}
      <ChatInput
        disabled={state.agentStatus === "working" || state.connectionState !== "connected"}
        placeholder={state.connectionState !== "connected" ? "Waiting for Claude Code to connect…" : undefined}
        onSend={handleSend}
      />
    </div>
  );
}
