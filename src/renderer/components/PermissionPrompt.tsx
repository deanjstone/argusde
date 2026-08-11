import type { PendingPermissionRequest } from "../chat-reducer.js";
import type { PermissionOutcome } from "../../shared/acp-events.js";

interface Props {
  request: PendingPermissionRequest;
  onRespond: (requestId: string, outcome: PermissionOutcome) => void;
}

export function PermissionPrompt({ request, onRespond }: Props) {
  return (
    <div className="permission-prompt" role="alertdialog">
      <p>
        Claude wants to: <strong>{request.toolCallTitle ?? request.toolCallId}</strong>
      </p>
      <div className="permission-options">
        {request.options.map((option) => (
          <button key={option.optionId} onClick={() => onRespond(request.requestId, { optionId: option.optionId })}>
            {option.name}
          </button>
        ))}
        <button onClick={() => onRespond(request.requestId, "cancelled")}>Cancel</button>
      </div>
    </div>
  );
}
