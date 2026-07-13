# Ask the Record — UI polish pass

Frontend-only refinement of `src/routes/_authenticated/search.tsx` (+ small tweaks to `useSmoothText.ts` and `src/styles.css`). No orchestration or edge-function changes.

## Goals
- Cleaner, more modern "enterprise-legal" feel — rectangular chat surfaces, hairline borders, more breathing room, less ornament.
- Smoother, faster-feeling streaming timeline.
- Tighter composer + message rhythm.

## Changes

### 1. Chat surface (message column)
- Replace the current soft/rounded card treatment with **rectangular message blocks**: `rounded-none` (or `rounded-sm` max), single hairline `border-b border-border/40` between turns, generous vertical padding (`py-6`), max content width ~720px, centered.
- User turn: right-aligned label ("You · timestamp") in tabular-nums small-caps, body in Source Serif at 15/24.
- Assistant turn: left rail with a 2px navy accent bar next to the answer; markdown body at 15.5/26 for editorial density.
- Remove nested card shadows; rely on border + spacing.

### 2. Timeline (RunCard / ThoughtStepRow)
- Collapse the rail into a **single 1px vertical hairline** with small square (not circular) nodes — 6px, filled with tool accent color, hollow when pending.
- Replace per-row cards with flat rows: `[node] [tool label · monospaced tabular time] [reasoning line]`, no borders, `gap-3`, `py-1.5`.
- Active row: thin left accent + `shimmer-text` on the reasoning line only (kill background shimmers on the row itself).
- Add a subtle **layout transition** (`transition-all duration-200 ease-out`) so newly appended rows fade+slide 4px, not pop.
- Elapsed time: right-aligned, `tabular-nums text-[11px] text-muted-foreground/70`, updates via existing 250ms ticker.
- Collapsed "Writing…" state: single centered shimmer line, no card chrome.

### 3. Composer
- Make it a true rectangular bar: `rounded-lg` (down from current), 1px border, `bg-background`, soft `shadow-[0_1px_0_rgba(0,0,0,0.02)]` only.
- Softer `composer-halo` (drop opacity further, tighter radius match).
- Submit button: square-ish 36×36, oxblood fill only when input non-empty; otherwise ghost.
- Placeholder copy simplified to "Ask the record…".
- Keep bottom-pinned with backdrop blur; reduce blur strength for a crisper edge.

### 4. Faster-feeling streaming
- `useSmoothText`: raise default chars/tick and reduce interval so tokens reveal ~1.6× faster (tune constants; keep the smoothing curve).
- Writer markdown smoothing: drop the 550ms cadence closer to ~180–220ms so paragraphs appear promptly.
- Reasoning lines: bump from 55 → ~90 chars/tick for snappier feel.
- Keep `prefers-reduced-motion` short-circuit intact.

### 5. Micro-polish
- Unify all timestamps/counts to `tabular-nums`.
- Replace remaining emoji-ish or heavier iconography in the trace with 14px lucide icons at `stroke-[1.5]`.
- Empty launcher: tighten SuggestionDeck card padding and use the same rectangular border language.
- Ensure light/dark parity for new borders (`border-border/40` tokens only, no hardcoded colors).

## Files touched
- `src/routes/_authenticated/search.tsx` — Composer, RunCard, ThoughtStepRow, message rendering, writer smoothing constants.
- `src/lib/useSmoothText.ts` — default speed constants.
- `src/styles.css` — refine `composer-halo`, add optional `.msg-rail` accent + row transition utility.

## Out of scope
- No changes to `useSynthesisStream`, edge functions, retrieval, or tool set.
- No changes to sidebar, other routes, or evidence panel logic (only visual token alignment if trivially adjacent).
