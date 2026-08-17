/// <reference types="vite/client" />
// PROTOTYPE — throwaway (argusde#90). Never rendered in a production build.
import { useEffect } from "react";

export interface PrototypeSwitcherProps {
  variants: string[];
  current: string;
  label: string;
  onChange: (variant: string) => void;
  /** Advances the fake agent one plan step, so each variant can be judged mid-run. */
  onAdvance: () => void;
  onReset: () => void;
  step: number;
  total: number;
  /** Shown in the bar itself so the fake agent state is always visible (prototype rule 5). */
  currentStepText: string;
}

export function PrototypeSwitcher({ variants, current, label, onChange, onAdvance, onReset, step, total, currentStepText }: PrototypeSwitcherProps) {
  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      const index = variants.indexOf(current);
      const delta = event.key === "ArrowRight" ? 1 : -1;
      onChange(variants[(index + delta + variants.length) % variants.length] ?? current);
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [variants, current, onChange]);

  if (import.meta.env.PROD) return null;

  const cycle = (delta: number) => {
    const index = variants.indexOf(current);
    onChange(variants[(index + delta + variants.length) % variants.length] ?? current);
  };

  return (
    // Top-centre, not the usual bottom-centre: the app's own primary nav is a
    // bottom tab bar, and one of the variants adds a tab to it — a bottom bar
    // would sit on top of the thing being evaluated.
    <div className="fixed left-1/2 top-2 z-50 w-[94vw] max-w-md -translate-x-1/2 rounded-xl border border-yellow-400/60 bg-yellow-300 px-2 py-1 text-neutral-900 shadow-lg">
      <div className="flex items-center gap-1">
        <button type="button" aria-label="Previous variant" onClick={() => cycle(-1)} className="px-2 text-sm font-bold">
          ←
        </button>
        <span className="min-w-0 flex-1 truncate text-center text-xs font-semibold">
          {current} — {label}
        </span>
        <button type="button" aria-label="Next variant" onClick={() => cycle(1)} className="px-2 text-sm font-bold">
          →
        </button>
      </div>
      <div className="flex items-center gap-2 border-t border-neutral-900/20 pt-1">
        <button
          type="button"
          onClick={onAdvance}
          disabled={step >= total}
          className="shrink-0 rounded-full bg-neutral-900 px-2 py-0.5 text-[11px] font-semibold text-yellow-300 disabled:opacity-40"
        >
          step {step}/{total} ▶
        </button>
        <button type="button" onClick={onReset} className="shrink-0 text-[11px] font-semibold underline">
          reset
        </button>
        <span className="min-w-0 flex-1 truncate text-[11px]">now: {currentStepText}</span>
      </div>
    </div>
  );
}
