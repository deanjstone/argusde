import type { ChatContentBlock } from "../../shared/acp-events.js";

/**
 * Renders one ACP content block, wherever a block is displayed — the chat
 * transcript's message bubbles and the activity card alike.
 *
 * Shared rather than copied because those two surfaces render the *same*
 * blocks: an agent's reply and a tool call's result are both
 * `ChatContentBlock[]`, and a live tool call and a replayed activity are
 * the same shape by design (see mergeHistoryTimeline). Two copies would
 * drift, and drift between the live and the replayed view is the exact
 * class of bug spec #93 has already had to fix twice.
 */
export function renderContentBlock(block: ChatContentBlock, key: number) {
  switch (block.type) {
    case "text":
      return (
        <span key={key} className="whitespace-pre-wrap">
          {block.text}
        </span>
      );
    case "image":
      // A real alt, not the empty one this carried before spec #93 phase 2.
      // An image in a message or a tool result is *content* — an empty alt
      // marks it decorative and hides it from assistive tech entirely.
      // ACP gives no caption to use, so this says what it is and no more;
      // story 65 explicitly allows a migration to improve accessibility.
      return (
        <img
          key={key}
          src={block.uri ?? `data:${block.mimeType};base64,${block.data}`}
          alt="Image content"
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
 * Flattens blocks into the plain text a collapsed activity card previews.
 * Only text blocks contribute — anything else is rendered directly beside
 * the preview rather than described in it, so there is no placeholder to
 * write here.
 */
export function flattenBlockText(content: ChatContentBlock[]): string {
  return content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n")
    .trim();
}
