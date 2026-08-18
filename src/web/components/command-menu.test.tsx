// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { CommandMenu } from "./command-menu.js";
import type { AgentCommand } from "../../shared/acp-events.js";

/**
 * The agent's own slash commands, offered for discovery (spec #93 phase 8,
 * argusde#122). Discovery only — picking one puts text in the composer; it is
 * the agent that parses the leading `/name` when the message is sent.
 */

const COMMANDS: AgentCommand[] = [
  { name: "review", description: "Review the current diff", inputHint: "What to focus on" },
  { name: "plan", description: "Draft a plan before changing anything", inputHint: null },
  { name: "research", description: "Read around the codebase before answering", inputHint: null },
];

function renderMenu(props: Partial<React.ComponentProps<typeof CommandMenu>> = {}) {
  const onSelect = props.onSelect ?? vi.fn();
  const onOpenChange = props.onOpenChange ?? vi.fn();
  const menu = (overrides: Partial<React.ComponentProps<typeof CommandMenu>> = {}) => (
    <CommandMenu
      open={overrides.open ?? props.open ?? true}
      commands={overrides.commands ?? props.commands ?? COMMANDS}
      query={overrides.query ?? props.query ?? ""}
      onSelect={onSelect}
      onOpenChange={onOpenChange}
    >
      <input aria-label="Message" />
    </CommandMenu>
  );
  const { rerender } = render(menu());
  return {
    onSelect,
    onOpenChange,
    rerenderWith: (overrides: Partial<React.ComponentProps<typeof CommandMenu>>) => rerender(menu(overrides)),
  };
}

describe("CommandMenu", () => {
  it("lists the agent's commands with their descriptions (stories 39, 40)", async () => {
    renderMenu();

    expect(await screen.findByText("review")).toBeInTheDocument();
    expect(screen.getByText("Review the current diff")).toBeInTheDocument();
    expect(screen.getByText("plan")).toBeInTheDocument();
  });

  it("shows nothing at all when the agent advertises no commands (story 45)", () => {
    renderMenu({ commands: [] });

    // Not an empty menu — no menu. An affordance with nothing behind it is
    // worse than its absence.
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByPlaceholderText(/command/i)).toBeNull();
  });

  it("renders nothing when closed", () => {
    renderMenu({ open: false });
    expect(screen.queryByText("review")).toBeNull();
  });

  it("filters the list as the query narrows (story 41)", async () => {
    renderMenu({ query: "rev" });

    expect(await screen.findByText("review")).toBeInTheDocument();
    // Neither the other two names nor their descriptions contain "rev".
    expect(screen.queryByText("plan")).toBeNull();
    expect(screen.queryByText("research")).toBeNull();
  });

  it("keeps every command whose name shares the query, not just the first", async () => {
    renderMenu({ query: "e" });

    // All three descriptions or names contain an "e" — a filter that returned
    // only the first match would look like it worked on a narrower query.
    expect(await screen.findByText("review")).toBeInTheDocument();
    expect(screen.getByText("plan")).toBeInTheDocument();
    expect(screen.getByText("research")).toBeInTheDocument();
  });

  it("matches on the description too, so a half-remembered command is still findable", async () => {
    renderMenu({ query: "diff" });

    expect(await screen.findByText("review")).toBeInTheDocument();
    expect(screen.queryByText("plan")).toBeNull();
  });

  it("says so when a query matches nothing, rather than showing a blank panel", async () => {
    renderMenu({ query: "zzzznotacommand" });

    expect(await screen.findByText(/no matching command/i)).toBeInTheDocument();
  });

  it("hands back the picked command's name (story 39)", async () => {
    const { onSelect } = renderMenu();

    fireEvent.click(await screen.findByText("plan"));

    expect(onSelect).toHaveBeenCalledWith(COMMANDS[1]);
  });

  it("shows a command's input hint, so one that takes an argument says what it wants", async () => {
    renderMenu({ query: "review" });

    expect(await screen.findByText(/what to focus on/i)).toBeInTheDocument();
  });

  it("picks with the keyboard, so the desk case is as fast as the phone case (story 42)", async () => {
    const { onSelect } = renderMenu();
    const input = screen.getByLabelText("Message");
    await screen.findByText("review");

    // Down once moves off the first row onto the second.
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith(COMMANDS[1]);
  });

  it("picks the first command when Enter is pressed without arrowing", async () => {
    const { onSelect } = renderMenu();
    const input = screen.getByLabelText("Message");
    await screen.findByText("review");

    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith(COMMANDS[0]);
  });

  it("wraps around rather than stopping at the ends of the list", async () => {
    const { onSelect } = renderMenu();
    const input = screen.getByLabelText("Message");
    await screen.findByText("review");

    // Up from the first row lands on the last — with 122 commands on the real
    // agent, reaching the end from the top otherwise means 121 keystrokes.
    fireEvent.keyDown(input, { key: "ArrowUp" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith(COMMANDS[2]);
  });

  it("keeps the highlight inside the filtered list when the query narrows", async () => {
    const { rerenderWith, onSelect } = renderMenu();
    const input = screen.getByLabelText("Message");
    await screen.findByText("review");

    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    // Now on the third row — then the query narrows to a single result, and
    // Enter must pick that one rather than an index that no longer exists.
    rerenderWith({ query: "plan" });
    fireEvent.keyDown(input, { key: "Enter" });

    expect(onSelect).toHaveBeenCalledWith(COMMANDS[1]);
  });

  it("closes on Escape without picking anything", async () => {
    const { onOpenChange, onSelect } = renderMenu();

    await screen.findByText("review");
    fireEvent.keyDown(document.activeElement ?? document.body, { key: "Escape" });

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(onSelect).not.toHaveBeenCalled();
  });
});
