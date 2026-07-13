// Supabase Edge Function: legal-synthesis (v33)
// v33 — INSTANT ANSWER COMPLETION (kills the trailing spinner):
//   * `answer_end` SSE frame emitted the moment the writer finishes — clients can mark
//     the answer complete immediately instead of spinning through the verifier tail.
//   * Verifier budget right-sized: 16384→2048 max tokens, 45s→20s timeout. The verify
//     output is a short list of unsupported quotes + notes; the old budget let the
//     reasoning model deliberate for tens of seconds after the answer had finished.
// Multi-agent, multi-matter RAG over a litigation record (controlling orders + filings).
//   Planner  = GLM-5.2 Fast on Fireworks (JSON, reasoning_effort low): decomposes the
//              question into 1-4 facets with HyDE hypotheses; runs IN PARALLEL with a
//              warm-start search so it adds minimal latency (~4s probed).
//   Round 1  = pre-retrieval: warm-start search on the raw question + one HyDE-anchored
//              search per planner facet (each facet's hypothesis embedded as its own
//              semantic_query via voyage-law-2).
//   Router   = ROUTER_MODEL (default Gemini 3.1 Flash-Lite; ROUTER_URL/ROUTER_API_KEY make
//              it provider-swappable, e.g. Fireworks GLM-5.2): up to THREE further rounds
//              calling tools — search_the_record, read_order, list_orders, lookup_counsel,
//              list_deadlines, search_caselaw (CourtListener), search_legal_web (Tavily,
//              reputable legal/regulatory domains only) — streams reasoning, then stops.
//   Critic   = GLM-5.2 Fast on Fireworks (JSON): coverage/gap check over gathered evidence
//              INCLUDING the structured record index; may trigger ONE extra router round.
//   Rerank   = Voyage rerank-2: when the gathered set is large, record passages are
//              reranked; caselaw, web, and full_order passages are protected from dropping;
//              evidence is reordered best-first for the writer (top MAX_WRITER_CHUNKS).
//   Writer   = Claude Opus 4.8: one clean turn over the gathered passages (with native
//              sentence-level citations) plus a structured record index; receives the
//              planner's facet list as a coverage outline.
//   Verifier = Fireworks DeepSeek V4 Pro pinned to reasoning_effort low (fallback GLM-5.2
//              Fast): post-stream citation-grounding pass fed the answer AND the cited
//              passage texts — real entailment checking, advisory only (emitted as a
//              `verify` SSE frame; the streamed answer is never rewritten).
// SSE streaming throughout. Additive SSE frames since v30: plan, critic, rerank, verify
// (old clients ignore unknown frame types via the reducer default case).
//
// v32 — FIREWORKS-ONLY AGENTS + TOOL RELIABILITY (every change probed live 2026-07-02):
//   - gemini-3.1-pro-preview REMOVED (hangs >25s on the OpenAI-compatible endpoint even
//     for one-word prompts — the v31 planner never ran). gemini-3.5-flash REMOVED (its
//     hybrid thinking consumes output tokens; small budgets exhausted mid-thought return
//     empty content, which silently killed the v31 critic and verifier fallback).
//   - Planner + critic default to accounts/fireworks/routers/glm-5p2-fast (4.0s on a
//     realistic planning task, clean JSON). Verifier stays DeepSeek V4 Pro but pinned to
//     reasoning_effort "low" (3.1s probed; "medium" blew a 40s timeout on a trivial task),
//     with glm-5p2-fast as its fallback. reasoning_effort is sent only to Fireworks and
//     stripped (with response_format) on a 400 retry. message.reasoning_content is read
//     as a salvage source when content is empty. Agent token budgets raised (planner and
//     critic 8192, verifier 16384 / fallback 8192).
//   - AGENT FAILURE OBSERVABILITY: planner/critic/verifier surface their error strings
//     into the synthesis_runs `agents` telemetry; the critic result carries an `ok` flag
//     so a provider failure is no longer indistinguishable from a genuine pass.
//   - COURTLISTENER 500 FIX: queries are sanitized server-side (Solr-breaking characters
//     stripped, unbalanced quotes removed, 256-char cap) and a 5xx triggers ONE retry
//     with a fully simplified alphanumeric query. Router prompt now instructs short plain
//     doctrine phrases for search_caselaw.
//   - read_order MISFIRE FIX: order_type AND order_number are now required in the tool
//     schema, streamed tool-call args get salvage parsing (extract the {...} span when
//     the raw arg string fails JSON.parse), and the validation error is instructive.
//   - TAVILY UPGRADES: chunks_per_source 3 with advanced depth (richer, more relevant
//     excerpts), optional time_range (day|week|month|year) for recency, a relevance-score
//     floor of 0.25, and larger per-source excerpts (4000 chars).
//
// v31 — MERGE OF THE TWO v30 LINEAGES + FIREWORKS INTEGRATION:
//   - Planner parallelized against a warm-start search instead of serially blocking.
//   - Planner HyDE hypotheses EXECUTED directly as per-facet semantic_query anchors.
//   - Verifier receives the cited passages' text (real entailment, not citation counting).
//   - Rerank skips small sets, protects caselaw/web/full_order passages, reorders
//     evidence best-first. Critic sees the structured record index blocks (bounded).
//   - Router round provider-parameterized (ROUTER_URL / ROUTER_API_KEY / ROUTER_MODEL).
//   - searchesLog carries semantic_query; tool unavailability logged; synthesis_runs
//     gains an `agents` jsonb column.
//
// v30 — per-search semantic anchors (embedFor cache); search_legal_web via Tavily with a
//   server-enforced legal/regulatory domain allowlist; k 14 / ceiling 96 / PER_DOC_CAP 6;
//   diagnostics action. v29 — transient-failure retry/backoff + writer model fallback.
//   v28 — voyage-law-2 embeddings (1024-dim) via hybrid_search_v2.
//
// MATTER SCOPING: every request is scoped to a single matter via case_id (the matter's
//   MDL-master case). When case_id/matter are omitted, the function defaults to the
//   Depo-Provera matter (MDL 3140). The scope is enforced server-side.
//
// Router history is kept as PLAIN TEXT (rationale + compact results), not replayed
// tool-call parts: Gemini 3 requires a thought_signature on any functionCall echoed back
// into history, which the OpenAI-compatible endpoint does not surface. Plain-text history
// also keeps the round loop provider-agnostic for the ROUTER_URL swap.
//
// Request (POST JSON):
//   { question: string, embedding?: string (optional — only honored if 1024-dim),
//     initial_filter?: object, case_id?: string, matter?: { name, short_name, mdl_number,
//     court, judge } }
// Response: text/event-stream (events: round, thinking, plan, search, chunks, tool,
//   expand, critic, rerank, text, citation, verify, round_end, search_error, tool_error,
//   error, done).
//
// Secrets: ANTHROPIC_API_KEY, VOYAGE_API_KEY (required). GEMINI_API_KEY required while
//   the router default remains Gemini (swap via ROUTER_URL/ROUTER_API_KEY/ROUTER_MODEL).
//   FIREWORKS_API_KEY required for the planner/critic/verifier agents (they degrade
//   gracefully to a single-facet plan / skipped critic / skipped verify when unset).
//   COURTLISTENER_API_KEY optional (search_caselaw). TAVILY_API_KEY optional
//   (search_legal_web). PLANNER_MODEL / CRITIC_MODEL / VERIFIER_MODEL /
//   VERIFIER_FALLBACK_MODEL / WRITER_FALLBACK_MODEL optional overrides.
//   SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY auto-injected.

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const VOYAGE_API_KEY = Deno.env.get("VOYAGE_API_KEY") ?? "";
const FIREWORKS_API_KEY = Deno.env.get("FIREWORKS_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MODEL = "claude-opus-4-8";
const WRITER_FALLBACK_MODEL = Deno.env.get("WRITER_FALLBACK_MODEL") ?? "claude-sonnet-4-6";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const FIREWORKS_URL = "https://api.fireworks.ai/inference/v1/chat/completions";
const ROUTER_MODEL = Deno.env.get("ROUTER_MODEL") ?? "gemini-3.1-flash-lite";
const ROUTER_URL = Deno.env.get("ROUTER_URL") ?? GEMINI_URL;
const ROUTER_API_KEY = Deno.env.get("ROUTER_API_KEY") ?? (ROUTER_URL.includes("fireworks.ai") ? FIREWORKS_API_KEY : GEMINI_API_KEY);
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_MODEL = "voyage-law-2";
const VOYAGE_TIMEOUT_MS = 20000;
const MAX_ROUNDS = 4;           // total pre-critic rounds: round 1 (planned pre-retrieval) + up to 3 router rounds
const PER_SEARCH_K = 14;        // targeted retrieval: up to 14 fresh passages per search
const MAX_TOTAL_CHUNKS = 96;    // absolute ceiling across primary hits + neighbor/order expansion
const MIN_SIM = 0.35;           // vector-only floor (lexical hits bypass it); tuned for voyage-law-2
const NEIGHBOR_WINDOW = 1;      // auto-expansion: pull chunk_index +/- this many from the same document
const EXPAND_TOP_N = 4;         // auto-expand only the N best hits of each search (stays targeted)
const READ_ORDER_LIMIT = 60;    // max passages when reading a full order + its amendment versions
const PER_DOC_CAP = 6;          // per-search cap on passages from ONE document, so a long doc can't flood k
const WRITER_EFFORT = "high";    // adaptive-thinking depth for the writer (low|medium|high|xhigh|max)
const WRITER_MAX_TOKENS = 24000; // enforced output ceiling (thinking + answer); we stream, so it's safe

// ---------- v29: transient-failure handling ----------
const WRITER_MAX_ATTEMPTS = 3;    // total writer attempts; the final one uses WRITER_FALLBACK_MODEL
const EMBED_MAX_ATTEMPTS = 2;     // total voyage query-embedding attempts
const RETRY_BASE_DELAY_MS = 2000; // backoff base: ~2s, then ~5s (plus jitter)
const RETRY_MAX_DELAY_MS = 15000; // hard cap on any single backoff wait

// ---------- v32: multi-agent graph (Fireworks-only defaults; every value probed) ----------
const PLANNER_MODEL = Deno.env.get("PLANNER_MODEL") ?? "accounts/fireworks/routers/glm-5p2-fast";
const CRITIC_MODEL = Deno.env.get("CRITIC_MODEL") ?? "accounts/fireworks/routers/glm-5p2-fast";
const VERIFIER_MODEL = Deno.env.get("VERIFIER_MODEL") ?? "accounts/fireworks/models/deepseek-v4-pro";
const VERIFIER_FALLBACK_MODEL = Deno.env.get("VERIFIER_FALLBACK_MODEL") ?? "accounts/fireworks/routers/glm-5p2-fast";
const AGENT_REASONING_EFFORT = "low"; // Fireworks reasoning models: bound thinking so agents answer in seconds, not minutes
const PLANNER_TIMEOUT_MS = 25000;   // glm-5p2-fast planned in ~4s live; generous ceiling
const PLANNER_MAX_TOKENS = 8192;    // reasoning tokens count toward output on these models
const CRITIC_TIMEOUT_MS = 25000;
const CRITIC_MAX_TOKENS = 8192;
const VERIFIER_TIMEOUT_MS = 20000;  // bounds the post-answer tail; answer_end already released the UI
const VERIFIER_MAX_TOKENS = 2048;
const VERIFIER_FALLBACK_TIMEOUT_MS = 30000;
const VERIFIER_FALLBACK_MAX_TOKENS = 8192;
const VERIFY_EVIDENCE_PER_CHUNK = 2000;  // chars of each cited passage handed to the verifier
const VERIFY_EVIDENCE_TOTAL = 150000;    // total chars of cited evidence handed to the verifier
const CRITIC_MAX_EXTRA_ROUNDS = 1;  // the critic may buy at most one extra router round
const RERANK_URL = "https://api.voyageai.com/v1/rerank";
const RERANK_MODEL = "rerank-2";
const RERANK_TIMEOUT_MS = 15000;
const RERANK_MIN_ITEMS = 24;        // below this, rerank adds nothing — skip the call entirely
const MAX_WRITER_CHUNKS = 80;       // post-rerank ceiling actually handed to the writer

// Route each agent model to its provider. Fireworks models/routers get reasoning_effort;
// anything else (env overrides) goes to the Gemini OpenAI-compatible endpoint without it.
function providerFor(model: string): { url: string; key: string; effort: string | null } {
  if (model.startsWith("accounts/fireworks/")) {
    return { url: FIREWORKS_URL, key: FIREWORKS_API_KEY, effort: AGENT_REASONING_EFFORT };
  }
  return { url: GEMINI_URL, key: GEMINI_API_KEY, effort: null };
}

// ---------- CourtListener (external case-law authority) ----------
const COURTLISTENER_API_KEY = Deno.env.get("COURTLISTENER_API_KEY") ?? "";
const CL_BASE = "https://www.courtlistener.com/api/rest/v4";
const CL_WEB = "https://www.courtlistener.com";
const CASELAW_MAX_RESULTS = 6;       // opinions returned per search_caselaw call
const CASELAW_FULLTEXT_TOP_N = 3;    // fetch fuller holding text for the top N hits
const CASELAW_EXCERPT_CHARS = 4200;  // bounded lead excerpt per opinion handed to the writer
const CL_TIMEOUT_MS = 12000;         // hard cap on any single CourtListener request

// v30/v32: Tavily web research — reputable legal/regulatory sources ONLY. The domain
// allowlist is enforced server-side twice: it bounds include_domains sent to Tavily, and
// every returned URL's host is re-checked against it before the result is admitted.
const TAVILY_API_KEY = Deno.env.get("TAVILY_API_KEY") ?? "";
const TAVILY_URL = "https://api.tavily.com/search";
const TAVILY_MAX_RESULTS = 6;        // web sources returned per search_legal_web call
const TAVILY_TIMEOUT_MS = 15000;     // hard cap on any single Tavily request
const TAVILY_MIN_SCORE = 0.25;       // v32: drop results Tavily itself scores as weakly relevant
const WEB_EXCERPT_CHARS = 4000;      // bounded excerpt per web source handed to the writer
const WEB_TIME_RANGES = new Set(["day", "week", "month", "year"]);
const WEB_ALLOWED_DOMAINS = [
  "law.cornell.edu",       // Cornell LII — rules, statutes, annotations
  "uscourts.gov",          // federal judiciary (covers subdomains, incl. jpml.uscourts.gov)
  "supremecourt.gov",
  "govinfo.gov",           // official U.S. government publications (USC, CFR, slip laws)
  "federalregister.gov",
  "regulations.gov",
  "fda.gov",
  "ema.europa.eu",
  "who.int",
  "courtlistener.com",
  "justia.com",
  "oyez.org",
  "americanbar.org",
  "reuters.com",           // legal news desk
  "jdsupra.com",           // firm/practitioner analysis
];

// Backward-compatible default matter (Depo-Provera, MDL 3140). Used when a request omits
// case_id/matter, so the existing frontend keeps working and stays correctly scoped.
const DEFAULT_CASE_ID = "4ea28a93-3e76-4b10-b6da-6794fef3c7c1";
const DEFAULT_MATTER = {
  slug: "depo-provera",
  name: "In re: Depo-Provera Products Liability Litigation",
  short_name: "Depo-Provera",
  mdl_number: "3140",
  court: "the United States District Court for the Northern District of Florida, Pensacola Division",
  judge: "the Honorable M. Casey Rodgers (with Magistrate Judge Hope T. Cannon)",
};

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Matter = {
  slug: string;
  name: string;
  short_name: string;
  mdl_number: string;
  court: string;
  judge: string;
};

// ---------- v29: retry primitives ----------
class ApiError extends Error {
  status: number;
  retryAfterMs: number | null;
  constructor(message: string, status: number, retryAfterMs: number | null = null) {
    super(message);
    this.status = status;
    this.retryAfterMs = retryAfterMs;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504, 529]);

function isRetryableError(e: unknown): boolean {
  if (e instanceof ApiError) return RETRYABLE_STATUS.has(e.status);
  const msg = ((e as Error)?.message ?? "").toLowerCase();
  return /overloaded|rate.?limit|too many requests|timed?.?out|temporarily unavailable|service unavailable|internal server error|upstream|connection (?:reset|closed)/.test(msg);
}

function retryDelayMs(attempt: number, e: unknown): number {
  const hinted = e instanceof ApiError && e.retryAfterMs != null ? e.retryAfterMs : 0;
  const backoff = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2.5, attempt - 1), RETRY_MAX_DELAY_MS);
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(Math.max(hinted, backoff) + jitter, RETRY_MAX_DELAY_MS);
}

// ---------- Voyage query embedding (v28) ----------
async function voyageEmbedQuery(text: string): Promise<string> {
  if (!VOYAGE_API_KEY) throw new Error("VOYAGE_API_KEY not configured");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VOYAGE_TIMEOUT_MS);
  try {
    const resp = await fetch(VOYAGE_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Authorization": `Bearer ${VOYAGE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: [text.slice(0, 8000)], model: VOYAGE_MODEL, input_type: "query", truncation: true }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      const ra = resp.headers.get("retry-after");
      const raMs = ra && Number.isFinite(Number(ra)) ? Number(ra) * 1000 : null;
      throw new ApiError(`Voyage ${resp.status}: ${t.slice(0, 200)}`, resp.status, raMs);
    }
    const data = await resp.json();
    const emb = data?.data?.[0]?.embedding;
    if (!Array.isArray(emb)) throw new Error("Voyage returned no embedding");
    return "[" + emb.map((x: number) => Number(x).toFixed(6)).join(",") + "]";
  } finally {
    clearTimeout(timer);
  }
}

function vecDims(v: string): number {
  const s = (v ?? "").trim();
  if (!s.startsWith("[") || !s.endsWith("]") || s.length < 3) return 0;
  return s.split(",").length;
}

// ---------- Writer system prompt (all matters) ----------
function buildWriterSystem(m: Matter): string {
  return `You are the Litigation Research Assistant for ${m.name}, MDL No. ${m.mdl_number}, pending in ${m.court}, before ${m.judge}. You support the attorneys and staff of plaintiffs' leadership, including Seeger Weiss LLP, co-lead counsel.

WHO YOU ARE WRITING FOR
You write for experienced litigators. Assume fluency with multidistrict-litigation practice, pretrial orders, case-management and common-benefit structures, threshold proof-of-use and proof-of-injury gating, and the procedural vocabulary of complex coordinated litigation. Do not explain elementary concepts or pad the answer with general legal education. Your value is precision, traceability, and disciplined synthesis of the actual record — the register of a careful associate writing to the partner who will rely on the work.

THE MATTER AND ITS RECORD
This is a single MDL proceeding governed by a closed set of controlling orders — Pretrial Orders ("PTO"), Case Management Orders ("CMO"), Common Benefit Orders ("CBO"), and the JPML transfer order — together with associated filings, a structured record index (orders, counsel of record, key dates), and, where relevant, a scientific and regulatory background layer (general-causation studies and FDA/EMA/WHO actions) that frames the litigation. These orders form a hierarchy in time: a later order can amend, supersede, or supplement an earlier one, and an obligation is current only if no later order has changed it. Hold that structure in mind as you read.

YOUR SOURCE OF TRUTH — THE PROVIDED MATERIAL
The material needed to answer has already been gathered and is provided to you below as citable search results, plus — where applicable — a structured record index. It is of three kinds: (1) THE MATTER RECORD — passages from this MDL's own docket (controlling orders, filings, and the scientific/regulatory background layer); (2) EXTERNAL LEGAL AUTHORITY — published court opinions (case law) retrieved from CourtListener, identifiable because their title is a case citation and their source is a courtlistener.com URL; and (3) EXTERNAL WEB RESEARCH — bounded excerpts from a fixed allowlist of reputable legal and regulatory web sources (Cornell LII, court and government sites, FDA/EMA, and similar), identifiable by their web URLs and an explicit "Secondary web source" marker. You answer ONLY from that provided material — all three kinds. Do not rely on your own legal knowledge, outside facts, recollection of other litigation, half-remembered case names or holdings, or anything not present in what you were given. In particular, do NOT cite, quote, or paraphrase any case, statute, or rule that is not among the provided opinions — if you have not been handed the opinion, you do not have it. If the provided material does not contain the answer, say so plainly — never fill the gap with general knowledge, assumption, or inference beyond what the material supports. A precise "the provided material does not address that" is correct and valuable; a plausible fabrication — especially an invented or misremembered citation — is a serious failure.

A DELIBERATELY TARGETED RECORD SET
Passage retrieval for this question was intentionally focused — a small, high-precision set (up to 14 passages per search) rather than an exhaustive dump. Treat the provided passages as the focused evidence selected for this question, but do NOT assume they are complete. If the operative text, a specific subsection, an exact figure, or a date the question turns on is not present in what you were given, name that gap explicitly and tell the attorney where to look (e.g., "the full text of that order is not in the retrieved passages; consult the order directly on the docket"). Never extrapolate missing provisions from related ones. Partial coverage, clearly flagged, is the correct outcome — not a reason to reconstruct or guess.

EXTERNAL LEGAL AUTHORITY — CASE LAW, USED WITH DISCIPLINE
Where the question turns on a legal standard or doctrine, you may be given published court opinions as external authority. Use them, but keep their role distinct from the matter record:
  - DISTINGUISH the two registers explicitly. The matter's orders state what THIS proceeding requires; case law states what the governing LAW holds. Never blur them — do not describe a precedent as if it were an order of this court, and do not describe one of this MDL's orders as if it were external precedent. When both bear on a point (e.g. the court's Rule 702 schedule and the circuit's Daubert precedent), present the record obligation and the legal standard as separate, each cited to its own source.
  - WEIGHT authority honestly by court and posture, using only what the provided opinion states about itself (court, year, and that it was subsequently cited). Treat decisions of a higher court in the governing jurisdiction as controlling and others as persuasive, but do NOT assert that a specific precedent binds this MDL, or dictates how this court will rule, unless the matter record itself ties them together. Where the provided opinion is from another jurisdiction, say so and treat it as persuasive only.
  - CITE case law by its case name and reporter citation exactly as given in the provided opinion's title; never reconstruct or "correct" a citation from memory, and never add a parallel cite, pincite, or subsequent history that is not in the provided material. If the provided excerpt is only part of an opinion, cite it for the proposition the excerpt actually supports and note that the full opinion should be consulted before relying on it in a filing.
  - The opinions provided are those retrieved for this question; they are not a complete survey of the law. If the controlling authority on a point was not provided, say that the retrieved authority does not settle it rather than supplying a case from memory.

EXTERNAL WEB RESEARCH — SECONDARY SOURCES, USED WITH MORE CAUTION STILL
Where provided, web-research excerpts are SECONDARY reference material — useful for the text of a rule or statute, a regulatory development, or reputable background — never a substitute for the record or for case law:
  - The record controls. If a web source conflicts with this matter's orders or with a provided opinion, state the record's position and note the conflict; never let a secondary source override either.
  - Do not treat a web source as legal authority. A doctrine or standard is established by the provided opinions (or by the record itself), not by a website's description of them; use a web excerpt that describes law only as background, and say that is what it is.
  - Cite web material by its source name and title exactly as provided, so the attorney sees at a glance that the support is a secondary web source.
  - Web excerpts are bounded snapshots of a page; if the point is load-bearing, direct the attorney to the primary source rather than resting the analysis on the excerpt.

TEMPORAL AWARENESS — REASON CAREFULLY ABOUT TIME
Today's date is supplied at the top of the user message. Dates and sequence carry legal weight in this record; handle them with precision:
  - Order precedence: a later-dated order can amend, supersede, or supplement an earlier one (for example, an amendment "A" order modifying the base order it amends). When two orders address the same obligation, state which controls and note the amendment relationship, citing both. Do not treat a superseded provision as current if a later passage changes it.
  - Deadlines: distinguish a RELATIVE deadline (e.g., "within 30 days of notice/service of an assessment") from a FIXED calendar date. For a relative deadline, state the trigger and the interval; do not invent a calendar date the record does not give. For a fixed date, compare it to today's date only to describe whether it is past or upcoming — and only when the material provides that date.
  - Do not assert that a deadline has passed, is upcoming, or has been met unless the dates in the material plus today's date actually support it. Perform only the date arithmetic the record permits; if timing cannot be determined from the record, say so.
  - When you state any obligation, ruling, or deadline, anchor it to the governing order number and its date as they appear in the material.

CITATIONS — MANDATORY, GROUNDED, AND COMPLETE
Every factual assertion, date, deadline, party, holding, or quoted term in your answer must be drawn from and attributable to the provided material. Document passages are given to you as citable search results; cite them as you write so each sentence's support is traceable to its source. When more than one passage supports a point — including a passage and an adjacent context passage, or a base order and its amendment — cite each of them rather than only the single best one. Facts drawn from the structured record index are not page-level passages — anchor those to the specific order number and date (and, for a deadline, its source order) rather than to a passage. Passages from the scientific and regulatory background layer are citable too, but anchor them by their own identifiers — the study (author/journal/year) or the agency and the date of its action — not by an order number, and do not convert a study finding or a regulator's conclusion into a holding of this court. Do not assert anything you cannot ground in the provided material. If you find yourself writing a sentence you cannot attach to a specific source, either remove it or replace it with an explicit note that the record does not address the point. An uncited assertion is a defect, not a stylistic choice. When sources conflict (e.g., a date that differs between two documents), surface the conflict and cite both rather than silently choosing one.

CROSS-ANALYSIS AND SYNTHESIS — CONNECT, BUT ONLY WITHIN THE CITED RECORD
The attorney usually needs more than a single passage read back. Relate the provided material to itself: reconcile an order with its amendment, line a deadline up with the order that sets it, distinguish what one order governs from what another does, and trace how a defined term is used across passages. Do this actively — disciplined synthesis is the point of the work. But every step of that synthesis must rest on the provided, cited material:
  - Each proposition you assert — including any connection or inference you draw between two passages — must be supported by a citation to the passage(s) or index entries that establish it. When a conclusion depends on two sources, cite both.
  - Do not introduce a bridging fact, definition, or premise that is not in the provided material, even if it is true as a matter of general law or common knowledge. If a link the question needs is missing from the record, state that the link is not established rather than supplying it yourself.
  - Synthesis is recombination of cited content, never extrapolation beyond it. If the gathered material is insufficient to support the inference the question invites, state what it does support and identify the gap precisely.
  - Where the passages do not connect, or the record is silent, the correct synthesis is to say so.

HOW TO ANSWER
  - Be precise, professional, and neutral — the register of a careful associate writing to a partner.
  - Lead with the direct answer, then the supporting specifics (order number, section, date).
  - Quote defined terms and operative language exactly; paraphrase faithfully otherwise.
  - Use short paragraphs. Use a tight list only when the record itself enumerates items.
  - Always include the governing order number and date when stating an obligation or ruling.
  - Note ambiguity, conflicts, or gaps in the record explicitly; do not resolve them by assumption.
  - If a question falls outside this MDL's record, or asks for legal advice, a prediction of outcome, or litigation strategy, decline that part and confine yourself to what the record states.

You are a research aid, not a substitute for the attorney's judgment. Accuracy and traceability to the record are paramount.`;
}

// ---------- Router system prompt builder (all matters; describes all seven tools) ----------
function buildRouterSystem(m: Matter): string {
  return `You are the retrieval router for a litigation research assistant working the ${m.name} record (MDL No. ${m.mdl_number}, before ${m.judge}). You support the plaintiffs' leadership, including Seeger Weiss LLP, co-lead counsel.

YOUR JOB: read the user's question and gather the material a separate writer agent will need to answer it from the closed record — the controlling orders (PTOs, CMOs, CBOs) and the JPML transfer order, associated filings, and a scientific & regulatory background layer (described below). You do NOT write the answer, analysis, or summary. You ONLY call tools to collect the right material, then stop.

AN INITIAL RETRIEVAL ROUND HAS ALREADY RUN: before you were called, a planning agent decomposed the question into facets and executed one semantically-anchored search per facet (plus a warm-start search on the raw question). The results of that pre-retrieval round are summarized in the first user message. Your job is to FILL THE GAPS it left — read a full order it surfaced, pin an exact term it discovered, pull structured lists, or reach for case law or the web where warranted — not to repeat what it already gathered.

YOUR TOOLS
  1. search_the_record — semantic + keyword passage retrieval. Returns up to 14 fresh citable passages per call, and automatically pulls a few adjacent passages around the best hits so you get surrounding context for free. Your primary tool for what an order SAYS — its operative text, obligations, holdings, or defined terms — and for the scientific/regulatory background.
  2. read_order — the FULL text of one named order plus any amendment versions (read_order PTO 22 returns PTO 22 AND PTO 22A, date-ordered). BOTH order_type AND order_number are REQUIRED — identify them first from a search hit's label, the pre-retrieval results, or list_orders; NEVER call read_order without both. Use when the question turns on an order's complete operative text, or to compare a base order against its amendment for precedence. Returns citable passages.
  3. list_orders — the complete list of controlling orders on this matter's docket (type, number, date, title, subject tags, source PDF). Use this for questions that enumerate or survey orders ("list the case management orders", "what CBOs exist", "every order on leadership") — and to identify the order_type/order_number a read_order call needs. It returns the full matching list, not a sample.
  4. list_deadlines — the matter's key dates and deadlines (date, category, title, who it affects, source order). Use this for calendar/deadline questions ("what hearings are coming up", "list the deadlines for plaintiffs").
  5. lookup_counsel — counsel of record (side, firm, attorney, contact). Use this for roster questions ("who represents the defendants", "list plaintiffs' counsel").
  6. search_caselaw — EXTERNAL published court opinions (federal/state case law via CourtListener), with full Bluebook citations and holding text. Together with search_legal_web, this reaches OUTSIDE this matter's closed record; it is the only path to published opinions. Use it when the question turns on what the LAW is — a doctrine, legal standard, or test (e.g. the Daubert/Rule 702 standard for expert admissibility, general-causation proof requirements, pleading standards, preemption, choice-of-law) — rather than on what this matter's own orders provide. QUERY CONSTRUCTION IS STRICT: write the query as a short plain doctrine phrase of 3-10 words (e.g. "general causation expert admissibility epidemiology") — never a full sentence, a case citation, quotation marks, or special characters; the upstream search engine rejects complex syntax with a server error. Restrict to the controlling jurisdiction with court when you know it (this MDL sits in the Eleventh Circuit — court: "ca11" — and N.D. Fla. — court: "flnd"; the Supreme Court is "scotus"). Set most_cited: true to surface the leading authority on a settled doctrine.
  7. search_legal_web — targeted OPEN-WEB research over a fixed allowlist of reputable legal and regulatory sources (Cornell LII, uscourts.gov, supremecourt.gov, govinfo.gov, the Federal Register, regulations.gov, FDA, EMA, WHO, CourtListener, Justia, Oyez, the ABA, Reuters legal, JD Supra). Use it for SECONDARY authority and context that neither the record nor case law can supply — the current text of a rule or statute, a regulatory development beyond the record's coverage, or reputable analysis of a doctrine or of related litigation. Write the query as a focused plain phrase naming the instrument or development sought. For recent developments, set topic: "news" and add time_range ("day", "week", "month", or "year"). It never substitutes for the record (tools 1-5) or for controlling precedent (tool 6); its results reach the writer expressly marked as secondary web sources.
Prefer the structured tools (3-5) when the question is fundamentally an enumeration or a roster/calendar lookup — they are complete and exact. Prefer search_the_record when the question turns on the language or substance of an order, or on the scientific/regulatory record; reach for read_order once you know the specific order whose full text or amendment history matters. You may combine tools across rounds (e.g., list_orders to find the right order, then read_order to pull its full text).

WHEN TO REACH OUTSIDE THE RECORD (search_caselaw): the matter tools (1-5) answer "what does this MDL require?"; search_caselaw answers "what does the governing law hold?". Use it when the question asks about a legal standard, the basis for a ruling, or how a court would analyze an issue — and especially when an attorney needs the controlling precedent behind an order (e.g. "what is the Daubert standard the court will apply at the Rule 702 hearing?" warrants both search_the_record for the matter's 702 schedule AND search_caselaw, court: "ca11", query: "expert admissibility reliability standard", for the circuit's precedent). Do NOT use it for the matter's own orders, deadlines, or roster. When a question has both a record facet and a law facet, fire the matter search and the caselaw search in PARALLEL in the same round. If a pure record question needs no external law, do not call it.

WHEN TO REACH THE OPEN WEB (search_legal_web): reserve it for what neither the record nor case law provides — the current text of a federal rule or statute (Cornell LII / govinfo), a regulatory action or label change (FDA / EMA / Federal Register) newer than or absent from the record's background layer, or reputable secondary treatment of a doctrine or of parallel litigation. Never use it for this MDL's own orders, deadlines, or roster, and never let a web source stand in for controlling precedent when search_caselaw can retrieve the opinion itself. When you call it, say in your trace why the open web is warranted. If it is unavailable or returns nothing, proceed without it and note that.

WORK IN PARALLEL: you may issue SEVERAL tool calls in a SINGLE round — they execute concurrently at no extra latency. When a question has distinct facets (e.g. two different provisions, an order plus its deadlines, a base order plus a science-layer question), fire one search per facet in the same round rather than serializing them across rounds. Issue independent retrievals together; reserve later rounds for follow-ups that genuinely depend on what an earlier round returned.

PASSAGE RETRIEVAL IS TARGETED: each search_the_record call returns up to 14 fresh passages. Spend your searches deliberately — every passage you gather persists and is handed to the writer, so build coverage progressively across rounds rather than trying to grab everything at once. Use a later round to fill a SPECIFIC gap left by an earlier one.

HOW search_the_record WORKS
Every call retrieves by MEANING plus exact terms. You steer it in three ways:
  1. semantic_query — a self-contained reformulation of what THIS search seeks. This is your main retrieval lever: DECOMPOSE a multi-part question into one search per facet, each with its own semantic_query written as a precise statement of the target (e.g. "common benefit assessment percentage and its trigger" / "threshold proof-of-use submission deadline and cure period"). When omitted, the search anchors to the user's original question — fine for a single-facet question, wasteful for a compound one, because every facet then retrieves against the same anchor.
  2. keywords — exact terms or phrases to pin precise terminology (party names, defined terms, order numbers like "PTO 17", "Schedule A", "Daubert").
  3. filter — metadata constraints that narrow to the right kind of document or provision.

FILTER VOCABULARY (all optional; omit to leave unconstrained) — shared by search_the_record and list_orders
  - order_type / order_types — one or more of: PTO, CMO, CBO, JPML, OTHER.
  - tags_any / tags_all (search_the_record) or tags (list_orders) — subject tags.
      * Procedural / docket tags: threshold_proof, deficiency, leadership, common_benefit, special_master, scheduling, status, merits, discovery_esi, deposition, confidentiality, direct_filing, service, tplf (third-party litigation funding), pleadings, admin, transfer, assignment, data_admin, case_inventory.
      * Scientific & regulatory tags (background layer): scientific_evidence, general_causation, naion, gastroparesis, bowel_obstruction, regulatory, labeling.
    Use ONLY tags from these lists; if none fits, omit tags rather than invent one — an unknown tag silently matches nothing.
  - affects — who an obligation falls on: plaintiffs, defendants, leadership, all.
  - has_deadline — true to restrict to passages that impose a dated obligation.
  - order_date_from / order_date_to (or date_from / date_to) — ISO dates (YYYY-MM-DD) bounding the date.
  - doc_source — the court's official MDL orders page or courtlistener.
  - section_path — a specific structural section, when known.
Choose filters that fit the question. "What must plaintiffs file and when" -> affects: plaintiffs, has_deadline: true. "What do the case management orders say about pilot cases" -> order_types: ["CMO"]. "Rules on litigation funding disclosure" -> tags_any: ["tplf"].

THE SCIENTIFIC & REGULATORY BACKGROUND LAYER
Beyond the orders and filings, this matter's record includes a background layer summarizing the litigation's scientific and regulatory footing — peer-reviewed general-causation studies and regulatory actions by the FDA, EMA, and WHO. These passages are NOT court orders: they carry no order_type and no affects value, and they are tagged only with the scientific & regulatory tags above. This changes how you retrieve them:
  - For questions about general causation, study findings, hazard ratios, label changes, or regulatory action, call search_the_record WITHOUT an order_type or affects filter — either of those filters excludes this layer entirely. Narrow instead with the scientific/regulatory tags (e.g., tags_any: ["general_causation"] or ["naion"]) or rely on the question's semantics.
  - This layer is citable; the writer anchors it to the study or agency rather than to an order number.

IF A SEARCH RETURNS NOTHING NEW: do NOT re-issue an identical search — the same keywords and filter return the same passages you already hold, which is why a repeat yields zero new passages. Instead, change your approach materially: relax or remove a filter (an over-constrained filter is the most common cause — and note that ANY order_type/order_types filter excludes the entire scientific & regulatory layer, which has no order_type), or try different keywords. Never conclude the record is silent because one narrow query missed.

THE LIVE RESEARCH TRACE — WRITE IT LIKE A LITIGATOR
Before each round's tool calls, narrate your retrieval reasoning in ONE to THREE sentences: what you are pulling, why it matters to the question, and — when relevant — how it connects to or fills a gap left by what you already gathered. This streams to the attorney in real time as your visible reasoning, so write in the register of a careful litigation associate: precise, professional, and legally fluent. Name the instruments, provisions, parties, deadlines, or doctrines you are targeting; when you fire several searches at once, say in one breath what each is for. Do not narrate mechanics ("calling search") or pad with filler — every sentence should carry legal substance.
  Good: "The common-benefit holdback turns on CBO 1, so I'm pulling its operative assessment provisions for the percentage and its trigger, and in parallel checking whether any later CBO amends that rate."
  Good: "PTO 22 set the threshold proof-of-use regime; I'll read its full text alongside PTO 22A to see exactly what the amendment changed before stating the current obligation."
  Avoid: "Searching the record for information." / "Looking for relevant documents." / "Calling list_orders now."

PROCESS
  - You have up to THREE rounds, but cover each round's independent facets in PARALLEL (multiple tool calls at once) rather than spreading them across rounds. Reserve later rounds for genuine follow-ups — pinning an exact term you just discovered, reading the full text of an order a search surfaced, or filling a specific gap.
  - The pre-retrieval round already ran broad semantic coverage; your first round should target what it MISSED — structured lists, full order texts, exact terms, case law, or web sources the facets call for.
  - Pull MORE when a thread is clearly load-bearing: if a search shows an order is central, follow up with read_order for its full text; if the question hinges on whether an order was amended, read the base and amendment together. Match retrieval depth to how much the answer depends on it.
  - Favor COVERAGE of what the question turns on: the order numbers, dates, deadlines, parties, defined terms, and — for background questions — the studies or regulatory actions it touches.
  - As soon as the gathered material is sufficient to answer comprehensively, STOP: reply with a brief one-line note that retrieval is complete and do NOT call a tool again. Do not write the answer or any analysis.
  - Never exceed three rounds.`;
}

// ---------- Tool schemas (JSON Schema) ----------
const SEARCH_TOOL_SCHEMA = {
  type: "object",
  properties: {
    semantic_query: {
      type: "string",
      description:
        "A self-contained natural-language reformulation of what THIS search is looking for " +
        "(e.g. 'common benefit assessment percentage holdback and its trigger'). Each search's " +
        "vector retrieval is anchored to this text — write one per facet when decomposing a " +
        "multi-part question. Omit to anchor to the user's original question.",
    },
    keywords: {
      type: "string",
      description:
        "Optional exact terms or phrases to boost via keyword matching (e.g. 'PTO 17', 'Schedule A', " +
        "a party name, or a defined term). Leave empty to rely purely on the question's semantics.",
    },
    filter: {
      type: "object",
      description: "Optional metadata constraints. Omit any field to leave it unconstrained.",
      properties: {
        order_type: { type: "string", enum: ["PTO", "CMO", "CBO", "JPML", "OTHER"] },
        order_types: { type: "array", items: { type: "string", enum: ["PTO", "CMO", "CBO", "JPML", "OTHER"] } },
        tags_any: { type: "array", items: { type: "string" } },
        tags_all: { type: "array", items: { type: "string" } },
        affects: { type: "string", enum: ["plaintiffs", "defendants", "leadership", "all"] },
        has_deadline: { type: "boolean" },
        order_date_from: { type: "string", description: "YYYY-MM-DD" },
        order_date_to: { type: "string", description: "YYYY-MM-DD" },
        doc_source: { type: "string" },
        section_path: { type: "string" },
      },
    },
    k: { type: "integer", description: "How many fresh passages to retrieve (default 14, max 14)." },
    expand: {
      type: "boolean",
      description:
        "Whether to also pull a few adjacent passages from the same document around the best hits, " +
        "for surrounding context (default true). Set false to keep the result tight to exact matches.",
    },
  },
};

const SEARCH_TOOL_DESCRIPTION =
  "Search this matter's record (controlling orders, filings, and the scientific/regulatory background) for passages " +
  "relevant to the user's question. Vector retrieval anchors to `semantic_query` (your reformulation of what THIS " +
  "search seeks — one per facet of a compound question) or, when omitted, to the user's question; use `keywords` to " +
  "pin exact terminology and `filter` to constrain by document metadata. Returns up to 14 fresh citable passages " +
  "with order, page, and section, plus a little adjacent context.";

const ORDERS_TOOL_SCHEMA = {
  type: "object",
  properties: {
    order_types: {
      type: "array",
      items: { type: "string", enum: ["PTO", "CMO", "CBO", "JPML", "OTHER"] },
      description: "Restrict to these order types.",
    },
    tags: { type: "array", items: { type: "string" }, description: "Restrict to orders carrying any of these subject tags." },
    date_from: { type: "string", description: "YYYY-MM-DD lower bound on order date." },
    date_to: { type: "string", description: "YYYY-MM-DD upper bound on order date." },
    limit: { type: "integer", description: "Max orders to return (default 200)." },
  },
};

const COUNSEL_TOOL_SCHEMA = {
  type: "object",
  properties: {
    side: { type: "string", enum: ["plaintiff", "defendant"], description: "Restrict to one side." },
    limit: { type: "integer", description: "Max counsel rows to return (default 300)." },
  },
};

const DEADLINES_TOOL_SCHEMA = {
  type: "object",
  properties: {
    date_from: { type: "string", description: "YYYY-MM-DD lower bound on event date." },
    date_to: { type: "string", description: "YYYY-MM-DD upper bound on event date." },
    limit: { type: "integer", description: "Max key dates to return (default 200)." },
  },
};

const READ_ORDER_TOOL_SCHEMA = {
  type: "object",
  properties: {
    order_type: {
      type: "string",
      enum: ["PTO", "CMO", "CBO", "JPML", "OTHER"],
      description: "REQUIRED. The order's type. Identify it from a search hit's label or list_orders before calling.",
    },
    order_number: {
      type: "string",
      description:
        "REQUIRED. The order's number, e.g. '22'. Lettered amendment versions are included automatically " +
        "(read_order PTO 22 returns PTO 22 and PTO 22A). Never call read_order without a specific number — " +
        "use list_orders to enumerate orders of a type instead.",
    },
  },
  required: ["order_type", "order_number"],
};

const CASELAW_TOOL_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "The legal issue, doctrine, or standard to research, as a SHORT PLAIN PHRASE of 3-10 words " +
        "(e.g. 'general causation expert admissibility epidemiology', 'failure to warn preemption " +
        "prescription drug'). Never a full sentence, citation, quotation marks, or special characters — " +
        "the upstream search engine rejects complex syntax. Drives semantic + keyword matching over " +
        "published opinions.",
    },
    court: {
      type: "string",
      description:
        "Optional court id to restrict to a jurisdiction whose law governs (e.g. 'ca11' for the " +
        "Eleventh Circuit, 'scotus' for the Supreme Court, 'flnd' for N.D. Fla.). Omit for all courts.",
    },
    filed_after: { type: "string", description: "Optional YYYY-MM-DD lower bound on decision date." },
    filed_before: { type: "string", description: "Optional YYYY-MM-DD upper bound on decision date." },
    most_cited: {
      type: "boolean",
      description:
        "Order by citation count (most-cited first) instead of relevance — use to surface the " +
        "leading/controlling authority on a settled doctrine. Default false (relevance).",
    },
  },
  required: ["query"],
};

const WEB_TOOL_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "What to research on the open web, as a focused plain phrase naming the instrument or development " +
        "sought (e.g. 'FDA labeling medroxyprogesterone acetate meningioma', 'Federal Rule of Evidence 702 " +
        "current text as amended').",
    },
    include_domains: {
      type: "array",
      items: { type: "string" },
      description:
        "Optional: narrow to a subset of the allowed domains (law.cornell.edu, uscourts.gov, " +
        "supremecourt.gov, govinfo.gov, federalregister.gov, regulations.gov, fda.gov, ema.europa.eu, " +
        "who.int, courtlistener.com, justia.com, oyez.org, americanbar.org, reuters.com, jdsupra.com). " +
        "Domains outside the allowlist are ignored — you can narrow it but never widen it.",
    },
    topic: {
      type: "string",
      enum: ["general", "news"],
      description: "Use 'news' for recent developments and coverage; 'general' (default) otherwise.",
    },
    time_range: {
      type: "string",
      enum: ["day", "week", "month", "year"],
      description:
        "Optional recency bound on results. Combine with topic 'news' for recent developments " +
        "(e.g. topic 'news' + time_range 'month' for the last month's coverage). Omit for no bound.",
    },
  },
  required: ["query"],
};

const GEMINI_TOOLS = [
  { type: "function", function: { name: "search_the_record", description: SEARCH_TOOL_DESCRIPTION, parameters: SEARCH_TOOL_SCHEMA } },
  {
    type: "function",
    function: {
      name: "search_caselaw",
      description:
        "Search EXTERNAL published court opinions (federal and state case law, via CourtListener) for " +
        "legal authority — controlling or persuasive precedent on a doctrine, standard, or test. This is " +
        "NOT part of this MDL's closed record; use it when the question turns on what the LAW is (e.g. the " +
        "Daubert/Rule 702 standard, pleading standards, choice-of-law, preemption) rather than on what this " +
        "matter's own orders say. Write `query` as a short plain doctrine phrase (3-10 words, no sentences, " +
        "citations, quotes, or special characters — complex syntax causes a server error upstream). Restrict " +
        "to the governing jurisdiction with `court` when known (e.g. the circuit that controls this MDL). " +
        "Returns citable opinions with full Bluebook citations and holding text. Do NOT use it for the " +
        "matter's own PTOs/CMOs/CBOs — use search_the_record / read_order for those.",
      parameters: CASELAW_TOOL_SCHEMA,
    },
  },
  {
    type: "function",
    function: {
      name: "search_legal_web",
      description:
        "Targeted OPEN-WEB research restricted to a fixed allowlist of reputable legal and regulatory " +
        "sources (Cornell LII, uscourts.gov, supremecourt.gov, govinfo.gov, the Federal Register, " +
        "regulations.gov, FDA, EMA, WHO, CourtListener, Justia, Oyez, the ABA, Reuters legal, JD Supra). " +
        "Use it ONLY for what neither the record nor case law can supply: the current text of a rule or " +
        "statute, a regulatory action or development beyond the record's coverage, or reputable secondary " +
        "analysis of a doctrine or of related litigation. For recent developments set topic 'news' and a " +
        "time_range. Results reach the writer marked as SECONDARY web sources — they never substitute for " +
        "the matter's record or for controlling precedent. Do NOT use it for this MDL's own orders, " +
        "deadlines, or roster.",
      parameters: WEB_TOOL_SCHEMA,
    },
  },
  {
    type: "function",
    function: {
      name: "read_order",
      description:
        "Pull the FULL text of a specific controlling order — all its passages in order — together with any " +
        "amendment versions (e.g. read_order PTO 22 returns PTO 22 AND its amendment PTO 22A, date-ordered). " +
        "BOTH order_type AND order_number are REQUIRED — identify them first (from a search hit's label, the " +
        "pre-retrieval results, or list_orders) and never call this tool without both. Use when the question " +
        "turns on the complete operative text of a named order, or to compare an order against its amendment " +
        "for temporal precedence. Returns citable passages, like search_the_record.",
      parameters: READ_ORDER_TOOL_SCHEMA,
    },
  },
  {
    type: "function",
    function: {
      name: "list_orders",
      description:
        "List the controlling orders on this matter's docket (PTOs, CMOs, CBOs, and the JPML transfer order), with " +
        "number, date, title, subject tags, and source PDF. Use for enumerations and surveys of orders, and to " +
        "identify the order_type/order_number that a read_order call requires. Returns the full matching list " +
        "(not a sample).",
      parameters: ORDERS_TOOL_SCHEMA,
    },
  },
  {
    type: "function",
    function: {
      name: "lookup_counsel",
      description:
        "Look up counsel of record for this matter (side, firm, attorney, and contact info). Use for roster questions " +
        "about who represents whom. Returns the full matching list.",
      parameters: COUNSEL_TOOL_SCHEMA,
    },
  },
  {
    type: "function",
    function: {
      name: "list_deadlines",
      description:
        "List this matter's key dates and deadlines (date, category, title, who it affects, and source order). Use for " +
        "calendar and deadline questions. Returns the full matching list.",
      parameters: DEADLINES_TOOL_SCHEMA,
    },
  },
];

const STRUCTURED_TOOLS = new Set(["list_orders", "lookup_counsel", "list_deadlines"]);

// ---------- helpers ----------

function splitSentences(text: string): string[] {
  const norm = (text ?? "").replace(/\s+/g, " ").trim();
  if (!norm) return [];
  const raw = norm.split(/(?<=[.?!])\s+(?=[A-Z("'“])/);
  const out: string[] = [];
  for (const piece of raw) {
    const t = piece.trim();
    if (!t) continue;
    if (out.length && t.length < 20) out[out.length - 1] += " " + t;
    else out.push(t);
  }
  return out.length ? out : [norm];
}

function orderLabel(c: any): string {
  if (c.order_type) return `${c.order_type}${c.order_number ? " " + c.order_number : ""}`;
  return c.doc_label || "Document";
}

function pageCite(c: any): string {
  if (c.page_start == null) return "";
  return c.page_start === c.page_end ? `p.${c.page_start}` : `p.${c.page_start}–${c.page_end}`;
}

function mergeFilters(initial: any, model: any): any {
  const m = (model && typeof model === "object") ? { ...model } : {};
  const i = (initial && typeof initial === "object") ? initial : {};
  return { ...m, ...i };
}

async function callRpc(fn: string, body: any): Promise<any[]> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`${fn} failed (${resp.status}): ${t.slice(0, 300)}`);
  }
  const rows = await resp.json();
  return Array.isArray(rows) ? rows : [];
}

function mapRow(r: any, extra: Record<string, unknown> = {}): { searchResult: any; chunk: any } {
  const sentences = splitSentences(r.content);
  const label = orderLabel(r);
  const page = pageCite(r);
  const title = `${label}${page ? " · " + page : ""}`;
  const source = r.pdf_url || `mdl:${r.id}`;
  const searchResult = {
    type: "search_result",
    source,
    title,
    content: sentences.map((s: string) => ({ type: "text", text: s })),
    citations: { enabled: true },
  };
  const chunk = {
    ref: r.id,
    order_label: label,
    doc_label: r.doc_label ?? null,
    order_type: r.order_type ?? null,
    order_number: r.order_number ?? null,
    order_date: r.order_date ?? null,
    page_start: r.page_start ?? null,
    page_end: r.page_end ?? null,
    section_label: r.section_label ?? null,
    affects: r.affects ?? null,
    has_deadline: !!r.has_deadline,
    tags: r.tags ?? null,
    pdf_url: r.pdf_url ?? null,
    score: r.score ?? null,
    vec_hit: !!r.vec_hit,
    lex_hit: !!r.lex_hit,
    sentences,
    ...extra,
  };
  return { searchResult, chunk };
}

function collectRows(rows: any[], seen: Set<string>, limit: number, extra: Record<string, unknown> = {}, perDocCap = Infinity) {
  const searchResults: any[] = [];
  const chunks: any[] = [];
  const ids: string[] = [];
  const perDoc = new Map<string, number>();
  for (const r of rows) {
    if (chunks.length >= limit) break;
    if (seen.has(r.id)) continue;
    if (seen.size >= MAX_TOTAL_CHUNKS) break;
    const docKey = (r.document_id ?? r.court_order_id ?? r.doc_label ?? "").toString();
    if (docKey && perDocCap !== Infinity) {
      const n = perDoc.get(docKey) ?? 0;
      if (n >= perDocCap) continue;
      perDoc.set(docKey, n + 1);
    }
    seen.add(r.id);
    const { searchResult, chunk } = mapRow(r, extra);
    searchResults.push(searchResult);
    chunks.push(chunk);
    ids.push(r.id);
  }
  return { searchResults, chunks, ids };
}

async function runSearch(
  input: any,
  embedFor: (text: string) => Promise<string>,
  question: string,
  displayFilter: any,
  caseId: string,
  seen: Set<string>,
): Promise<{ searchResults: any[]; chunks: any[]; rawCount: number; hitIds: string[] }> {
  const keywords = (input?.keywords && String(input.keywords).trim()) || question;
  const semanticText = (input?.semantic_query && String(input.semantic_query).trim()) || question;
  const embedding = await embedFor(semanticText);
  const filter = { ...mergeFilters(displayFilter, input?.filter), case_id: caseId };
  let k = Number.isFinite(input?.k) ? Math.floor(input.k) : PER_SEARCH_K;
  k = Math.max(1, Math.min(PER_SEARCH_K, k));

  const fetchK = Math.max(k, Math.min(50, k + seen.size));

  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/hybrid_search_v2`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ q: keywords, query_embedding: embedding, filter, k: fetchK, min_sim: MIN_SIM }),
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`hybrid_search_v2 failed (${resp.status}): ${body.slice(0, 300)}`);
  }
  const rows: any[] = await resp.json();
  const { searchResults, chunks, ids } = collectRows(rows, seen, k, {}, PER_DOC_CAP);
  return { searchResults, chunks, rawCount: rows.length, hitIds: ids };
}

async function expandNeighbors(
  caseId: string,
  centerIds: string[],
  seen: Set<string>,
): Promise<{ searchResults: any[]; chunks: any[] }> {
  if (!centerIds.length || seen.size >= MAX_TOTAL_CHUNKS) return { searchResults: [], chunks: [] };
  const perCenter = await Promise.all(centerIds.map((cid) =>
    callRpc("expand_neighbors", { p_case_id: caseId, p_chunk_ids: [cid], p_window: NEIGHBOR_WINDOW })
      .then((rows) => ({ cid, rows }))
      .catch(() => ({ cid, rows: [] as any[] }))
  ));
  const searchResults: any[] = [];
  const chunks: any[] = [];
  for (const { cid, rows } of perCenter) {
    const got = collectRows(rows, seen, MAX_TOTAL_CHUNKS, { neighbor: true, parent_ref: cid });
    searchResults.push(...got.searchResults);
    chunks.push(...got.chunks);
  }
  return { searchResults, chunks };
}

async function runReadOrder(
  input: any,
  caseId: string,
  seen: Set<string>,
): Promise<{ searchResults: any[]; chunks: any[]; count: number; versions: string[] }> {
  const a = (input && typeof input === "object") ? input : {};
  const orderType = a.order_type ? String(a.order_type).toUpperCase() : null;
  const stem = (a.order_number != null && String(a.order_number).trim()) ? String(a.order_number).trim() : null;
  if (!orderType && !stem) {
    throw new Error(
      "read_order requires both order_type (PTO/CMO/CBO/JPML/OTHER) and order_number (e.g. '22'). " +
      "Identify the specific order first — from a search hit's label or via list_orders — then call read_order with both fields.",
    );
  }
  const rows = await callRpc("order_chunks", {
    p_case_id: caseId,
    p_order_type: orderType,
    p_number_stem: stem,
    p_limit: READ_ORDER_LIMIT,
  });
  const { searchResults, chunks } = collectRows(rows, seen, READ_ORDER_LIMIT, { full_order: true });
  const versions = [...new Set(
    rows.map((r: any) => `${r.order_type ?? ""}${r.order_number ? " " + r.order_number : ""}`.trim()).filter(Boolean),
  )];
  return { searchResults, chunks, count: chunks.length, versions };
}

// ---------- CourtListener case-law retrieval ----------

async function clFetch(path: string, params: Record<string, string | undefined>): Promise<any> {
  const url = new URL(`${CL_BASE}${path}`);
  for (const [k, v] of Object.entries(params)) {
    if (v != null && String(v).trim() !== "") url.searchParams.set(k, String(v));
  }
  const headers: Record<string, string> = { "Accept": "application/json" };
  if (COURTLISTENER_API_KEY) headers["Authorization"] = `Token ${COURTLISTENER_API_KEY}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CL_TIMEOUT_MS);
  try {
    const resp = await fetch(url.toString(), { headers, signal: ctrl.signal });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`CourtListener ${resp.status}: ${t.slice(0, 200)}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// v32: CourtListener's Solr backend 500s on sentence-length queries carrying quotes,
// field syntax, or special characters (observed live). Sanitize before sending: normalize
// smart quotes, drop unbalanced quoting, strip Solr operators, collapse whitespace, cap.
function sanitizeClQuery(q: string): string {
  let s = (q ?? "").replace(/[“”]/g, '"').replace(/[‘’]/g, "'");
  const quoteCount = (s.match(/"/g) ?? []).length;
  if (quoteCount % 2 !== 0) s = s.replace(/"/g, " ");
  s = s.replace(/[:{}\[\]^~\\\/!*?()<>|&+=%#@$§;,]/g, " ");
  return s.replace(/\s+/g, " ").trim().slice(0, 256);
}

function tidyCaseName(name: string): string {
  const raw = (name ?? "").replace(/\s+/g, " ").trim();
  if (!raw) return "Opinion";
  const isShouty = raw === raw.toUpperCase() && /[A-Z]/.test(raw);
  if (!isShouty) return raw;
  const small = new Set(["v.", "of", "the", "and", "for", "in", "on", "a", "an", "&"]);
  return raw
    .toLowerCase()
    .split(" ")
    .map((w, i) => {
      if (i > 0 && small.has(w)) return w;
      if (w === "v.") return "v.";
      return w.charAt(0).toUpperCase() + w.slice(1);
    })
    .join(" ");
}

const REPORTER_RE = /\b(U\.?\s?S\.?|S\.?\s?Ct\.?|L\.?\s?Ed\.?|F\.?\s?(?:2d|3d|4th)?|F\.?\s?Supp\.?|So\.?|N\.?[EW]\.?|S\.?[EW]\.?|P\.?|A\.?|Cal\.?|Fed\.?\s?Appx\.?)\b/;

function pickReporterCite(citations: any): string | null {
  if (!Array.isArray(citations) || !citations.length) return null;
  const strs = citations.map((c) => String(c).trim()).filter(Boolean);
  const reporter = strs.find((c) => REPORTER_RE.test(c) && !/\bWL\b|\bLEXIS\b/i.test(c));
  return reporter ?? strs[0] ?? null;
}

function caseYear(dateFiled: string | null | undefined): string | null {
  const m = /^(\d{4})/.exec(String(dateFiled ?? ""));
  return m ? m[1] : null;
}

function fullCaseCitation(r: any): string {
  const name = tidyCaseName(r.caseName || r.caseNameFull || "Opinion");
  const rep = pickReporterCite(r.citation);
  const courtStr = (r.court_citation_string || "").toString().trim();
  const yr = caseYear(r.dateFiled);
  const paren = [courtStr, yr].filter(Boolean).join(" ");
  let out = name;
  if (rep) out += `, ${rep}`;
  if (paren) out += ` (${paren})`;
  return out;
}

function shortCaseLabel(r: any): string {
  const name = tidyCaseName(r.caseName || r.caseNameFull || "Opinion");
  const firstParty = name.split(/\s+v\.?\s+/i)[0]?.trim() || name;
  const rep = pickReporterCite(r.citation);
  const yr = caseYear(r.dateFiled);
  const courtStr = (r.court_citation_string || "").toString().trim();
  const paren = [courtStr, yr].filter(Boolean).join(" ");
  let out = firstParty;
  if (rep) out += `, ${rep}`;
  if (paren) out += ` (${paren})`;
  return out;
}

async function fetchOpinionExcerpt(opinionId: number): Promise<string> {
  try {
    const data = await clFetch(`/opinions/${opinionId}/`, {});
    let text: string = data?.plain_text || "";
    if (!text && data?.html_with_citations) {
      text = String(data.html_with_citations).replace(/<[^>]+>/g, " ");
    }
    text = text.replace(/\s+/g, " ").trim();
    return text.slice(0, CASELAW_EXCERPT_CHARS);
  } catch {
    return "";
  }
}

async function runCaselawSearch(
  input: any,
  question: string,
  seen: Set<string>,
): Promise<{ searchResults: any[]; chunks: any[]; count: number; total: number; unavailable?: string }> {
  if (!COURTLISTENER_API_KEY) {
    return { searchResults: [], chunks: [], count: 0, total: 0, unavailable: "COURTLISTENER_API_KEY not configured" };
  }
  const a = (input && typeof input === "object") ? input : {};
  const rawQ = (a.query && String(a.query).trim()) || (a.keywords && String(a.keywords).trim()) || question;
  const q = sanitizeClQuery(rawQ) || rawQ.slice(0, 200);
  const params: Record<string, string | undefined> = {
    type: "o",
    q,
    order_by: a.most_cited ? "citeCount desc" : "score desc",
    court: a.court ? String(a.court).toLowerCase() : undefined,
    filed_after: a.filed_after ? String(a.filed_after) : undefined,
    filed_before: a.filed_before ? String(a.filed_before) : undefined,
    stat_Published: "on",
  };
  // v32: one retry on a CourtListener 5xx with a fully simplified alphanumeric query —
  // the dominant live failure was Solr rejecting router-built query syntax.
  let data: any;
  try {
    data = await clFetch("/search/", params);
  } catch (e) {
    const msg = (e as Error).message;
    const simple = q.replace(/[^a-zA-Z0-9\s]/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
    if (/CourtListener 5\d\d/.test(msg) && simple && simple !== q) {
      params.q = simple;
      data = await clFetch("/search/", params);
    } else {
      throw e;
    }
  }
  const total = Number.isFinite(data?.count) ? data.count : 0;
  const raw: any[] = Array.isArray(data?.results) ? data.results.slice(0, CASELAW_MAX_RESULTS) : [];

  const topIds = raw.slice(0, CASELAW_FULLTEXT_TOP_N)
    .map((r) => r?.opinions?.[0]?.id)
    .filter((id) => Number.isInteger(id)) as number[];
  const excerptMap = new Map<number, string>();
  await Promise.all(topIds.map(async (id) => { excerptMap.set(id, await fetchOpinionExcerpt(id)); }));

  const searchResults: any[] = [];
  const chunks: any[] = [];
  let count = 0;
  for (const r of raw) {
    const opId = r?.opinions?.[0]?.id;
    const ref = `cl:op:${opId ?? r.cluster_id ?? Math.abs(hashStr(JSON.stringify(r)))}`;
    if (seen.has(ref)) continue;
    if (seen.size >= MAX_TOTAL_CHUNKS) break;
    seen.add(ref);

    const fullCite = fullCaseCitation(r);
    const shortLabel = shortCaseLabel(r);
    const url = r.absolute_url ? `${CL_WEB}${r.absolute_url}` : CL_WEB;
    const courtStr = (r.court_citation_string || r.court || "").toString().trim();
    const status = (r.status || "").toString().trim();
    const citeCount = Number.isFinite(r.citeCount) ? r.citeCount : null;

    const header =
      `${fullCite}.` +
      (courtStr ? ` Court: ${courtStr}.` : "") +
      (r.dateFiled ? ` Decided ${r.dateFiled}.` : "") +
      (status ? ` ${status} opinion.` : "") +
      (citeCount != null ? ` Subsequently cited by ${citeCount} decision(s).` : "");

    const excerpt = (opId != null && excerptMap.get(opId)) || "";
    const snippet = String(r?.opinions?.[0]?.snippet || "").replace(/\s+/g, " ").trim();
    const bodyText = excerpt || snippet || "";
    const bodySentences = bodyText ? splitSentences(bodyText) : [];
    const sentences = [header, ...bodySentences];

    searchResults.push({
      type: "search_result",
      source: url,
      title: fullCite,
      content: sentences.map((s) => ({ type: "text", text: s })),
      citations: { enabled: true },
    });
    chunks.push({
      ref,
      kind: "caselaw",
      order_label: shortLabel,
      case_name: tidyCaseName(r.caseName || r.caseNameFull || "Opinion"),
      full_citation: fullCite,
      reporter_cite: pickReporterCite(r.citation),
      court: courtStr || null,
      case_date: r.dateFiled ?? null,
      cite_count: citeCount,
      status: status || null,
      docket_number: r.docketNumber ?? null,
      page_start: null,
      page_end: null,
      pdf_url: url,
      excerpted: !!excerpt,
      sentences,
    });
    count++;
  }
  return { searchResults, chunks, count, total };
}

// ---------- Tavily web research (v30; upgraded v32) ----------
async function runWebSearch(
  input: any,
  question: string,
  seen: Set<string>,
): Promise<{ searchResults: any[]; chunks: any[]; count: number; unavailable?: string }> {
  if (!TAVILY_API_KEY) {
    return { searchResults: [], chunks: [], count: 0, unavailable: "TAVILY_API_KEY not configured" };
  }
  const a = (input && typeof input === "object") ? input : {};
  const q = (a.query && String(a.query).trim()) || question;
  const requested = Array.isArray(a.include_domains)
    ? a.include_domains.map((d: any) => String(d).toLowerCase().trim()).filter(Boolean)
    : [];
  const narrowed = requested.length ? WEB_ALLOWED_DOMAINS.filter((d) => requested.includes(d)) : [];
  const domains = narrowed.length ? narrowed : WEB_ALLOWED_DOMAINS;
  const timeRange = (a.time_range && WEB_TIME_RANGES.has(String(a.time_range))) ? String(a.time_range) : null;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TAVILY_TIMEOUT_MS);
  let data: any;
  try {
    const body: Record<string, unknown> = {
      query: q.slice(0, 380),
      topic: a.topic === "news" ? "news" : "general",
      search_depth: "advanced",
      chunks_per_source: 3, // v32: with advanced depth, return up to 3 relevant chunks per source
      max_results: TAVILY_MAX_RESULTS,
      include_domains: domains,
      include_answer: false,
      include_raw_content: false,
      include_images: false,
    };
    if (timeRange) body.time_range = timeRange;
    const resp = await fetch(TAVILY_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Authorization": `Bearer ${TAVILY_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`Tavily ${resp.status}: ${t.slice(0, 200)}`);
    }
    data = await resp.json();
  } finally {
    clearTimeout(timer);
  }

  const raw: any[] = Array.isArray(data?.results) ? data.results : [];
  const searchResults: any[] = [];
  const chunks: any[] = [];
  let count = 0;
  for (const r of raw) {
    const url = (r?.url ?? "").toString().trim();
    if (!url) continue;
    // v32: drop results Tavily itself scores as weakly relevant.
    if (Number.isFinite(r?.score) && r.score < TAVILY_MIN_SCORE) continue;
    let host = "";
    try { host = new URL(url).hostname.replace(/^www\./, "").toLowerCase(); } catch { host = ""; }
    if (!host || !WEB_ALLOWED_DOMAINS.some((d) => host === d || host.endsWith(`.${d}`))) continue;
    const ref = `web:${Math.abs(hashStr(url))}`;
    if (seen.has(ref)) continue;
    if (seen.size >= MAX_TOTAL_CHUNKS) break;
    seen.add(ref);

    const title = (r?.title ?? "").toString().replace(/\s+/g, " ").trim() || url;
    const body = (r?.content ?? "").toString().replace(/\s+/g, " ").trim().slice(0, WEB_EXCERPT_CHARS);
    const published = r?.published_date ? String(r.published_date).slice(0, 10) : null;
    const header =
      `${title}. Source: ${host}` +
      (published ? `, published ${published}` : "") +
      `. (Secondary web source — not part of this matter's record.)`;
    const sentences = [header, ...(body ? splitSentences(body) : [])];

    searchResults.push({
      type: "search_result",
      source: url,
      title: `${title} — ${host}`,
      content: sentences.map((s) => ({ type: "text", text: s })),
      citations: { enabled: true },
    });
    chunks.push({
      ref,
      kind: "web",
      order_label: host,
      web_title: title,
      url,
      domain: host,
      published,
      relevance: Number.isFinite(r?.score) ? r.score : null,
      page_start: null,
      page_end: null,
      pdf_url: url,
      sentences,
    });
    count++;
  }
  return { searchResults, chunks, count };
}

function hashStr(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) { h = (h << 5) - h + s.charCodeAt(i); h |= 0; }
  return h;
}

// ---------- structured-tool formatting ----------

function fmtOrderLine(o: any): string {
  const label = `${o.order_type ?? "Order"}${o.order_number ? " " + o.order_number : ""}`;
  const date = o.order_date ? ` (${o.order_date})` : "";
  const title = o.canonical_title ? ` ${String(o.canonical_title).trim()}` : "";
  const tags = (Array.isArray(o.tags) && o.tags.length) ? ` [${o.tags.join(", ")}]` : "";
  const summary = o.summary ? ` — ${String(o.summary).replace(/\s+/g, " ").trim()}` : "";
  const url = o.pdf_url ? ` <${o.pdf_url}>` : "";
  return `- ${label}${date}:${title}${tags}${summary}${url}`;
}

function fmtCounselLine(c: any): string {
  const side = c.side ? `[${c.side}] ` : "";
  const who = [c.attorney_name, c.firm_name].filter(Boolean).join(", ");
  const represents = c.represents ? ` — represents ${c.represents}` : "";
  const contact = [c.email, c.phone].filter(Boolean).join(" / ");
  const contactStr = contact ? ` — ${contact}` : "";
  return `- ${side}${who || "(unnamed)"}${represents}${contactStr}`;
}

function fmtDeadlineLine(d: any): string {
  const cat = d.category ? ` [${d.category}]` : "";
  const title = d.title ? ` ${String(d.title).replace(/\s+/g, " ").trim()}` : "";
  const range = d.end_date && d.end_date !== d.event_date ? ` → ${d.end_date}` : "";
  const time = d.event_time ? ` ${d.event_time}` : "";
  const affects = d.affects ? ` (affects: ${d.affects})` : "";
  const src = d.source_order_type
    ? ` — source: ${d.source_order_type}${d.source_order_number ? " " + d.source_order_number : ""}`
    : "";
  const cite = d.citation ? ` — ${String(d.citation).replace(/\s+/g, " ").trim()}` : "";
  const conflict = d.is_conflicted ? " — NOTE: this date is flagged as conflicted in the record" : "";
  return `- ${d.event_date}${range}${time}${cat}${title}${affects}${src}${cite}${conflict}`;
}

async function runStructuredTool(
  name: string,
  args: any,
  caseId: string,
): Promise<{ routerText: string; writerText: string; count: number }> {
  const a = (args && typeof args === "object") ? args : {};
  const limit = Number.isFinite(a.limit) ? Math.floor(a.limit) : undefined;

  if (name === "list_orders") {
    const rows = await callRpc("orders_for_case", {
      p_case_id: caseId,
      p_order_types: Array.isArray(a.order_types) && a.order_types.length ? a.order_types : null,
      p_tags: Array.isArray(a.tags) && a.tags.length ? a.tags : null,
      p_date_from: a.date_from || null,
      p_date_to: a.date_to || null,
      p_limit: limit ?? 200,
    });
    const lines = rows.map(fmtOrderLine);
    const writerText = `CONTROLLING ORDERS ON THE DOCKET (${rows.length}) — this list is complete for the requested scope; cite each by its order number and date:\n${lines.join("\n")}`;
    const routerLines = rows
      .slice(0, 25)
      .map((o) => `- ${o.order_type ?? "Order"}${o.order_number ? " " + o.order_number : ""}${o.order_date ? " (" + o.order_date + ")" : ""}`);
    const routerText = `list_orders returned ${rows.length} order(s):\n${routerLines.join("\n")}${rows.length > 25 ? "\n…(more)" : ""}`;
    return { routerText, writerText, count: rows.length };
  }

  if (name === "lookup_counsel") {
    const rows = await callRpc("counsel_for_case", {
      p_case_id: caseId,
      p_side: a.side || null,
      p_limit: limit ?? 300,
    });
    const lines = rows.map(fmtCounselLine);
    const writerText = `COUNSEL OF RECORD (${rows.length}) — this list is compiled from the docket; identify counsel by name, firm, and side:\n${lines.join("\n")}`;
    const routerText = `lookup_counsel returned ${rows.length} counsel record(s).`;
    return { routerText, writerText, count: rows.length };
  }

  if (name === "list_deadlines") {
    const rows = await callRpc("deadlines_for_case", {
      p_case_id: caseId,
      p_from: a.date_from || null,
      p_to: a.date_to || null,
      p_limit: limit ?? 200,
    });
    const lines = rows.map(fmtDeadlineLine);
    const writerText = `KEY DATES / DEADLINES (${rows.length}) — compiled from the docket; anchor each to its source order and note any flagged conflict:\n${lines.join("\n")}`;
    const routerLines = rows.slice(0, 25).map(fmtDeadlineLine);
    const routerText = `list_deadlines returned ${rows.length} date(s):\n${routerLines.join("\n")}${rows.length > 25 ? "\n…(more)" : ""}`;
    return { routerText, writerText, count: rows.length };
  }

  throw new Error(`Unknown structured tool: ${name}`);
}

// ---------- Router turn (OpenAI-compatible streaming; provider-parameterized) ----------
async function routerRound(
  messages: any[],
  round: number,
  emit: (o: any) => void,
): Promise<{ rationale: string; toolCalls: { id: string; name: string; args: any; rawArgs: string }[]; finish: string | null }> {
  const res = await fetch(ROUTER_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${ROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: ROUTER_MODEL,
      messages,
      tools: GEMINI_TOOLS,
      tool_choice: "auto",
      temperature: 0,
      max_tokens: 2048,
      stream: true,
    }),
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    const ra = res.headers.get("retry-after");
    const raMs = ra && Number.isFinite(Number(ra)) ? Number(ra) * 1000 : null;
    throw new ApiError(`Router ${res.status}: ${t.slice(0, 400)}`, res.status, raMs);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let rationale = "";
  let finish: string | null = null;
  const tc: Record<number, { id?: string; name?: string; args: string }> = {};

  const handle = (ev: any) => {
    const ch = ev.choices?.[0];
    if (!ch) return;
    const d = ch.delta || {};
    if (typeof d.content === "string" && d.content) {
      rationale += d.content;
      emit({ type: "thinking", round, text: d.content });
    }
    if (Array.isArray(d.tool_calls)) {
      for (const t of d.tool_calls) {
        const idx = typeof t.index === "number" ? t.index : 0;
        const cur = tc[idx] || (tc[idx] = { args: "" });
        if (t.id) cur.id = t.id;
        if (t.function?.name) cur.name = t.function.name;
        if (typeof t.function?.arguments === "string") cur.args += t.function.arguments;
      }
    }
    if (ch.finish_reason) finish = ch.finish_reason;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const payload = line.slice(5).trim();
      if (!payload || payload === "[DONE]") continue;
      let ev: any;
      try { ev = JSON.parse(payload); } catch { continue; }
      handle(ev);
    }
  }

  const toolCalls = Object.keys(tc)
    .map((k) => parseInt(k, 10))
    .sort((a, b) => a - b)
    .map((k, i) => {
      const c = tc[k];
      // v32: salvage-parse streamed tool-call args — a malformed raw string previously
      // collapsed silently to {} and produced read_order calls with no arguments.
      let args: any = {};
      if (c.args) {
        try { args = JSON.parse(c.args); } catch {
          const m = c.args.match(/\{[\s\S]*\}/);
          if (m) { try { args = JSON.parse(m[0]); } catch { args = {}; } }
        }
      }
      return { id: c.id || `call_${round}_${i}`, name: c.name || "search_the_record", args, rawArgs: c.args || "{}" };
    });

  return { rationale, toolCalls, finish };
}

function compactResults(chunks: any[], totalSeen: number, round: number): string {
  const meta = `(gathered ${totalSeen}/${MAX_TOTAL_CHUNKS} passages; round ${round}/${Math.max(MAX_ROUNDS, round)})`;
  if (!chunks.length) return `No NEW passages — this query duplicated passages already gathered, or the filter is too narrow. Do not repeat it; change the keywords or relax/remove a filter. ${meta}`;
  const lines = chunks.map((c) => {
    const page = c.page_start != null ? ` p.${c.page_start}` : "";
    const sec = c.section_label ? ` ${c.section_label}` : "";
    const snip = (Array.isArray(c.sentences) ? c.sentences.join(" ") : "").slice(0, 240);
    return `- [${c.order_label}${page}]${sec}: ${snip}`;
  });
  return `Found ${chunks.length} new passage(s):\n${lines.join("\n")}\n${meta}`;
}

// ============================================================================
// v32: multi-agent helpers — generic JSON caller, Planner, Critic, Verifier, Rerank
// ============================================================================

// Strip <think>...</think> reasoning blocks that some reasoning models prepend to their
// content before the requested JSON (Fireworks usually separates reasoning into
// message.reasoning_content, but tag-in-content variants exist).
function stripThink(text: string): string {
  return (text ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
}

// Generic non-streaming OpenAI-compatible JSON call. Sends response_format json_object
// and (for Fireworks reasoning models) reasoning_effort; if the provider rejects the
// request with a 400, retries once with both stripped and relies on prompt discipline +
// salvage parsing. Reads message.content, falling back to message.reasoning_content when
// content arrives empty.
async function openAiJson(
  url: string,
  apiKey: string,
  model: string,
  system: string,
  user: string,
  maxTokens: number,
  timeoutMs: number,
  effort: string | null = null,
): Promise<any> {
  const attempt = async (withExtras: boolean): Promise<any> => {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const body: Record<string, unknown> = {
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        temperature: 0,
        max_tokens: maxTokens,
      };
      if (withExtras) {
        body.response_format = { type: "json_object" };
        if (effort) body.reasoning_effort = effort;
      }
      const res = await fetch(url, {
        method: "POST",
        signal: ctrl.signal,
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const t = await res.text().catch(() => "");
        throw new ApiError(`${model} ${res.status}: ${t.slice(0, 300)}`, res.status, null);
      }
      const data = await res.json();
      const msg = data?.choices?.[0]?.message ?? {};
      let content = stripThink(String(msg?.content ?? ""));
      if (!content && msg?.reasoning_content) content = stripThink(String(msg.reasoning_content));
      try { return JSON.parse(content); } catch {
        const m = content.match(/\{[\s\S]*\}/);
        if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
        throw new Error(`${model} returned non-JSON output (finish: ${data?.choices?.[0]?.finish_reason ?? "?"}, content: ${content.slice(0, 120)})`);
      }
    } finally {
      clearTimeout(timer);
    }
  };
  try {
    return await attempt(true);
  } catch (e) {
    if (e instanceof ApiError && e.status === 400) return await attempt(false);
    throw e;
  }
}

// ---------- PLANNER ----------
type Facet = {
  id: string;
  question: string;
  hypothesis: string;      // HyDE passage — embedded verbatim as the facet search's semantic anchor
  specialists: string[];   // subset of the seven tools
  keywords?: string[];
  court?: string;
};

type PlanResult = { facets: Facet[]; rationale: string; ok: boolean; error?: string };

async function runPlanner(question: string, matter: Matter): Promise<PlanResult> {
  const fallback: PlanResult = {
    facets: [{ id: "default", question, hypothesis: "", specialists: ["search_the_record"] }],
    rationale: "",
    ok: false,
  };
  const provider = providerFor(PLANNER_MODEL);
  if (!provider.key) return { ...fallback, error: `planner provider key not configured for ${PLANNER_MODEL}` };
  const system = `You are the PLANNER for a multi-agent litigation research assistant working the ${matter.name} record (MDL No. ${matter.mdl_number}, before ${matter.judge}).

Decompose the attorney's question into 1-4 independent research FACETS. For each facet, produce:
  - id: short slug (e.g. "record_daubert_schedule", "ca11_daubert_precedent", "fda_label_update")
  - question: the focused sub-question this facet answers
  - hypothesis: a 1-3 sentence HYPOTHETICAL answer (HyDE) — the kind of passage that would answer this facet if it existed in the record, written in the register of a litigation memo. It is embedded VERBATIM as that facet's semantic-search anchor, so make it substantive and specific (name the instruments, obligations, percentages, deadlines, or doctrines the passage would contain).
  - specialists: which retrieval tools apply. Available: search_the_record (matter passages, incl. the scientific/regulatory background), read_order (full text of a named order — needs a specific order_type and order_number), list_orders / list_deadlines / lookup_counsel (structured docket index), search_caselaw (external published opinions via CourtListener), search_legal_web (open web restricted to reputable legal/regulatory domains: Cornell LII, uscourts.gov, supremecourt.gov, govinfo.gov, Federal Register, regulations.gov, FDA, EMA, WHO, CourtListener, Justia, Oyez, ABA, Reuters legal, JD Supra).
  - keywords (optional): 1-5 exact terms/phrases to pin (e.g. ["PTO 22", "Daubert"]). For search_caselaw or search_legal_web facets, keep phrasing short and plain — no sentences, citations, quotes, or special characters.
  - court (optional): jurisdiction code for search_caselaw facets, if applicable ("ca11", "flnd", "scotus")

Rules:
  * Prefer the record + case law for anything that turns on an order or a legal standard.
  * Reach for search_legal_web ONLY for the current text of a rule or statute, a regulatory action beyond the record's coverage, or reputable secondary analysis. Never for the matter's own orders.
  * For a simple single-issue question, emit ONE facet — do not over-decompose.
  * Independent facets are executed in PARALLEL.
  * Never invent case names, statute cites, or PTO numbers.

Return ONLY JSON of the shape: { "rationale": "1-2 sentences on the decomposition", "facets": [ ... ] }`;
  try {
    const out = await openAiJson(provider.url, provider.key, PLANNER_MODEL, system, question, PLANNER_MAX_TOKENS, PLANNER_TIMEOUT_MS, provider.effort);
    const facets = Array.isArray(out?.facets) ? out.facets : [];
    const normalized: Facet[] = facets.slice(0, 4).map((f: any, i: number) => ({
      id: String(f?.id ?? `facet_${i + 1}`).slice(0, 64),
      question: String(f?.question ?? question).trim(),
      hypothesis: String(f?.hypothesis ?? "").trim(),
      specialists: Array.isArray(f?.specialists) && f.specialists.length ? f.specialists.map((s: any) => String(s)) : ["search_the_record"],
      keywords: Array.isArray(f?.keywords) ? f.keywords.map((k: any) => String(k)).filter(Boolean).slice(0, 5) : undefined,
      court: f?.court ? String(f.court) : undefined,
    }));
    if (!normalized.length) return { ...fallback, error: "planner returned no facets" };
    return { facets: normalized, rationale: String(out?.rationale ?? "").trim(), ok: true };
  } catch (e) {
    return { ...fallback, error: (e as Error).message.slice(0, 300) };
  }
}

// ---------- CRITIC ----------
type CriticResult = { done: boolean; missing: string[]; followup: string; ok: boolean; error?: string };

async function runCritic(
  question: string,
  facets: Facet[],
  gatheredSummary: string,
): Promise<CriticResult> {
  const provider = providerFor(CRITIC_MODEL);
  if (!provider.key) return { done: true, missing: [], followup: "", ok: false, error: `critic provider key not configured for ${CRITIC_MODEL}` };
  const system = `You are the CRITIC in a multi-agent litigation research pipeline. Given the attorney's question, the PLANNER's facets, and a summary of what has been gathered so far (passages plus any structured docket-index blocks), decide whether retrieval is complete.

Return ONLY JSON: { "done": boolean, "missing": [facet_ids...], "followup": "one short paragraph telling the router what specific gap(s) to fill, or empty string if done" }

Be strict about coverage but tolerate reasonable substitution (a related order that answers the question is fine). If done, set done=true, missing=[], followup="". If not done, name the specific gap in one paragraph — an order to read in full (with its order_type and order_number), a deadline missing from the index, a case-law precedent the answer needs, or a rule/regulatory source to look up on the allowed web domains.`;
  const user = `Question: ${question}\n\nPlanner facets:\n${facets.map((f) => `- ${f.id}: ${f.question} [specialists: ${f.specialists.join(", ")}]`).join("\n")}\n\nGathered so far:\n${gatheredSummary || "(nothing)"}`;
  try {
    const out = await openAiJson(provider.url, provider.key, CRITIC_MODEL, system, user, CRITIC_MAX_TOKENS, CRITIC_TIMEOUT_MS, provider.effort);
    return {
      done: !!out?.done,
      missing: Array.isArray(out?.missing) ? out.missing.map((s: any) => String(s)) : [],
      followup: String(out?.followup ?? "").trim(),
      ok: true,
    };
  } catch (e) {
    return { done: true, missing: [], followup: "", ok: false, error: (e as Error).message.slice(0, 300) };
  }
}

// ---------- VERIFIER ----------
// Post-writer citation-grounding pass, fed the answer AND the text of the passages the
// writer actually cited — claim-vs-passage entailment, not citation-presence counting.
// Primary: Fireworks DeepSeek V4 Pro pinned to reasoning_effort low (unbounded reasoning
// blew the timeout in v31). Fallback: GLM-5.2 Fast. Advisory only: the streamed answer is
// never rewritten; findings surface as a `verify` SSE frame. Failures carry error strings.
type VerifyResult =
  | { ok: true; unsupported: string[]; notes: string; model: string }
  | { ok: false; errors: string[] };

async function runVerifier(
  question: string,
  answer: string,
  evidence: string,
): Promise<VerifyResult> {
  if (!answer.trim()) return { ok: false, errors: ["empty answer"] };
  const errors: string[] = [];
  const system = `You are the VERIFIER in a multi-agent litigation research pipeline. You are given the attorney's question, the WRITER's final answer (which streamed with inline citations to source passages), and the TEXT of the source passages the writer cited.

Check each factual sentence of the answer against the cited passages: a sentence is UNSUPPORTED if no provided passage supports it, or if it clearly overreaches beyond what the cited passages state (e.g. converting a scheduled hearing into a ruling, adding a date or figure the passages do not contain, or asserting an amendment relationship the passages do not establish). Be strict but not pedantic — a topic sentence that summarizes a paragraph does not need its own support if the following sentences are supported, and faithful paraphrase is fine.

Return ONLY JSON: { "unsupported": ["short verbatim quote of each unsupported sentence, max 5"], "notes": "one short paragraph summarizing grounding quality, empty if fully grounded" }`;
  const user = `Question: ${question}\n\nWriter answer (as streamed; inline citation markers may appear as superscripts or brackets):\n${answer.slice(0, 30000)}\n\nCITED SOURCE PASSAGES:\n${evidence.slice(0, VERIFY_EVIDENCE_TOTAL) || "(none — the answer carried no citations)"}`;

  const primary = providerFor(VERIFIER_MODEL);
  if (primary.key) {
    try {
      const out = await openAiJson(primary.url, primary.key, VERIFIER_MODEL, system, user, VERIFIER_MAX_TOKENS, VERIFIER_TIMEOUT_MS, primary.effort);
      return {
        ok: true,
        unsupported: Array.isArray(out?.unsupported) ? out.unsupported.slice(0, 5).map((s: any) => String(s)) : [],
        notes: String(out?.notes ?? "").trim(),
        model: VERIFIER_MODEL,
      };
    } catch (e) {
      errors.push(`${VERIFIER_MODEL}: ${(e as Error).message.slice(0, 300)}`);
    }
  } else {
    errors.push(`${VERIFIER_MODEL}: provider key not configured`);
  }

  const fb = providerFor(VERIFIER_FALLBACK_MODEL);
  if (fb.key) {
    try {
      const out = await openAiJson(fb.url, fb.key, VERIFIER_FALLBACK_MODEL, system, user, VERIFIER_FALLBACK_MAX_TOKENS, VERIFIER_FALLBACK_TIMEOUT_MS, fb.effort);
      return {
        ok: true,
        unsupported: Array.isArray(out?.unsupported) ? out.unsupported.slice(0, 5).map((s: any) => String(s)) : [],
        notes: String(out?.notes ?? "").trim(),
        model: VERIFIER_FALLBACK_MODEL,
      };
    } catch (e) {
      errors.push(`${VERIFIER_FALLBACK_MODEL}: ${(e as Error).message.slice(0, 300)}`);
    }
  } else {
    errors.push(`${VERIFIER_FALLBACK_MODEL}: provider key not configured`);
  }

  return { ok: false, errors };
}

// ---------- Voyage rerank-2 ----------
async function voyageRerank(
  question: string,
  items: { text: string; idx: number }[],
): Promise<{ idx: number; score: number }[]> {
  if (!VOYAGE_API_KEY || !items.length) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RERANK_TIMEOUT_MS);
  try {
    const resp = await fetch(RERANK_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Authorization": `Bearer ${VOYAGE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: question.slice(0, 2000),
        documents: items.map((it) => it.text),
        model: RERANK_MODEL,
        top_k: items.length,
      }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`Voyage rerank ${resp.status}: ${t.slice(0, 200)}`);
    }
    const data = await resp.json();
    const results: any[] = Array.isArray(data?.data) ? data.data : [];
    return results
      .filter((r) => Number.isInteger(r?.index) && items[r.index])
      .map((r) => ({ idx: items[r.index].idx, score: Number.isFinite(r.relevance_score) ? r.relevance_score : 0 }));
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

// Rerank the gathered record passages against the question, drop the weakest beyond
// MAX_WRITER_CHUNKS, and reorder evidence best-first for the writer. PROTECTED (never
// dropped): caselaw, web, and full_order passages — the first two carry their sources'
// own relevance ranking, and full-order passages were explicitly requested for their
// contiguous operative text. Final order handed to the writer: full-order passages
// (original document order) -> scored record passages (best first) -> caselaw -> web.
// The UI is unaffected: chunks were already streamed, and citations resolve by ref.
async function rerankAndTrim(
  question: string,
  emittedResults: any[],
  allSearchResults: any[],
): Promise<{ chunks: any[]; results: any[]; ran: boolean; kept: number; dropped: number }> {
  const total = emittedResults.length;
  const unchanged = { chunks: emittedResults, results: allSearchResults, ran: false, kept: total, dropped: 0 };
  if (total <= RERANK_MIN_ITEMS || !VOYAGE_API_KEY) return unchanged;

  const fullOrderIdx: number[] = [];
  const caselawIdx: number[] = [];
  const webIdx: number[] = [];
  const scoreItems: { text: string; idx: number }[] = [];
  emittedResults.forEach((c, idx) => {
    if (c.kind === "caselaw") { caselawIdx.push(idx); return; }
    if (c.kind === "web") { webIdx.push(idx); return; }
    if (c.full_order) { fullOrderIdx.push(idx); return; }
    const text = (Array.isArray(c.sentences) ? c.sentences.join(" ") : "").slice(0, 4000);
    scoreItems.push({ text, idx });
  });
  if (!scoreItems.length) return unchanged;

  const scored = await voyageRerank(question, scoreItems);
  if (!scored.length) return unchanged;

  const protectedCount = fullOrderIdx.length + caselawIdx.length + webIdx.length;
  const budget = Math.max(0, MAX_WRITER_CHUNKS - protectedCount);
  const keptScoredIdx = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, budget)
    .map((s) => s.idx);

  const orderedIdx = [...fullOrderIdx, ...keptScoredIdx, ...caselawIdx, ...webIdx];
  const chunks: any[] = [];
  const results: any[] = [];
  for (const idx of orderedIdx) {
    chunks.push(emittedResults[idx]);
    results.push(allSearchResults[idx]);
  }
  return { chunks, results, ran: true, kept: chunks.length, dropped: total - chunks.length };
}

// ---------- Anthropic streaming turn (the writer) ----------
async function streamTurn(
  body: any,
  round: number,
  emit: (o: any) => void,
  emittedResults: any[],
  onAnswerText: (t: string) => void,
  onCitation: (ref: string | null) => void,
): Promise<{ assistantContent: any[]; stopReason: string | null; text: string }> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    const ra = res.headers.get("retry-after");
    const raMs = ra && Number.isFinite(Number(ra)) ? Number(ra) * 1000 : null;
    throw new ApiError(`Anthropic API ${res.status}: ${t.slice(0, 400)}`, res.status, raMs);
  }

  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  const blocks: any[] = [];
  let stopReason: string | null = null;
  let turnText = "";

  const handle = (ev: any) => {
    switch (ev.type) {
      case "content_block_start": {
        const cb = ev.content_block || {};
        const b: any = { type: cb.type };
        if (cb.type === "text") { b.text = ""; b.citations = []; }
        else if (cb.type === "thinking") { b.thinking = ""; b.signature = cb.signature || ""; }
        else if (cb.type === "redacted_thinking") { b.data = cb.data || ""; }
        else if (cb.type === "tool_use") { b.id = cb.id; b.name = cb.name; b.input = {}; b._partial = ""; }
        blocks[ev.index] = b;
        break;
      }
      case "content_block_delta": {
        const b = blocks[ev.index]; if (!b) break;
        const d = ev.delta || {};
        if (d.type === "text_delta") {
          b.text += d.text; turnText += d.text; onAnswerText(d.text);
          emit({ type: "text", round, block_id: `${round}:${ev.index}`, text: d.text });
        } else if (d.type === "thinking_delta") {
          b.thinking += d.thinking;
          emit({ type: "thinking", round, text: d.thinking });
        } else if (d.type === "signature_delta") {
          b.signature = (b.signature || "") + (d.signature || "");
        } else if (d.type === "input_json_delta") {
          b._partial += d.partial_json || "";
        } else if (d.type === "citations_delta") {
          const c = d.citation; if (!c) break;
          b.citations.push(c);
          const r = emittedResults[c.search_result_index];
          onCitation(r?.ref != null ? String(r.ref) : null);
          emit({
            type: "citation", round, block_id: `${round}:${ev.index}`,
            ref: r?.ref ?? null,
            order_label: r?.order_label ?? c.title ?? null,
            page: r ? pageCite(r) : null,
            sentence_start: c.start_block_index, sentence_end: c.end_block_index,
            cited_text: c.cited_text, source: c.source, title: c.title,
          });
        }
        break;
      }
      case "content_block_stop": {
        const b = blocks[ev.index]; if (!b) break;
        if (b.type === "tool_use") {
          try { b.input = b._partial ? JSON.parse(b._partial) : {}; } catch { b.input = {}; }
          delete b._partial;
        }
        break;
      }
      case "message_delta": {
        if (ev.delta?.stop_reason) stopReason = ev.delta.stop_reason;
        break;
      }
      case "error": {
        throw new Error(ev.error?.message || "Anthropic stream error");
      }
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, i); buf = buf.slice(i + 2);
      let dataStr = "";
      for (const line of raw.split("\n")) if (line.startsWith("data:")) dataStr += line.slice(5).trim();
      if (!dataStr) continue;
      let ev: any; try { ev = JSON.parse(dataStr); } catch { continue; }
      handle(ev);
    }
  }

  const assistantContent: any[] = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.type === "text") { if (b.text && b.text.trim()) assistantContent.push({ type: "text", text: b.text }); }
    else if (b.type === "thinking") { if (b.signature) assistantContent.push({ type: "thinking", thinking: b.thinking, signature: b.signature }); }
    else if (b.type === "redacted_thinking") { assistantContent.push({ type: "redacted_thinking", data: b.data }); }
    else if (b.type === "tool_use") { assistantContent.push({ type: "tool_use", id: b.id, name: b.name, input: b.input }); }
  }
  return { assistantContent, stopReason, text: turnText };
}

// ---------- handler ----------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

  let payload: any;
  try { payload = await req.json(); } catch { return new Response("Bad JSON", { status: 400, headers: CORS }); }
  // Configuration diagnostics — POST { action: "diagnostics" }. Returns version,
  // configured-key booleans (never values), active models, and retrieval limits.
  if ((payload?.action ?? "").toString() === "diagnostics") {
    return new Response(JSON.stringify({
      ok: true,
      version: "v32",
      models: {
        router: ROUTER_MODEL,
        router_url: ROUTER_URL === GEMINI_URL ? "gemini" : "custom",
        planner: PLANNER_MODEL,
        critic: CRITIC_MODEL,
        verifier: VERIFIER_MODEL,
        verifier_fallback: VERIFIER_FALLBACK_MODEL,
        agent_reasoning_effort: AGENT_REASONING_EFFORT,
        writer: MODEL,
        writer_fallback: WRITER_FALLBACK_MODEL,
      },
      keys: {
        anthropic: !!ANTHROPIC_API_KEY,
        gemini: !!GEMINI_API_KEY,
        voyage: !!VOYAGE_API_KEY,
        fireworks: !!FIREWORKS_API_KEY,
        courtlistener: !!COURTLISTENER_API_KEY,
        tavily: !!TAVILY_API_KEY,
      },
      limits: {
        max_rounds: MAX_ROUNDS,
        critic_extra_rounds: CRITIC_MAX_EXTRA_ROUNDS,
        per_search_k: PER_SEARCH_K,
        max_total_chunks: MAX_TOTAL_CHUNKS,
        max_writer_chunks: MAX_WRITER_CHUNKS,
        rerank_min_items: RERANK_MIN_ITEMS,
        per_doc_cap: PER_DOC_CAP,
        read_order_limit: READ_ORDER_LIMIT,
        web_domains: WEB_ALLOWED_DOMAINS.length,
        tavily_min_score: TAVILY_MIN_SCORE,
      },
    }), { status: 200, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  const question = (payload?.question ?? "").toString().trim();
  const clientEmbedding = (payload?.embedding ?? "").toString().trim();
  const initialFilter = (payload?.initial_filter && typeof payload.initial_filter === "object") ? payload.initial_filter : {};
  const caseId = (payload?.case_id ?? "").toString().trim() || DEFAULT_CASE_ID;
  const matter: Matter = (payload?.matter && typeof payload.matter === "object")
    ? { ...DEFAULT_MATTER, ...payload.matter }
    : DEFAULT_MATTER;
  const writerSystem = buildWriterSystem(matter);
  const routerSystem = buildRouterSystem(matter);

  if (!question) return new Response("Missing question", { status: 400, headers: CORS });

  const hasClientVec = vecDims(clientEmbedding) === 1024;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (o: any) => {
        try { controller.enqueue(encoder.encode(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`)); } catch { /* closed */ }
      };

      const missing: string[] = [];
      if (!ROUTER_API_KEY) missing.push(ROUTER_URL === GEMINI_URL ? "GEMINI_API_KEY" : "ROUTER_API_KEY");
      if (!ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
      if (!hasClientVec && !VOYAGE_API_KEY) missing.push("VOYAGE_API_KEY");
      if (missing.length) {
        emit({ type: "error", message: `${missing.join(" and ")} not set. Add ${missing.length > 1 ? "them" : "it"} in Supabase → Project Settings → Edge Functions → Secrets, then retry.` });
        emit({ type: "done", rounds: 0, chunk_count: 0, citation_count: 0 });
        controller.close();
        return;
      }

      // The planner runs IN PARALLEL with embedding resolution + the warm-start search,
      // so its latency (~4s on glm-5p2-fast) is hidden behind work that happens anyway.
      const agents: Record<string, unknown> = {};
      const plannerT0 = Date.now();
      const plannerPromise = runPlanner(question, matter);

      // Resolve the query embedding (server-side voyage-law-2 unless the client already
      // supplied a 1024-dim vector). One retry on transient Voyage failures.
      let embedding = hasClientVec ? clientEmbedding : "";
      if (!embedding) {
        for (let attempt = 1; attempt <= EMBED_MAX_ATTEMPTS && !embedding; attempt++) {
          try {
            embedding = await voyageEmbedQuery(question);
          } catch (e) {
            if (attempt >= EMBED_MAX_ATTEMPTS || !isRetryableError(e)) {
              emit({ type: "error", message: `Query embedding failed: ${(e as Error).message}` });
              emit({ type: "done", rounds: 0, chunk_count: 0, citation_count: 0 });
              controller.close();
              return;
            }
            await sleep(retryDelayMs(attempt, e));
          }
        }
      }

      // Per-search semantic embedding: each search may carry its own semantic_query;
      // embed it once (cached), falling back to the question's vector on any failure.
      const embedCache = new Map<string, string>();
      embedCache.set(question, embedding);
      const embedFor = async (text: string): Promise<string> => {
        const key = (text ?? "").trim();
        if (!key || key === question) return embedding;
        const hit = embedCache.get(key);
        if (hit) return hit;
        try {
          const v = await voyageEmbedQuery(key);
          embedCache.set(key, v);
          return v;
        } catch {
          return embedding; // fall back to the question anchor
        }
      };

      const emittedResults: any[] = [];   // UI chunks, in citation-index order
      const allSearchResults: any[] = []; // Anthropic search_result blocks, same order
      const recordIndexBlocks: string[] = []; // structured-tool output for the writer
      const seen = new Set<string>();
      const searchesLog: any[] = [];
      const citedRefs = new Set<string>(); // refs the writer actually cites (for the verifier)
      let rounds = 0, answerText = "", citationCount = 0, finalErr: string | null = null;
      let writerModelUsed = MODEL;

      // Shared per-round dispatch: announce the round's tool calls in order, run them in
      // PARALLEL, fold results (chunks/frames/log), and return the router-facing result
      // text blocks. Used by the main router loop AND the critic follow-up round, so the
      // two paths can never drift apart. Dedup stays correct: each task folds its rows
      // into `seen` inside a synchronous loop (no awaits), so the loops never interleave.
      const dispatchRound = async (
        calls: { name: string; input: any }[],
        round: number,
      ): Promise<string[]> => {
        for (const c of calls) {
          if (STRUCTURED_TOOLS.has(c.name)) emit({ type: "tool", round, tool: c.name, args: c.input });
          else if (c.name === "read_order") emit({ type: "tool", round, tool: "read_order", args: c.input });
          else if (c.name === "search_caselaw") emit({ type: "tool", round, tool: "search_caselaw", args: c.input });
          else if (c.name === "search_legal_web") emit({ type: "tool", round, tool: "search_legal_web", args: c.input });
          else emit({ type: "search", round, keywords: c.input.keywords ?? null, semantic_query: c.input.semantic_query ?? null, filter: mergeFilters(initialFilter, c.input.filter), k: PER_SEARCH_K });
        }

        const settled = await Promise.all(calls.map(async (c) => {
          try {
            if (STRUCTURED_TOOLS.has(c.name)) {
              return { kind: "structured" as const, c, sr: await runStructuredTool(c.name, c.input, caseId) };
            }
            if (c.name === "read_order") {
              return { kind: "read_order" as const, c, ro: await runReadOrder(c.input, caseId, seen) };
            }
            if (c.name === "search_caselaw") {
              return { kind: "caselaw" as const, c, cl: await runCaselawSearch(c.input, question, seen) };
            }
            if (c.name === "search_legal_web") {
              return { kind: "web" as const, c, wb: await runWebSearch(c.input, question, seen) };
            }
            const sr = await runSearch(c.input, embedFor, question, initialFilter, caseId, seen);
            let exp: { searchResults: any[]; chunks: any[] } = { searchResults: [], chunks: [] };
            if (c.input.expand !== false && sr.hitIds.length) {
              try { exp = await expandNeighbors(caseId, sr.hitIds.slice(0, EXPAND_TOP_N), seen); }
              catch { /* neighbor expansion is best-effort; never fail the search for it */ }
            }
            return { kind: "search" as const, c, sr, exp };
          } catch (e) {
            return { kind: "error" as const, c, message: (e as Error).message };
          }
        }));

        const resultBlocks: string[] = [];
        for (const s of settled) {
          if (s.kind === "structured") {
            searchesLog.push({ round, tool: s.c.name, args: s.c.input, returned: s.sr.count });
            recordIndexBlocks.push(s.sr.writerText);
            emit({ type: "tool", round, tool: s.c.name, count: s.sr.count, done: true });
            resultBlocks.push(s.sr.routerText);
          } else if (s.kind === "read_order") {
            for (const ch of s.ro.chunks) emittedResults.push(ch);
            for (const b of s.ro.searchResults) allSearchResults.push(b);
            searchesLog.push({ round, tool: "read_order", args: s.c.input, returned: s.ro.count });
            emit({ type: "chunks", round, chunks: s.ro.chunks });
            emit({ type: "tool", round, tool: "read_order", count: s.ro.count, done: true });
            const label = s.ro.versions.length ? s.ro.versions.join(" + ") : "the order";
            resultBlocks.push(`read_order pulled the full text of ${label} (${s.ro.count} passage(s), including any amendment versions).`);
          } else if (s.kind === "caselaw") {
            if (s.cl.unavailable) {
              searchesLog.push({ round, tool: "search_caselaw", args: s.c.input, unavailable: s.cl.unavailable });
              emit({ type: "tool", round, tool: "search_caselaw", count: 0, done: true });
              emit({ type: "tool_error", round, tool: "search_caselaw", message: `Case-law search unavailable: ${s.cl.unavailable}.` });
              resultBlocks.push(`search_caselaw is unavailable (${s.cl.unavailable}); proceed with the matter record only and note that external case law was not consulted.`);
            } else {
              for (const ch of s.cl.chunks) emittedResults.push(ch);
              for (const b of s.cl.searchResults) allSearchResults.push(b);
              searchesLog.push({ round, tool: "search_caselaw", args: s.c.input, returned: s.cl.count });
              emit({ type: "chunks", round, chunks: s.cl.chunks });
              emit({ type: "tool", round, tool: "search_caselaw", count: s.cl.count, done: true });
              const lines = s.cl.chunks.map((c: any) => `- ${c.full_citation}${c.cite_count != null ? ` (cited ${c.cite_count}×)` : ""}`);
              const moreNote = s.cl.total > s.cl.count ? ` of ${s.cl.total} matching` : "";
              resultBlocks.push(
                s.cl.count
                  ? `search_caselaw found ${s.cl.count} published opinion(s)${moreNote} (external legal authority):\n${lines.join("\n")}`
                  : `search_caselaw returned no opinions for that query; try a broader query or remove the court restriction.`,
              );
            }
          } else if (s.kind === "web") {
            if (s.wb.unavailable) {
              searchesLog.push({ round, tool: "search_legal_web", args: s.c.input, unavailable: s.wb.unavailable });
              emit({ type: "tool", round, tool: "search_legal_web", count: 0, done: true });
              emit({ type: "tool_error", round, tool: "search_legal_web", message: `Web research unavailable: ${s.wb.unavailable}.` });
              resultBlocks.push(`search_legal_web is unavailable (${s.wb.unavailable}); proceed without open-web sources and note that external web research was not consulted.`);
            } else {
              for (const ch of s.wb.chunks) emittedResults.push(ch);
              for (const b of s.wb.searchResults) allSearchResults.push(b);
              searchesLog.push({ round, tool: "search_legal_web", args: s.c.input, returned: s.wb.count });
              emit({ type: "chunks", round, chunks: s.wb.chunks });
              emit({ type: "tool", round, tool: "search_legal_web", count: s.wb.count, done: true });
              const lines = s.wb.chunks.map((c: any) => `- ${c.web_title} (${c.domain ?? "web"})`);
              resultBlocks.push(
                s.wb.count
                  ? `search_legal_web found ${s.wb.count} source(s) from the allowed reputable domains (SECONDARY web sources, not the record):\n${lines.join("\n")}`
                  : `search_legal_web returned nothing from the allowed domains; rephrase the query, switch topic to "news", or proceed without web sources.`,
              );
            }
          } else if (s.kind === "search") {
            for (const ch of s.sr.chunks) emittedResults.push(ch);
            for (const b of s.sr.searchResults) allSearchResults.push(b);
            searchesLog.push({ round, keywords: s.c.input.keywords ?? null, semantic_query: s.c.input.semantic_query ?? null, filter: s.c.input.filter ?? null, k: PER_SEARCH_K, returned: s.sr.chunks.length, expanded: s.exp.chunks.length });
            emit({ type: "chunks", round, chunks: s.sr.chunks });
            if (s.exp.chunks.length) {
              for (const ch of s.exp.chunks) emittedResults.push(ch);
              for (const b of s.exp.searchResults) allSearchResults.push(b);
              emit({ type: "chunks", round, chunks: s.exp.chunks });
              emit({ type: "expand", round, source: "neighbors", count: s.exp.chunks.length });
            }
            resultBlocks.push(
              compactResults(s.sr.chunks, seen.size, round) +
              (s.exp.chunks.length ? `\n(+${s.exp.chunks.length} adjacent passage(s) pulled for surrounding context.)` : ""),
            );
          } else {
            const structuredLike = s.c.name === "read_order" || s.c.name === "search_caselaw" || s.c.name === "search_legal_web" || STRUCTURED_TOOLS.has(s.c.name);
            if (structuredLike) emit({ type: "tool_error", round, tool: s.c.name, message: s.message });
            else emit({ type: "search_error", round, message: s.message });
            resultBlocks.push(`${s.c.name} error: ${s.message}`);
          }
        }
        return resultBlocks;
      };

      // ----- Round 1: warm-start search + planner-driven HyDE facet searches -----
      // The warm start anchors to the raw question and runs while the planner thinks; the
      // facet searches then embed each facet's HyDE hypothesis as its own semantic anchor.
      rounds = 1;
      emit({ type: "round", round: 1 });
      emit({ type: "search", round: 1, keywords: null, semantic_query: null, filter: initialFilter, k: PER_SEARCH_K });
      const preBlocks: string[] = [];
      try {
        const warm = await runSearch({ k: PER_SEARCH_K }, embedFor, question, initialFilter, caseId, seen);
        for (const ch of warm.chunks) emittedResults.push(ch);
        for (const b of warm.searchResults) allSearchResults.push(b);
        searchesLog.push({ round: 1, warm_start: true, keywords: null, semantic_query: null, k: PER_SEARCH_K, returned: warm.chunks.length });
        emit({ type: "chunks", round: 1, chunks: warm.chunks });
        agents.warm_start = { returned: warm.chunks.length };
        preBlocks.push(`Warm-start search (anchored to the raw question): ${compactResults(warm.chunks, seen.size, 1)}`);
      } catch (e) {
        emit({ type: "search_error", round: 1, message: (e as Error).message });
        agents.warm_start = { error: (e as Error).message };
        preBlocks.push(`Warm-start search error: ${(e as Error).message}`);
      }

      const plan = await plannerPromise;
      agents.planner = { ok: plan.ok, facets: plan.facets.length, ms: Date.now() - plannerT0, ...(plan.error ? { error: plan.error } : {}) };
      if (plan.ok) {
        emit({
          type: "plan",
          rationale: plan.rationale,
          facets: plan.facets.map((f) => ({
            id: f.id, question: f.question, hypothesis: f.hypothesis,
            specialists: f.specialists, keywords: f.keywords ?? [], court: f.court ?? null,
          })),
        });
        // Execute HyDE directly: one semantically-anchored record search per facet, in
        // parallel. Only facets that call for record retrieval are pre-executed; caselaw,
        // web, and structured facets are left to the router, which sees the facet list.
        const recFacets = plan.facets.filter((f) => f.specialists.includes("search_the_record") && (f.hypothesis || f.question) && seen.size < MAX_TOTAL_CHUNKS);
        if (recFacets.length) {
          for (const f of recFacets) {
            emit({ type: "search", round: 1, keywords: f.keywords?.length ? f.keywords.join(" ") : null, semantic_query: f.hypothesis || f.question, filter: initialFilter, k: PER_SEARCH_K });
          }
          const settledF = await Promise.all(recFacets.map(async (f) => {
            try {
              const input: any = { semantic_query: f.hypothesis || f.question, k: PER_SEARCH_K };
              if (f.keywords?.length) input.keywords = f.keywords.join(" ");
              const sr = await runSearch(input, embedFor, question, initialFilter, caseId, seen);
              let exp: { searchResults: any[]; chunks: any[] } = { searchResults: [], chunks: [] };
              if (sr.hitIds.length) {
                try { exp = await expandNeighbors(caseId, sr.hitIds.slice(0, EXPAND_TOP_N), seen); } catch { /* best effort */ }
              }
              return { f, sr, exp, error: null as string | null };
            } catch (e) {
              return { f, sr: null as any, exp: null as any, error: (e as Error).message };
            }
          }));
          for (const s of settledF) {
            if (s.error) {
              emit({ type: "search_error", round: 1, message: `[facet ${s.f.id}] ${s.error}` });
              preBlocks.push(`Facet [${s.f.id}] search error: ${s.error}`);
              continue;
            }
            for (const ch of s.sr.chunks) emittedResults.push(ch);
            for (const b of s.sr.searchResults) allSearchResults.push(b);
            searchesLog.push({ round: 1, facet: s.f.id, semantic_query: s.f.hypothesis || s.f.question, keywords: s.f.keywords?.length ? s.f.keywords.join(" ") : null, k: PER_SEARCH_K, returned: s.sr.chunks.length, expanded: s.exp.chunks.length });
            emit({ type: "chunks", round: 1, chunks: s.sr.chunks });
            if (s.exp.chunks.length) {
              for (const ch of s.exp.chunks) emittedResults.push(ch);
              for (const b of s.exp.searchResults) allSearchResults.push(b);
              emit({ type: "chunks", round: 1, chunks: s.exp.chunks });
              emit({ type: "expand", round: 1, source: "neighbors", count: s.exp.chunks.length });
            }
            preBlocks.push(
              `Facet [${s.f.id}] "${s.f.question}": ` + compactResults(s.sr.chunks, seen.size, 1) +
              (s.exp.chunks.length ? `\n(+${s.exp.chunks.length} adjacent passage(s) pulled for surrounding context.)` : ""),
            );
          }
        }
      }
      emit({ type: "round_end", round: 1, stop_reason: "tool_use" });

      // ----- Router phase: fill the gaps the planned pre-retrieval left -----
      let userText = question;
      if (initialFilter && Object.keys(initialFilter).length) {
        userText += `\n\n[The user applied these filters in the interface; they are enforced on every search and may not be removed: ${JSON.stringify(initialFilter)}.]`;
      }
      if (plan.ok && (plan.facets.length > 1 || (plan.facets[0]?.hypothesis ?? "").length > 20)) {
        const facetLines = plan.facets.map((f, i) =>
          `${i + 1}. [${f.id}] ${f.question}` +
          (f.specialists?.length ? `\n   specialists: ${f.specialists.join(", ")}` : "") +
          (f.keywords?.length ? `\n   keywords: ${f.keywords.join(", ")}` : "") +
          (f.court ? `\n   court: ${f.court}` : "")
        ).join("\n");
        userText += `\n\n[PLANNER decomposed this question into the following facets. Record-search facets were already executed in the pre-retrieval round below; use the facet list to decide which OTHER specialists (read_order, structured lists, search_caselaw, search_legal_web) still need to run, and to spot facets the pre-retrieval left uncovered.]\n${facetLines}`;
      }
      userText += `\n\n[PRE-RETRIEVAL ROUND — already executed before you; do NOT repeat these searches:]\n\n${preBlocks.join("\n\n")}\n\nFill the specific gaps this pre-retrieval left. If it already suffices to answer comprehensively, reply with a brief one-line note that retrieval is complete and do NOT call a tool.`;

      const routerMessages: any[] = [
        { role: "system", content: routerSystem },
        { role: "user", content: userText },
      ];

      while (rounds < MAX_ROUNDS && seen.size < MAX_TOTAL_CHUNKS) {
        const round = rounds + 1;
        emit({ type: "round", round });
        let r: { rationale: string; toolCalls: any[]; finish: string | null } | null = null;
        try {
          r = await routerRound(routerMessages, round, emit);
        } catch (e1) {
          if (isRetryableError(e1)) {
            await sleep(retryDelayMs(1, e1));
            try {
              r = await routerRound(routerMessages, round, emit);
            } catch (e2) {
              emit({ type: "search_error", round, message: `Router: ${(e2 as Error).message}` });
              emit({ type: "round_end", round, stop_reason: "router_error" });
              rounds = round;
              break;
            }
          } else {
            emit({ type: "search_error", round, message: `Router: ${(e1 as Error).message}` });
            emit({ type: "round_end", round, stop_reason: "router_error" });
            rounds = round;
            break;
          }
        }
        rounds = round;

        if (!r || !r.toolCalls.length) {
          emit({ type: "round_end", round, stop_reason: "router_done" });
          break;
        }

        // Record the router's reasoning as plain assistant text (NO tool_calls in history).
        routerMessages.push({
          role: "assistant",
          content: r.rationale && r.rationale.trim() ? r.rationale.trim() : "Gathering the record.",
        });

        const calls = r.toolCalls.map((t) => ({
          name: t.name as string,
          input: (t.args && typeof t.args === "object") ? t.args : {},
        }));
        const resultBlocks = await dispatchRound(calls, round);

        emit({ type: "round_end", round, stop_reason: "tool_use" });
        if (seen.size >= MAX_TOTAL_CHUNKS) break;

        routerMessages.push({
          role: "user",
          content: `${resultBlocks.join("\n\n")}\n\nIf the gathered material is sufficient to fully answer the question, reply with a brief one-line note that retrieval is complete and do NOT call a tool. Otherwise, gather what is still missing — issue parallel calls if several gaps are independent, use read_order (with BOTH order_type and order_number) to pull an order's full text or its amendment, and relax filters where a narrow one came up short. Do NOT repeat a search you already ran; change the keywords, filter, or tool so it returns NEW material.`,
        });
      }

      // ----- Critic: coverage check; may buy ONE extra router round -----
      const haveEvidenceForCritic = allSearchResults.length > 0 || recordIndexBlocks.length > 0;
      if (haveEvidenceForCritic && rounds < MAX_ROUNDS + CRITIC_MAX_EXTRA_ROUNDS && seen.size < MAX_TOTAL_CHUNKS) {
        try {
          const passageLines = emittedResults.slice(0, 40).map((c: any) => {
            const label = c.full_citation ?? c.web_title ?? c.order_label ?? "chunk";
            const page = c.page_start != null ? ` p.${c.page_start}` : "";
            const snip = (Array.isArray(c.sentences) ? c.sentences.join(" ") : "").slice(0, 200);
            return `- [${label}${page}] ${snip}`;
          }).join("\n");
          const indexPart = recordIndexBlocks.length
            ? `\n\nSTRUCTURED INDEX BLOCKS:\n${recordIndexBlocks.map((b) => b.slice(0, 3000)).join("\n\n")}`
            : "";
          const critic = await runCritic(question, plan.facets, passageLines + indexPart);
          agents.critic = { ran: true, ok: critic.ok, done: critic.done, missing: critic.missing, extra_round: false, ...(critic.error ? { error: critic.error } : {}) };
          if (critic.ok) {
            emit({ type: "critic", done: critic.done, missing: critic.missing, followup: critic.followup });
          }
          if (critic.ok && !critic.done && critic.followup) {
            const round = rounds + 1;
            emit({ type: "round", round });
            routerMessages.push({
              role: "user",
              content: `CRITIC coverage check: the answer set is incomplete. Fill this specific gap and do not repeat searches you already ran:\n\n${critic.followup}${critic.missing.length ? `\n\nMissing facets: ${critic.missing.join(", ")}` : ""}`,
            });
            try {
              const r = await routerRound(routerMessages, round, emit);
              rounds = round;
              if (r?.toolCalls?.length) {
                const calls = r.toolCalls.map((t) => ({ name: t.name as string, input: (t.args && typeof t.args === "object") ? t.args : {} }));
                await dispatchRound(calls, round);
                (agents.critic as Record<string, unknown>).extra_round = true;
              }
              emit({ type: "round_end", round, stop_reason: "tool_use" });
            } catch (e) {
              emit({ type: "search_error", round, message: `Critic follow-up: ${(e as Error).message}` });
              emit({ type: "round_end", round, stop_reason: "router_error" });
            }
          }
        } catch { /* critic is best-effort */ }
      }

      // Safety net: if nothing at all was gathered (no passages and no structured data),
      // run one default semantic search so the writer is never starved.
      if (!allSearchResults.length && !recordIndexBlocks.length) {
        emit({ type: "search", round: rounds, keywords: null, semantic_query: null, filter: initialFilter, k: PER_SEARCH_K });
        try {
          const sr = await runSearch({ k: PER_SEARCH_K }, embedFor, question, initialFilter, caseId, seen);
          for (const ch of sr.chunks) emittedResults.push(ch);
          for (const b of sr.searchResults) allSearchResults.push(b);
          emit({ type: "chunks", round: rounds, chunks: sr.chunks });
        } catch (e) {
          emit({ type: "search_error", round: rounds, message: (e as Error).message });
        }
      }

      // ----- Rerank: trim past MAX_WRITER_CHUNKS and reorder evidence best-first -----
      try {
        const preRerank = emittedResults.length;
        const rr = await rerankAndTrim(question, emittedResults, allSearchResults);
        if (rr.ran) {
          emittedResults.length = 0; allSearchResults.length = 0;
          emittedResults.push(...rr.chunks); allSearchResults.push(...rr.results);
          agents.rerank = { ran: true, before: preRerank, after: rr.kept, dropped: rr.dropped };
          emit({ type: "rerank", model: RERANK_MODEL, before: preRerank, after: rr.kept, dropped: rr.dropped });
        } else {
          agents.rerank = { ran: false, total: preRerank };
        }
      } catch { agents.rerank = { ran: false, error: true }; }

      // ----- Writer: Opus 4.8 synthesizes with citations (extended thinking ON) -----
      const writerRound = rounds + 1;
      try {
        emit({ type: "round", round: writerRound, writer: true });
        const today = new Date().toISOString().slice(0, 10);
        const haveEvidence = allSearchResults.length > 0 || recordIndexBlocks.length > 0;
        const haveCaselaw = emittedResults.some((c: any) => c.kind === "caselaw");
        const caselawNote = haveCaselaw
          ? ` Some of the provided sources are EXTERNAL court opinions (their titles are case citations and their sources are courtlistener.com URLs) — treat those as legal authority, kept distinct from this matter's own orders, exactly as instructed; cite case law only from those provided opinions and never from memory.`
          : "";
        const haveWeb = emittedResults.some((c: any) => c.kind === "web");
        const webNote = haveWeb
          ? ` Some provided sources are EXTERNAL WEB RESEARCH from reputable legal/regulatory sites (web URLs, expressly marked as secondary web sources) — treat them strictly as secondary reference per your instructions; this matter's record and the provided opinions control over them.`
          : "";
        const facetNote = (plan.ok && plan.facets.length > 1)
          ? `\n\nDuring retrieval the question was decomposed into these research facets:\n${plan.facets.map((f, i) => `${i + 1}. ${f.question}`).join("\n")}\nAddress each facet the gathered material supports; where the material leaves a facet unsupported or only partially covered, say so explicitly rather than passing over it.`
          : "";
        const matterAnchor = `The attorney's question concerns this matter — ${matter.short_name}, MDL ${matter.mdl_number}. Treat the question as pertaining to this matter only; do not assume it relates to any other MDL or litigation, and do not remark on which matter the question is "framed for." Answer it directly from the ${matter.short_name} record.`;
        const leadIn = haveEvidence
          ? `Today's date is ${today}.\n\n${matterAnchor}\n\nQuestion: ${question}${facetNote}\n\nThe material gathered for this question follows — document passages (citable search results) and, where applicable, a structured record index.${caselawNote}${webNote} The passages are ordered by assessed relevance to the question (most relevant first). Using only that material, answer the question for the attorney, citing each assertion to its source as you write. Reason carefully about dates, order precedence, and deadlines as instructed, synthesize across the passages where the question calls for it, and flag anything the gathered material does not cover.`
          : `Today's date is ${today}.\n\n${matterAnchor}\n\nQuestion: ${question}\n\nNo material was retrieved from the record for this question. If you cannot answer from the record, say so plainly.`;
        const writerUser: any[] = [{ type: "text", text: leadIn }, ...allSearchResults];
        if (recordIndexBlocks.length) {
          writerUser.push({
            type: "text",
            text:
              "STRUCTURED RECORD INDEX — verified facts compiled directly from this matter's docket index (orders, counsel of record, key dates). " +
              "These are reliable for enumerations and for anchoring order numbers and dates; they are not page-level passages, so anchor any statement drawn from them to the specific order number and date (and, for a deadline, its source order) rather than citing a passage. " +
              "Do not treat the absence of an item here as proof it does not exist unless the list is described as complete.\n\n" +
              recordIndexBlocks.join("\n\n"),
          });
        }

        let turn: { assistantContent: any[]; stopReason: string | null; text: string } | null = null;
        let lastErr: unknown = null;
        for (let attempt = 1; attempt <= WRITER_MAX_ATTEMPTS; attempt++) {
          writerModelUsed = attempt === WRITER_MAX_ATTEMPTS ? WRITER_FALLBACK_MODEL : MODEL;

          // Adaptive thinking lets the writer plan structure and decide which passages support
          // which claims BEFORE writing — materially improving citation coverage. Opus 4.8 uses
          // adaptive thinking + output_config.effort (NOT the legacy enabled/budget_tokens, which
          // 400s). display:"summarized" is required for the reasoning to stream as readable text.
          // The fallback model omits these parameters and streams a plain cited answer.
          const body: any = {
            model: writerModelUsed,
            max_tokens: WRITER_MAX_TOKENS,
            system: [{ type: "text", text: writerSystem, cache_control: { type: "ephemeral" } }],
            messages: [{ role: "user", content: writerUser }],
            stream: true,
          };
          if (writerModelUsed === MODEL) {
            body.thinking = { type: "adaptive", display: "summarized" };
            body.output_config = { effort: WRITER_EFFORT };
          }

          let sawAnswerText = false;
          try {
            if (attempt > 1) {
              emit({
                type: "thinking",
                round: writerRound,
                text: `\n[Transient upstream error — retrying the writer (attempt ${attempt}/${WRITER_MAX_ATTEMPTS}${writerModelUsed !== MODEL ? `, falling back to ${writerModelUsed}` : ""}).]\n`,
              });
            }
            turn = await streamTurn(
              body, writerRound, emit, emittedResults,
              () => { sawAnswerText = true; },
              (ref) => { citationCount++; if (ref) citedRefs.add(ref); },
            );
            break;
          } catch (e) {
            lastErr = e;
            if (sawAnswerText) {
              throw new Error(`The answer stream was interrupted mid-write (${(e as Error).message}). The research gathered above is preserved — re-run the question to get a complete answer.`);
            }
            if (attempt >= WRITER_MAX_ATTEMPTS || !isRetryableError(e)) throw e;
            await sleep(retryDelayMs(attempt, e));
          }
        }
        if (!turn) {
          throw (lastErr instanceof Error ? lastErr : new Error("Writer produced no output"));
        }
        emit({ type: "round_end", round: writerRound, stop_reason: turn.stopReason });
        answerText = turn.text;
        rounds = writerRound;
      } catch (e) {
        const msg = (e as Error).message;
        finalErr = msg;
        const friendly = isRetryableError(e)
          ? `The writer model is temporarily overloaded upstream (${msg}). ${WRITER_MAX_ATTEMPTS} attempts were made, including a fallback model. The research gathered above is preserved — re-run the question in a moment.`
          : msg;
        emit({ type: "error", message: friendly });
      }

      // v33: the answer is complete the moment the writer stops — tell the client NOW,
      // before the advisory verifier tail, so nothing spins on a finished answer.
      if (answerText.trim() && !finalErr) {
        emit({ type: "answer_end", rounds, citation_count: citationCount });
      }

      // ----- Verifier: post-stream grounding pass over the CITED passages -----
      // Advisory only — the streamed answer is never rewritten; findings surface as a
      // `verify` SSE frame (count + quotes + notes) for the UI to flag. Non-fatal.
      if (answerText.trim() && !finalErr) {
        const verifyT0 = Date.now();
        try {
          const byRef = new Map<string, any>();
          for (const c of emittedResults) if (c?.ref != null) byRef.set(String(c.ref), c);
          const evParts: string[] = [];
          let evTotal = 0;
          for (const ref of citedRefs) {
            const c = byRef.get(ref);
            if (!c) continue;
            const label = c.full_citation ?? c.web_title ?? c.order_label ?? "source";
            const page = c.page_start != null ? ` p.${c.page_start}` : "";
            const body = (Array.isArray(c.sentences) ? c.sentences.join(" ") : "").slice(0, VERIFY_EVIDENCE_PER_CHUNK);
            const part = `[${label}${page}] ${body}`;
            if (evTotal + part.length > VERIFY_EVIDENCE_TOTAL) break;
            evParts.push(part);
            evTotal += part.length;
          }
          const v = await runVerifier(question, answerText, evParts.join("\n\n"));
          if (v.ok) {
            agents.verify = { ran: true, model: v.model, unsupported: v.unsupported.length, ms: Date.now() - verifyT0 };
            emit({ type: "verify", unsupported: v.unsupported.length, unsupported_quotes: v.unsupported, notes: v.notes, model: v.model });
          } else {
            agents.verify = { ran: false, errors: v.errors, ms: Date.now() - verifyT0 };
          }
        } catch (e) {
          agents.verify = { ran: false, error: (e as Error).message.slice(0, 300), ms: Date.now() - verifyT0 };
        }
      }

      emit({ type: "done", rounds, chunk_count: emittedResults.length, citation_count: citationCount });
      controller.close();

      try {
        await fetch(`${SUPABASE_URL}/rest/v1/synthesis_runs`, {
          method: "POST",
          headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", "Prefer": "return=minimal" },
          body: JSON.stringify({
            question,
            initial_filter: { ...initialFilter, case_id: caseId, matter: matter.slug },
            rounds, searches: searchesLog,
            chunk_ids: emittedResults.map((c) => c.ref), answer: answerText,
            citation_count: citationCount,
            agents,
            model: `${ROUTER_MODEL} -> ${writerModelUsed}${writerModelUsed === MODEL ? " (thinking; voyage-law-2 retrieval)" : " (fallback writer; voyage-law-2 retrieval)"}`,
            error: finalErr,
          }),
        });
      } catch { /* ignore */ }
    },
  });

  return new Response(stream, {
    headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
});
