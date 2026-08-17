import { useState } from "react";
import type { ChatContentBlock } from "../../shared/acp-events.js";
import type { TimelineToolCall } from "../chat-state.js";
import { Badge } from "./ui/badge.js";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "./ui/collapsible.js";
import { Item, ItemActions, ItemContent, ItemTitle } from "./ui/item.js";

/**
 * How much of an activity's result the collapsed card shows.
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
 * Flattens a tool call's content into the plain text the collapsed card
 * previews. Non-text blocks contribute a short placeholder rather than
 * nothing, so an activity whose whole result is an image still reads as
 * having produced something.
 */
function previewText(content: ChatContentBlock[]): string {
  return content
    .map((block) => {
      switch (block.type) {
        case "text":
          return block.text;
        case "image":
          return `[image ${block.mimeType}]`;
        case "resource_link":
          return `[${block.name}]`;
        default:
          return "";
      }
    })
    .join("\n")
    .trim();
}

function renderContentBlock(block: ChatContentBlock, key: number) {
  switch (block.type) {
    case "text":
      return (
        <span key={key} className="whitespace-pre-wrap">
          {block.text}
        </span>
      );
    case "image":
      return (
        <img
          key={key}
          src={block.uri ?? `data:${block.mimeType};base64,${block.data}`}
          alt=""
          className="max-w-full rounded"
        />
      );
    case "resource_link":
      return (
        <a key={key} href={block.uri} className="text-primary underline">
          {block.name}
        </a>
      );
    default:
      return null;
  }
}

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
 */
export function ActivityCard({ item }: { item: TimelineToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const text = previewText(item.content);
  const clamped = text.length > ACTIVITY_PREVIEW_CHARS;
  const preview = clamped ? text.slice(0, ACTIVITY_PREVIEW_CHARS - ELLIPSIS.length) + ELLIPSIS : text;
  // An image-only result has no preview text but is still worth opening,
  // so expandability is keyed off having any content at all rather than
  // off the preview being clamped.
  const canExpand = clamped || (text.length === 0 && item.content.length > 0);

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

      {item.content.length > 0 && (
        <Collapsible open={expanded} onOpenChange={setExpanded}>
          {!expanded && text.length > 0 && (
            <ItemContent data-testid="activity-preview" className="text-muted-foreground">
              {preview}
            </ItemContent>
          )}
          <CollapsibleContent>
            <ItemContent className="text-muted-foreground">
              {item.content.map((block, i) => renderContentBlock(block, i))}
            </ItemContent>
          </CollapsibleContent>
          {canExpand && (
            <CollapsibleTrigger className="mt-1 text-xs text-primary underline underline-offset-2">
              {expanded ? "Show less" : "Show more"}
            </CollapsibleTrigger>
          )}
        </Collapsible>
      )}
    </Item>
  );
}
