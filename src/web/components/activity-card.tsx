import { useState } from "react";
import type { TimelineToolCall } from "../chat-state.js";
import { flattenBlockText, renderContentBlock } from "./content-block.js";
import { Badge } from "./ui/badge.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.js";
import { Item, ItemActions, ItemContent, ItemTitle } from "./ui/item.js";

/**
 * How much of an activity's result text the collapsed card shows.
 *
 * Deliberately shorter than the server's 400-character `detail` bound
 * (see activity-bounds.ts) so a collapsed card stays compact — roughly six
 * lines at 390px, which is the width that actually has to stay scrollable.
 *
 * Applied here rather than read from the server's `detail` column on
 * purpose: a live tool call has no `detail`, so sourcing the preview from
 * it would give replayed activities a different preview length from live
 * ones — the live-vs-replay divergence spec #93 phase 1 already had to fix
 * once. One rule, both paths.
 */
export const ACTIVITY_PREVIEW_CHARS = 240;

/** Marks a preview as cut short, so a clamped result is never read as a short one. */
const ELLIPSIS = "…";

/**
 * A failed or rejected call has to be distinguishable at a glance from one
 * that ran — the record is meant to show what was refused as well as what
 * succeeded (spec #93 story 8).
 */
function statusVariant(status: NonNullable<TimelineToolCall["status"]>) {
  switch (status) {
    case "failed":
      return "destructive" as const;
    case "completed":
      return "secondary" as const;
    default:
      return "outline" as const;
  }
}

/**
 * One thing the agent did, live or replayed from history.
 *
 * Takes a TimelineToolCall rather than an ActivityRecord so a single card
 * renders both paths — a replayed activity is merged into the timeline as
 * a tool call precisely so the two can't drift apart.
 *
 * Only *text* is ever truncated. Images and resource links render in full
 * whether the card is collapsed or not, because that is what the card did
 * before spec #93 phase 2 migrated it, and story 63 asks a migration to
 * preserve behaviour. Gating them behind the expand control (an earlier
 * shape of this component) made an image in a short result unreachable:
 * there was no clamped text, so no trigger appeared.
 */
export function ActivityCard({ item }: { item: TimelineToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const text = flattenBlockText(item.content);
  const nonTextBlocks = item.content.filter((block) => block.type !== "text");
  const clamped = text.length > ACTIVITY_PREVIEW_CHARS;
  const preview = clamped ? text.slice(0, ACTIVITY_PREVIEW_CHARS - ELLIPSIS.length) + ELLIPSIS : text;

  return (
    <Item variant="outline" size="sm" className="flex-col items-stretch gap-1.5">
      <div className="flex w-full items-center justify-between gap-2">
        <ItemTitle className="min-w-0 truncate">{item.title ?? item.id}</ItemTitle>
        {item.status && (
          <ItemActions>
            <Badge data-testid="activity-status" variant={statusVariant(item.status)}>
              {item.status}
            </Badge>
          </ItemActions>
        )}
      </div>

      {item.dataTruncated && (
        <p className="text-xs text-muted-foreground">
          This result was too large to store in full — what follows is the part that was kept.
        </p>
      )}

      {nonTextBlocks.length > 0 && (
        <ItemContent className="text-muted-foreground">
          {nonTextBlocks.map((block, i) => renderContentBlock(block, i))}
        </ItemContent>
      )}

      {text.length > 0 &&
        (clamped ? (
          <Collapsible open={expanded} onOpenChange={setExpanded}>
            {!expanded && (
              <ItemContent data-testid="activity-preview" className="text-muted-foreground">
                {preview}
              </ItemContent>
            )}
            <CollapsibleContent>
              <ItemContent className="text-muted-foreground">
                <span className="whitespace-pre-wrap">{text}</span>
              </ItemContent>
            </CollapsibleContent>
            <CollapsibleTrigger className="mt-1 text-xs text-primary underline underline-offset-2">
              {expanded ? "Show less" : "Show more"}
            </CollapsibleTrigger>
          </Collapsible>
        ) : (
          <ItemContent data-testid="activity-preview" className="text-muted-foreground">
            <span className="whitespace-pre-wrap">{text}</span>
          </ItemContent>
        ))}
    </Item>
  );
}
