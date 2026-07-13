## Fix two console errors

### 1. TanStack Router `_nonReactive` crash on hover preload

`TypeError: Cannot read properties of undefined (reading '_nonReactive')` fires from `loadRouteMatch` inside `RouterCore.preloadRoute` — a known TanStack Router bug when `defaultPreload: 'intent'` races with a route that has no loader/context match ready. It's non-fatal (a try/catch swallows the render), but it spams Sentry and the console every time the user hovers a link.

- In `src/router.tsx`, drop hover-intent preloading: change `defaultPreload: 'intent'` → `defaultPreload: false`. Navigation stays instant because our routes are already code-split and cached by TanStack Query; the only thing we lose is speculative fetch on hover, which is the exact code path throwing.
- Leave `defaultPreloadStaleTime`, `scrollRestoration`, and pending timings untouched.

### 2. `v_question_suggestions` 404 (missing view)

The DB view isn't provisioned yet, so every call to `fetchQuestionSuggestions` in `src/lib/supabase.ts` hits `/rest/v1/v_question_suggestions` and returns `PGRST205`. The code already returns `[]` on error, but supabase-js still logs the 404 network request and React Query retries.

- In `src/lib/supabase.ts`, short-circuit `fetchQuestionSuggestions` to return `[]` immediately (guarded by a `SUGGESTIONS_VIEW_ENABLED = false` const at top of file). Add a one-line TODO comment noting to flip it back on once the view exists.
- In `src/routes/_authenticated/search.tsx` `SuggestionDeck`, set React Query options `retry: false` and `refetchOnWindowFocus: false` on the `question-suggestions` query so a future 404 (if flag is flipped prematurely) doesn't retry-spam. Fallback seeds (`examples_synth`) continue to render.

### Out of scope

Timeline UI, streaming, edge functions, DB migrations.

### Files touched

- `src/router.tsx`
- `src/lib/supabase.ts`
- `src/routes/_authenticated/search.tsx`