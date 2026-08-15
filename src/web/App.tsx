import { useEffect, useRef, useState } from "react";
import type { ChatContentBlock, ConnectionState, PermissionOutcome, SessionModeSummary } from "../shared/acp-events.js";
import { WS_PATH, type CheckpointRecord, type DirectoryListing, type ProjectRecord, type ThreadRecord } from "../shared/ws-protocol.js";
import { WsClient } from "./ws-client.js";
import { chatStateReducer, initialChatState, type ChatState } from "./chat-state.js";
import { WorkspaceSetup } from "./components/workspace-setup.js";
import { ChatView, type DiffState } from "./components/chat-view.js";
import { TabBar, type Tab } from "./components/tab-bar.js";
import { ProjectPicker } from "./components/project-picker.js";
import { ThreadList } from "./components/thread-list.js";

interface SetupState {
  submitting: boolean;
  error?: string;
}

interface ThreadInfo {
  threadId: string;
  projectId: string;
  title: string;
  worktreePath: string | null;
  closedAt: string | null;
}

interface ThreadHistoryMessage {
  messageId: string;
  role: "user" | "agent";
  content: ChatContentBlock[];
}

const EMPTY_DIFF: DiffState = { text: null, loading: false, error: undefined };

const LAST_ACTIVE_THREAD_KEY = "argusde:lastActiveThreadId";

// Small pure read/write functions, matching src/main/server-config.ts's own
// persistence shape (fail-soft on any error, sane default, no library) —
// localStorage can throw in some browser storage/privacy configurations,
// and losing reload-resume is a soft failure, never worth crashing over.
function readLastActiveThreadId(): string | null {
  try {
    return localStorage.getItem(LAST_ACTIVE_THREAD_KEY);
  } catch {
    return null;
  }
}

function writeLastActiveThreadId(threadId: string): void {
  try {
    localStorage.setItem(LAST_ACTIVE_THREAD_KEY, threadId);
  } catch {
    // best-effort only
  }
}

function clearLastActiveThreadId(): void {
  try {
    localStorage.removeItem(LAST_ACTIVE_THREAD_KEY);
  } catch {
    // best-effort only
  }
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
  const [checkpoints, setCheckpoints] = useState<CheckpointRecord[]>([]);
  const [diff, setDiff] = useState<DiffState>(EMPTY_DIFF);
  const [activeTurn, setActiveTurn] = useState<number | undefined>(undefined);
  const [promoting, setPromoting] = useState(false);
  const [reverting, setReverting] = useState(false);
  const [closing, setClosing] = useState(false);
  // Once true, stays true for the rest of this page session — lets the
  // top-level gate distinguish "genuinely first-ever load" (show
  // WorkspaceSetup) from "closed the active Thread, but this session has
  // definitely used the app before" (show the normal tab-bar shell, with
  // no Thread active). Closing a Thread is the first code path that can
  // ever set `thread` back to null after it was first set — without this,
  // closing your current (possibly only) Thread would strand you back on
  // the first-run screen even though your other Projects/Threads still
  // exist. Deliberately doesn't attempt to solve full reload persistence
  // (this flag itself resets on a real page reload) — a separate, already
  // repeatedly deferred gap.
  //
  // Invariant a future code path must preserve: `thread` must never be
  // set to null before `hasEverHadThread` is already true (today the only
  // such path, handleCloseThread, satisfies this — it can only run once a
  // Thread was already active). A future "delete Project" or similar flow
  // that nulls `thread` without that ordering would silently reintroduce
  // this exact regression.
  const [hasEverHadThread, setHasEverHadThread] = useState(false);
  // Starts true unconditionally — resolved to false in the same tick
  // server.welcome arrives, whether or not there's actually a remembered
  // Thread to restore (see attemptSessionRestore below), so a fresh
  // install sees no extra delay beyond the existing !connected gate.
  const [restoring, setRestoring] = useState(true);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [threadsInProject, setThreadsInProject] = useState<ThreadRecord[]>([]);
  const [creatingProject, setCreatingProject] = useState(false);
  const [createProjectError, setCreateProjectError] = useState<string | undefined>(undefined);
  const [creatingThread, setCreatingThread] = useState(false);
  // Guards against an in-flight fetchDiff call overwriting a *later* one's
  // result — e.g. a slow "Turn 5" request resolving after a fast "Turn 8"
  // request already rendered, which would silently show a stale diff.
  const diffRequestRef = useRef(0);
  // Same request-ordering guard as diffRequestRef, one per independently-
  // refreshable list — see refreshProjects/refreshThreads below.
  const projectsRequestIdRef = useRef(0);
  const threadsRequestIdRef = useRef(0);
  // The WS push handler below is registered once (in a [] useEffect) and
  // would otherwise read a stale `thread` from mount time — this ref is
  // kept in sync so it can filter out a *different* Thread's live events
  // without a stale-closure bug. Without this filter, a background Thread
  // (nothing stops creating one) would silently bleed its streamed events
  // into whatever Thread is currently being viewed.
  //
  // Set synchronously inside becomeActiveThread (the only place the active
  // Thread ever changes), NOT via a useEffect keyed on `thread` — a passive
  // effect runs asynchronously after commit/paint, leaving a real gap
  // during which a live event for the Thread just switched to would still
  // read the *previous* Thread's id here and get dropped. Writing the ref
  // in the same synchronous call as setThread (no `await` in between)
  // closes that gap entirely — nothing else in JS can run mid-function.
  const activeThreadIdRef = useRef<string | null>(null);

  async function refreshCheckpoints(threadId: string) {
    const client = clientRef.current;
    if (!client) return;
    try {
      const result = await client.sendCommand<CheckpointRecord[]>({ type: "thread.list-checkpoints", threadId });
      setCheckpoints(result);
    } catch (error) {
      // Non-critical — the strip just stays stale until the next successful
      // refresh rather than surfacing this as a chat-level error — but the
      // reason still needs to be visible somewhere, not silently dropped.
      console.error("Failed to refresh checkpoints:", error);
    }
  }

  useEffect(() => {
    const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
    const client = new WsClient({ url: `${wsProtocol}//${location.host}${WS_PATH}` });
    clientRef.current = client;

    const unsubscribe = client.onPush((push) => {
      switch (push.type) {
        case "server.welcome":
          setChatState((s) => chatStateReducer(s, { kind: "welcome", apiVersion: push.apiVersion }));
          setConnected(true);
          void attemptSessionRestore();
          break;
        case "session.event":
          // Only the currently-active Thread's events reach chat state — a
          // background Thread's events are still received (the connection
          // is shared) but silently dropped for UI purposes.
          if (push.threadId === activeThreadIdRef.current) {
            setChatState((s) => chatStateReducer(s, { kind: "session-event", threadId: push.threadId, event: push.event }));
            if (push.event.kind === "turn-complete") void refreshCheckpoints(push.threadId);
          }
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

  /**
   * The shared "this is the active Thread now" tail — used whether the
   * Thread is brand new (empty history) or an existing one whose history
   * was just fetched via thread.get-history. A full chat-state reset (not
   * appendOrMergeMessage's append semantics) since this may be an entirely
   * different conversation than whatever was showing before.
   */
  function becomeActiveThread(
    info: ThreadInfo,
    messages: ThreadHistoryMessage[],
    currentModeId: string | null,
    availableModes: SessionModeSummary[],
    connectionState: ConnectionState,
    connectionError: string | undefined,
  ) {
    activeThreadIdRef.current = info.threadId;
    setThread(info);
    setHasEverHadThread(true);
    writeLastActiveThreadId(info.threadId);
    setChatState((s) =>
      chatStateReducer(s, { kind: "history-loaded", messages, currentModeId, availableModes, connectionState, connectionError }),
    );
    setDiff(EMPTY_DIFF);
    setActiveTurn(undefined);
    setSelectedProjectId(null);
    setTab("chat");
    void refreshCheckpoints(info.threadId);
  }

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
      await loadThreadHistoryAndBecomeActive(threadId);
      setSetup({ submitting: false });
    } catch (error) {
      setSetup({ submitting: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  function listDirectory(path?: string): Promise<DirectoryListing> {
    const client = clientRef.current;
    if (!client) return Promise.reject(new Error("Not connected"));
    return client.sendCommand<DirectoryListing>({ type: "fs.list-directory", path });
  }

  async function refreshProjects() {
    const client = clientRef.current;
    if (!client) return;
    const requestId = ++projectsRequestIdRef.current;
    try {
      const result = await client.sendCommand<ProjectRecord[]>({ type: "project.list" });
      // A newer refreshProjects call already resolved (or is in flight) —
      // applying this older response now would overwrite it with stale data.
      if (requestId !== projectsRequestIdRef.current) return;
      setProjects(result);
    } catch (error) {
      console.error("Failed to load projects:", error);
    }
  }

  async function refreshThreads(projectId: string) {
    const client = clientRef.current;
    if (!client) return;
    const requestId = ++threadsRequestIdRef.current;
    try {
      const result = await client.sendCommand<ThreadRecord[]>({ type: "thread.list", projectId });
      // Same rationale as refreshProjects above — e.g. selecting Project A
      // then quickly selecting Project B before A's slower response lands
      // must not let A's threads overwrite B's already-rendered list.
      if (requestId !== threadsRequestIdRef.current) return;
      setThreadsInProject(result);
    } catch (error) {
      console.error("Failed to load threads:", error);
    }
  }

  useEffect(() => {
    if (tab === "threads" && selectedProjectId === null) void refreshProjects();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, selectedProjectId]);

  useEffect(() => {
    if (selectedProjectId) void refreshThreads(selectedProjectId);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedProjectId]);

  /**
   * Fetches a just-created (or existing) Thread's full state via
   * thread.get-history and adopts it as the active Thread — deliberately
   * NOT hardcoding empty history/null mode/no catalog for a brand-new
   * Thread. ThreadRuntime.start() broadcasts its session-start event
   * (carrying the mode catalog) synchronously, before the thread.create
   * command's own response is sent — so that broadcast reaches the client
   * before `thread` state (and activeThreadIdRef) is set to the new
   * Thread's id, and the cross-thread event filter correctly drops it as
   * not-yet-active. Re-fetching via get-history reads the same catalog
   * back from ThreadRuntime's cache instead of racing the live broadcast.
   */
  async function loadThreadHistoryAndBecomeActive(threadId: string) {
    const client = clientRef.current;
    if (!client) return;
    const history = await client.sendCommand<{
      threadId: string;
      projectId: string;
      title: string;
      worktreePath: string | null;
      closedAt: string | null;
      currentModeId: string | null;
      availableModes: SessionModeSummary[];
      connectionState: ConnectionState;
      connectionError: string | undefined;
      messages: ThreadHistoryMessage[];
    }>({ type: "thread.get-history", threadId });

    becomeActiveThread(
      {
        threadId: history.threadId,
        projectId: history.projectId,
        title: history.title,
        worktreePath: history.worktreePath,
        closedAt: history.closedAt,
      },
      history.messages,
      history.currentModeId,
      history.availableModes,
      history.connectionState,
      history.connectionError,
    );
  }

  /**
   * Called once, from the WS push handler's server.welcome case — attempts
   * to restore whichever Thread was most recently active (spec #33 Story
   * 28), so a reload doesn't force the user back through first-run setup
   * or a manual Projects→Threads drill-down. Reuses
   * loadThreadHistoryAndBecomeActive as-is: a closed Thread, or one whose
   * server-side runtime isn't currently live, still resolves and renders
   * correctly (Phase 11), so this needs no special-casing for either. If
   * the server confirms the remembered Thread genuinely doesn't exist
   * (e.g. a wiped/replaced database), the stale reference is cleared so a
   * future reload doesn't keep repeating a futile round trip — but any
   * other failure (a dropped connection, a transient network blip) leaves
   * the reference alone, so a real network hiccup can't permanently
   * disable resume. Either way, falls through to the normal
   * `!thread && !hasEverHadThread` → WorkspaceSetup gate for this attempt.
   */
  async function attemptSessionRestore() {
    const rememberedThreadId = readLastActiveThreadId();
    if (!rememberedThreadId) {
      setRestoring(false);
      return;
    }
    try {
      await loadThreadHistoryAndBecomeActive(rememberedThreadId);
    } catch (error) {
      // Only clear the remembered id when the server has actually said
      // this Thread doesn't exist (requireThread's exact wording, in
      // src/server/ws/ws-server.ts, propagated verbatim through
      // command.result's error field) — every other failure here (a
      // dropped WebSocket, a transient network blip mid-request, the kind
      // of thing a phone PWA reload hits far more often than a desktop
      // browser) is not evidence the Thread is gone. Clearing on those too
      // would silently and permanently disable resume after one bad
      // network moment, with no way for the user to even notice.
      if (error instanceof Error && error.message.startsWith("Unknown thread:")) {
        clearLastActiveThreadId();
      }
    } finally {
      setRestoring(false);
    }
  }

  async function handleSelectThread(threadId: string) {
    try {
      await loadThreadHistoryAndBecomeActive(threadId);
    } catch (error) {
      setChatState((s) =>
        chatStateReducer(s, { kind: "protocol-error", message: error instanceof Error ? error.message : String(error) }),
      );
    }
  }

  async function handleCreateProject(workspaceRoot: string) {
    const client = clientRef.current;
    if (!client || creatingProject) return;
    setCreatingProject(true);
    setCreateProjectError(undefined);
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
      await loadThreadHistoryAndBecomeActive(threadId);
    } catch (error) {
      // Shown directly on the Threads tab (ProjectPicker's own error prop),
      // not just dispatched into chatState.connectionError — that field is
      // only ever rendered inside ChatView, which this screen never reaches
      // when creation itself is what failed (no active Thread to show a
      // Chat tab for). Without this, a failure here looked exactly like
      // tapping Select this folder / Create did nothing at all.
      setCreateProjectError(error instanceof Error ? error.message : String(error));
    } finally {
      setCreatingProject(false);
    }
  }

  async function handleCreateThread(title: string) {
    const client = clientRef.current;
    if (!client || !selectedProjectId || creatingThread) return;
    setCreatingThread(true);
    try {
      const { threadId } = await client.sendCommand<{ threadId: string }>({
        type: "thread.create",
        projectId: selectedProjectId,
        title,
      });
      await loadThreadHistoryAndBecomeActive(threadId);
    } catch (error) {
      setChatState((s) =>
        chatStateReducer(s, { kind: "protocol-error", message: error instanceof Error ? error.message : String(error) }),
      );
    } finally {
      setCreatingThread(false);
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

  async function fetchDiff(turnA: number, turnB: number) {
    const client = clientRef.current;
    if (!client || !thread) return;
    const requestId = ++diffRequestRef.current;
    setDiff({ text: null, loading: true, error: undefined });
    try {
      const result = await client.sendCommand<{ diff: string }>({
        type: "thread.diff-checkpoints",
        threadId: thread.threadId,
        turnA,
        turnB,
      });
      if (requestId !== diffRequestRef.current) return; // a newer request has since superseded this one
      setDiff({ text: result.diff, loading: false, error: undefined });
    } catch (error) {
      if (requestId !== diffRequestRef.current) return;
      setDiff({ text: null, loading: false, error: error instanceof Error ? error.message : String(error) });
    }
  }

  function handleSelectTurn(turn: number) {
    setActiveTurn(turn);
    void fetchDiff(turn - 1, turn);
  }

  function handleSinceStart() {
    const latest = checkpoints.at(-1);
    if (!latest || latest.turn === 0) return;
    setActiveTurn(latest.turn);
    void fetchDiff(0, latest.turn);
  }

  function handleCloseDiff() {
    diffRequestRef.current++; // invalidate any in-flight fetchDiff so it can't resurrect the panel after close
    setDiff(EMPTY_DIFF);
    setActiveTurn(undefined);
  }

  function handleSetMode(modeId: string) {
    const client = clientRef.current;
    if (!client || !thread) return;
    client.sendCommand({ type: "thread.set-mode", threadId: thread.threadId, modeId }).catch((error) => {
      setChatState((s) =>
        chatStateReducer(s, { kind: "protocol-error", message: error instanceof Error ? error.message : String(error) }),
      );
    });
  }

  async function handlePromoteToWorktree() {
    const client = clientRef.current;
    if (!client || !thread || promoting) return;
    setPromoting(true);
    try {
      const result = await client.sendCommand<{ worktreePath: string }>({
        type: "thread.promote-to-worktree",
        threadId: thread.threadId,
      });
      setThread((t) => (t ? { ...t, worktreePath: result.worktreePath } : t));
    } catch (error) {
      setChatState((s) =>
        chatStateReducer(s, { kind: "protocol-error", message: error instanceof Error ? error.message : String(error) }),
      );
    } finally {
      setPromoting(false);
    }
  }

  async function handleRevertCheckpoint() {
    const client = clientRef.current;
    if (!client || !thread || activeTurn === undefined || reverting) return;
    setReverting(true);
    try {
      await client.sendCommand({ type: "thread.revert-checkpoint", threadId: thread.threadId, turn: activeTurn });
      handleCloseDiff(); // the diff just shown is now stale — the workspace has moved on
      await refreshCheckpoints(thread.threadId);
    } catch (error) {
      setChatState((s) =>
        chatStateReducer(s, { kind: "protocol-error", message: error instanceof Error ? error.message : String(error) }),
      );
    } finally {
      setReverting(false);
    }
  }

  async function handleCloseThread() {
    const client = clientRef.current;
    if (!client || !thread || closing || thread.closedAt) return;
    setClosing(true);
    try {
      await client.sendCommand({ type: "thread.close", threadId: thread.threadId });
      setThread(null);
      setTab("threads");
    } catch (error) {
      setChatState((s) =>
        chatStateReducer(s, { kind: "protocol-error", message: error instanceof Error ? error.message : String(error) }),
      );
    } finally {
      setClosing(false);
    }
  }

  function handleRespondPermission(requestId: string, outcome: PermissionOutcome) {
    const client = clientRef.current;
    if (!client || !thread) return;
    client.sendCommand({ type: "thread.respond-permission", threadId: thread.threadId, requestId, outcome }).catch((error) => {
      // The permission prompt is already cleared optimistically below — if
      // the send actually failed, at least surface it instead of leaving
      // the agent silently stuck waiting for a response that never arrived.
      setChatState((s) =>
        chatStateReducer(s, { kind: "protocol-error", message: error instanceof Error ? error.message : String(error) }),
      );
    });
    setChatState((s) => chatStateReducer(s, { kind: "permission-responded", requestId }));
  }

  // Two separate gates, not one combined check with a ternary: restoring
  // only ever flips false from inside attemptSessionRestore, which itself
  // only ever runs after setConnected(true) — so a single combined
  // `!connected || restoring` with `restoring ? "Restoring…" : "Connecting…"`
  // made "Connecting…" unreachable dead code (whenever !connected is true,
  // restoring is too, by construction). Checking !connected first, on its
  // own, is what actually lets it render during the real socket-handshake
  // window.
  if (!connected) {
    return (
      <div className="flex h-dvh items-center justify-center bg-neutral-950 text-neutral-400">
        <p className="text-sm">Connecting…</p>
      </div>
    );
  }

  if (restoring) {
    return (
      <div className="flex h-dvh items-center justify-center bg-neutral-950 text-neutral-400">
        <p className="text-sm">Restoring your last session…</p>
      </div>
    );
  }

  if (!thread && !hasEverHadThread) {
    return (
      <WorkspaceSetup onSubmit={handleWorkspaceSubmit} listDirectory={listDirectory} submitting={setup.submitting} error={setup.error} />
    );
  }

  return (
    <div className="flex h-dvh flex-col">
      <div className="min-h-0 flex-1">
        {tab === "chat" &&
          (thread ? (
            <ChatView
              state={chatState}
              onSend={handleSend}
              onRespondPermission={handleRespondPermission}
              checkpoints={checkpoints}
              onSelectTurn={handleSelectTurn}
              onSinceStart={handleSinceStart}
              activeTurn={activeTurn}
              diff={diff}
              onCloseDiff={handleCloseDiff}
              onRevert={() => void handleRevertCheckpoint()}
              reverting={reverting}
              onSetMode={handleSetMode}
              worktreePath={thread.worktreePath}
              onPromoteToWorktree={() => void handlePromoteToWorktree()}
              promoting={promoting}
              onCloseThread={() => void handleCloseThread()}
              closing={closing}
              threadClosed={thread.closedAt !== null}
            />
          ) : (
            // Defensive fallback, not the primary flow — handleCloseThread
            // already switches to the Threads tab on success.
            <div className="flex h-full items-center justify-center bg-neutral-950 p-4 text-center text-sm text-neutral-500">
              No thread selected — pick one from the Threads tab.
            </div>
          ))}
        {tab === "threads" &&
          (selectedProjectId === null ? (
            <ProjectPicker
              projects={projects}
              onSelectProject={setSelectedProjectId}
              onCreateProject={(workspaceRoot) => void handleCreateProject(workspaceRoot)}
              listDirectory={listDirectory}
              creating={creatingProject}
              error={createProjectError}
            />
          ) : (
            <ThreadList
              threads={threadsInProject}
              onSelectThread={(threadId) => void handleSelectThread(threadId)}
              onCreateThread={(title) => void handleCreateThread(title)}
              onBack={() => setSelectedProjectId(null)}
              creating={creatingThread}
            />
          ))}
        {tab === "settings" && (
          <div className="flex h-full flex-col gap-2 bg-neutral-950 p-4 text-sm text-neutral-100">
            <h2 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">Connection</h2>
            <p>Server API version: {chatState.apiVersion ?? "unknown"}</p>
            {thread && <p className="text-neutral-500">Thread ID: {thread.threadId}</p>}
          </div>
        )}
      </div>
      <TabBar active={tab} onChange={setTab} />
    </div>
  );
}
