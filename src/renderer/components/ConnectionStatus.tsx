import type { ConnectionState } from "../../shared/acp-events.js";

interface Props {
  state: ConnectionState;
  error: string | undefined;
  onRestart: () => void;
}

export function ConnectionStatus({ state, error, onRestart }: Props) {
  if (state === "connected") return null;

  return (
    <div className={`connection-status connection-status-${state}`}>
      <span>
        {state === "connecting" && "Connecting to Claude Code…"}
        {state === "disconnected" && "Disconnected from Claude Code."}
        {state === "error" && `Connection error${error ? `: ${error}` : "."}`}
      </span>
      {(state === "disconnected" || state === "error") && <button onClick={onRestart}>Restart session</button>}
    </div>
  );
}
