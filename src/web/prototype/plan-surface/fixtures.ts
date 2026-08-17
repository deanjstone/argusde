// PROTOTYPE — throwaway (argusde#90). Fake data only; nothing here talks to a server.
import type { PlanEntrySummary } from "../../../shared/acp-events.js";
import type { CheckpointRecord } from "../../../shared/ws-protocol.js";
import type { ChatState } from "../../chat-state.js";

/** A five-step plan, deliberately long enough that a phone can't show it all at once. */
export const PLAN: PlanEntrySummary[] = [
  { content: "Read chat-state.ts and find where plan events are discarded", priority: "high", status: "completed" },
  { content: "Add a plan case to the reducer and store the latest entries", priority: "high", status: "completed" },
  { content: "Render the plan surface in ChatView and wire it to the reducer state", priority: "high", status: "in_progress" },
  { content: "Cover the reducer case and the surface with tests", priority: "medium", status: "pending" },
  { content: "Check the surface against the mobile viewport and the axe pass", priority: "low", status: "pending" },
];

export const PLAN_STEPS_TOTAL = PLAN.length;

export function planAtStep(step: number): PlanEntrySummary[] {
  return PLAN.map((entry, index) => ({
    ...entry,
    status: index < step ? "completed" : index === step ? "in_progress" : "pending",
  }));
}

export function completedCount(entries: PlanEntrySummary[]): number {
  return entries.filter((entry) => entry.status === "completed").length;
}

export function currentEntry(entries: PlanEntrySummary[]): PlanEntrySummary | undefined {
  return entries.find((entry) => entry.status === "in_progress") ?? entries.find((entry) => entry.status === "pending");
}

export const CHECKPOINTS: CheckpointRecord[] = [
  { turn: 0, threadId: "proto", ref: "refs/argusde/turn-0", createdAt: "2026-08-17T09:00:00.000Z", revertedToTurn: null },
  { turn: 1, threadId: "proto", ref: "refs/argusde/turn-1", createdAt: "2026-08-17T09:04:00.000Z", revertedToTurn: null },
  { turn: 2, threadId: "proto", ref: "refs/argusde/turn-2", createdAt: "2026-08-17T09:11:00.000Z", revertedToTurn: null },
];

/** Enough transcript that the plan surface has to compete with real chat density. */
export const CHAT_STATE: ChatState = {
  connectionState: "connected",
  connectionError: undefined,
  agentStatus: "working",
  apiVersion: "1.0.0",
  currentModeId: "default",
  availableModes: [
    { id: "default", name: "Always ask" },
    { id: "acceptEdits", name: "Accept edits" },
  ],
  pendingPermissionRequest: undefined,
  timeline: [
    {
      type: "message",
      id: "m1",
      role: "user",
      content: [{ type: "text", text: "Surface the agent's plan in the chat view — plan entries already reach the reducer." }],
    },
    {
      type: "message",
      id: "m2",
      role: "agent",
      content: [
        {
          type: "text",
          text: "I'll start by reading the reducer to see exactly where plan entries are dropped, then decide where the surface hangs off ChatView.",
        },
      ],
    },
    {
      type: "tool-call",
      id: "t1",
      title: "Read src/web/chat-state.ts",
      status: "completed",
      content: [{ type: "text", text: 'case "plan": return state;  // line 122' }],
    },
    {
      type: "message",
      id: "m3",
      role: "agent",
      content: [
        {
          type: "text",
          text: "Confirmed — the entries arrive fully typed and are thrown away. Adding a latestPlan field to ChatState now.",
        },
      ],
    },
    {
      type: "tool-call",
      id: "t2",
      title: "Edit src/web/chat-state.ts",
      status: "in_progress",
      content: [{ type: "text", text: "+  latestPlan: PlanEntrySummary[];" }],
    },
  ],
};
