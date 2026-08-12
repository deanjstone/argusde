import type { AcpSessionEvent, PermissionOutcome } from "../shared/acp-events.js";

export interface ArgusDeRendererApi {
  onSessionEvent(listener: (event: AcpSessionEvent) => void): () => void;
  sendMessage(text: string): Promise<void>;
  respondToPermission(requestId: string, outcome: PermissionOutcome): Promise<void>;
  restartSession(): Promise<void>;
}

declare global {
  interface Window {
    argusde: ArgusDeRendererApi;
  }
}
