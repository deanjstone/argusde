import type { SessionUsage } from "../../shared/acp-events.js";
import { cn } from "../lib/utils.js";
import { Progress } from "./ui/progress.js";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "./ui/tooltip.js";

export interface ContextMeterProps {
  usage: SessionUsage | null;
}

export type PressureBand = "comfortable" | "warning" | "pressure";

/**
 * How much room is left, as a band rather than a number, so the appearance can
 * change under pressure (story 48).
 *
 * Proportional, not absolute. The real claude-agent-acp reports a 1,000,000
 * token window and sat at ~5% after two turns — an absolute "nearly full"
 * threshold would never be reached, and the meter would be decorative.
 */
export function pressureBand(fraction: number): PressureBand {
  if (fraction >= 0.9) return "pressure";
  if (fraction >= 0.75) return "warning";
  return "comfortable";
}

const BAND_INDICATOR: Record<PressureBand, string> = {
  comfortable: "[&>[data-slot=progress-indicator]]:bg-primary",
  warning: "[&>[data-slot=progress-indicator]]:bg-warning",
  pressure: "[&>[data-slot=progress-indicator]]:bg-destructive",
};

const BAND_LABEL: Record<PressureBand, string> = {
  comfortable: "text-muted-foreground",
  warning: "text-warning",
  pressure: "text-destructive",
};

/**
 * The context meter (spec #93 phase 9).
 *
 * Absent when the agent has reported nothing (story 50) — an absent meter, not
 * a zeroed one: a 0% bar is a claim about the context, where nothing at all is
 * the honest statement that nothing was reported. That is also the state of a
 * freshly reopened Thread, whose new session starts with an empty context and
 * has not yet reported.
 */
export function ContextMeter({ usage }: ContextMeterProps) {
  if (!usage) return null;

  // A zero-sized window would otherwise produce NaN and render as "NaN%".
  const fraction = usage.size > 0 ? Math.min(usage.used / usage.size, 1) : 0;
  const percent = Math.round(fraction * 100);
  const band = pressureBand(fraction);
  const label = `Context: ${usage.used.toLocaleString()} of ${usage.size.toLocaleString()} tokens used`;

  return (
    <TooltipProvider>
      <Tooltip>
        {/* asChild on a plain element, never on a shadcn primitive: the CLI
            emits React-19-style components that cannot receive a ref under
            this project's React 18, and an unmeasurable trigger positions its
            overlay off-screen (argusde#122 lost real time to exactly this). */}
        <TooltipTrigger asChild>
          <div className="flex shrink-0 items-center gap-1.5" data-slot="context-meter">
            <Progress
              value={percent}
              // The figures are on the element itself, not only in the
              // tooltip: story 49 wants this compact, but a tooltip is
              // unreachable on a phone, which is the case this app is for.
              aria-label={label}
              data-band={band}
              className={cn("w-12", BAND_INDICATOR[band])}
            />
            <span className={cn("text-xs tabular-nums", BAND_LABEL[band])}>{percent}%</span>
          </div>
        </TooltipTrigger>
        <TooltipContent>{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
