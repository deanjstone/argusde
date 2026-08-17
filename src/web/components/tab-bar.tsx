import { cn } from "../lib/utils.js";

export type Tab = "chat" | "files" | "threads" | "settings";

export interface TabBarProps {
  active: Tab;
  onChange: (tab: Tab) => void;
}

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "chat", label: "Chat" },
  { id: "files", label: "Files" },
  { id: "threads", label: "Threads" },
  { id: "settings", label: "Settings" },
];

/** Bottom tab-bar navigation shell, per the mobile-first UI direction chosen in the prototype (spec #33). */
export function TabBar({ active, onChange }: TabBarProps) {
  return (
    // Flex with equal-basis children rather than `grid-cols-N`, which had to
    // be edited by hand when a fourth tab was added and silently mislaid one
    // until it was. An inline `gridTemplateColumns` would have been the
    // obvious fix and is not available: this app is served under
    // `style-src 'self'`, which blocks inline style attributes.
    <nav className="flex border-t border-border bg-background pb-[env(safe-area-inset-bottom)]">
      {TABS.map((tab) => (
        <button
          key={tab.id}
          type="button"
          aria-current={tab.id === active ? "page" : undefined}
          onClick={() => onChange(tab.id)}
          className={cn(
            "flex-1 py-2.5 text-sm font-medium transition-colors",
            // --primary-bright, not --primary: the accent doubles as a surface
            // colour and so has to stay dark enough for near-white text on
            // top of it, which leaves it at 3.35:1 as text on the app
            // background. Same hue, readable weight.
            tab.id === active ? "text-primary-bright" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {tab.label}
        </button>
      ))}
    </nav>
  );
}
