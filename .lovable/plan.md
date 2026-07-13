# Planner model swap + streamed reasoning + Haiku 4.5 follow-ups

Three surgical edits in `supabase/functions/legal-synthesis/index.ts`, plus one small addition to the client timeline to render the new "Planning" step.

## Changes

### 1. Planner model → `gemini-3.1-flash-lite`
- Change the `PLANNER_MODEL` default from `gemini-3.1-pro-preview` to `gemini-3.1-flash-lite` (env override still honored).
- No other tuning needed — planner prompt/output shape is unchanged.

### 2. Stream planner reasoning as a dedicated "Planning" step
Today `runPlanner` calls `geminiJson` (non-streaming) and emits nothing until facets are ready. New behavior:

- Add a `geminiJsonStreaming(model, system, user, maxTokens, onReasoning)` helper that calls the same OpenAI-compatible Gemini endpoint with `stream: true` and `reasoning: { effort: "low" }` (flash-lite supports thinking; we opt in and request `include_reasoning`). It:
  - Streams SSE deltas.
  - Forwards any `delta.reasoning` / `reasoning_content` text via `onReasoning(text)`.
  - Accumulates `delta.content` and JSON-parses it at the end (same salvage logic as `geminiJson`).
- `runPlanner(question, matter, emit)` now takes the SSE `emit` callback and:
  - Emits `{ type: "plan_start", model: PLANNER_MODEL }` on entry.
  - Emits `{ type: "plan_reasoning", text }` deltas as reasoning streams in.
  - Emits `{ type: "plan_done", facets, rationale }` when JSON is parsed (existing `plan` event kept for back-compat, or fold into `plan_done`).
- Update the single caller in the main handler to pass `emit`.
- On any streaming failure, fall back to the existing non-streaming `geminiJson` path so planning never blocks.

### 3. Follow-up suggester → `claude-haiku-4-5`
- Replace the hardcoded `model: "claude-3-5-haiku-latest"` in the follow-up suggestion Anthropic call with `claude-haiku-4-5`.
- No other params change; response shape is identical.

### 4. Client: render the "Planning" step
In `src/routes/_authenticated/search.tsx`:
- Extend the SSE reducer in `src/lib/useSynthesisStream.ts` to handle `plan_start` / `plan_reasoning` / `plan_done` — append reasoning text to a `planning` block on the current run.
- In the timeline, add a `PlanningStep` row rendered before Round 1: label "Planning", model chip `gemini-3.1-flash-lite`, streamed reasoning text using the existing `useSmoothText` + word-shimmer treatment, and collapses to a one-line "Decomposed into N facets" summary once `plan_done` arrives (mirrors existing round-collapse behavior).

## Technical notes

- Gemini's OpenAI-compat endpoint exposes reasoning via `choices[].delta.reasoning` (OpenRouter passthrough) or `reasoning_content` depending on route; helper handles both.
- Keep `response_format: { type: "json_object" }` in the streaming call so the final content is still parseable JSON.
- `temperature: 0` and `max_tokens: 2048` unchanged.
- No schema/DB changes. `synthesis_runs.model` string will still record `ROUTER_MODEL -> writerModel`; planner model is implicit.

## Verification

- Deploy `legal-synthesis`, run a Depo-Provera question, confirm:
  - Timeline shows "Planning" step with streaming reasoning, then collapses.
  - Facets/rounds proceed as before.
  - Follow-up chips still generate (now via Haiku 4.5).
- Check gateway/function logs for any 4xx from flash-lite streaming; if `reasoning` field is rejected, drop it and stream content-only (reasoning simply won't appear — planner still works).