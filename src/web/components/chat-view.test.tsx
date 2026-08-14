// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { ChatView } from "./chat-view.js";
import { initialChatState, type ChatState } from "../chat-state.js";

function stateWith(overrides: Partial<ChatState>): ChatState {
  return { ...initialChatState, ...overrides };
}

describe("ChatView", () => {
  it("renders user and agent messages from the timeline", () => {
    const state = stateWith({
      timeline: [
        { type: "message", id: "1", role: "user", content: [{ type: "text", text: "what's broken?" }] },
        { type: "message", id: "2", role: "agent", content: [{ type: "text", text: "the retry handler." }] },
      ],
    });

    render(<ChatView state={state} onSend={() => {}} onRespondPermission={() => {}} />);

    expect(screen.getByText("what's broken?")).toBeInTheDocument();
    expect(screen.getByText("the retry handler.")).toBeInTheDocument();
  });

  it("renders a tool call's title and status", () => {
    const state = stateWith({
      timeline: [{ type: "tool-call", id: "tc-1", title: "Read file", status: "completed", content: [] }],
    });

    render(<ChatView state={state} onSend={() => {}} onRespondPermission={() => {}} />);

    expect(screen.getByText("Read file")).toBeInTheDocument();
    expect(screen.getByText(/completed/i)).toBeInTheDocument();
  });

  it("shows a working indicator when the agent is working", () => {
    const state = stateWith({ agentStatus: "working" });
    render(<ChatView state={state} onSend={() => {}} onRespondPermission={() => {}} />);
    expect(screen.getByText(/working/i)).toBeInTheDocument();
  });

  it("sends the typed message and clears the input", () => {
    const onSend = vi.fn();
    render(<ChatView state={initialChatState} onSend={onSend} onRespondPermission={() => {}} />);

    const input = screen.getByPlaceholderText(/message/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "hello there" } });
    fireEvent.submit(input.closest("form")!);

    expect(onSend).toHaveBeenCalledWith("hello there");
    expect(input.value).toBe("");
  });

  it("does not send an empty message", () => {
    const onSend = vi.fn();
    render(<ChatView state={initialChatState} onSend={onSend} onRespondPermission={() => {}} />);

    fireEvent.submit(screen.getByPlaceholderText(/message/i).closest("form")!);
    expect(onSend).not.toHaveBeenCalled();
  });

  it("renders a pending permission request with option buttons, and calls onRespondPermission on click", () => {
    const onRespond = vi.fn();
    const state = stateWith({
      pendingPermissionRequest: {
        requestId: "perm-1",
        toolCallId: "tc-1",
        toolCallTitle: "Run tests",
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "deny", name: "Deny", kind: "reject_once" },
        ],
      },
    });

    render(<ChatView state={state} onSend={() => {}} onRespondPermission={onRespond} />);

    expect(screen.getByText("Run tests")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Allow" }));
    expect(onRespond).toHaveBeenCalledWith("perm-1", { optionId: "allow" });
  });

  it("shows a connection status message when not connected", () => {
    const state = stateWith({ connectionState: "connecting" });
    render(<ChatView state={state} onSend={() => {}} onRespondPermission={() => {}} />);
    expect(screen.getByText(/connecting/i)).toBeInTheDocument();
  });

  it("shows the connection error message when in an error state", () => {
    const state = stateWith({ connectionState: "error", connectionError: "stream closed" });
    render(<ChatView state={state} onSend={() => {}} onRespondPermission={() => {}} />);
    expect(screen.getByText("stream closed")).toBeInTheDocument();
  });

  it("renders no mode switcher when the agent has no available modes", () => {
    render(<ChatView state={initialChatState} onSend={() => {}} onRespondPermission={() => {}} />);
    expect(screen.queryByRole("combobox", { name: /agent mode/i })).not.toBeInTheDocument();
  });

  it("renders the mode switcher from chat state and forwards mode selection", () => {
    const onSetMode = vi.fn();
    const state = stateWith({
      currentModeId: "default",
      availableModes: [
        { id: "default", name: "Default" },
        { id: "plan", name: "Plan" },
      ],
    });

    render(<ChatView state={state} onSend={() => {}} onRespondPermission={() => {}} onSetMode={onSetMode} />);

    const select = screen.getByRole("combobox", { name: /agent mode/i });
    fireEvent.change(select, { target: { value: "plan" } });
    expect(onSetMode).toHaveBeenCalledWith("plan");
  });

  it("shows a 'promote to worktree' control on a fresh thread with no worktree and no messages sent", () => {
    render(
      <ChatView
        state={initialChatState}
        onSend={() => {}}
        onRespondPermission={() => {}}
        checkpoints={[{ threadId: "t1", turn: 0, ref: "r0", createdAt: "" }]}
        worktreePath={null}
        onPromoteToWorktree={() => {}}
      />,
    );

    expect(screen.getByRole("button", { name: /promote to worktree/i })).toBeInTheDocument();
  });

  it("calls onPromoteToWorktree when the promote control is clicked", () => {
    const onPromoteToWorktree = vi.fn();
    render(
      <ChatView
        state={initialChatState}
        onSend={() => {}}
        onRespondPermission={() => {}}
        checkpoints={[{ threadId: "t1", turn: 0, ref: "r0", createdAt: "" }]}
        worktreePath={null}
        onPromoteToWorktree={onPromoteToWorktree}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: /promote to worktree/i }));
    expect(onPromoteToWorktree).toHaveBeenCalled();
  });

  it("hides the promote control once a message has been sent — keyed off the timeline, not checkpoints (a checkpoint only lands once a turn fully completes, so a still-in-flight message must hide it too)", () => {
    const state = stateWith({
      timeline: [{ type: "message", id: "1", role: "user", content: [{ type: "text", text: "go" }] }],
    });
    render(
      <ChatView
        state={state}
        onSend={() => {}}
        onRespondPermission={() => {}}
        checkpoints={[{ threadId: "t1", turn: 0, ref: "r0", createdAt: "" }]}
        worktreePath={null}
        onPromoteToWorktree={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: /promote to worktree/i })).not.toBeInTheDocument();
  });

  it("disables the promote control while a promotion is already in flight, so a rapid double-click can't send two commands", () => {
    const onPromoteToWorktree = vi.fn();
    render(
      <ChatView
        state={initialChatState}
        onSend={() => {}}
        onRespondPermission={() => {}}
        checkpoints={[{ threadId: "t1", turn: 0, ref: "r0", createdAt: "" }]}
        worktreePath={null}
        onPromoteToWorktree={onPromoteToWorktree}
        promoting={true}
      />,
    );

    const button = screen.getByRole("button", { name: /promote to worktree/i });
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(onPromoteToWorktree).not.toHaveBeenCalled();
  });

  it("shows a worktree indicator instead of the promote control once a thread is promoted, and applies a colored border", () => {
    const { container } = render(
      <ChatView
        state={initialChatState}
        onSend={() => {}}
        onRespondPermission={() => {}}
        checkpoints={[{ threadId: "t1", turn: 0, ref: "r0", createdAt: "" }]}
        worktreePath="/workspace-worktrees/t1"
        onPromoteToWorktree={() => {}}
      />,
    );

    expect(screen.queryByRole("button", { name: /promote to worktree/i })).not.toBeInTheDocument();
    expect(screen.getByText(/worktree/i)).toBeInTheDocument();
    expect(container.firstElementChild?.className).toMatch(/border-(amber|emerald|violet)-\d+/);
  });

  it("renders no checkpoint strip or diff view when no checkpoints are passed", () => {
    render(<ChatView state={initialChatState} onSend={() => {}} onRespondPermission={() => {}} />);
    expect(screen.queryByRole("button", { name: "Turn 1" })).not.toBeInTheDocument();
  });

  it("renders the checkpoint strip and forwards turn selection", () => {
    const onSelectTurn = vi.fn();
    const checkpoints = [
      { threadId: "t1", turn: 0, ref: "r0", createdAt: "" },
      { threadId: "t1", turn: 1, ref: "r1", createdAt: "" },
    ];

    render(
      <ChatView
        state={initialChatState}
        onSend={() => {}}
        onRespondPermission={() => {}}
        checkpoints={checkpoints}
        onSelectTurn={onSelectTurn}
        onSinceStart={() => {}}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Turn 1" }));
    expect(onSelectTurn).toHaveBeenCalledWith(1);
  });

  it("forwards activeTurn to the checkpoint strip so the selected turn is highlighted", () => {
    const checkpoints = [
      { threadId: "t1", turn: 0, ref: "r0", createdAt: "" },
      { threadId: "t1", turn: 1, ref: "r1", createdAt: "" },
    ];

    render(
      <ChatView
        state={initialChatState}
        onSend={() => {}}
        onRespondPermission={() => {}}
        checkpoints={checkpoints}
        onSelectTurn={() => {}}
        onSinceStart={() => {}}
        activeTurn={1}
      />,
    );

    expect(screen.getByRole("button", { name: "Turn 1" })).toHaveAttribute("aria-current", "true");
  });

  it("renders the diff panel when a diff is present and forwards close", () => {
    const onCloseDiff = vi.fn();
    render(
      <ChatView
        state={initialChatState}
        onSend={() => {}}
        onRespondPermission={() => {}}
        diff={{ text: "+added line", loading: false, error: undefined }}
        onCloseDiff={onCloseDiff}
      />,
    );

    expect(screen.getByText("+added line")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onCloseDiff).toHaveBeenCalled();
  });
});
