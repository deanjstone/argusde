import { cn } from "../lib/utils.js";

export type Tab = "chat" | "threads" | "settings";

export interface TabBarProps {
  active: Tab;
  onChange: (tab: Tab) => void;
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "threads", label: "Threads" },
  { id: "settings", label: "Settings" },
];

/** Bottom tab-bar navigation shell, per the mobile-first UI direction chosen in the prototype (spec #33). */
export function TabBar({ active, onChange }: TabBarProps) {
  return (
    <nav className="grid grid-cols-3 border-t border-neutral-800 bg-neutral-950 pb-[env(safe-area-inset-bottom)]">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          aria-current={tab.id === active ? "page" : undefined}
          onClick={() => onChange(tab.id)}
          className={cn(
            "py-2.5 text-sm font-medium transition-colors",
            tab.id === active ? "text-violet-400" : "text-neutral-500 hover:text-neutral-300",
          )}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
