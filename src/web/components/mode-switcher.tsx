import type { SessionModeSummary } from "../../shared/acp-events.js";

export interface ModeSwitcherProps {
  currentModeId: string | undefined;
  availableModes: SessionModeSummary[];
  onSetMode: (modeId: string) => void;
}

/** Compact per-Thread mode switcher (spec #33 decision #9) — renders nothing when the connected agent doesn't advertise any modes. */
export function ModeSwitcher({ currentModeId, availableModes, onSetMode }: ModeSwitcherProps) {
  if (availableModes.length === 0) return null;

  return (
    <select
      aria-label="Agent mode"
      value={currentModeId}
      onChange={(event) => onSetMode(event.target.value)}
      className="rounded-md border border-neutral-700 bg-neutral-900 px-2 py-1 text-xs text-neutral-300"
    >
      {availableModes.map((mode) => (
        <option key={mode.id} value={mode.id}>
          {mode.name}
        </option>
      ))}
    </select>
  );
}
