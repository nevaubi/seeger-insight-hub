Two small, targeted fixes — one frontend, one edge function.

## 1. Slow the reasoning stream

Right now only the final answer runs through `useSmoothText` (550 cps). The per-round reasoning ("planning retrieval…", "The record contains …") is rendered raw as tokens arrive from the model, so it feels like a data dump.

Change `RoundHeader` in `src/routes/_authenticated/search.tsx`:

- Feed `reasoning` through `useSmoothText(reasoning, streaming, 55)` before rendering. 55 cps ≈ a fast reader; matches the editorial tone and lets the eye track it. Non-streaming rounds already pass `streaming=false`, so `useSmoothText` snap-flushes and completed rounds render instantly (no regressions for scroll-back).
- Same treatment for the writer-phase reasoning line at line 1251 (`writerReasoning`) so the pre-answer "Composing the answer…" text also glides.
- Keep the final markdown at 550 cps — it's paragraphs, not a live thought.

Not touching the tool-note rows or the "planning retrieval…" shimmer placeholder — those are single short strings and already feel calm.

## 2. Fix the "Lookup failed — read_order needs an order_type and/or order_number" round

What's happening: the planner/router occasionally emits a `read_order` tool call with an empty input (no `order_type`, no `order_number`). The server throws, the round shows an oxblood "Lookup failed" node, and a full round is wasted. Root cause is model behavior — the tool schema currently marks both fields optional, so nothing stops the model from calling it bare.

Three-part fix in `supabase/functions/legal-synthesis/index.ts`:

1. **Tighten the tool schema.** On the `read_order` tool definition (~line 531), add `anyOf: [{ required: ["order_type"] }, { required: ["order_number"] }]` to the input schema. Anthropic honors JSON-schema `anyOf` for tool inputs, so the model can no longer emit an empty call. Keep both fields individually optional so `PTO 22`, `order_type: PTO`, and `order_number: 22` all still work.

2. **Graceful server fallback.** In `runReadOrder` (~line 780), instead of `throw new Error("read_order needs …")`, return `{ count: 0, chunks: [], searchResults: [], skipped: true, reason: "no_target" }`. The orchestrator already handles zero-return tools; this stops burning a research round on a validation error.

3. **Prompt nudge.** In the router/specialist instructions (~line 320 and ~line 1505), add one line: *"Never call `read_order` without at least one of `order_type` or `order_number`. If you don't know the order yet, call `list_orders` first, then `read_order` with the specific number."*

Frontend cosmetic touch-up in the same edit: when a tool row arrives with `skipped: true` (or `count: 0` on a read_order), render it as a muted gray "Skipped — no target order" instead of the oxblood "Lookup failed" node. Keeps the timeline honest without alarming red.

## Files

- `src/routes/_authenticated/search.tsx` — reasoning smoothing + skipped-tool styling
- `src/lib/useSynthesisStream.ts` — carry `skipped`/`reason` through the tool event
- `supabase/functions/legal-synthesis/index.ts` — schema `anyOf`, soft fallback, prompt line

## Out of scope

- Changing the overall multi-agent flow, budgets, or Planner logic
- Any other tool's error handling (only `read_order` shows this pattern in the logs you shared)
- Touching motion/reduced-motion behavior — `useSmoothText` already respects `prefersReducedMotion`