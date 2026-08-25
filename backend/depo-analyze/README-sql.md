# depo-analyze v2 — deployment notes

## 1. Deploy the function

Copy `index.ts` into your backend repo at `supabase/functions/depo-analyze/index.ts` and deploy:

```bash
supabase functions deploy depo-analyze --project-ref <your-ref>
```

Existing secrets are reused (`GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
`FIREWORKS_API_KEY`). Any subset works — a facet whose provider is missing or failing falls back
to Gemini, then Anthropic, and only that facet degrades.

## 2. Allow the new finding types (only if `finding_type` is an enum)

The function writes four new facet values. If `deposition_findings.finding_type` is a plain
`text` column, nothing to do. If it is a Postgres enum, run:

```sql
ALTER TYPE deposition_finding_type ADD VALUE IF NOT EXISTS 'impeachment';
ALTER TYPE deposition_finding_type ADD VALUE IF NOT EXISTS 'objection';
ALTER TYPE deposition_finding_type ADD VALUE IF NOT EXISTS 'case_theme';
ALTER TYPE deposition_finding_type ADD VALUE IF NOT EXISTS 'topic';
```

(Substitute the real type name from `\d deposition_findings`.) Until this runs, the function
detects the rejected insert and stores those rows as `quality_note` with `data.facet` set, so no
analysis is lost — the UI just shows them under Quality.

## 3. Progress surface

The function writes `depositions.metadata.analysis` as it goes:

```json
{ "overview": "done", "admission": "done", "impeachment": "running", "objection": "error", "updated_at": "..." }
```

The workspace polls this while `status = 'analyzing'` and renders a per-pass progress strip, and
renders each facet's findings the moment they land.
