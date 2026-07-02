
# Multi-agent overhaul of `legal-synthesis` (Phases A + B)

Goal: turn the current single-router / 6-tool loop into an intelligent multi-agent graph with wider, reranked RAG and a Tavily web-search specialist scoped to reputable legal + regulatory + scientific sources. Backend-only; frontend gets new SSE event types and degrades gracefully until Pass 2.

## Target architecture

```text
                 ┌──────────────────────────────┐
   question ──▶  │ PLANNER  (gemini-3.1-pro)    │  ← decomposes into facets,
                 │  emits research plan JSON    │    picks specialists per facet,
                 └──────────────┬───────────────┘    writes HyDE hypotheses
                                │
        ┌───────────────┬───────┼────────────┬─────────────────┐
        ▼               ▼       ▼            ▼                 ▼
   RecordAgent    CaselawAgent StructuredAgent  WebAgent    (parallel)
   (search_       (search_     (list_orders/    (Tavily,
   the_record,    caselaw)     counsel/         allow-listed
   read_order,                  deadlines)      domains)
   HyDE + multi-
   query fanout,
   Voyage rerank)
        │               │            │             │
        └───────────────┴─────┬──────┴─────────────┘
                              ▼
                 ┌──────────────────────────────┐
                 │ CRITIC   (gemini-3.5-flash)  │  ← coverage/gap analysis,
                 │  approves or requests more   │    can trigger one more round
                 └──────────────┬───────────────┘
                                ▼
                 ┌──────────────────────────────┐
                 │ WRITER   (claude-opus-4-8)   │  ← streams answer + citations
                 └──────────────┬───────────────┘
                                ▼
                 ┌──────────────────────────────┐
                 │ VERIFIER (gemini-3.5-flash)  │  ← post-stream: flag any
                 │  citation-grounding pass     │    unsupported sentence
                 └──────────────────────────────┘
```

Router models (all via Lovable AI Gateway where possible; Claude/Voyage/Tavily direct):
- Planner: `google/gemini-3.1-pro-preview` (JSON structured output).
- Specialists: no LLM, deterministic tool calls dispatched by Planner output.
- Critic: `google/gemini-3.5-flash`.
- Writer: `claude-opus-4-8` (unchanged) → fallback `claude-sonnet-4-6`.
- Verifier: `google/gemini-3.5-flash`.

## Phase A — Planner + wider RAG + Tavily (this pass)

### 1. New shared helpers (`supabase/functions/legal-synthesis/index.ts`, v30)
- `runPlanner(question, matter)` → JSON `{ facets: [{ id, question, hypothesis, specialists: [...], keywords: [...], filter, court? }], stop_when: "all_facets_covered" }`. Hypothesis is a 1–3 sentence HyDE passage used as an additional embedding query.
- `runCritic(question, plan, gathered)` → `{ done: bool, missing: [facet_ids], followup_queries: [...] }`. Runs at most once (adds up to +1 round).
- `runVerifier(answer, citations, chunks)` → `{ unsupported: [sentenceIdx], notes }`. Emitted as new SSE `verify` event; writer output is not rewritten in Phase A.

### 2. Retrieval upgrades
- **HyDE**: for each facet, embed both the raw question and Planner's hypothesis; union results.
- **Multi-query fanout**: Planner emits up to 3 paraphrases per facet; run in parallel through `hybrid_search_v2`.
- **Voyage rerank-2**: new call to `https://api.voyageai.com/v1/rerank` with `model: rerank-2`, up to 150 candidates → keep top 80 (raise `MAX_TOTAL_CHUNKS` 60→100 hard ceiling for safety).
- Knob changes: `MAX_ROUNDS` 3→5, `PER_SEARCH_K` 10→15, `EXPAND_TOP_N` 3→5, `MIN_SIM` retuned per rerank score distribution.

### 3. Tavily WebAgent (new tool `search_web`)
- Direct call to `https://api.tavily.com/search` with `TAVILY_API_KEY` (already in secrets).
- Request: `{ query, search_depth: "advanced", max_results: 8, include_answer: false, include_domains: [...ALLOWLIST] }`.
- Allowlist constant `WEB_ALLOWED_DOMAINS`: `courtlistener.com, law.cornell.edu, justia.com, casetext.com, supremecourt.gov, uscourts.gov, ca11.uscourts.gov, flnd.uscourts.gov, jpml.uscourts.gov, reuters.com, law360.com, bloomberglaw.com, ssrn.com, fda.gov, ema.europa.eu, who.int, nih.gov, ncbi.nlm.nih.gov, nejm.org, jamanetwork.com, thelancet.com, bmj.com`. Any result outside the list is dropped server-side (defense-in-depth even though `include_domains` filters upstream).
- Results normalized into `Chunk` shape with `kind: 'web'`, `source_url`, `snippet`, `title`, `published_date`. Bounded per-result excerpt (2000 chars) so the writer window stays sane.
- Emitted through existing `chunks` SSE stream + a new `web_result` note so the UI trace shows web hits distinctly.

### 4. Planner-driven dispatch loop
- Replace the single Gemini router loop with: one Planner call → parallel specialist fan-out → Critic → optional second fan-out → Writer → Verifier.
- Preserve existing SSE contract; add new event types: `plan` (facets), `critic` (gap notes), `web_result`, `verify` (post-stream grounding).
- Structured tools (`list_orders`, `lookup_counsel`, `list_deadlines`, `read_order`) unchanged; matter scoping still forced.

### 5. Prompts
- New `SYSTEM_PLANNER`, `SYSTEM_CRITIC`, `SYSTEM_VERIFIER` prompts colocated with existing `WRITER_SYSTEM`.
- Writer system prompt updated to describe the new `kind: 'web'` sources and how to cite them (source URL + publisher + date; never converted into a court holding).

### 6. Frontend (minimal, non-breaking)
- `src/lib/useSynthesisStream.ts`: add discriminated `plan | critic | web_result | verify` event handlers; each just appends to `notes` / a new `webResults[]` / `verifyFlags[]` so old UI still renders.
- No visual redesign this pass — Phase A ships behind the same trace timeline; Phase B adds a proper Planner/Critic pane.

## Phase B — Verifier-driven rewrite loop + UI (next pass, deferred)
- Verifier returns unsupported sentences → Writer gets a second pass to revise or drop them.
- Full trace UI: Planner facets, per-agent panels, Critic gaps, Verifier flags, web-source chips.
- Optional: swap Voyage rerank for Cohere rerank-3 if quality warrants.
- Optional: cache Planner outputs per (question hash, matter) for cheap re-runs.

## Files touched (Phase A)

Backend:
- `supabase/functions/legal-synthesis/index.ts` — full rewrite of orchestration section; helpers, prompts, Tavily client, rerank, constants.

Frontend (additive only):
- `src/lib/useSynthesisStream.ts` — new event types + `webResults` / `verifyFlags` state.

## Secrets

Already present: `LOVABLE_API_KEY` (Planner/Critic/Verifier via gateway), `SUPABASE_SERVICE_ROLE_KEY`, `VOYAGE_API_KEY` (assumed — needed for embeddings today and for rerank; if missing, prompt user), `TAVILY_API_KEY` (confirmed), `COURTLISTENER_API_KEY` (optional). I'll verify with `fetch_secrets` at build time before writing code; if `VOYAGE_API_KEY` is absent for rerank use, I'll surface it.

## Risks / mitigations
- **Latency**: Planner + rerank + Critic add ~4–6s. Mitigated by parallel specialist dispatch and streaming `plan`/`critic` events immediately.
- **Cost per query**: +1 Gemini Pro call, +1 Flash call, +1 Voyage rerank, +N Tavily. Cheap versus Opus writer; net multiplier ≈ 1.15×.
- **Prompt-injection via web results**: allowlist + strip HTML + bounded excerpts + writer system prompt explicitly says web content is untrusted context, never a legal holding.
- **Backward compat**: all new SSE events are additive; the reducer already has a default-case fallback added earlier.

## Success criteria
- Ask "What Daubert standard governs the Rule 702 hearing and what recent 11th Circuit precedent applies?" → Planner emits ≥2 facets (record 702 schedule + ca11 case law + optional Tavily law-review supplement); Writer answer cites both a PTO/CMO passage and a courtlistener opinion; Verifier flags none.
- Ask a scientific-causation question → WebAgent surfaces FDA/NEJM sources; writer cites them with URLs and publisher, not as holdings.
- No regression in current single-facet questions (Planner falls through to a one-facet plan = today's behavior).
