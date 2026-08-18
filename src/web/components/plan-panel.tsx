import { useState } from "react";
import type { PlanEntrySummary } from "../../shared/acp-events.js";
import { cn } from "../lib/utils.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.js";
import { Progress } from "./ui/progress.js";

export interface PlanPanelProps {
  plan: PlanEntrySummary[] | null;
}

const STATUS_MARKER: Record<string, string> = {
  completed: "✓",
  in_progress: "▸",
  pending: "·",
};

const STATUS_STYLE: Record<string, string> = {
  completed: "text-muted-foreground line-through decoration-muted-foreground/50",
  in_progress: "text-foreground",
  pending: "text-muted-foreground",
};

/**
 * The agent's plan: a resting pill that answers "where are we", and a panel
 * that expands upward for the detail (spec #93 phase 10, shape from prototype
 * #90).
 *
 * **Collapsible, not drawer**, though #93's component table offers either. A
 * drawer is modal, and story 54 requires the composer to stay answerable while
 * the plan is open — prototype #90's own reason for the shape: *"a panel that
 * lands on the input is a panel you have to dismiss before you can answer the
 * agent"*. Non-modal also avoids the trap recorded on argusde#122, where a
 * modal `aria-hidden`s the page behind it and silently breaks any test
 * synchronising on an element disappearing.
 *
 * `priority` is carried on the wire and deliberately never rendered: the real
 * claude-agent-acp reported `"medium"` for every entry of every plan, and
 * styling by a field that never varies is decoration pretending to be
 * information.
 */
export function PlanPanel({ plan }: PlanPanelProps) {
  const [open, setOpen] = useState(false);

  // Story 58: no plan means no pill. An empty plan gets the same answer — a
  // pill reporting "0/0" answers nothing anyone asked.
  if (!plan || plan.length === 0) return null;

  const completed = plan.filter((entry) => entry.status === "completed").length;
  // The first, when an agent reports several running at once — the pill has
  // room for one, and the first is the one it started.
  const current = plan.find((entry) => entry.status === "in_progress");
  const percent = Math.round((completed / plan.length) * 100);

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="border-t border-border">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-xs text-muted-foreground hover:text-foreground">
        <span className="tabular-nums">
          {completed}/{plan.length}
        </span>
        <Progress value={percent} aria-hidden className="w-10 shrink-0" />
        {/* The resting state answers the common question on its own (story
            52). With no step running there is nothing to name, so it says what
            it is rather than naming nothing. */}
        <span className="min-w-0 flex-1 truncate">{current ? current.content : "Plan"}</span>
        <span aria-hidden className="shrink-0">
          {open ? "▾" : "▴"}
        </span>
      </CollapsibleTrigger>

      {/* Sits between the transcript and the composer in the same flex column,
          so it takes its height from what the transcript gives up and can
          never cover the composer or the tab bar (story 54). Plain overflow
          rather than `scroll-area` — see the style-src commentary in
          server/http/static-server.ts. */}
      <CollapsibleContent className="max-h-56 overflow-y-auto px-3 pb-2">
        <ol className="space-y-1">
          {plan.map((entry, index) => (
            <li
              // No stable id on an ACP plan entry, and every notification
              // carries the whole plan — so position *is* the identity.
              key={index}
              data-status={entry.status}
              className={cn("flex items-baseline gap-2 text-xs", STATUS_STYLE[entry.status] ?? STATUS_STYLE.pending)}
            >
              <span aria-hidden className="w-3 shrink-0 text-center">
                {STATUS_MARKER[entry.status] ?? STATUS_MARKER.pending}
              </span>
              <span className="min-w-0 flex-1">{entry.content}</span>
            </li>
          ))}
        </ol>
      </CollapsibleContent>
    </Collapsible>
  );
}
