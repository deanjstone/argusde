import type { TimelineItem } from "../chat-reducer.js";
import { ContentBlockView } from "./ContentBlockView.js";

interface Props {
  timeline: TimelineItem[];
  agentStatus: "idle" | "working";
}

export function MessageList({ timeline, agentStatus }: Props) {
  return (
    <div className="message-list">
      {timeline.map((item) =>
        item.type === "message" ? (
          <div key={item.id} className={`message message-${item.role}`}>
            <div className="message-role">{item.role}</div>
            <div className="message-content">
              {item.content.map((block, i) => (
                <ContentBlockView key={i} block={block} />
              ))}
            </div>
          </div>
        ) : (
          <div key={item.id} className={`tool-call tool-call-${item.status ?? "pending"}`}>
            <div className="tool-call-title">{item.title ?? item.id}</div>
            {item.status && <div className="tool-call-status">{item.status}</div>}
            <div className="tool-call-content">
              {item.content.map((block, i) => (
                <ContentBlockView key={i} block={block} />
              ))}
            </div>
          </div>
        ),
      )}
      {agentStatus === "working" && <div className="agent-working-indicator">Claude is working…</div>}
    </div>
  );
}
