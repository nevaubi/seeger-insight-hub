
## Goal

Replace the current `RunCard` / `TimelineNode` / `ThoughtStepRow` visuals in `src/routes/_authenticated/search.tsx` with a refined, single-rail timeline modeled on the attached HTML — cleaner spacing, hairline connector, shimmer only on the active step, smooth spring/layout transitions, and a compact collapsed pill when the run finishes. No backend, no state-shape, no SSE, no reducer changes.

## Scope (frontend-only, one file + one CSS token)

Touch only:
- `src/routes/_authenticated/search.tsx` — rewrite the timeline sub-tree (nodes, rail, round headers, "processing…" pulse, collapsed pill). Keep data derivation (`traceSteps`, `rounds`, `writerActive`, `finalRound`, notes, expansions, citations) exactly as-is.
- `src/styles.css` — add a scoped `text-shimmer` utility (sweeping gradient on text) and a subtle `agent-spinner` ring. Reuse existing navy/parchment/oxblood tokens; no palette additions.

Do NOT touch: `useSynthesisStream.ts`, edge functions, matter context, evidence column, composer, answer renderer, or any other route.

## Visual spec (matches reference, translated to our palette)

- Single vertical hairline rail at ~11px left, `border-color`, not a card. Kill the current bordered `RunCard` container so the timeline breathes on the parchment surface.
- Round header: 20px circled numeral (ivory bg, hairline border, muted numeral) + tiny uppercase "Round N · <facet>" eyebrow + one-line phase reasoning in serif.
- Step row: 14px status node on the rail (filled navy check when done, thin rotating ring while running), agent/tool name in Inter semibold 12px, thought/summary line beneath at 12px. Active thought uses `text-shimmer` (slate→navy→slate sweep); completed thought is muted foreground.
- Tool-specific icon + accent color per kind (record=navy, caselaw=gold, web=oxblood, structured=muted) reused from existing `TOOL_META`, rendered inline next to the name — not as a separate node.
- Bottom "Processing…" row: 6px pulsing dot on the rail + uppercase micro-label, only while `running && !writerActive`.
- Writer phase: same rail, node swaps to a pen glyph with shimmer label "Drafting answer…" until first token, then collapses.
- Collapsed state (after `finalRound` set): the whole timeline morphs into a single pill — "Analyzed N phases · M steps · Xs" — with a chevron that expands the full trace inline. Uses `AnimatePresence` height/opacity, no modal.

## Motion

- Use existing `motion/react` (already imported in the file) with a shared `SPRING = { type: 'spring', stiffness: 500, damping: 40 }` and `EASE = { duration: 0.3, ease: [0.16, 1, 0.3, 1] }` constant defined at top of file.
- `LayoutGroup` around the rail so new rounds/steps slide in without jank.
- Per-step stagger via `transition={{ ...SPRING, delay: idx * 0.04 }}`.
- Respect `prefersReducedMotion()` from `src/lib/motion.ts` — fall back to opacity-only fades and disable shimmer keyframes.

## Data mapping (no shape changes)

The reference's `rounds[].agents` maps to our existing derivation:
- `rounds` = grouped `traceSteps` by round number (already computed).
- Per round, `agents` = the tool/search/thinking steps in that round, keyed by their existing id.
- `status: 'running' | 'done'` derived from `currentRound === round && !step.finished` (already tracked).
- `thought` = existing step summary text (searches → keywords/count, tools → `describeTool`, thinking → smoothed thinking text, web → domain + title).

## Acceptance

- No new deps, no bundler config changes.
- Timeline renders identically for: idle → planning → parallel tools (record + caselaw + web) → critic → rerank → writer → done → collapsed pill → re-expand.
- Only one step shimmers at a time (the active one in the active round); everything else is static muted text.
- Collapsed pill appears within ~300ms of the writer emitting its first token; expanding it restores the exact trace.
- No layout shift in the answer column, evidence rail, or composer.
- Reduced-motion users see no shimmer and no spring — just fades.

## Out of scope

Backend behavior, SSE event names, retrieval, citations panel, answer typography, composer, matter switcher.
