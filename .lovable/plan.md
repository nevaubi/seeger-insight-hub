# Diagnose "0 chunks per round" and raise RAG returns in `legal-synthesis`

The Supabase connection to clawallday12@gmail.com's org is live, so I can do this end-to-end: inspect, mirror the function into this repo, patch, redeploy, and verify on the running Depo-Provera matter.

## Phase 1 — Diagnose (read-only, ~3 tool calls)

1. **Inspect `search_pages`**: dump its definition with `supabase--read_query` against `pg_proc` to see the exact `match_count` cap and the similarity threshold (or `<=>` distance cutoff). This is the single biggest knob.
2. **Sample the corpus**: `SELECT count(*) FROM document_pages` and `SELECT count(*) FROM documents WHERE doc_source = 'flnd_court_site'` to confirm there's enough material that 0-hit rounds are genuinely a retrieval-tuning problem rather than missing data.
3. **Pull recent function logs**: `supabase--edge_function_logs function_name=legal-synthesis` filtered for the last few runs. Classify each round: `tool` event (router picked list_orders / lookup_counsel / list_deadlines → 0 chunks by design) vs `search_pages` actually returning < lim. Report the split.

Deliverable: a short note ("X of Y zero rounds were structured-tool rounds; Z were real misses; threshold is currently 0.78, lim is 8") so you know whether the fix is UI clarity, edge-function tuning, or both.

## Phase 2 — Mirror `legal-synthesis` into the repo

Create `supabase/functions/legal-synthesis/` with the current deployed source (pulled via the Supabase tooling). From this point on, every change is version-controlled here and deploys via `supabase--deploy_edge_functions`. No `supabase/config.toml` project-level edits.

## Phase 3 — Edge function changes (in the mirrored file)

1. Raise per-sub-query retrieval: `match_count` / `lim` → **16** (from current).
2. Lower the similarity floor by ~0.05 (if the function applies one client-side; if `search_pages` itself enforces it, do this via a migration instead — see Phase 4).
3. **Empty-result fallback widen**: if a sub-query returns 0 rows, retry once with `lim: 24` and log the retry. Cap retries at 1 per sub-query.
4. **Richer SSE payload**: emit `{ type: 'chunks', round, requested, returned, chunks }` so the frontend can show `n/k` per search instead of guessing.
5. Keep writer prompt budget unchanged — passing more than ~20 chunks to the writer wastes tokens, so cap the writer's working set at 20 even if retrieval returns more.
6. Tool/router behavior untouched. The "0 returned" on structured-tool rounds is correct.

## Phase 4 — DB function tweak (only if threshold lives in `search_pages`)

If Phase 1 shows the similarity floor is enforced inside the SQL function, ship a `supabase--migration` that recreates `search_pages` with the lower threshold and accepts the larger `lim`. Keep the signature the same so nothing else breaks.

## Phase 5 — Frontend SSE-aware counts (`src/routes/search.tsx` only)

Now that the function emits `requested`/`returned`, update `SearchStepRow` to render `· 3/16 chunks` (and `· 0 chunks — no matches` when zero). Add a muted "no vector search" note on `ToolStepRow` so structured-tool rounds visibly differ from real misses. Strictly scoped to that one file — no styles, no other routes, no hook changes beyond reading the two new fields off the existing `SearchEvt` type.

## Phase 6 — Verify

- `bunx tsgo --noEmit` (frontend).
- `supabase--deploy_edge_functions function_names=["legal-synthesis"]`, then `supabase--curl_edge_functions` with the standard streaming POST against a known-hard Depo-Provera question ("What must plaintiffs do to establish proof of use, and by when?").
- Drive Playwright on the live preview: same question on Depo-Provera, then a follow-up on the other matter. Confirm console is clean and every search row shows `n/k` with most `n` ≥ ~6, and tool rounds say "no vector search."

## Out of scope (call out, don't do)

- Hybrid (BM25 + vector) search, cross-encoder reranking, query-rewriting upgrades. Bigger lift, only worth it after #1–#3 land and you've measured.
- Changing the router's tool selection.
- Auth, RLS, or any non-RAG schema changes.

## Approval

This will: read your DB, mirror an edge function into the repo, ship one migration only if the threshold lives in SQL, deploy `legal-synthesis` once, and touch one frontend file.
