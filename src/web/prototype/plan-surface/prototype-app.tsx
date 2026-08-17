/*
 * PROTOTYPE — throwaway (argusde#90): "What shape does the plan surface take?"
 *
 * Four variants of the plan surface, switchable via `?variant=`, mounted
 * inside the real ChatView + TabBar chrome with fake data. Nothing here
 * connects to a server; nothing here ships. Delete the whole directory
 * once the question is answered.
 */
import { useEffect, useState } from "react";
import { ChatView } from "../../components/chat-view.js";
import { TabBar, type Tab } from "../../components/tab-bar.js";
import { cn } from "../../lib/utils.js";
import { CHAT_STATE, CHECKPOINTS, PLAN_STEPS_TOTAL, completedCount, currentEntry, planAtStep } from "./fixtures.js";
import { PrototypeSwitcher } from "./prototype-switcher.js";
import { VariantAInlineCard, VariantBPinnedStrip, VariantCBottomSheet, VariantDPlanTab } from "./variants.js";

const VARIANTS = ["A", "B", "C", "D"] as const;
type VariantKey = (typeof VARIANTS)[number];

const VARIANT_LABELS: Record<VariantKey, string> = {
  A: VariantAInlineCard.variantName,
  B: VariantBPinnedStrip.variantName,
  C: VariantCBottomSheet.variantName,
  D: VariantDPlanTab.variantName,
};

function readVariant(): VariantKey {
  const value = new URLSearchParams(location.search).get("variant");
  return (VARIANTS as readonly string[]).includes(value ?? "") ? (value as VariantKey) : "A";
}

/** Variant D's four-tab bar — the real TabBar has three fixed tabs. */
function PlanTabBar({ active, badge, onChange }: { active: string; badge: string; onChange: (tab: string) => void }) {
  const tabs = [
    { id: "chat", label: "Chat" },
    { id: "plan", label: "Plan" },
    { id: "threads", label: "Threads" },
    { id: "settings", label: "Settings" },
  ];
  return (
    <nav className="grid grid-cols-4 border-t border-neutral-800 bg-neutral-950 pb-[env(safe-area-inset-bottom)]">
      {tabs.map((tab) => (
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
          {tab.id === "plan" && (
            <span className="ml-1 rounded-full bg-violet-500/20 px-1.5 py-0.5 text-[10px] text-violet-300">{badge}</span>
          )}
        </button>
      ))}
    </nav>
  );
}

export function PrototypeApp() {
  const [variant, setVariant] = useState<VariantKey>(readVariant);
  const [step, setStep] = useState(2);
  const [tab, setTab] = useState<Tab>("chat");
  const [planTab, setPlanTab] = useState("chat");

  // Prototype-only convenience: the real ChatView has no autoscroll yet, and
  // variant A's card lives at the bottom of the transcript — without this you
  // land above the fold and can't see the surface being judged.
  useEffect(() => {
    const panes = document.querySelectorAll<HTMLElement>("div.overflow-y-auto");
    panes.forEach((pane) => (pane.scrollTop = pane.scrollHeight));
  }, [variant, step]);

  const entries = planAtStep(step);
  const done = completedCount(entries);

  function changeVariant(next: string) {
    setVariant(next as VariantKey);
    const params = new URLSearchParams(location.search);
    params.set("variant", next);
    history.replaceState(null, "", `${location.pathname}?${params.toString()}`);
  }

  const chat = (
    <ChatView
      state={CHAT_STATE}
      onSend={() => {}}
      onRespondPermission={() => {}}
      checkpoints={CHECKPOINTS}
      availableTurns={CHECKPOINTS.map((c) => c.turn)}
      worktreePath="/home/deanj/.argusde/worktrees/proto"
      planSlotInline={variant === "A" ? <VariantAInlineCard entries={entries} /> : undefined}
      planSlotPinned={variant === "B" ? <VariantBPinnedStrip entries={entries} /> : undefined}
      planSlotComposer={variant === "C" ? <VariantCBottomSheet entries={entries} /> : undefined}
    />
  );

  return (
    <div className="relative flex h-dvh flex-col pt-14">
      <h1 className="sr-only">ArgusDE plan-surface prototype</h1>
      <main className="relative min-h-0 flex-1">
        {variant === "D" ? (
          planTab === "plan" ? (
            <VariantDPlanTab entries={entries} />
          ) : (
            chat
          )
        ) : (
          chat
        )}
      </main>
      {variant === "D" ? (
        <PlanTabBar active={planTab} badge={`${done}/${PLAN_STEPS_TOTAL}`} onChange={setPlanTab} />
      ) : (
        <TabBar active={tab} onChange={setTab} />
      )}
      <PrototypeSwitcher
        variants={[...VARIANTS]}
        current={variant}
        label={VARIANT_LABELS[variant]}
        onChange={changeVariant}
        onAdvance={() => setStep((value) => Math.min(value + 1, PLAN_STEPS_TOTAL))}
        onReset={() => setStep(0)}
        step={step}
        total={PLAN_STEPS_TOTAL}
        currentStepText={currentEntry(entries)?.content ?? "all steps complete"}
      />
    </div>
  );
}
