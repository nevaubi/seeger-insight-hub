// Supabase Edge Function: legal-synthesis (v30)
// v30 — MULTI-AGENT GRAPH + WIDER RAG + TAVILY WEB SUB-AGENT:
//   * PLANNER (Gemini 3.1 Pro): decomposes the question into facets, writes a HyDE
//     hypothesis per facet, and picks which specialists to run. Emitted as `plan` SSE.
//   * SPECIALISTS: the existing router loop still dispatches tools in parallel, plus a new
//     `search_web` tool backed by Tavily, scoped to a reputable-legal + regulatory +
//     scientific domain allowlist (courtlistener, uscourts, fda.gov, nejm, jamanetwork, ...).
//   * VOYAGE RERANK-2: after retrieval, all record passages are reranked; top 80 survive.
//   * CRITIC (Gemini 3.5 Flash): coverage/gap check; may trigger ONE extra router round.
//     Emitted as `critic` SSE.
//   * VERIFIER (Gemini 3.5 Flash): post-stream citation-grounding pass. Emitted as `verify`
//     SSE (advisory; the writer output is NOT rewritten in Phase A).
//   * Retrieval knobs widened: MAX_ROUNDS 3->5, PER_SEARCH_K 10->15, EXPAND_TOP_N 3->5,
//     MAX_TOTAL_CHUNKS 60->120 (pre-rerank), MAX_WRITER_CHUNKS 80 (post-rerank ceiling).
// New SSE event types (additive; the reducer's default case keeps old clients working):
//   plan, critic, verify, web_result.
//
// Supabase Edge Function: legal-synthesis (v29)
// Multi-agent, multi-matter RAG over a litigation record (controlling orders + filings).
//   Router = Gemini 3.1 Flash-Lite (OpenAI-compatible endpoint): plans and runs up to
//   3 rounds, calling tools — search_the_record, read_order, list_orders,
//   lookup_counsel, list_deadlines, and search_caselaw (external published
//   opinions via CourtListener) — streams concise reasoning, then stops.
//   Writer = Claude Opus 4.8: one clean turn over the gathered passages (with native
//   sentence-level citations) plus a structured record index.
// SSE streaming throughout.
//
// v29 — TRANSIENT-FAILURE RESILIENCE (retry + backoff + model fallback):
//   - The writer call now retries on transient upstream failures (HTTP 429/5xx/529 and
//     mid-stream `overloaded_error` / rate-limit SSE events) with exponential backoff,
//     honoring a Retry-After header when the API sends one. Up to WRITER_MAX_ATTEMPTS
//     total attempts; the FINAL attempt falls back to WRITER_FALLBACK_MODEL (capacity
//     errors are usually model-specific, so switching models beats a same-model retry).
//     The fallback attempt omits the adaptive-thinking parameters (they are tuned for
//     the primary model) and streams a plain cited answer.
//   - SAFETY GUARD: a retry is only attempted while ZERO answer text has streamed to the
//     client. Once any answer text is visible, a rerun would duplicate it — so a
//     mid-answer interruption is surfaced as a clear error instead of retried.
//   - The Voyage query-embedding call retries once on transient failure (an embedding
//     failure previously killed the entire run before any retrieval happened).
//   - A transient Gemini router failure is retried once per round before falling through
//     (router failures remain non-fatal: the writer runs with whatever was gathered).
//   - Retry progress is streamed into the research trace as thinking text, and the
//     terminal error message tells the user the research above is preserved.
//   - synthesis_runs now records the writer model actually used (primary or fallback).
//
// v28 — EMBEDDINGS MOVED TO voyage-law-2 (1024-dim, server-side):
//   - The query embedding is now generated INSIDE this function via the Voyage AI API
//     (model voyage-law-2, input_type 'query'). Callers send only { question }; the
//     legacy `embedding` field is accepted for backward compatibility but is used only
//     if it is already a 1024-dim vector — a legacy 384-dim bge vector is ignored and
//     the function self-embeds instead.
//   - Passage retrieval now calls hybrid_search_v2 (chunks.embedding_v2, vector(1024)).
//   - MIN_SIM retuned for voyage-law-2's score distribution (relevant hits typically
//     score 0.4–0.7; 0.35 admits borderline material while cutting noise).
//
// MATTER SCOPING: every request is scoped to a single matter via case_id (the matter's
//   MDL-master case). When case_id/matter are omitted, the function defaults to the
//   Depo-Provera matter (MDL 3140) so existing callers behave exactly as before. The
//   scope is enforced server-side: case_id is injected into every retrieval filter and
//   into every structured-tool call, so one matter's data can never bleed into another's.
//
// INTELLIGENT RETRIEVAL: a round's tool calls run in PARALLEL; each search auto-expands its
// top hits with adjacent passages (neighbor/sibling context); read_order pulls a full order
// plus its amendment versions (temporal/precedence). All gathered passages persist across
// rounds, deduped, capped at MAX_TOTAL_CHUNKS, and handed to the writer in full. Structured
// tools (orders/counsel/deadlines) return the complete matching list as a record index.
//
// Router history is kept as PLAIN TEXT (rationale + compact results), not replayed
// tool-call parts: Gemini 3 requires a thought_signature on any functionCall echoed back
// into history, which the OpenAI-compatible endpoint does not surface. Issuing a fresh
// tool call each round avoids that entirely.
//
// Request (POST JSON):
//   { question: string, embedding?: string (optional — only honored if 1024-dim; the
//     function self-embeds via voyage-law-2 otherwise), initial_filter?: object,
//     case_id?: string (matter master case), matter?: { name, short_name, mdl_number, court, judge } }
// Response: text/event-stream (events: round, thinking, search, chunks, tool, expand, text,
//   citation, round_end, search_error, tool_error, error, done).
//
// Secrets: ANTHROPIC_API_KEY, GEMINI_API_KEY, VOYAGE_API_KEY (user-provided).
//   COURTLISTENER_API_KEY optional (enables search_caselaw; without it that one tool degrades
//   gracefully). ROUTER_MODEL optional (default gemini-3.1-flash-lite). WRITER_FALLBACK_MODEL
//   optional (default claude-sonnet-4-6). SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY auto-injected.

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const VOYAGE_API_KEY = Deno.env.get("VOYAGE_API_KEY") ?? "";
const ROUTER_MODEL = Deno.env.get("ROUTER_MODEL") ?? "gemini-3.1-flash-lite";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MODEL = "claude-opus-4-8";
const WRITER_FALLBACK_MODEL = Deno.env.get("WRITER_FALLBACK_MODEL") ?? "claude-sonnet-4-6";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_MODEL = "voyage-law-2";
const VOYAGE_TIMEOUT_MS = 20000;
const MAX_ROUNDS = 5;
const PER_SEARCH_K = 15;        // v30: widened retrieval
const MAX_TOTAL_CHUNKS = 120;   // v30: pre-rerank ceiling across all record passages
const MAX_WRITER_CHUNKS = 80;   // v30: post-rerank cap actually handed to the writer
const MIN_SIM = 0.32;           // slightly relaxed to feed the reranker more candidates
const NEIGHBOR_WINDOW = 1;
const EXPAND_TOP_N = 5;         // v30: expand more hits per search
const READ_ORDER_LIMIT = 40;
const WRITER_EFFORT = "high";
const WRITER_MAX_TOKENS = 24000;

// ---------- v29: transient-failure handling ----------
const WRITER_MAX_ATTEMPTS = 3;
const EMBED_MAX_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 2000;
const RETRY_MAX_DELAY_MS = 15000;

// ---------- v30: multi-agent + web + rerank ----------
const PLANNER_MODEL = Deno.env.get("PLANNER_MODEL") ?? "gemini-3.1-pro-preview";
const CRITIC_MODEL  = Deno.env.get("CRITIC_MODEL")  ?? "gemini-3.5-flash";
const VERIFIER_MODEL = Deno.env.get("VERIFIER_MODEL") ?? "gemini-3.5-flash";
const RERANK_URL   = "https://api.voyageai.com/v1/rerank";
const RERANK_MODEL = "rerank-2";
const RERANK_TIMEOUT_MS = 15000;
const TAVILY_URL = "https://api.tavily.com/search";
const TAVILY_API_KEY = Deno.env.get("TAVILY_API_KEY") ?? "";
const TAVILY_TIMEOUT_MS = 15000;
const WEB_MAX_RESULTS = 8;
const WEB_EXCERPT_CHARS = 2000;
// Reputable legal + regulatory + scientific domains only. Tavily filters upstream via
// include_domains; we also re-check server-side (defense in depth) before handing results
// to the writer.
const WEB_ALLOWED_DOMAINS = [
  // Case law + court sites
  "courtlistener.com", "law.cornell.edu", "justia.com", "casetext.com",
  "supremecourt.gov", "uscourts.gov", "ca11.uscourts.gov", "flnd.uscourts.gov",
  "jpml.uscourts.gov",
  // Legal news / secondary
  "reuters.com", "law360.com", "bloomberglaw.com", "abajournal.com", "ssrn.com",
  // Regulatory
  "fda.gov", "ema.europa.eu", "who.int",
  // Scientific / medical
  "nih.gov", "ncbi.nlm.nih.gov", "pubmed.ncbi.nlm.nih.gov",
  "nejm.org", "jamanetwork.com", "thelancet.com", "bmj.com",
];

// ---------- CourtListener (external case-law authority) ----------
// The deployed edge function reaches CourtListener's REST API directly (it cannot use the
// MCP connector, which is an authoring-time tool). A token is strongly recommended for
// production rate limits; without one the tool degrades gracefully (the router is told case
// law is unavailable, and the rest of the pipeline runs unchanged).
const COURTLISTENER_API_KEY = Deno.env.get("COURTLISTENER_API_KEY") ?? "";
const CL_BASE = "https://www.courtlistener.com/api/rest/v4";
const CL_WEB = "https://www.courtlistener.com";
const CASELAW_MAX_RESULTS = 6;       // opinions returned per search_caselaw call
const CASELAW_FULLTEXT_TOP_N = 3;    // fetch fuller holding text for the top N hits
const CASELAW_EXCERPT_CHARS = 4200;  // bounded lead excerpt per opinion handed to the writer
const CL_TIMEOUT_MS = 12000;         // hard cap on any single CourtListener request

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
// A typed upstream error carrying the HTTP status and any Retry-After hint, so retry
// classification can be exact for request-level failures and message-based for
// mid-stream SSE error events (which carry no HTTP status).
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

// Transient upstream conditions worth retrying. Status-based when we have a status
// (ApiError); otherwise message-based — this is how a mid-stream Anthropic
// `overloaded_error` (message "Overloaded") is classified as retryable.
function isRetryableError(e: unknown): boolean {
  if (e instanceof ApiError) return RETRYABLE_STATUS.has(e.status);
  const msg = ((e as Error)?.message ?? "").toLowerCase();
  return /overloaded|rate.?limit|too many requests|timed?.?out|temporarily unavailable|service unavailable|internal server error|upstream|connection (?:reset|closed)/.test(msg);
}

// Exponential backoff with jitter, honoring an upstream Retry-After hint when present.
function retryDelayMs(attempt: number, e: unknown): number {
  const hinted = e instanceof ApiError && e.retryAfterMs != null ? e.retryAfterMs : 0;
  const backoff = Math.min(RETRY_BASE_DELAY_MS * Math.pow(2.5, attempt - 1), RETRY_MAX_DELAY_MS);
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(Math.max(hinted, backoff) + jitter, RETRY_MAX_DELAY_MS);
}

// ---------- Voyage query embedding (v28) ----------
// Embeds the user's question server-side with the SAME model family that embedded the
// corpus (voyage-law-2), input_type 'query'. Returns a pgvector text literal (1024 dims).
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

// Dimension of a pgvector text literal like "[0.1,-0.2,...]" (0 when empty/invalid).
function vecDims(v: string): number {
  const s = (v ?? "").trim();
  if (!s.startsWith("[") || !s.endsWith("]") || s.length < 3) return 0;
  return s.split(",").length;
}

// ---------- Writer system prompt (all matters) ----------
// One unified builder drives every matter, including Depo-Provera (via DEFAULT_MATTER).
// Keeping a single source of truth prevents the Depo and non-Depo writer prompts from
// drifting apart as instructions evolve.
function buildWriterSystem(m: Matter): string {
  return `You are the Litigation Research Assistant for ${m.name}, MDL No. ${m.mdl_number}, pending in ${m.court}, before ${m.judge}. You support the attorneys and staff of plaintiffs' leadership, including Seeger Weiss LLP, co-lead counsel.

WHO YOU ARE WRITING FOR
You write for experienced litigators. Assume fluency with multidistrict-litigation practice, pretrial orders, case-management and common-benefit structures, threshold proof-of-use and proof-of-injury gating, and the procedural vocabulary of complex coordinated litigation. Do not explain elementary concepts or pad the answer with general legal education. Your value is precision, traceability, and disciplined synthesis of the actual record — the register of a careful associate writing to the partner who will rely on the work.

THE MATTER AND ITS RECORD
This is a single MDL proceeding governed by a closed set of controlling orders — Pretrial Orders ("PTO"), Case Management Orders ("CMO"), Common Benefit Orders ("CBO"), and the JPML transfer order — together with associated filings, a structured record index (orders, counsel of record, key dates), and, where relevant, a scientific and regulatory background layer (general-causation studies and FDA/EMA/WHO actions) that frames the litigation. These orders form a hierarchy in time: a later order can amend, supersede, or supplement an earlier one, and an obligation is current only if no later order has changed it. Hold that structure in mind as you read.

YOUR SOURCE OF TRUTH — THE PROVIDED MATERIAL
The material needed to answer has already been gathered and is provided to you below as citable search results, plus — where applicable — a structured record index. It is of two kinds: (1) THE MATTER RECORD — passages from this MDL's own docket (controlling orders, filings, and the scientific/regulatory background layer), and (2) EXTERNAL LEGAL AUTHORITY — published court opinions (case law) retrieved from CourtListener, identifiable because their title is a case citation and their source is a courtlistener.com URL. You answer ONLY from that provided material — both kinds. Do not rely on your own legal knowledge, outside facts, recollection of other litigation, half-remembered case names or holdings, or anything not present in what you were given. In particular, do NOT cite, quote, or paraphrase any case, statute, or rule that is not among the provided opinions — if you have not been handed the opinion, you do not have it. If the provided material does not contain the answer, say so plainly — never fill the gap with general knowledge, assumption, or inference beyond what the material supports. A precise "the provided material does not address that" is correct and valuable; a plausible fabrication — especially an invented or misremembered citation — is a serious failure.

A DELIBERATELY TARGETED RECORD SET
Passage retrieval for this question was intentionally focused — a small, high-precision set (up to 10 passages per search) rather than an exhaustive dump. Treat the provided passages as the focused evidence selected for this question, but do NOT assume they are complete. If the operative text, a specific subsection, an exact figure, or a date the question turns on is not present in what you were given, name that gap explicitly and tell the attorney where to look (e.g., "the full text of that order is not in the retrieved passages; consult the order directly on the docket"). Never extrapolate missing provisions from related ones. Partial coverage, clearly flagged, is the correct outcome — not a reason to reconstruct or guess.

EXTERNAL LEGAL AUTHORITY — CASE LAW, USED WITH DISCIPLINE
Where the question turns on a legal standard or doctrine, you may be given published court opinions as external authority. Use them, but keep their role distinct from the matter record:
  - DISTINGUISH the two registers explicitly. The matter's orders state what THIS proceeding requires; case law states what the governing LAW holds. Never blur them — do not describe a precedent as if it were an order of this court, and do not describe one of this MDL's orders as if it were external precedent. When both bear on a point (e.g. the court's Rule 702 schedule and the circuit's Daubert precedent), present the record obligation and the legal standard as separate, each cited to its own source.
  - WEIGHT authority honestly by court and posture, using only what the provided opinion states about itself (court, year, and that it was subsequently cited). Treat decisions of a higher court in the governing jurisdiction as controlling and others as persuasive, but do NOT assert that a specific precedent binds this MDL, or dictates how this court will rule, unless the matter record itself ties them together. Where the provided opinion is from another jurisdiction, say so and treat it as persuasive only.
  - CITE case law by its case name and reporter citation exactly as given in the provided opinion's title; never reconstruct or "correct" a citation from memory, and never add a parallel cite, pincite, or subsequent history that is not in the provided material. If the provided excerpt is only part of an opinion, cite it for the proposition the excerpt actually supports and note that the full opinion should be consulted before relying on it in a filing.
  - The opinions provided are those retrieved for this question; they are not a complete survey of the law. If the controlling authority on a point was not provided, say that the retrieved authority does not settle it rather than supplying a case from memory.

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

// ---------- Router system prompt builder (all matters; describes all six tools) ----------
function buildRouterSystem(m: Matter): string {
  return `You are the retrieval router for a litigation research assistant working the ${m.name} record (MDL No. ${m.mdl_number}, before ${m.judge}). You support the plaintiffs' leadership, including Seeger Weiss LLP, co-lead counsel.

YOUR JOB: read the user's question and gather the material a separate writer agent will need to answer it from the closed record — the controlling orders (PTOs, CMOs, CBOs) and the JPML transfer order, associated filings, and a scientific & regulatory background layer (described below). You do NOT write the answer, analysis, or summary. You ONLY call tools to collect the right material, then stop.

YOUR TOOLS
  1. search_the_record — semantic + keyword passage retrieval. Returns up to 10 fresh citable passages per call, and automatically pulls a few adjacent passages around the best hits so you get surrounding context for free. Your primary tool for what an order SAYS — its operative text, obligations, holdings, or defined terms — and for the scientific/regulatory background.
  2. read_order — the FULL text of one named order plus any amendment versions (read_order PTO 22 returns PTO 22 AND PTO 22A, date-ordered). Use when the question turns on an order's complete operative text, or to compare a base order against its amendment for precedence. Returns citable passages.
  3. list_orders — the complete list of controlling orders on this matter's docket (type, number, date, title, subject tags, source PDF). Use this for questions that enumerate or survey orders ("list the case management orders", "what CBOs exist", "every order on leadership"). It returns the full matching list, not a sample.
  4. list_deadlines — the matter's key dates and deadlines (date, category, title, who it affects, source order). Use this for calendar/deadline questions ("what hearings are coming up", "list the deadlines for plaintiffs").
  5. lookup_counsel — counsel of record (side, firm, attorney, contact). Use this for roster questions ("who represents the defendants", "list plaintiffs' counsel").
  6. search_caselaw — EXTERNAL published court opinions (federal/state case law via CourtListener), with full Bluebook citations and holding text. This is the ONLY tool that reaches OUTSIDE this matter's closed record. Use it when the question turns on what the LAW is — a doctrine, legal standard, or test (e.g. the Daubert/Rule 702 standard for expert admissibility, general-causation proof requirements, pleading standards, preemption, choice-of-law) — rather than on what this matter's own orders provide. Restrict to the controlling jurisdiction with court when you know it (this MDL sits in the Eleventh Circuit — court: "ca11" — and N.D. Fla. — court: "flnd"; the Supreme Court is "scotus"). Set most_cited: true to surface the leading authority on a settled doctrine.
Prefer the structured tools (3-5) when the question is fundamentally an enumeration or a roster/calendar lookup — they are complete and exact. Prefer search_the_record when the question turns on the language or substance of an order, or on the scientific/regulatory record; reach for read_order once you know the specific order whose full text or amendment history matters. You may combine tools across rounds (e.g., list_orders to find the right order, then read_order to pull its full text).

WHEN TO REACH OUTSIDE THE RECORD (search_caselaw): the matter tools (1-5) answer "what does this MDL require?"; search_caselaw answers "what does the governing law hold?". Use it when the question asks about a legal standard, the basis for a ruling, or how a court would analyze an issue — and especially when an attorney needs the controlling precedent behind an order (e.g. "what is the Daubert standard the court will apply at the Rule 702 hearing?" warrants both search_the_record for the matter's 702 schedule AND search_caselaw, court: "ca11", for the circuit's expert-admissibility precedent). Do NOT use it for the matter's own orders, deadlines, or roster. When a question has both a record facet and a law facet, fire the matter search and the caselaw search in PARALLEL in the same round. If a pure record question needs no external law, do not call it.

WORK IN PARALLEL: you may issue SEVERAL tool calls in a SINGLE round — they execute concurrently at no extra latency. When a question has distinct facets (e.g. two different provisions, an order plus its deadlines, a base order plus a science-layer question), fire one search per facet in the same round rather than serializing them across rounds. Issue independent retrievals together; reserve later rounds for follow-ups that genuinely depend on what an earlier round returned.

PASSAGE RETRIEVAL IS TARGETED: each search_the_record call returns up to 10 fresh passages. Spend your searches deliberately — every passage you gather persists and is handed to the writer, so build coverage progressively across rounds rather than trying to grab everything at once. Use a later round to fill a SPECIFIC gap left by an earlier one.

HOW search_the_record WORKS
Every search is automatically anchored to the semantic meaning of the user's question. You refine retrieval in two ways:
  1. filter — metadata constraints that narrow to the right kind of document or provision.
  2. keywords — exact terms or phrases to pin precise terminology (party names, defined terms, order numbers like "PTO 17", "Schedule A", "Daubert").

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
  - Use up to THREE rounds, but cover each round's independent facets in PARALLEL (multiple tool calls at once) rather than spreading them across rounds. Reserve later rounds for genuine follow-ups — pinning an exact term you just discovered, reading the full text of an order a search surfaced, or filling a specific gap.
  - For a single-issue question, one or two precise searches are usually enough. For a question that turns on several orders, provisions, dates, or parties, fan out across facets in the first round, then deepen.
  - Pull MORE when a thread is clearly load-bearing: if a search shows an order is central, follow up with read_order for its full text; if the question hinges on whether an order was amended, read the base and amendment together. Match retrieval depth to how much the answer depends on it.
  - Favor COVERAGE of what the question turns on: the order numbers, dates, deadlines, parties, defined terms, and — for background questions — the studies or regulatory actions it touches.
  - As soon as the gathered material is sufficient to answer comprehensively, STOP: reply with a brief one-line note that retrieval is complete and do NOT call a tool again. Do not write the answer or any analysis.
  - Never exceed three rounds.`;
}

// ---------- Tool schemas (JSON Schema) ----------
const SEARCH_TOOL_SCHEMA = {
  type: "object",
  properties: {
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
    k: { type: "integer", description: "How many fresh passages to retrieve (default 10, max 10)." },
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
  "relevant to the user's question. The semantic meaning of the user's question is applied automatically on every " +
  "call; use `keywords` to pin exact terminology and `filter` to constrain by document metadata. Returns up to 10 " +
  "fresh citable passages with order, page, and section, plus a little adjacent context. Call up to three times.";

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
    order_type: { type: "string", enum: ["PTO", "CMO", "CBO", "JPML", "OTHER"] },
    order_number: {
      type: "string",
      description:
        "The order's number, e.g. '22'. Lettered amendment versions are included automatically " +
        "(read_order PTO 22 returns PTO 22 and PTO 22A). Omit to read every order of the given type.",
    },
  },
};

const CASELAW_TOOL_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "The legal issue, doctrine, or standard to research as natural language (e.g. " +
        "'Daubert standard for general causation expert testimony', 'Rule 702 reliability of " +
        "epidemiological evidence'). Drives semantic + keyword matching over published opinions.",
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

// v30: Tavily-backed web search, scoped to reputable legal + regulatory + scientific
// sources by a server-side domain allowlist. Kept small (max 8 results, ~2KB excerpt each)
// so the writer context stays sane.
const WEB_TOOL_SCHEMA = {
  type: "object",
  properties: {
    query: {
      type: "string",
      description:
        "Natural-language web query for a targeted lookup on reputable legal, regulatory, or " +
        "scientific sources (e.g. 'Eleventh Circuit Daubert general causation meningioma', " +
        "'FDA Depo-Provera label change intracranial meningioma', 'NEJM medroxyprogesterone " +
        "meningioma cohort study'). Results are restricted server-side to an allowlist of " +
        "courts, uscourts.gov, fda.gov, ema.europa.eu, who.int, NIH/PubMed, NEJM, JAMA, " +
        "Lancet, BMJ, Law360, Bloomberg Law, and SSRN — any other domain is dropped.",
    },
    published_after: { type: "string", description: "Optional YYYY-MM-DD lower bound (Tavily days-back)." },
    max_results: { type: "integer", description: "Cap results (default 8, max 8)." },
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
        "matter's own orders say. Restrict to the governing jurisdiction with `court` when known (e.g. the " +
        "circuit that controls this MDL). Returns citable opinions with full Bluebook citations and holding " +
        "text. Do NOT use it for the matter's own PTOs/CMOs/CBOs — use search_the_record / read_order for those.",
      parameters: CASELAW_TOOL_SCHEMA,
    },
  },
  {
    type: "function",
    function: {
      name: "read_order",
      description:
        "Pull the FULL text of a specific controlling order — all its passages in order — together with any " +
        "amendment versions (e.g. read_order PTO 22 returns PTO 22 AND its amendment PTO 22A, date-ordered). Use " +
        "when the question turns on the complete operative text of a named order, or to compare an order against its " +
        "amendment for temporal precedence. Returns citable passages, like search_the_record.",
      parameters: READ_ORDER_TOOL_SCHEMA,
    },
  },
  {
    type: "function",
    function: {
      name: "list_orders",
      description:
        "List the controlling orders on this matter's docket (PTOs, CMOs, CBOs, and the JPML transfer order), with " +
        "number, date, title, subject tags, and source PDF. Use for enumerations and surveys of orders. Returns the " +
        "full matching list (not a sample).",
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
  {
    type: "function",
    function: {
      name: "search_web",
      description:
        "Targeted web search over REPUTABLE legal, regulatory, and scientific sources ONLY " +
        "(CourtListener, uscourts.gov, Cornell LII, Justia, FDA/EMA/WHO, NIH/PubMed, NEJM, " +
        "JAMA, Lancet, BMJ, Law360, Bloomberg Law, SSRN). Use SPARINGLY, and ONLY when the " +
        "matter record and search_caselaw are insufficient — e.g. very recent regulatory " +
        "actions or agency guidance, secondary commentary on a doctrine, or a peer-reviewed " +
        "study the corpus does not include. Results are provisional context, not a substitute " +
        "for the matter record or published case law. Any non-allowlisted domain is dropped.",
      parameters: WEB_TOOL_SCHEMA,
    },
  },
];

const STRUCTURED_TOOLS = new Set(["list_orders", "lookup_counsel", "list_deadlines"]);

// ---------- helpers ----------

// Sentence splitter, shared by the citable search-result blocks AND the UI chunk payload,
// so citation block indices map 1:1 to displayed sentences.
function splitSentences(text: string): string[] {
  const norm = (text ?? "").replace(/\s+/g, " ").trim();
  if (!norm) return [];
  const raw = norm.split(/(?<=[.?!])\s+(?=[A-Z("'\u201c])/);
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
  return c.page_start === c.page_end ? `p.${c.page_start}` : `p.${c.page_start}\u2013${c.page_end}`;
}

// Merge UI-applied filters (hard constraints) over the model's filter. UI keys always win.
function mergeFilters(initial: any, model: any): any {
  const m = (model && typeof model === "object") ? { ...model } : {};
  const i = (initial && typeof initial === "object") ? initial : {};
  return { ...m, ...i };
}

// Generic PostgREST RPC call against the same Supabase (service role).
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

// Build the Anthropic citable search_result block AND the UI chunk payload from one DB
// row. Shared by hybrid_search_v2, expand_neighbors, and order_chunks so every retrieval
// path produces identical shapes. `extra` carries provenance flags (e.g. { neighbor: true }).
function mapRow(r: any, extra: Record<string, unknown> = {}): { searchResult: any; chunk: any } {
  const sentences = splitSentences(r.content);
  const label = orderLabel(r);
  const page = pageCite(r);
  const title = `${label}${page ? " \u00b7 " + page : ""}`;
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

// Take fresh (unseen) rows up to `limit`, registering them in `seen` and respecting the
// global ceiling. Shared by every retrieval path so dedup + cap behave identically.
function collectRows(rows: any[], seen: Set<string>, limit: number, extra: Record<string, unknown> = {}) {
  const searchResults: any[] = [];
  const chunks: any[] = [];
  const ids: string[] = [];
  for (const r of rows) {
    if (chunks.length >= limit) break;
    if (seen.has(r.id)) continue;
    if (seen.size >= MAX_TOTAL_CHUNKS) break;
    seen.add(r.id);
    const { searchResult, chunk } = mapRow(r, extra);
    searchResults.push(searchResult);
    chunks.push(chunk);
    ids.push(r.id);
  }
  return { searchResults, chunks, ids };
}

// Call hybrid_search_v2 on the same Supabase, scoped to the matter's case_id. Returns new
// (deduped) chunks plus `hitIds` (top fresh hits in score order, for neighbor expansion).
// `displayFilter` is the user-applied filter (shown in the UI); `caseId` is injected into
// the RPC filter only, so it never appears in the UI filter chips.
async function runSearch(
  input: any,
  embedding: string,
  question: string,
  displayFilter: any,
  caseId: string,
  seen: Set<string>,
): Promise<{ searchResults: any[]; chunks: any[]; rawCount: number; hitIds: string[] }> {
  const keywords = (input?.keywords && String(input.keywords).trim()) || question;
  const filter = { ...mergeFilters(displayFilter, input?.filter), case_id: caseId };
  let k = Number.isFinite(input?.k) ? Math.floor(input.k) : PER_SEARCH_K;
  k = Math.max(1, Math.min(PER_SEARCH_K, k));

  // Overfetch then dedup: hybrid_search_v2 is deterministic, so a near-identical query in a
  // later round returns the same top rows — which are already in `seen` and would net ZERO
  // new passages. Asking the RPC for more than k (bounded by its internal 50-row pools) lets
  // us skip the already-seen rows and still hand back up to k FRESH passages per call.
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
  const { searchResults, chunks, ids } = collectRows(rows, seen, k);
  return { searchResults, chunks, rawCount: rows.length, hitIds: ids };
}

// Neighbor/sibling expansion: pull the chunks adjacent (chunk_index +/- NEIGHBOR_WINDOW,
// same document) to a set of center hits, so the writer sees contiguous context instead of
// isolated snippets. Positional — no embedding needed.
async function expandNeighbors(
  caseId: string,
  centerIds: string[],
  seen: Set<string>,
): Promise<{ searchResults: any[]; chunks: any[] }> {
  if (!centerIds.length || seen.size >= MAX_TOTAL_CHUNKS) return { searchResults: [], chunks: [] };
  // Expand each center separately (in parallel) so every neighbor records which hit it sits
  // next to (parent_ref) — the UI folds neighbors under their parent passage. A neighbor
  // adjacent to two centers is claimed by whichever is collected first (seen-dedup).
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

// Read the full text of a named order plus any amendment versions (PTO 22 -> 22 + 22A),
// ordered by date then position. Citable passages, handed to the writer like search hits.
async function runReadOrder(
  input: any,
  caseId: string,
  seen: Set<string>,
): Promise<{ searchResults: any[]; chunks: any[]; count: number; versions: string[] }> {
  const a = (input && typeof input === "object") ? input : {};
  const orderType = a.order_type ? String(a.order_type).toUpperCase() : null;
  const stem = (a.order_number != null && String(a.order_number).trim()) ? String(a.order_number).trim() : null;
  if (!orderType && !stem) throw new Error("read_order needs an order_type and/or order_number");
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

// HTTP GET against the CourtListener REST API. Sends the token when configured; bounded by
// a hard timeout so a slow upstream can never hang the whole synthesis stream.
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

// Title-case an ALL-CAPS party string (CourtListener stores many case names in caps), while
// leaving normally-cased names untouched. Keeps short connectors ("v.", "of", "the") lower.
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

// Pick the official reporter citation from CourtListener's citation array, skipping
// vendor-neutral DB cites (Westlaw "WL", LexisNexis "LEXIS", "U.S. App. LEXIS").
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

// Full Bluebook-style citation: "Guinn v. AstraZeneca Pharmaceuticals LP, 602 F.3d 1245 (11th Cir. 2010)".
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

// Shorter label for the evidence card / citation chip: "Guinn, 602 F.3d 1245 (11th Cir. 2010)".
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

// Fetch a bounded plain-text excerpt of one opinion (best effort; returns "" on any failure).
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

// search_caselaw: query CourtListener Opinions for external legal authority, map each hit to a
// citable Anthropic search_result block + a UI chunk (kind: "caselaw"). Holding text for the
// top hits is pulled in parallel; the rest fall back to the keyword-matched search snippet.
async function runCaselawSearch(
  input: any,
  question: string,
  seen: Set<string>,
): Promise<{ searchResults: any[]; chunks: any[]; count: number; total: number; unavailable?: string }> {
  if (!COURTLISTENER_API_KEY) {
    return { searchResults: [], chunks: [], count: 0, total: 0, unavailable: "COURTLISTENER_API_KEY not configured" };
  }
  const a = (input && typeof input === "object") ? input : {};
  const q = (a.query && String(a.query).trim()) || (a.keywords && String(a.keywords).trim()) || question;
  const params: Record<string, string | undefined> = {
    type: "o",
    q,
    order_by: a.most_cited ? "citeCount desc" : "score desc",
    court: a.court ? String(a.court).toLowerCase() : undefined,
    filed_after: a.filed_after ? String(a.filed_after) : undefined,
    filed_before: a.filed_before ? String(a.filed_before) : undefined,
    stat_Published: "on",
  };
  const data = await clFetch("/search/", params);
  const total = Number.isFinite(data?.count) ? data.count : 0;
  const raw: any[] = Array.isArray(data?.results) ? data.results.slice(0, CASELAW_MAX_RESULTS) : [];

  // Pull fuller holding text for the top N (parallel, best effort).
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

// Run a structured (case-scoped) tool. Returns text for the router (compact) and the
// writer (record-index block), plus a count for the UI trace.
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

// ---------- Gemini router turn (OpenAI-compatible streaming) ----------
// Streams the router's stated rationale as `thinking` events; returns any tool calls.
async function geminiRouterRound(
  messages: any[],
  round: number,
  emit: (o: any) => void,
): Promise<{ rationale: string; toolCalls: { id: string; name: string; args: any; rawArgs: string }[]; finish: string | null }> {
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${GEMINI_API_KEY}`, "Content-Type": "application/json" },
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
    throw new ApiError(`Gemini router ${res.status}: ${t.slice(0, 400)}`, res.status, raMs);
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
      let args: any = {};
      try { args = c.args ? JSON.parse(c.args) : {}; } catch { args = {}; }
      return { id: c.id || `call_${round}_${i}`, name: c.name || "search_the_record", args, rawArgs: c.args || "{}" };
    });

  return { rationale, toolCalls, finish };
}

// Compact, model-facing summary of a passage search result (keeps the router's context lean).
function compactResults(chunks: any[], totalSeen: number, round: number): string {
  const meta = `(gathered ${totalSeen}/${MAX_TOTAL_CHUNKS} passages; round ${round}/${MAX_ROUNDS})`;
  if (!chunks.length) return `No NEW passages — this query duplicated passages already gathered, or the filter is too narrow. Do not repeat it; change the keywords or relax/remove a filter. ${meta}`;
  const lines = chunks.map((c) => {
    const page = c.page_start != null ? ` p.${c.page_start}` : "";
    const sec = c.section_label ? ` ${c.section_label}` : "";
    const snip = (Array.isArray(c.sentences) ? c.sentences.join(" ") : "").slice(0, 240);
    return `- [${c.order_label}${page}]${sec}: ${snip}`;
  });
  return `Found ${chunks.length} new passage(s):\n${lines.join("\n")}\n${meta}`;
}

// ---------- Anthropic streaming turn (the writer) ----------
async function streamTurn(
  body: any,
  round: number,
  emit: (o: any) => void,
  emittedResults: any[],
  onAnswerText: (t: string) => void,
  onCitation: () => void,
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
          b.citations.push(c); onCitation();
          const r = emittedResults[c.search_result_index];
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

// ============================================================================
// v30: multi-agent helpers — Tavily web search, Voyage rerank, Planner, Critic, Verifier
// ============================================================================

// ---------- Tavily web sub-agent ----------
function domainOf(url: string): string {
  try { return new URL(url).hostname.toLowerCase().replace(/^www\./, ""); } catch { return ""; }
}
function isAllowlistedDomain(host: string): boolean {
  if (!host) return false;
  return WEB_ALLOWED_DOMAINS.some((d) => host === d || host.endsWith("." + d));
}

async function tavilySearch(query: string, maxResults: number, daysBack?: number): Promise<any[]> {
  if (!TAVILY_API_KEY) return [];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TAVILY_TIMEOUT_MS);
  try {
    const body: Record<string, unknown> = {
      api_key: TAVILY_API_KEY,
      query,
      search_depth: "advanced",
      max_results: Math.max(1, Math.min(WEB_MAX_RESULTS, maxResults)),
      include_answer: false,
      include_raw_content: false,
      include_domains: WEB_ALLOWED_DOMAINS,
    };
    if (Number.isFinite(daysBack) && (daysBack as number) > 0) body.days = daysBack;
    const resp = await fetch(TAVILY_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`Tavily ${resp.status}: ${t.slice(0, 200)}`);
    }
    const data = await resp.json();
    return Array.isArray(data?.results) ? data.results : [];
  } finally {
    clearTimeout(timer);
  }
}

// Wraps Tavily into the same {searchResults, chunks, count} shape as the other tools.
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
  const maxR = Number.isFinite(a.max_results) ? Math.floor(a.max_results) : WEB_MAX_RESULTS;
  let daysBack: number | undefined;
  if (a.published_after) {
    const ms = Date.parse(String(a.published_after));
    if (Number.isFinite(ms)) daysBack = Math.max(1, Math.ceil((Date.now() - ms) / 86400000));
  }
  let raw: any[] = [];
  try { raw = await tavilySearch(q, maxR, daysBack); }
  catch (e) { return { searchResults: [], chunks: [], count: 0, unavailable: (e as Error).message }; }

  const searchResults: any[] = [];
  const chunks: any[] = [];
  let count = 0;
  for (const r of raw) {
    const url = String(r?.url ?? "").trim();
    if (!url) continue;
    const host = domainOf(url);
    if (!isAllowlistedDomain(host)) continue; // defense in depth
    const ref = `web:${url}`;
    if (seen.has(ref)) continue;
    if (seen.size >= MAX_TOTAL_CHUNKS) break;
    seen.add(ref);
    const title = String(r?.title ?? "").replace(/\s+/g, " ").trim() || host;
    const content = String(r?.content ?? "").replace(/\s+/g, " ").trim().slice(0, WEB_EXCERPT_CHARS);
    const published = r?.published_date ? String(r.published_date).slice(0, 10) : null;
    const header = `${title} — ${host}${published ? ` (${published})` : ""}. Source: ${url}`;
    const bodySents = content ? splitSentences(content) : [];
    const sentences = [header, ...bodySents];
    searchResults.push({
      type: "search_result",
      source: url,
      title,
      content: sentences.map((s) => ({ type: "text", text: s })),
      citations: { enabled: true },
    });
    chunks.push({
      ref,
      kind: "web",
      order_label: `${host}${published ? ` · ${published}` : ""}`,
      case_name: title,
      full_citation: `${title}, ${host}${published ? ` (${published})` : ""}`,
      court: null,
      case_date: published,
      cite_count: null,
      status: null,
      docket_number: null,
      page_start: null,
      page_end: null,
      pdf_url: url,
      excerpted: !!content,
      sentences,
    });
    count++;
  }
  return { searchResults, chunks, count };
}

// ---------- Voyage rerank-2 ----------
// Takes gathered record passages and reranks them against the question. Returns a new
// ordering (best->worst) with rerank scores. Web + caselaw chunks bypass rerank (they
// have their own relevance signal — Tavily rank and CourtListener score/cite count).
async function voyageRerank(
  question: string,
  items: { text: string; idx: number }[],
): Promise<{ idx: number; score: number }[]> {
  if (!VOYAGE_API_KEY || items.length <= 1) return items.map((it) => ({ idx: it.idx, score: 0 }));
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), RERANK_TIMEOUT_MS);
  try {
    const resp = await fetch(RERANK_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Authorization": `Bearer ${VOYAGE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        query: question.slice(0, 2000),
        documents: items.map((it) => it.text.slice(0, 4000)),
        model: RERANK_MODEL,
        top_k: items.length,
        truncation: true,
      }),
    });
    if (!resp.ok) return items.map((it) => ({ idx: it.idx, score: 0 }));
    const data = await resp.json();
    const results = Array.isArray(data?.data) ? data.data : [];
    return results.map((r: any) => ({
      idx: items[r.index]?.idx ?? 0,
      score: Number.isFinite(r.relevance_score) ? r.relevance_score : 0,
    }));
  } catch {
    return items.map((it) => ({ idx: it.idx, score: 0 }));
  } finally {
    clearTimeout(timer);
  }
}

// ---------- Gemini JSON call (Planner / Critic / Verifier) ----------
// Non-streaming Gemini call via the OpenAI-compatible endpoint, returning parsed JSON.
// Uses response_format: json_object for reliable structured output.
async function geminiJson(
  model: string,
  system: string,
  user: string,
  maxTokens = 2048,
): Promise<any> {
  const res = await fetch(GEMINI_URL, {
    method: "POST",
    headers: { "Authorization": `Bearer ${GEMINI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      temperature: 0,
      max_tokens: maxTokens,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new ApiError(`${model} ${res.status}: ${t.slice(0, 300)}`, res.status, null);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content ?? "";
  try { return JSON.parse(content); } catch {
    // salvage: some models wrap JSON in fences
    const m = content.match(/\{[\s\S]*\}/);
    if (m) { try { return JSON.parse(m[0]); } catch { /* fall through */ } }
    throw new Error(`${model} returned non-JSON output`);
  }
}

// ---------- PLANNER ----------
type Facet = {
  id: string;
  question: string;
  hypothesis: string;      // HyDE passage — a short hypothetical answer used as an extra embedding
  specialists: string[];   // subset of: search_the_record, read_order, list_orders, lookup_counsel, list_deadlines, search_caselaw, search_web
  keywords?: string[];
  court?: string;
};

async function runPlanner(question: string, matter: Matter): Promise<{ facets: Facet[]; rationale: string }> {
  const system = `You are the PLANNER for a multi-agent litigation research assistant working the ${matter.name} record (MDL No. ${matter.mdl_number}, before ${matter.judge}).

Decompose the attorney's question into 1–4 independent research FACETS. For each facet, produce:
  - id: short slug (e.g. "record_daubert_schedule", "ca11_daubert_precedent", "fda_label_update")
  - question: the focused sub-question this facet answers
  - hypothesis: a 1–3 sentence HYPOTHETICAL answer (HyDE) — the kind of passage that would answer this facet if it existed in the record. Written in the register of a litigation memo. This is used verbatim as an extra semantic-search query, so make it substantive.
  - specialists: which retrieval tools to run. Available: search_the_record (matter passages), read_order (full text of a named order), list_orders / list_deadlines / lookup_counsel (structured docket index), search_caselaw (external published opinions via CourtListener), search_web (reputable-only web search: fda.gov, ema.europa.eu, who.int, NIH/PubMed, NEJM, JAMA, Lancet, BMJ, Law360, Bloomberg Law, SSRN, uscourts.gov).
  - keywords (optional): 1–5 exact terms/phrases to pin (e.g. ["PTO 22", "Daubert"])
  - court (optional): jurisdiction code for search_caselaw, if applicable ("ca11", "flnd", "scotus")

Rules:
  * Prefer record + case_law for anything that turns on an order or a legal standard.
  * Reach for search_web ONLY for very recent regulatory action, agency guidance, or peer-reviewed studies unlikely to be in the corpus. Never for the matter's own orders.
  * For a simple single-issue question, emit ONE facet — don't over-decompose.
  * When several facets are independent, they will be executed in PARALLEL.
  * Never invent case names, statute cites, or PTO numbers.

Return ONLY JSON of the shape: { "rationale": "1–2 sentences on the decomposition", "facets": [ ... ] }`;
  try {
    const out = await geminiJson(PLANNER_MODEL, system, question, 2048);
    const facets = Array.isArray(out?.facets) ? out.facets : [];
    const normalized: Facet[] = facets.slice(0, 4).map((f: any, i: number) => ({
      id: String(f?.id ?? `facet_${i + 1}`).slice(0, 64),
      question: String(f?.question ?? question).trim(),
      hypothesis: String(f?.hypothesis ?? "").trim(),
      specialists: Array.isArray(f?.specialists) ? f.specialists.map((s: any) => String(s)) : ["search_the_record"],
      keywords: Array.isArray(f?.keywords) ? f.keywords.map((k: any) => String(k)) : undefined,
      court: f?.court ? String(f.court) : undefined,
    }));
    return { facets: normalized.length ? normalized : [{ id: "default", question, hypothesis: "", specialists: ["search_the_record"] }], rationale: String(out?.rationale ?? "") };
  } catch {
    // Planner failure is non-fatal: fall back to a single default facet so the existing
    // router loop still runs the question with its normal heuristics.
    return { facets: [{ id: "default", question, hypothesis: "", specialists: ["search_the_record"] }], rationale: "" };
  }
}

// ---------- CRITIC ----------
async function runCritic(
  question: string,
  facets: Facet[],
  gatheredSummary: string,
): Promise<{ done: boolean; missing: string[]; followup: string }> {
  const system = `You are the CRITIC in a multi-agent litigation research pipeline. Given the attorney's question, the PLANNER's facets, and a summary of what has been gathered so far, decide whether retrieval is complete.

Return ONLY JSON: { "done": boolean, "missing": [facet_ids...], "followup": "one short paragraph telling the router what specific gap(s) to fill, or empty string if done" }

Be strict about coverage but tolerate reasonable substitution (a related order that answers the question is fine). If done, set done=true, missing=[], followup="". If not done, name the specific gap in one paragraph — an order to read, a deadline missing from the index, a case-law precedent the answer needs, a regulatory action to look up on the web.`;
  const user = `Question: ${question}\n\nPlanner facets:\n${facets.map((f) => `- ${f.id}: ${f.question} [specialists: ${f.specialists.join(", ")}]`).join("\n")}\n\nGathered so far:\n${gatheredSummary || "(nothing)"}`;
  try {
    const out = await geminiJson(CRITIC_MODEL, system, user, 1024);
    return {
      done: !!out?.done,
      missing: Array.isArray(out?.missing) ? out.missing.map((s: any) => String(s)) : [],
      followup: String(out?.followup ?? "").trim(),
    };
  } catch {
    return { done: true, missing: [], followup: "" };
  }
}

// ---------- VERIFIER ----------
// Post-writer citation-grounding pass. Advisory only in Phase A — the writer output is NOT
// rewritten; unsupported sentences are surfaced as a `verify` SSE event so the UI can flag
// them and the attorney can spot-check.
async function runVerifier(
  question: string,
  answer: string,
  citedRefs: string[],
): Promise<{ unsupported: string[]; notes: string }> {
  if (!answer.trim()) return { unsupported: [], notes: "" };
  const system = `You are the VERIFIER in a multi-agent litigation research pipeline. Check whether each sentence in the WRITER's answer is grounded in the material that was provided to the writer. The writer streamed inline citations to source passages; only sentences with no supporting citation, or sentences that clearly overreach beyond a cited passage, count as UNSUPPORTED. Be strict but not pedantic — a topic sentence that summarizes a paragraph does not need its own citation if the following sentences are cited.

Return ONLY JSON: { "unsupported": ["short verbatim quote of each unsupported sentence, max 3"], "notes": "one short paragraph, empty if all grounded" }`;
  const user = `Question: ${question}\n\nWriter answer (as streamed, may include inline superscript citations):\n${answer.slice(0, 12000)}\n\nCited source refs (${citedRefs.length}): ${citedRefs.slice(0, 60).join(", ")}`;
  try {
    const out = await geminiJson(VERIFIER_MODEL, system, user, 1024);
    return {
      unsupported: Array.isArray(out?.unsupported) ? out.unsupported.slice(0, 3).map((s: any) => String(s)) : [],
      notes: String(out?.notes ?? "").trim(),
    };
  } catch {
    return { unsupported: [], notes: "" };
  }
}

// Reranks the record passages (skipping web + caselaw, which have their own scoring),
// keeps top MAX_WRITER_CHUNKS, and returns the reordered arrays. Also returns a boolean
// indicating whether rerank ran (false = fallback / not enough items).
async function rerankAndTrim(
  question: string,
  emittedResults: any[],
  allSearchResults: any[],
): Promise<{ chunks: any[]; results: any[]; ran: boolean; kept: number; dropped: number }> {
  const total = emittedResults.length;
  if (total <= MAX_WRITER_CHUNKS && total <= 12) {
    return { chunks: emittedResults, results: allSearchResults, ran: false, kept: total, dropped: 0 };
  }
  // Only rerank record passages (kind is undefined). Web + caselaw pass through in place.
  const recordItems: { text: string; idx: number }[] = [];
  const nonRecord: number[] = [];
  emittedResults.forEach((c, idx) => {
    if (c.kind === "web" || c.kind === "caselaw") { nonRecord.push(idx); return; }
    const text = (Array.isArray(c.sentences) ? c.sentences.join(" ") : "").slice(0, 4000);
    recordItems.push({ text, idx });
  });
  const scored = await voyageRerank(question, recordItems);
  if (!scored.length) return { chunks: emittedResults, results: allSearchResults, ran: false, kept: total, dropped: 0 };
  // Keep all non-record; then top-N record by rerank score, up to MAX_WRITER_CHUNKS total.
  const budgetForRecord = Math.max(0, MAX_WRITER_CHUNKS - nonRecord.length);
  const sortedRecordIdx = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, budgetForRecord)
    .map((s) => s.idx);
  const keepSet = new Set<number>([...nonRecord, ...sortedRecordIdx]);
  // Preserve original ordering for stable citation numbering.
  const chunks: any[] = [];
  const results: any[] = [];
  emittedResults.forEach((c, idx) => {
    if (!keepSet.has(idx)) return;
    chunks.push(c);
    results.push(allSearchResults[idx]);
  });
  return { chunks, results, ran: true, kept: chunks.length, dropped: total - chunks.length };
}

// ---------- handler ----------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

  let payload: any;
  try { payload = await req.json(); } catch { return new Response("Bad JSON", { status: 400, headers: CORS }); }
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

  // v28: a client-supplied embedding is honored only when it is already in the corpus's
  // vector space (1024-dim voyage-law-2); anything else (including legacy 384-dim bge
  // vectors from older frontends) is ignored and the function embeds the question itself.
  const hasClientVec = vecDims(clientEmbedding) === 1024;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (o: any) => {
        try { controller.enqueue(encoder.encode(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`)); } catch { /* closed */ }
      };

      const missing: string[] = [];
      if (!GEMINI_API_KEY) missing.push("GEMINI_API_KEY");
      if (!ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
      if (!hasClientVec && !VOYAGE_API_KEY) missing.push("VOYAGE_API_KEY");
      if (missing.length) {
        emit({ type: "error", message: `${missing.join(" and ")} not set. Add ${missing.length > 1 ? "them" : "it"} in Supabase → Project Settings → Edge Functions → Secrets, then retry.` });
        emit({ type: "done", rounds: 0, chunk_count: 0, citation_count: 0 });
        controller.close();
        return;
      }

      // Resolve the query embedding (server-side voyage-law-2 unless the client already
      // supplied a 1024-dim vector). v29: one retry on transient Voyage failures — an
      // embedding failure here previously killed the run before any retrieval happened.
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

      const emittedResults: any[] = [];   // UI chunks, in citation-index order
      const allSearchResults: any[] = []; // Anthropic search_result blocks, same order
      const recordIndexBlocks: string[] = []; // structured-tool output for the writer
      const seen = new Set<string>();
      const searchesLog: any[] = [];
      let rounds = 0, answerText = "", citationCount = 0, finalErr: string | null = null;
      let writerModelUsed = MODEL;

      let userText = question;
      if (initialFilter && Object.keys(initialFilter).length) {
        userText += `\n\n[The user applied these filters in the interface; they are enforced on every search and may not be removed: ${JSON.stringify(initialFilter)}.]`;
      }

      // ----- Phase 1: Gemini router gathers the record -----
      // History is plain text (rationale + compact results), never replayed tool-call parts,
      // so Gemini 3's thought_signature requirement never triggers. Router failures are
      // non-fatal: we fall through to the writer with whatever was gathered. v29: a
      // transient router failure is retried ONCE per round before falling through.
      const routerMessages: any[] = [
        { role: "system", content: routerSystem },
        { role: "user", content: userText },
      ];

      while (rounds < MAX_ROUNDS) {
        const round = rounds + 1;
        emit({ type: "round", round });
        let r: { rationale: string; toolCalls: any[]; finish: string | null } | null = null;
        try {
          r = await geminiRouterRound(routerMessages, round, emit);
        } catch (e1) {
          if (isRetryableError(e1)) {
            await sleep(retryDelayMs(1, e1));
            try {
              r = await geminiRouterRound(routerMessages, round, emit);
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

        // Classify the round's tool calls, then ANNOUNCE them in order (instant) so the
        // research trace reads top-to-bottom even though the retrievals run concurrently.
        const calls = r.toolCalls.map((t) => ({
          name: t.name as string,
          input: (t.args && typeof t.args === "object") ? t.args : {},
        }));
        for (const c of calls) {
          if (STRUCTURED_TOOLS.has(c.name)) emit({ type: "tool", round, tool: c.name, args: c.input });
          else if (c.name === "read_order") emit({ type: "tool", round, tool: "read_order", args: c.input });
          else if (c.name === "search_caselaw") emit({ type: "tool", round, tool: "search_caselaw", args: c.input });
          else if (c.name === "search_web") emit({ type: "tool", round, tool: "search_web", args: c.input });
          else emit({ type: "search", round, keywords: c.input.keywords ?? null, filter: mergeFilters(initialFilter, c.input.filter), k: PER_SEARCH_K });
        }

        // Run every call in this round in PARALLEL. Dedup stays correct: each task folds its
        // rows into `seen` inside a synchronous loop (no awaits), so the loops never interleave.
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
            if (c.name === "search_web") {
              return { kind: "web" as const, c, wb: await runWebSearch(c.input, question, seen) };
            }
            const sr = await runSearch(c.input, embedding, question, initialFilter, caseId, seen);
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

        // Fold results in announce order: emit chunks, build the router's result text, log.
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
              emit({ type: "tool", round, tool: "search_caselaw", count: 0, done: true });
              emit({ type: "tool_error", round, tool: "search_caselaw", message: `Case-law search unavailable: ${s.cl.unavailable}.` });
              resultBlocks.push(`search_caselaw is unavailable (${s.cl.unavailable}); proceed with the matter record only and note that external case law was not consulted.`);
            } else {
              for (const ch of s.cl.chunks) emittedResults.push(ch);
              for (const b of s.cl.searchResults) allSearchResults.push(b);
              searchesLog.push({ round, tool: "search_caselaw", args: s.c.input, returned: s.cl.count });
              emit({ type: "chunks", round, chunks: s.cl.chunks });
              emit({ type: "tool", round, tool: "search_caselaw", count: s.cl.count, done: true });
              const lines = s.cl.chunks.map((c: any) => `- ${c.full_citation}${c.cite_count != null ? ` (cited ${c.cite_count}\u00d7)` : ""}`);
              const moreNote = s.cl.total > s.cl.count ? ` of ${s.cl.total} matching` : "";
              resultBlocks.push(
                s.cl.count
                  ? `search_caselaw found ${s.cl.count} published opinion(s)${moreNote} (external legal authority):\n${lines.join("\n")}`
                  : `search_caselaw returned no opinions for that query; try a broader query or remove the court restriction.`,
              );
            }
            }
          } else if (s.kind === "web") {
            if (s.wb.unavailable) {
              emit({ type: "tool", round, tool: "search_web", count: 0, done: true });
              emit({ type: "tool_error", round, tool: "search_web", message: `Web search unavailable: ${s.wb.unavailable}.` });
              resultBlocks.push(`search_web is unavailable (${s.wb.unavailable}); proceed without web sources.`);
            } else {
              for (const ch of s.wb.chunks) emittedResults.push(ch);
              for (const b of s.wb.searchResults) allSearchResults.push(b);
              searchesLog.push({ round, tool: "search_web", args: s.c.input, returned: s.wb.count });
              emit({ type: "chunks", round, chunks: s.wb.chunks });
              emit({ type: "tool", round, tool: "search_web", count: s.wb.count, done: true });
              for (const ch of s.wb.chunks) {
                emit({ type: "web_result", round, title: ch.case_name ?? ch.order_label, url: ch.pdf_url, published: ch.case_date });
              }
              const lines = s.wb.chunks.map((c: any) => `- ${c.full_citation}`);
              resultBlocks.push(
                s.wb.count
                  ? `search_web found ${s.wb.count} reputable web source(s):\n${lines.join("\n")}`
                  : `search_web returned no allowlisted results for that query; either the reputable sources didn't surface it, or the domain filter dropped everything.`,
              );
            }
          } else if (s.kind === "search") {
            for (const ch of s.sr.chunks) emittedResults.push(ch);
            for (const b of s.sr.searchResults) allSearchResults.push(b);
            searchesLog.push({ round, keywords: s.c.input.keywords ?? null, filter: s.c.input.filter ?? null, k: PER_SEARCH_K, returned: s.sr.chunks.length, expanded: s.exp.chunks.length });
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
            const structuredLike = s.c.name === "read_order" || s.c.name === "search_caselaw" || STRUCTURED_TOOLS.has(s.c.name);
            if (structuredLike) emit({ type: "tool_error", round, tool: s.c.name, message: s.message });
            else emit({ type: "search_error", round, message: s.message });
            resultBlocks.push(`${s.c.name} error: ${s.message}`);
          }
        }

        emit({ type: "round_end", round, stop_reason: "tool_use" });
        if (seen.size >= MAX_TOTAL_CHUNKS) break;

        // Feed results back as plain text; let the router refine or stop.
        routerMessages.push({
          role: "user",
          content: `${resultBlocks.join("\n\n")}\n\nIf the gathered material is sufficient to fully answer the question, reply with a brief one-line note that retrieval is complete and do NOT call a tool. Otherwise, gather what is still missing — issue parallel calls if several gaps are independent, use read_order to pull an order's full text or its amendment, and relax filters where a narrow one came up short. Do NOT repeat a search you already ran; change the keywords, filter, or tool so it returns NEW material.`,
        });
      }

      // Safety net: if nothing at all was gathered (no passages and no structured data),
      // run one default semantic search so the writer is never starved.
      if (!allSearchResults.length && !recordIndexBlocks.length) {
        emit({ type: "search", round: rounds, keywords: null, filter: initialFilter, k: PER_SEARCH_K });
        try {
          const sr = await runSearch({ k: PER_SEARCH_K }, embedding, question, initialFilter, caseId, seen);
          for (const ch of sr.chunks) emittedResults.push(ch);
          for (const b of sr.searchResults) allSearchResults.push(b);
          emit({ type: "chunks", round: rounds, chunks: sr.chunks });
        } catch (e) {
          emit({ type: "search_error", round: rounds, message: (e as Error).message });
        }
      }

      // ----- Phase 2: Opus 4.8 writer synthesizes with citations (extended thinking ON) -----
      // v29: wrapped in a bounded retry loop. Transient upstream failures (429/5xx/529 and
      // mid-stream overloaded/rate-limit SSE errors) back off and retry; the FINAL attempt
      // falls back to WRITER_FALLBACK_MODEL. A retry is only attempted while ZERO answer
      // text has streamed — once any answer text is visible, a rerun would duplicate it, so
      // a mid-answer interruption is surfaced as an explicit error instead.
      const writerRound = rounds + 1;
      try {
        emit({ type: "round", round: writerRound, writer: true });
        const today = new Date().toISOString().slice(0, 10);
        const haveEvidence = allSearchResults.length > 0 || recordIndexBlocks.length > 0;
        const haveCaselaw = emittedResults.some((c: any) => c.kind === "caselaw");
        const caselawNote = haveCaselaw
          ? ` Some of the provided sources are EXTERNAL court opinions (their titles are case citations and their sources are courtlistener.com URLs) — treat those as legal authority, kept distinct from this matter's own orders, exactly as instructed; cite case law only from those provided opinions and never from memory.`
          : "";
        const matterAnchor = `The attorney's question concerns this matter — ${matter.short_name}, MDL ${matter.mdl_number}. Treat the question as pertaining to this matter only; do not assume it relates to any other MDL or litigation, and do not remark on which matter the question is "framed for." Answer it directly from the ${matter.short_name} record.`;
        const leadIn = haveEvidence
          ? `Today's date is ${today}.\n\n${matterAnchor}\n\nQuestion: ${question}\n\nThe material gathered for this question follows — document passages (citable search results) and, where applicable, a structured record index.${caselawNote} Using only that material, answer the question for the attorney, citing each assertion to its source as you write. Reason carefully about dates, order precedence, and deadlines as instructed, synthesize across the passages where the question calls for it, and flag anything the gathered material does not cover.`
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
          // Capacity errors (529 Overloaded) are usually model-specific: the final attempt
          // switches to the fallback writer rather than trying the same model again.
          writerModelUsed = attempt === WRITER_MAX_ATTEMPTS ? WRITER_FALLBACK_MODEL : MODEL;

          // Adaptive thinking lets the writer plan structure and decide which passages support
          // which claims BEFORE writing — materially improving citation coverage. Opus 4.8 uses
          // adaptive thinking + output_config.effort (NOT the legacy enabled/budget_tokens, which
          // 400s). display:"summarized" is required for the reasoning to stream as readable text
          // (the default "omitted" returns empty thinking blocks). The fallback model omits
          // these parameters (they are tuned for the primary model) and streams a plain cited
          // answer — degraded thinking depth is preferable to no answer at all.
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
              () => { sawAnswerText = true; }, () => { citationCount++; },
            );
            break;
          } catch (e) {
            lastErr = e;
            // Never auto-retry once answer text has already streamed — a rerun would
            // duplicate the visible answer in the client. Surface the interruption instead.
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
