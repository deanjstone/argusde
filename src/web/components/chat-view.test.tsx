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
});
