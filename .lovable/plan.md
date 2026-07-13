## Wire suggestion cards to the 48-hour cron

Now that the `suggest-questions` cron runs every 48h and populates `v_question_suggestions`, flip the frontend off the fallback path so cards read the live pool.

### Edits

**1. `src/lib/supabase.ts`**
- Flip `SUGGESTIONS_VIEW_ENABLED` from `false` → `true`.
- Remove the stale TODO comment above it.
- Keep the `try/catch` + `return []` fallback so a missing view still degrades to hardcoded seeds instead of throwing.

**2. `src/routes/_authenticated/search.tsx` — `SuggestionDeck`**
- Bump React Query `staleTime` from `5 * 60_000` to `6 * 60 * 60_000` (6h). The cron writes new batches every 48h, so refetching more than a few times per day is wasted work; 6h keeps tabs opened mid-cycle reasonably fresh.
- Add `gcTime: 24 * 60 * 60_000` so the cached pool survives navigation between routes within a session.
- Leave `retry: false` and `refetchOnWindowFocus: false` as-is (silent fallback, no focus thrash).
- Keep the sessionStorage offset + Shuffle behavior unchanged — it already cycles through the 20-item pool 4 at a time.

### Not changing
- The edge function, cron SQL, or fallback seed list.
- `FollowUpChips` (post-answer suggestions, unrelated to the starter pool).

### Verification
- Load `/search` on a fresh session → network tab shows one `v_question_suggestions` request returning up to 20 rows; 4 cards render.
- Click Shuffle → next 4 rotate in without a refetch.
- Reload within 6h → no new request (served from cache).
