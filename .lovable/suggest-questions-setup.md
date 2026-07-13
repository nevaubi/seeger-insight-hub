# `suggest-questions` — one-time setup on the external Supabase project

This is deployed to the same Supabase project as `legal-synthesis`
(`blhcucozljrojnvqosyi`). Run the SQL below once, then schedule the cron.

## 1. Table + view + grants

```sql
create table if not exists public.question_suggestions (
  id           bigserial primary key,
  matter_slug  text        not null,
  question     text        not null,
  category     text        not null check (category in ('orders','deadlines','counsel','science','strategy')),
  generated_at timestamptz not null default now()
);

create index if not exists question_suggestions_matter_ts_idx
  on public.question_suggestions (matter_slug, generated_at desc);

grant select on public.question_suggestions to anon, authenticated;
grant all    on public.question_suggestions to service_role;
grant usage, select on sequence public.question_suggestions_id_seq to service_role;

create or replace view public.v_question_suggestions as
  select matter_slug, question, category, generated_at
  from public.question_suggestions
  order by generated_at desc;

grant select on public.v_question_suggestions to anon, authenticated;
```

## 2. Secret

Add `SUGGEST_QUESTIONS_SECRET` (any long random string) to the Supabase
edge-function secrets. `ANTHROPIC_API_KEY` and the standard
`SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are already present.

## 3. Cron — every 48 hours + immediate first run

Enable extensions if not already:

```sql
create extension if not exists pg_cron;
create extension if not exists pg_net;
```

Reschedule (replace `<SECRET>` with the value from step 2):

```sql
-- Drop the old 6h schedule if it exists (safe if it doesn't)
select cron.unschedule('suggest-questions-6h');

-- New 48h schedule — runs at 00:17 UTC every other day
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

-- Fire the first run immediately so the cards populate now
select net.http_post(
  url := 'https://blhcucozljrojnvqosyi.supabase.co/functions/v1/suggest-questions',
  headers := jsonb_build_object(
    'Content-Type', 'application/json',
    'x-cron-secret', '<SECRET>'
  ),
  body := '{}'::jsonb
);
```

Verify: `select jobname, schedule from cron.job where jobname like 'suggest-questions%';`
should show only `suggest-questions-48h`.

The frontend gracefully falls back to hardcoded example prompts until the
first successful run populates the table.
