import { useEffect, useRef, useState } from "react";
import type { PermissionOutcome } from "../shared/acp-events.js";
import { WsClient } from "./ws-client.js";
import { chatStateReducer, initialChatState, type ChatState } from "./chat-state.js";
import { WorkspaceSetup } from "./components/workspace-setup.js";
import { ChatView } from "./components/chat-view.js";
import { TabBar, type Tab } from "./components/tab-bar.js";

interface SetupState {
  submitting: boolean;
  error?: string;
}

interface ThreadInfo {
  threadId: string;
  title: string;
}

/**
 * Thin composition root — wires WsClient + the chat-state reducer + the
 * three components together. Not unit-tested directly (same precedent as
 * src/server/index.ts's composition root): covered by the E2E browser test
 * against a real server.
 */
export function App() {
  const clientRef = useRef<WsClient | null>(null);
  const [connected, setConnected] = useState(false);
  const [setup, setSetup] = useState<SetupState>({ submitting: false });
  const [thread, setThread] = useState<ThreadInfo | null>(null);
  const [chatState, setChatState] = useState<ChatState>(initialChatState);
  const [tab, setTab] = useState<Tab>("chat");

  useEffect(() => {
    const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
    const client = new WsClient({ url: `${wsProtocol}//${location.host}/ws` });
    clientRef.current = client;

    const unsubscribe = client.onPush((push) => {
      switch (push.type) {
        case "server.welcome":
          setChatState((s) => chatStateReducer(s, { kind: "welcome", apiVersion: push.apiVersion }));
          setConnected(true);
          break;
        case "session.event":
          setChatState((s) => chatStateReducer(s, { kind: "session-event", threadId: push.threadId, event: push.event }));
          break;
        case "protocol-error":
          setChatState((s) => chatStateReducer(s, { kind: "protocol-error", message: push.message }));
          break;
        case "command.result":
          break;
      }
    });

    return () => {
      unsubscribe();
      client.close();
    };
  }, []);

  async function handleWorkspaceSubmit(workspaceRoot: string) {
    const client = clientRef.current;
    if (!client) return;
    setSetup({ submitting: true });
    try {
      const { projectId } = await client.sendCommand<{ projectId: string }>({
        type: "project.create",
        workspaceRoot,
        title: workspaceRoot,
      });
      const { threadId } = await client.sendCommand<{ threadId: string }>({
        type: "thread.create",
        projectId,
        title: workspaceRoot,
      });
      setThread({ threadId, title: workspaceRoot });
      setSetup({ submitting: false });
    } catch (error) {
      setSetup({ submitting: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  async function handleSend(text: string) {
    const client = clientRef.current;
    if (!client || !thread) return;
    setChatState((s) => chatStateReducer(s, { kind: "user-message-sent", text }));
    try {
      await client.sendCommand({ type: "thread.send-message", threadId: thread.threadId, text });
    } catch (error) {
      setChatState((s) =>
        chatStateReducer(s, { kind: "protocol-error", message: error instanceof Error ? error.message : String(error) }),
      );
    }
  }

  function handleRespondPermission(requestId: string, outcome: PermissionOutcome) {
    const client = clientRef.current;
    if (!client || !thread) return;
    void client.sendCommand({ type: "thread.respond-permission", threadId: thread.threadId, requestId, outcome });
    setChatState((s) => chatStateReducer(s, { kind: "permission-responded", requestId }));
  }

  if (!connected) {
    return (
      <div className="flex h-screen items-center justify-center bg-neutral-950 text-neutral-400">
        <p className="text-sm">Connecting…</p>
      </div>
    );
  }

  if (!thread) {
    return <WorkspaceSetup onSubmit={handleWorkspaceSubmit} submitting={setup.submitting} error={setup.error} />;
  }

  return (
    <div className="flex h-screen flex-col">
      <div className="min-h-0 flex-1">
        {tab === "chat" && <ChatView state={chatState} onSend={handleSend} onRespondPermission={handleRespondPermission} />}
        {tab === "threads" && (
          <div className="flex h-full flex-col bg-neutral-950 p-4 text-neutral-100">
            <h2 className="mb-2 text-xs uppercase tracking-wide text-neutral-500">Threads</h2>
            <div className="rounded-lg bg-neutral-900 px-3 py-2.5 text-sm">{thread.title}</div>
          </div>
        )}
        {tab === "settings" && (
          <div className="flex h-full flex-col gap-2 bg-neutral-950 p-4 text-sm text-neutral-100">
            <h2 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">Connection</h2>
            <p>Server API version: {chatState.apiVersion ?? "unknown"}</p>
            <p className="text-neutral-500">Thread ID: {thread.threadId}</p>
          </div>
        )}
      </div>
      <TabBar active={tab} onChange={setTab} />
    </div>
  );
}
