import type { ChatContentBlock } from "../../shared/acp-events.js";

/**
 * Per-activity storage bounds (spec #93 phase 1).
 *
 * T3 Code's equivalents are 120/180 characters, tuned for a dense desktop
 * timeline. ArgusDE's chat surface is mobile-first — roughly 40 characters
 * to a line at 390px — so these were picked against *this* UI rather than
 * inherited:
 *
 * - `summary` is the activity card's headline. 100 characters is about two
 *   lines on a phone, past which it stops reading as a headline.
 * - `detail` is the expanded card's body. 400 characters is about ten lines
 *   on a phone: enough to judge a tool result without scrolling into it.
 * - `data` has no T3 counterpart — T3's prose is already truncated upstream,
 *   whereas ArgusDE passes ACP tool content through directly and ACP results
 *   can carry whole file contents. 16 KiB of serialised JSON bounds what one
 *   pathological result can write, and the caller is told it happened rather
 *   than silently losing the tail.
 */
export const ACTIVITY_BOUNDS = {
  summaryChars: 100,
  detailChars: 400,
  dataBytes: 16 * 1024,
} as const;

/** Marks a value as cut short, so a truncated string is never mistaken for the whole of a short one. */
const ELLIPSIS = "…";

/**
 * Cuts to at most `max` characters, spending the last one on an ellipsis so
 * the result still fits the bound exactly. A string already within the bound
 * is returned untouched (no ellipsis), which is what makes "ends with …"
 * meaningful.
 */
export function boundText(value: string | null | undefined, max: number): string | null {
  if (value === null || value === undefined) return null;
  if (value.length <= max) return value;
  return value.slice(0, max - ELLIPSIS.length) + ELLIPSIS;
}

/**
 * Serialises content blocks, dropping blocks from the end until the JSON
 * fits the byte cap.
 *
 * Whole blocks rather than a substring of the serialised form, because the
 * stored value has to stay parseable JSON — a byte-sliced payload is not a
 * smaller payload, it's a corrupt one. A single first block that overflows
 * on its own degrades to an empty array rather than storing something
 * unreadable; `truncated` is what tells the reader either happened.
 */
export function boundData(data: ChatContentBlock[]): { data: ChatContentBlock[]; truncated: boolean } {
  const serialised = JSON.stringify(data);
  if (Buffer.byteLength(serialised, "utf8") <= ACTIVITY_BOUNDS.dataBytes) {
    return { data, truncated: false };
  }

  const kept: ChatContentBlock[] = [];
  for (const block of data) {
    const candidate = [...kept, block];
    if (Buffer.byteLength(JSON.stringify(candidate), "utf8") > ACTIVITY_BOUNDS.dataBytes) break;
    kept.push(block);
  }
  return { data: kept, truncated: true };
}

/**
 * Flattens a tool call's content blocks into the plain-text preview stored
 * as `detail`. Non-text blocks contribute a short placeholder rather than
 * nothing, so an activity whose whole result is an image still says so
 * instead of appearing to have produced no output at all.
 */
export function flattenDetail(data: ChatContentBlock[]): string | null {
  const parts = data.map((block) => {
    switch (block.type) {
      case "text":
        return block.text;
      case "image":
        return `[image ${block.mimeType}]`;
      case "resource_link":
        return `[${block.name}](${block.uri})`;
      case "other":
        return "[unsupported content]";
    }
  });
  const joined = parts.join("\n").trim();
  return joined.length > 0 ? joined : null;
}
