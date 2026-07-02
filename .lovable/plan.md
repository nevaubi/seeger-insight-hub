# Suggestions: post-answer follow-ups + cron-generated starter pool

Two related features, one shared surface (chips in the Ask-the-Record UI).

## 1. Post-answer follow-up suggestions (per-run, live)

When a run finishes (`writer` phase hits `end_turn`), the `legal-synthesis` edge function emits one final SSE frame:

```
event: data
{ "type": "followups", "suggestions": ["...", "...", "..."] }
```

3–4 short, matter-scoped follow-ups grounded in what was actually retrieved this run (order labels, tags, parties that showed up in citations). Generated cheaply by Haiku with a tight prompt + the run's citation list — no extra RAG round.

UI: render as a row of chips under the final answer labeled "Follow up". Click = prefill composer + auto-submit. Chips animate in with the same fade the timeline uses.

Wiring:
- `src/lib/useSynthesisStream.ts`: add `SseFollowups` to the event union, store `followups: string[]` in state.
- `src/routes/_authenticated/search.tsx`: render `FollowUpChips` in the Resting state, below the citations block.
- `supabase/functions/legal-synthesis/index.ts`: after Verifier, one Haiku call taking `{ question, matter, citedRefs[], finalAnswerSnippet }` → JSON array of 3–4 strings. Emit `followups` frame before `done`. Non-fatal if it fails (skip silently).

## 2. Cron-generated "Try a question" pool (starter suggestions)

A rotating pool of 20 curated starter questions per matter, refreshed every 6 hours, exposed on the Launcher state and refreshable client-side.

### Backend

New table `question_suggestions` (external Supabase, read-only from app; the cron writes via service role):

```
matter_slug text, question text, rationale text?, generated_at timestamptz,
category text  -- 'orders' | 'deadlines' | 'counsel' | 'science' | 'strategy'
```

Read view `v_question_suggestions` exposes `matter_slug, question, category, generated_at`, ordered by `generated_at desc`. Client only ever reads the latest 20 per matter.

New edge function `suggest-questions`:
- Input: `{ matter_slug }` (loops all active matters when called by cron).
- Pulls a compact matter brief: recent orders (last 20 by `order_date`), upcoming deadlines (next 30), tag histogram, and a handful of party names.
- One Haiku call: "Generate 20 high-value questions a plaintiff-side litigator would actually ask about this matter right now, spread across categories, no duplicates, ≤ 90 chars each." Returns JSON `[{question, category}]`.
- Inserts the 20 rows, deletes anything older than 48h for that matter.

Cron: `pg_cron` every 6h calls the function via `pg_net` with the shared secret. Backfill: run once immediately after deploy.

### Frontend

- `src/lib/supabase.ts`: `fetchQuestionSuggestions(matterSlug)` — SELECT top 20 from `v_question_suggestions`, ordered newest first.
- `src/routes/_authenticated/search.tsx` Launcher state:
  - Replace the current static examples with a `SuggestionDeck` component.
  - Load 20 on mount (React Query, matter-scoped key, `staleTime: 5min`).
  - Show 4 at a time as chips. **Shuffle** button (ghost icon-only, ↻) picks the next 4 via a rotating cursor (`(offset + 4) % 20`) with a subtle crossfade. Cursor persists in `sessionStorage` per matter so shuffle feels stateful within a session.
  - Empty state (cron hasn't run yet): fall back to the current hardcoded seeds.
  - Category shown as a tiny uppercase label above each chip in the muted brass tone.

Same `SuggestionDeck` (without shuffle, 3–4 chips only) renders the run-scoped follow-ups from feature #1 in the Resting state.

## Files touched

- `supabase/functions/legal-synthesis/index.ts` — emit `followups` frame at end of writer.
- `supabase/functions/suggest-questions/index.ts` — NEW, cron-invoked generator.
- Migration — `question_suggestions` table + `v_question_suggestions` view + GRANTs + `pg_cron` schedule.
- `src/lib/useSynthesisStream.ts` — new event type + state field.
- `src/lib/supabase.ts` — `fetchQuestionSuggestions`.
- `src/routes/_authenticated/search.tsx` — `SuggestionDeck`, shuffle, follow-up chips.

## Out of scope

- Personalization by user history (matter-scoped only for now).
- Editing / pinning suggestions.
- Suggestions on other pages (Deadlines, Roster). Ask-the-Record only.

## Open question before I build

The external Supabase project is currently used **read-only** from the app. This feature needs a **write path** (cron inserts into `question_suggestions`). Two options:

1. **Add the table + cron to the external Supabase project** you already query — I'll produce the SQL + edge function code and you run them there. Cleanest, keeps everything in one DB.
2. **Use Lovable Cloud** for `question_suggestions` only (writes here, reads from the app), while all other data stays in the external project. Adds a second data source to the app.

Option 1 is what I'd recommend. Confirm and I'll proceed.
