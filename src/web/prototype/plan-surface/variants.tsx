// PROTOTYPE — throwaway (argusde#90). No tests, no error handling, no abstractions.
import { useState } from "react";
import type { PlanEntrySummary } from "../../../shared/acp-events.js";
import { cn } from "../../lib/utils.js";
import { completedCount, currentEntry } from "./fixtures.js";

const STATUS_GLYPH: Record<string, string> = { completed: "✓", in_progress: "▸", pending: "○" };

function StatusIcon({ status }: { status: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 w-3 shrink-0 text-center text-xs",
        status === "completed" ? "text-emerald-400" : status === "in_progress" ? "text-violet-400" : "text-neutral-600",
      )}
    >
      {STATUS_GLYPH[status] ?? "○"}
    </span>
  );
}

function StepRow({ entry }: { entry: PlanEntrySummary }) {
  return (
    <li className="flex items-start gap-2 py-1">
      <StatusIcon status={entry.status} />
      <span
        className={cn(
          "text-sm leading-snug",
          entry.status === "completed"
            ? "text-neutral-500 line-through decoration-neutral-700"
            : entry.status === "in_progress"
              ? "text-neutral-100"
              : "text-neutral-400",
        )}
      >
        {entry.content}
      </span>
    </li>
  );
}

function ProgressBar({ done, total }: { done: number; total: number }) {
  return (
    <div className="h-1 w-full overflow-hidden rounded-full bg-neutral-800">
      <div className="h-full bg-violet-500 transition-all" style={{ width: `${(done / total) * 100}%` }} />
    </div>
  );
}

/**
 * Variant A — inline card in the transcript.
 * The plan is a point-in-time artifact: it lands where it arrived, scrolls
 * away with history, and a later plan revision appears as a new card below.
 */
export function VariantAInlineCard({ entries }: { entries: PlanEntrySummary[] }) {
  const done = completedCount(entries);
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/60 p-3">
      <div className="mb-2 flex items-baseline justify-between gap-2">
        <span className="text-xs font-medium uppercase tracking-wide text-neutral-400">Plan</span>
        <span className="text-xs text-neutral-500">
          {done}/{entries.length} done
        </span>
      </div>
      <ul className="space-y-0.5">
        {entries.map((entry, index) => (
          <StepRow key={index} entry={entry} />
        ))}
      </ul>
      <p className="mt-2 text-[11px] text-neutral-600">Updated as the agent works · scrolls with the transcript</p>
    </div>
  );
}
VariantAInlineCard.variantName = "Inline card in the transcript";

/**
 * Variant B — collapsible pinned strip, directly modelled on CheckpointStrip.
 * Collapsed it is one line: progress plus the step being worked on. Expanded
 * it is the full checklist. Always visible, never scrolls away.
 */
export function VariantBPinnedStrip({ entries }: { entries: PlanEntrySummary[] }) {
  const [expanded, setExpanded] = useState(false);
  const done = completedCount(entries);
  const current = currentEntry(entries);

  return (
    <div className="border-b border-neutral-800 bg-neutral-950">
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((value) => !value)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-neutral-900"
      >
        <span aria-hidden className={cn("text-xs text-neutral-500 transition-transform", expanded && "rotate-90")}>
          ▸
        </span>
        <span className="shrink-0 rounded-md border border-violet-500/40 px-1.5 py-0.5 text-[11px] text-violet-300">
          Plan {done}/{entries.length}
        </span>
        <span className="truncate text-xs text-neutral-300">{current?.content ?? "All steps complete"}</span>
      </button>
      {expanded && (
        <div className="px-3 pb-2">
          <ul className="space-y-0.5">
            {entries.map((entry, index) => (
              <StepRow key={index} entry={entry} />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
VariantBPinnedStrip.variantName = "Collapsible pinned strip";

/**
 * Variant C — progress pill above the composer that opens a plan panel.
 *
 * The panel grows *upward* from just above the pill: it takes height from the
 * transcript (which is flex-1 and simply shrinks), so the composer and the app's
 * bottom tab bar stay visible and usable the whole time it is open. Deliberately
 * not an `absolute inset-0` overlay — a sheet that lands on top of the input is
 * a sheet you have to dismiss before you can answer the agent.
 */
export function VariantCBottomSheet({ entries }: { entries: PlanEntrySummary[] }) {
  const [open, setOpen] = useState(false);
  const done = completedCount(entries);
  const current = currentEntry(entries);

  return (
    <>
      {open && (
        <div className="max-h-[62%] shrink overflow-y-auto overscroll-contain rounded-t-2xl border-t border-neutral-800 bg-neutral-900/95 px-4 pb-3 pt-2">
          <div aria-hidden className="mx-auto mb-2 h-1 w-10 rounded-full bg-neutral-700" />
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <h2 className="text-sm font-medium text-neutral-100">Plan</h2>
            <span className="text-xs text-neutral-500">
              {done}/{entries.length} done
            </span>
          </div>
          <ul className="space-y-1">
            {entries.map((entry, index) => (
              <StepRow key={index} entry={entry} />
            ))}
          </ul>
        </div>
      )}

      <div className="border-t border-neutral-800 px-3 py-2">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center gap-3 rounded-full border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-left hover:bg-neutral-800"
        >
          <span className="shrink-0 text-[11px] font-medium text-violet-300">
            {done}/{entries.length}
          </span>
          <span className="w-16 shrink-0">
            <ProgressBar done={done} total={entries.length} />
          </span>
          <span className="min-w-0 flex-1 truncate text-[11px] text-neutral-400">{current?.content ?? "Plan complete"}</span>
          <span aria-hidden className={cn("shrink-0 text-xs text-neutral-500 transition-transform", open && "rotate-180")}>
            ⌃
          </span>
        </button>
      </div>
    </>
  );
}
VariantCBottomSheet.variantName = "Composer pill → expanding panel";

/**
 * Variant D — the plan gets its own tab in the bottom tab bar, with a badge.
 * Chat stays completely clean; the plan is a full-screen, grouped view.
 */
export function VariantDPlanTab({ entries }: { entries: PlanEntrySummary[] }) {
  const done = entries.filter((entry) => entry.status === "completed");
  const now = entries.filter((entry) => entry.status === "in_progress");
  const next = entries.filter((entry) => entry.status === "pending");

  const section = (title: string, rows: PlanEntrySummary[]) =>
    rows.length === 0 ? null : (
      <section key={title} className="mb-4">
        <h3 className="mb-1 text-xs uppercase tracking-wide text-neutral-500">{title}</h3>
        <ul className="space-y-0.5">
          {rows.map((entry, index) => (
            <StepRow key={index} entry={entry} />
          ))}
        </ul>
      </section>
    );

  return (
    <div className="h-full overflow-y-auto bg-neutral-950 p-4">
      <div className="mb-3">
        <div className="mb-1 flex items-baseline justify-between">
          <h2 className="text-sm font-medium text-neutral-100">Plan</h2>
          <span className="text-xs text-neutral-500">
            {done.length}/{entries.length} done
          </span>
        </div>
        <ProgressBar done={done.length} total={entries.length} />
      </div>
      {section("Now", now)}
      {section("Next", next)}
      {section("Done", done)}
    </div>
  );
}
VariantDPlanTab.variantName = "Dedicated Plan tab";
