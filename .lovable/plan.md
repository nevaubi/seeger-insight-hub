
# Modernize the Ask-the-Record chat UI

Scope: `src/routes/search.tsx` (and small additions to `src/styles.css` / `src/lib/motion.ts`). Presentation-only. No changes to `useSynthesisStream`, the SSE contract, Supabase queries, or the synthesis endpoint. No new deps.

## What's there today (analysis)

- **Layout**: 3:2 split — left chat pane (user turn → RunCard → Answer card), right "Evidence" column. Composer docked at the bottom of the left pane. Hero/launcher state centers a single composer with example chips.
- **Streaming surfaces**:
  - `RunCard` shows a vertical timeline of search steps + a "Writing" step, with a collapsible "Show reasoning" block (raw thinking text) and round notes (including structured tool results like `list_orders`).
  - `AnswerStream` renders streamed markdown with inline numbered citation pills.
  - Evidence cards on the right; clicking a citation flashes the matching card.
- **Motion**: only `motion-fade-rise`, `motion-shimmer`, `motion-pulse-soft`, plain `Loader2` spinners. No staged transitions when state moves launcher → researching → answering → done. Reasoning/tool steps pop in without continuity.
- **Visual register**: serif headings, oxblood accent, slate neutrals — solid foundation, but several enterprise-grade gaps: flat skeletons, no glassy/elevated surfaces for the live "agent working" state, tool calls visually identical to plain search steps, no model/router header, no token-stream cursor, abrupt collapse of timeline when done.

## Goals

1. Feel like a current enterprise AI product (Linear / Vercel v0 / ChatGPT desktop level), while keeping the institutional legal aesthetic.
2. Make streaming legible: router decision → tool call → reasoning → answer, each with its own visual treatment and smooth transitions.
3. Smoother micro-motion across the whole chat lifecycle, no jank, prefers-reduced-motion respected.

## Plan

### 1. Conversation shell refresh
- Replace the plain bottom border on the docked composer with a soft top-gradient mask so streamed text fades under the composer instead of clipping.
- Widen the answer column to `max-w-[72ch]`, raise leading on the serif answer, tighten the user-turn avatar into a small "You" pill with a subtle border instead of filled primary disc (more enterprise, less consumer-chat).
- Add a slim **conversation header strip**: matter short_name · model badge ("Claude · router v12") · elapsed timer that ticks while `running`. Purely presentational; pull matter from `useMatter`, model label is a constant string.

### 2. New "Agent activity" card (replaces current RunCard chrome)
Single elevated card that becomes the live status surface while `running`, then gracefully collapses to a one-line summary when done.

Visual:
- Card with `bg-card/80 backdrop-blur` + a 1px inner ring, soft shadow on the *running* state only; shadow lifts away on completion (transitioned, not snapped).
- Header row: animated status dot (three states: routing / searching / writing), label that crossfades between phases via `motion-fade-rise` + key swap, right-side compact metrics (`searches · passages · citations`) with tabular nums.
- Vertical timeline keeps the rail but each step gets a typed **chip**:
  - `Router` (new, derived from the first thinking burst before any search/tool — show "Planning approach" then collapse)
  - `Search "keywords"` with filter chips (existing)
  - `Tool · list_orders` / `lookup_counsel` / `list_deadlines` — distinct icon + count, derived from the `notes` array entries produced by the `tool` SSE events (already in state, no hook changes)
  - `Writing the answer` (existing)
- Step pop-in: replace per-step `motion-fade-rise` with a staggered `translate-y-1 + opacity` transition using `var(--ease-out-soft)` and a tighter 180ms duration, capped stagger of 40ms × index. Active step gets a slow pulsing 2px left accent bar instead of just the dot pulse.
- "Show reasoning" → rename **Thoughts**, move into a tab inside the same card (Tabs: *Timeline · Thoughts*), instead of a nested collapsible. Thoughts pane streams the raw `thinking[round]` text with a monospace face, a subtle scroll-fade mask top/bottom, and a blinking caret at the tail while `running`.
- Done state: card auto-collapses (height transitioned) to a single 36px row: ✓ + "Researched in 4.2s · 3 searches · 12 passages · 8 citations · Show details". One click re-expands with the timeline preserved.

### 3. Smoother answer streaming
- Add a typing **caret** (`▍` blinking) after the last streamed character of the active block while `running && isFinalActive`. Hide on completion via fade.
- Wrap each new streamed block in `motion-fade-rise` keyed by `block_id` so a new paragraph slides in instead of appearing instantly.
- Citation pills: refine to monospace tabular numerals in a rounded chip with `bg-accent/10 text-accent border border-accent/25`, hover lifts -1px with a subtle ring; on click, in addition to the existing scroll+flash, briefly outline the source pill itself.
- Add a small `useSmoothText`-style easing on the *first* paragraph of the final round so the answer doesn't feel like a wall of text appearing at once. (Hook already exists in the repo — re-use without modification.)

### 4. Evidence column polish
- Sticky header becomes a thin segmented control: *All · Cited · Uncited* (presentational filter over `sortedChunkRefs`, no data changes).
- Replace the static skeletons with the project's `motion-shimmer` on rounded blocks sized to match real cards (avatar line + 3 text lines + footer chips), so the loading state matches final layout.
- Flash on citation click: switch from instant background to a 700ms `box-shadow` ring pulse using the accent color, then settle. Less jarring.
- Each evidence card grows a small ordinal badge ("#3") in the corner matching the citation number(s) that reference it — helps eye jump from answer to source.

### 5. Launcher (empty state)
- Keep the serif headline, but add a subtle conic-gradient halo behind the composer (CSS only, masked, low opacity) that animates a 12s slow rotation. Respects `prefers-reduced-motion` (static fallback).
- Example chips: arrange in a 2-column grid on `md+`, each chip gets a leading category icon (Brain/PenLine/Search) and a faint trailing `⌘↵` glyph hint. Hover lifts unchanged but adds a 1px accent ring transition.

### 6. Motion system additions (in `src/styles.css`)
Add three reusable utilities (no new lib):
- `.motion-stream-in` — translate-y(4px)+opacity, 220ms, `var(--ease-out-soft)`.
- `.motion-caret` — 1.1s steps(2) blink, used by the typing caret.
- `.motion-ring-pulse` — keyframed `box-shadow` ring used by the evidence flash.
- All gated under `@media (prefers-reduced-motion: reduce)` to no-op.

### 7. Header/composer micro-polish
- Composer focus ring already uses an accent glow — extend with a 1px inner highlight on the input row when `running` to signal the agent is live.
- Stop button restyled as a small pill with a tiny square icon (presentational); spinner in submit replaced with a thin progress ring that fills as `searches.length` grows (capped at 75%, last 25% during writing). No new data — derived from existing state.

## Technical notes

- All changes are JSX + Tailwind + 3 small CSS keyframes. No edits to `useSynthesisStream`, the SSE contract, Supabase calls, route definitions, or `SYNTHESIS_ENDPOINT`.
- Router/Tool chips are derived from data already in `state` (the `notes` array carries tool completions; the first `thinking` burst before any `search`/`chunks` event is the router phase).
- Elapsed timer is a local `useState` started on `submitted` change, stopped when `running` goes false. No persistence.
- Tabs inside the activity card use the existing shadcn `Tabs` component (already in `src/components/ui/tabs.tsx`).
- Reduced-motion: every new animation paired with a `@media (prefers-reduced-motion: reduce)` override.

## Out of scope (call out)

- No changes to the Browse Passages panel in this pass (separate, simpler surface).
- No changes to data flow, citation logic, or the synthesis backend.
- No threading / chat history persistence — single-session, matches current behavior.

## Verification

Playwright at 1280px and 390px:
1. Launcher renders with new halo + example grid; no console errors.
2. Submit a question; capture frames at *routing*, *searching*, *writing*, *done* — confirm phase label crossfades, timeline streams in staggered, Thoughts tab populates, caret blinks, answer streams with `motion-stream-in` per block.
3. Click a citation — evidence card ring-pulses and scrolls into view; ordinal badge matches citation number.
4. After completion, activity card collapses to one-line summary; clicking re-expands with full timeline intact.
5. Reload with `prefers-reduced-motion: reduce` emulated; confirm animations no-op but layout/state still correct.
