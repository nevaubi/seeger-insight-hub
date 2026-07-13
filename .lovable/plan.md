
# Suggestion refresh — 48h cadence, immediate first run

The "Try a question" cards on the agent chat launcher are backed by the `suggest-questions` edge function on the external Supabase project (`blhcucozljrojnvqosyi`), scheduled via `pg_cron`. Today it fires every 6 hours. Switch to every 48 hours, and kick off the first run immediately.

## Changes

### 1. Edge function — extend prune window
`supabase/functions/suggest-questions/index.ts`

- The current `persist()` deletes rows older than 48h. With a 48h cadence, a delayed cron run could briefly leave the table empty. Extend the prune cutoff to **96h** so the previous batch remains readable until the new one lands.
- No other logic changes. Model, prompt, categories, and count (20) stay the same.

### 2. Cron reschedule (external Supabase — SQL to run once)
Update `.lovable/suggest-questions-setup.md` and provide the SQL for the user to run on the external project:

```sql
-- Drop the old 6h schedule if it exists
select cron.unschedule('suggest-questions-6h');

-- New 48h schedule (runs at 17 minutes past the hour, every 2 days at 00:17 UTC)
select cron.schedule(
  'suggest-questions-48h',
  '17 0 */2 * *',
  $$
  select net.http_post(
    url := 'https://blhcucozljrojnvqosyi.supabase.co/functions/v1/suggest-questions',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'x-cron-secret', '<SECRET>'
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Fire the first run immediately (don't wait up to 48h)
select net.http_post(
  url := 'https://blhcucozljrojnvqosyi.supabase.co/functions/v1/suggest-questions',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', '<SECRET>'
  ),
  body := '{}'::jsonb
);
```

Notes:
- `17 0 */2 * *` = 00:17 UTC every other day. If you prefer a strict "every 48 hours from now" wall clock, `pg_cron` can't express that directly; the every-other-day schedule is the standard idiom.
- The immediate `net.http_post` call at the end serves as the "first run right now".

### 3. Frontend — no changes
`SuggestionDeck` in `src/routes/_authenticated/search.tsx` already reads the latest N rows from `v_question_suggestions` and falls back to hardcoded prompts when empty, so the cadence change is transparent to the UI. The Shuffle button continues to reroll the visible 4 from the pool.

## Verification
- Deploy the edge function.
- Run the SQL block above on the external Supabase project.
- Confirm `select * from cron.job where jobname = 'suggest-questions-48h';` returns one row and the old `suggest-questions-6h` is gone.
- Reload the search page; the 4 suggestion cards should populate from the fresh batch within seconds.
