# Depositions: parallel multi-model analysis

Goal: cut the wait between upload and usable findings, and make the findings substantially richer by fanning the work out across the model providers already configured in the backend (Gemini, Anthropic, OpenAI, Fireworks, Voyage) instead of one sequential pass.

## What changes for you

- Upload finishes → analysis starts immediately and results **stream in facet by facet**. Admissions typically land first; the deeper passes fill in behind them instead of everyone waiting for one long job.
- Four new analysis tabs alongside Admissions / Chronology / Exhibits / Quality:
  - **Impeachment** — internal contradictions, conflicts with prior statements, evasive/non-responsive answers, each with the exact cited span.
  - **Witness & topics** — background, qualifications, bias/interest indicators, and a topic map of what was actually covered.
  - **Objections** — full objection log with stated grounds, instructions not to answer, and follow-up gaps worth re-noticing.
  - **Case themes** — Depo-Provera specific hits: warnings and labeling, corporate knowledge of meningioma risk, safer-alternative (Depo-SubQ 104) evidence.
- Each finding keeps a verified page:line cite; unverifiable quotes are marked rather than silently kept.
- Live progress: the analysis header shows which passes are running, done, or failed, so a slow provider never blocks the rest.

## How it works

A new `depo-analyze` (v2) runs a **map-reduce fan-out** rather than one prompt:

1. **Chunker** splits the transcript into overlapping windows by segment boundaries (Q/A pairs kept intact) with page:line anchors on every window.
2. **Parallel extractors** — one worker pool per facet, all facets in flight at once, and windows within a facet processed with bounded concurrency (~6). Cheap/fast model (`gemini-3.1-flash-lite`) does the high-volume span extraction; each returns strict JSON with quote + page/line.
3. **Provider routing and failover** — facets are spread across Gemini / OpenAI / Fireworks / Anthropic so no single rate limit serializes the run; a failing provider falls back to the configured `*_FALLBACK_MODEL` and the facet degrades alone.
4. **Reduce pass** — per facet, dedupe near-identical spans, rank by materiality (Voyage rerank where useful), and have a stronger model (`claude-haiku-4-5` / `gemini-3.5-flash`) write titles, stance, and confidence.
5. **Verifier** — every quote is string-matched back against the stored lines; mismatches get `verify_status: 'failed'` and are down-ranked, not shown as fact.
6. **Incremental writes** — each facet's findings are inserted as soon as that facet reduces, so the UI can render partial results while the rest is still running.

Ingest side: `depo-ingest` kicks off `depo-analyze` itself (fire-and-forget) so the client no longer needs a round trip to start work.

## Technical notes

- New/updated sources written to this repo for you to deploy: `supabase/functions/depo-analyze/index.ts` (rewrite), plus small edits to `supabase/functions/depo-ingest/index.ts` for auto-start and progress rows. Deployment to your external backend stays with you, same as `legal-synthesis`.
- Secrets reused, none added: `GEMINI_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `FIREWORKS_API_KEY`, `VOYAGE_API_KEY`.
- New `finding_type` values: `impeachment`, `topic`, `objection`, `case_theme`. If `deposition_findings.finding_type` is a Postgres enum in your backend, the plan ships an `ALTER TYPE ... ADD VALUE` snippet for you to run; the function also detects an insert rejection and falls back to writing them as `quality_note` with a `data.facet` marker so nothing is lost.
- Progress is exposed via `depositions.metadata.analysis` (`{facet: 'running'|'done'|'error'}`), polled by the client — no new tables.
- Frontend: `src/lib/supabase.ts` gains the new finding types; `src/routes/_authenticated/depositions.$id.tsx` gains the four tabs, per-facet skeletons from `src/components/depo-skeletons.tsx`, and a compact progress strip; `src/lib/depo-export.ts` and `src/lib/file-export.ts` extend the DOCX/PDF digest and the XLSX workbook with the new sections (tables for impeachment/objections/themes, profile block for witness/topics).
- Client `analyzeDeposition` becomes a poll-and-render loop rather than a single blocking call; `src/lib/depo-api.ts` updated accordingly.
