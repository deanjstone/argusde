import { useEffect, useState, type ReactNode } from "react";
import type { AgentCommand } from "../../shared/acp-events.js";
import { Command, CommandEmpty, CommandGroup, CommandItem, CommandList } from "./ui/command.js";
import { Popover, PopoverAnchor, PopoverContent } from "./ui/popover.js";

export interface CommandMenuProps {
  open: boolean;
  commands: AgentCommand[];
  /** What was typed after the `/`, used to narrow the list. */
  query: string;
  onSelect: (command: AgentCommand) => void;
  onOpenChange: (open: boolean) => void;
  /** The composer, which the menu anchors itself above. */
  children: ReactNode;
}

/**
 * The agent's own slash commands (spec #93 phase 8).
 *
 * Discovery only — this never runs anything. Picking a command puts `/name `
 * in the composer and the user sends it like any other message; the agent side
 * parses the leading name itself, which was verified against the real
 * claude-agent-acp rather than assumed (an unknown command comes back as
 * "Unknown command: …", not as a conversational reply).
 *
 * The first Radix *popover* in this app. It only works at all because
 * argusde#113 put a per-response CSP nonce in place — the injected `<style>`
 * an overlay uses to lock scroll is blocked outright without one.
 */
export function CommandMenu({ open, commands, query, onSelect, onOpenChange, children }: CommandMenuProps) {
  // Story 45: an agent that advertises no commands gets no menu, not an empty
  // one. Checked here rather than at the call site so there is one answer.
  const hasCommands = commands.length > 0;
  const filtered = matching(commands, query);

  /**
   * Which row is highlighted, owned here rather than by cmdk (story 42).
   *
   * The popover deliberately never takes focus — the caret has to stay in the
   * composer while the command name is still being typed — so cmdk's own
   * keyboard handling, which listens on its focused input, never fires. The
   * keys are read off the composer instead and applied to this index, which is
   * then handed to cmdk as its controlled `value` so the highlight and the
   * selection can never disagree.
   */
  const [activeIndex, setActiveIndex] = useState(0);

  // A narrowing query can leave the index past the end of the list; without
  // this, Enter would pick nothing at all.
  const safeIndex = filtered.length === 0 ? 0 : Math.min(activeIndex, filtered.length - 1);

  useEffect(() => {
    setActiveIndex(0);
  }, [query, open]);

  useEffect(() => {
    if (!open || !hasCommands) return;

    function handleKeyDown(event: KeyboardEvent): void {
      if (filtered.length === 0) return;
      if (event.key === "ArrowDown") {
        event.preventDefault();
        // Wrapping, not clamping: with 122 commands on the real agent,
        // reaching the last one from the top otherwise takes 121 keystrokes.
        setActiveIndex((current) => (Math.min(current, filtered.length - 1) + 1) % filtered.length);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        setActiveIndex((current) => (Math.min(current, filtered.length - 1) + filtered.length - 1) % filtered.length);
      } else if (event.key === "Enter") {
        // Takes Enter away from the composer's submit while the menu is open,
        // which is the right precedence: the user is picking a command, not
        // sending "/pl".
        event.preventDefault();
        const picked = filtered[safeIndex];
        if (picked) onSelect(picked);
      }
    }

    // On the document because focus is in the composer, which this component
    // does not own — the keys bubble to here from wherever they were typed.
    document.addEventListener("keydown", handleKeyDown);
    return () => document.removeEventListener("keydown", handleKeyDown);
  }, [open, hasCommands, filtered, safeIndex, onSelect]);

  return (
    <Popover open={open && hasCommands} onOpenChange={onOpenChange}>
      <PopoverAnchor asChild>{children}</PopoverAnchor>
      <PopoverContent
        // Radix renders this with role="dialog", which axe requires to have an
        // accessible name — without one it is a serious violation, caught by
        // the audit rather than by review.
        aria-label="Agent commands"
        align="start"
        side="top"
        // The composer is the point of this surface; the menu must not steal
        // the caret from it while the user is still typing the command name.
        onOpenAutoFocus={(event) => event.preventDefault()}
        className="w-[min(28rem,calc(100vw-2rem))] p-0"
      >
        <Command
          // cmdk's own fuzzy filter is bypassed: the query lives in the
          // composer, not in a CommandInput, so the filtering is done here
          // against the same string the user can actually see.
          shouldFilter={false}
          value={filtered[safeIndex]?.name ?? ""}
          onValueChange={(name) => {
            const index = filtered.findIndex((command) => command.name === name);
            if (index >= 0) setActiveIndex(index);
          }}
        >
          {/* Plain overflow rather than `scroll-area` — see the style-src
              commentary in server/http/static-server.ts: scroll-area styles
              through an inline style attribute, which no nonce can cover. The
              cap matters: the real agent advertised 122 commands. */}
          <CommandList className="max-h-64 overflow-y-auto">
            <CommandEmpty>No matching command.</CommandEmpty>
            <CommandGroup>
              {filtered.map((command) => (
                <CommandItem
                  key={command.name}
                  value={command.name}
                  onSelect={() => onSelect(command)}
                  className="flex items-baseline gap-2"
                >
                  <span className="font-mono text-sm">{command.name}</span>
                  {/* One clamped line. The real agent's descriptions run to
                      several hundred characters — wrapped in full they'd make
                      a menu nobody can scan. */}
                  <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{command.description}</span>
                  {command.inputHint && (
                    <span className="shrink-0 text-xs italic text-muted-foreground">{command.inputHint}</span>
                  )}
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}

/**
 * Substring match on the name first, then the description — a half-remembered
 * command ("the one about the diff") is findable without knowing its name.
 * Deliberately not fuzzy: with 122 commands, a fuzzy match on a two-letter
 * query returns nearly everything, which is the same as no filter at all.
 */
export function matching(commands: AgentCommand[], query: string): AgentCommand[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return commands;
  const byName = commands.filter((command) => command.name.toLowerCase().includes(needle));
  const byDescription = commands.filter(
    (command) => !command.name.toLowerCase().includes(needle) && command.description.toLowerCase().includes(needle),
  );
  return [...byName, ...byDescription];
}
