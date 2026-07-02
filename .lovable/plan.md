# Ask the Record — workflow, timing, and layout upgrades

Three tracks. Each independent, each verifiable.

---

## 1) Per-step elapsed times (smooth, always-on)

Today only one global `useElapsed` clock exists (top-right of the header). Steps in the timeline have no timing. The plan adds a per-step timer that starts when the step first appears and freezes when it flips to "done".

**Data model (`src/lib/useSynthesisStream.ts`)**
- Extend `RoundState` with `startedAt: number` (set on first frame of that round) and `endedAt: number | null` (set on `round_end`).
- Extend the tool step shape (already tracked from `SseTool` / `SseToolError`) with `startedAt` / `endedAt`. The reducer stamps `startedAt = performance.now()` on the first `tool` frame for a `(round, tool, args-hash)` key, and `endedAt` on the matching `done: true` or `tool_error` frame.
- Same treatment for "search" pseudo-steps (`SseSearch` → start; first `SseChunks` for that round → end) and "thinking" segments.
- Expose a stable `steps: TimelineStep[]` selector per round from the hook so the UI does not have to reconstruct timing from event streams.

**UI (`src/routes/_authenticated/search.tsx`)**
- New `useTicker(active: boolean, intervalMs = 250)` — a single shared 250 ms rAF-driven ticker for the whole `RunCard` so we don't spin one interval per row.
- New `StepClock` component: reads `startedAt` / `endedAt` and renders `fmtElapsed(now − startedAt)` when active, snaps to `endedAt − startedAt` when done. Rendered right-aligned inside each `StepRow` in tabular-nums, muted-foreground, with a subtle fade when it freezes.
- Round headers show `Σ` of their children plus a live "· running" pill; the header time freezes on `round_end`.
- 250 ms tick is fast enough to feel live without visible jitter; reduced-motion falls back to 1 s tick.

**Verification**: manual — run a query, confirm each step's clock ticks while active, freezes when green-checked, and round totals equal the sum of child durations (± tick granularity).

---

## 2) Draggable left/right divider (lg+ only)

Today the layout is `lg:flex-[3]` for the chat pane and implicit flex-1 for evidence, no user control.

**Component**: new `src/components/split-pane.tsx` — controlled `SplitPane` with:
- Left/right children, `min` / `max` percent (default 35 / 75), `storageKey` for localStorage persistence, `defaultPercent` (default 62 for chat).
- Renders `flex-basis: {pct}%` on left, `flex: 1` on right, and a 6-px hit-area divider (2-px visible hairline centered) with `cursor-col-resize`, `aria-orientation="vertical"`, `role="separator"`, `tabIndex=0`.
- Pointer events: `pointerdown` captures pointer, `pointermove` updates % against the container `getBoundingClientRect()`, `pointerup` releases and writes storage. Uses `requestAnimationFrame` to coalesce moves.
- Keyboard: ←/→ adjust ±2 %, Shift+←/→ ±8 %, Home = min, End = max, Enter/Space toggles collapse-to-min.
- Below `lg` the divider is hidden and children stack (existing behavior preserved).
- Double-click resets to `defaultPercent`.

**Wiring**: replace the current `lg:flex lg:gap-6` container in `SynthesisPanel` with `<SplitPane storageKey="ask-record-split" defaultPercent={62}>`. No changes to the panels themselves.

**Verification**: manual drag, keyboard nudges, refresh persists, mobile stacks as before.

---

## 3) Multi-agent workflow — smarter orchestration

Frontend-visible improvements plus corresponding edge-function moves in `supabase/functions/legal-synthesis/index.ts` (v30 → v31). Guardrails: **same SSE contract, additive event fields only** so the hook stays backward-compatible.

### 3a) Planner: budget-aware, question-typed
- Add `question_type` to planner output: `factual | procedural | comparative | strategic | causation`. Bias facet count and web-search allowance per type (e.g. `causation` unlocks Tavily science whitelist by default; `procedural` stays local + PACER).
- Emit new SSE `plan_meta` frame with `{ question_type, facet_count, expected_rounds }` so the UI can show a compact "Plan · 4 facets · science + record" chip under the composer.

### 3b) Adaptive retrieval budget
- Replace fixed `MAX_ROUNDS=5` / `MAX_TOTAL_CHUNKS=120` with a budget derived from `question_type` and planner confidence (`simple` → 2 rounds/40 chunks, `hard` → 6 rounds/160 chunks).
- Critic can extend the budget once (`+1 round`, `+30 chunks`) if it declares "insufficient", but only once — prevents runaway loops.
- Emit `budget` SSE frame at plan time and again after each critic pass.

### 3c) Specialist parallelism + dedupe
- Run the per-facet specialists concurrently (`Promise.allSettled`), capped at 4 in flight.
- Global chunk-dedupe keyed by `(document_id, page_start, page_end)` across specialists before rerank, so overlapping facets don't consume budget twice.
- Rerank stays Voyage rerank-2, but with a per-facet minimum quota (≥ 6 chunks per surviving facet) so a dominant facet can't starve minor ones.

### 3d) New specialist: `authority_check` (CourtListener)
- After the writer's first draft, if any citation refers to case law (kind:'caselaw'), run a lightweight verifier that pulls the CourtListener opinion by citation and checks the cited proposition still appears. Emits `authority` SSE frames (`{ cite, status: 'ok' | 'stale' | 'not_found' }`) for the UI.

### 3e) Web-search specialist hardening
- Tavily calls gated by: whitelist (already in place) + `question_type ∈ {causation, strategic, comparative}` + max 2 web queries per run.
- Add `source_tier` to web results (`regulator | peer_reviewed | secondary`) and expose in the evidence card so the writer's authority mix is visible.

### 3f) Verifier → self-heal loop (bounded)
- If the verifier finds an ungrounded sentence, emit `verify` frame with `{ block_id, sentence_idx, status: 'ungrounded' }` and trigger **one** targeted micro-round: a focused retrieval on the sentence's claim + a writer patch. Second failure → strike the sentence and mark it as removed in a `verify` frame the UI can render.

### UI surface for the above
- `RunCard` gets four new step categories: `plan`, `web`, `authority`, `verify`. All flow through the existing `classifyTool` mapping — just add cases and colors (verify = oxblood, authority = navy, plan = gold).
- New "Plan" pill under the composer header when `plan_meta` arrives.
- Evidence card gets a small `source_tier` chip for web results.
- No changes to answer rendering.

---

## Sequencing

1. **Track 2 (SplitPane)** — pure frontend, low risk, ships first.
2. **Track 1 (per-step timing)** — frontend hook + reducer changes only; ships without touching the edge function.
3. **Track 3 (workflow)** — edge function v31 + additive SSE frames + UI mappings. Ship in this order:
   - 3a plan_meta + 3b budget (single edge change, single UI chip).
   - 3c parallelism + dedupe (edge only, no UI change).
   - 3d authority_check + 3e web tiers (edge + evidence chip).
   - 3f verifier self-heal (edge + verify row in timeline).

## Files touched

- `src/components/split-pane.tsx` (new)
- `src/routes/_authenticated/search.tsx` (SplitPane wire-up, StepClock, plan chip, new step categories)
- `src/lib/useSynthesisStream.ts` (timing fields, `steps` selector, new SSE variants: `plan_meta`, `budget`, `authority`, `verify` with `sentence_idx`, `web_result.source_tier`)
- `supabase/functions/legal-synthesis/index.ts` (v31: typed planner, adaptive budget, parallel specialists, dedupe, authority_check, web tiers, verifier self-heal)

## Open questions

1. Split-pane default — 62 % chat / 38 % evidence, or 58 / 42? (evidence density varies a lot)
2. Verifier self-heal — one retry then strike, or two retries? One is safer for latency.
3. Per-step time display — always visible, or only on hover to keep the rail quiet?
