import type { SessionModeSummary } from "../../shared/acp-events.js";

export interface ModeSwitcherProps {
  currentModeId: string | undefined;
  availableModes: SessionModeSummary[];
  onSetMode: (modeId: string) => void;
}

/**
 * Compact per-Thread mode switcher (spec #33 decision #9), rendered bare
 * with no parent-side conditional needed — owns its own empty-catalog
 * guard and container styling, matching CheckpointStrip's precedent in
 * this same file tree. Renders nothing when the connected agent doesn't
 * advertise any modes.
 */
export function ModeSwitcher({ currentModeId, availableModes, onSetMode }: ModeSwitcherProps) {
  if (availableModes.length === 0) return null;

  // A mid-session current_mode_update can in principle report a mode id
  // outside the catalog learned at start (stale catalog, agent bug, or a
  // mode added after start()) — without this, the native <select> would
  // silently fall back to highlighting the first real option, misrepresenting
  // which mode is actually active rather than showing the true (if unrecognized) value.
  const isKnownMode = availableModes.some((mode) => mode.id === currentModeId);

  return (
    <div className="flex justify-end border-b border-border px-3 py-2">
      <select
        aria-label="Agent mode"
        value={currentModeId}
        onChange={(event) => onSetMode(event.target.value)}
        className="rounded-md border border-input bg-card px-2 py-1 text-xs text-foreground"
      >
        {!isKnownMode && currentModeId !== undefined && (
          <option value={currentModeId} disabled>
            {currentModeId} (unknown)
          </option>
        )}
        {availableModes.map((mode) => (
          <option key={mode.id} value={mode.id}>
            {mode.name}
          </option>
        ))}
      </select>
    </div>
  );
}
