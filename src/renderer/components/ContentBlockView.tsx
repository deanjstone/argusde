import type { ChatContentBlock } from "../../shared/acp-events.js";

export function ContentBlockView({ block }: { block: ChatContentBlock }) {
  switch (block.type) {
    case "text":
      return <p>{block.text}</p>;
    case "image":
      return <img src={block.uri ?? `data:${block.mimeType};base64,${block.data}`} alt="" />;
    case "resource_link":
      return (
        <a href={block.uri} target="_blank" rel="noreferrer">
          {block.name}
        </a>
      );
    default:
      return null;
  }
}
