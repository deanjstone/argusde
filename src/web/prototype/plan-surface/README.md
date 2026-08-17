# PROTOTYPE — plan surface (argusde#90)

**Throwaway.** Four variants of the plan surface, switchable via `?variant=`, mounted
inside the real `ChatView` + `TabBar` chrome with fake data. Nothing here connects to a
server and nothing here ships — the winner gets rewritten properly, the rest gets deleted.

## Run

```
pnpm prototype:plan
# → http://localhost:5199/prototype-plan.html?variant=A
```

Switcher bar sits at the **top** (the app's own nav is a bottom tab bar, and variant D
adds a tab to it). `←`/`→` arrow keys cycle variants; `step N/5 ▶` advances the fake
agent one plan step so each variant can be judged mid-run, not just at rest.

## Variants

| Key | Shape | Answers |
|---|---|---|
| A | Inline card in the transcript | plan as a point-in-time artifact; scrolls away with history |
| B | Collapsible pinned strip (CheckpointStrip-shaped) | always visible, one line collapsed, full checklist expanded |
| C | Composer pill → bottom sheet | chat chrome untouched, full plan one tap away, phone-native sheet |
| D | Dedicated Plan tab with a badge | chat stays clean, plan is a full-screen grouped view, invisible while chatting |

## What is throwaway and must go

- this whole directory
- `src/web/prototype-plan.html`
- the `prototype:plan` script in `package.json`
- the `planSlotPinned` / `planSlotInline` / `planSlotComposer` props in
  `src/web/components/chat-view.tsx` (marked `PROTOTYPE (argusde#90)`)
