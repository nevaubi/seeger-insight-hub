// Supabase Edge Function: legal-synthesis
// Multi-agent, multi-matter RAG over a litigation record (controlling orders + filings).
//   Router = Gemini 3.1 Flash-Lite (OpenAI-compatible endpoint): plans and runs up to
//            3 rounds, calling tools — search_the_record, read_order, list_orders,
//            lookup_counsel, list_deadlines — streams concise reasoning, then stops.
//   Writer = Claude Opus 4.8: one clean turn over the gathered passages (with native
//            sentence-level citations) plus a structured record index.
// SSE streaming throughout.
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
//   { question: string, embedding: string ("[...]" 384-dim), initial_filter?: object,
//     case_id?: string (matter master case), matter?: { name, short_name, mdl_number, court, judge } }
// Response: text/event-stream (events: round, thinking, search, chunks, tool, expand, text,
//   citation, round_end, search_error, tool_error, error, done).
//
// Secrets: ANTHROPIC_API_KEY, GEMINI_API_KEY (user-provided). ROUTER_MODEL optional
//   (default gemini-3.1-flash-lite). SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY auto-injected.

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const ROUTER_MODEL = Deno.env.get("ROUTER_MODEL") ?? "gemini-3.1-flash-lite";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MODEL = "claude-opus-4-8";
const GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions";
const MAX_ROUNDS = 3;
const PER_SEARCH_K = 10;        // targeted retrieval: up to 10 fresh passages per search
const MAX_TOTAL_CHUNKS = 60;    // absolute ceiling across primary hits + neighbor/order expansion
const MIN_SIM = 0.2;            // vector-only floor (lexical hits bypass it); lowered from 0.3 to admit
                               // borderline-relevant passages that bge-small scores in the 0.2-0.3 band
const NEIGHBOR_WINDOW = 1;      // auto-expansion: pull chunk_index +/- this many from the same document
const EXPAND_TOP_N = 3;         // auto-expand only the N best hits of each search (stays targeted)
const READ_ORDER_LIMIT = 40;    // max passages when reading a full order + its amendment versions
const WRITER_EFFORT = "high";    // adaptive-thinking depth for the writer (low|medium|high|xhigh|max)
const WRITER_MAX_TOKENS = 24000; // enforced output ceiling (thinking + answer); we stream, so it's safe

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

YOUR SOURCE OF TRUTH — A CLOSED RECORD
The material needed to answer has already been gathered from the actual docket and is provided to you below as citable search results, plus — where applicable — a structured record index. You answer ONLY from that provided material. Do not rely on your own legal knowledge, outside facts, recollection of other litigation, or anything not present in what you were given. If the provided record does not contain the answer, say so plainly — never fill the gap with general knowledge, assumption, or inference beyond what the material supports. A precise "the record before me does not address that" is correct and valuable; a plausible fabrication is a serious failure.

A DELIBERATELY TARGETED RECORD SET
Passage retrieval for this question was intentionally focused — a small, high-precision set (up to 10 passages per search) rather than an exhaustive dump. Treat the provided passages as the focused evidence selected for this question, but do NOT assume they are complete. If the operative text, a specific subsection, an exact figure, or a date the question turns on is not present in what you were given, name that gap explicitly and tell the attorney where to look (e.g., "the full text of that order is not in the retrieved passages; consult the order directly on the docket"). Never extrapolate missing provisions from related ones. Partial coverage, clearly flagged, is the correct outcome — not a reason to reconstruct or guess.

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

// ---------- Router system prompt builder (all matters; describes all five tools) ----------
function buildRouterSystem(m: Matter): string {
  return `You are the retrieval router for a litigation research assistant working the ${m.name} record (MDL No. ${m.mdl_number}, before ${m.judge}). You support the plaintiffs' leadership, including Seeger Weiss LLP, co-lead counsel.

YOUR JOB: read the user's question and gather the material a separate writer agent will need to answer it from the closed record — the controlling orders (PTOs, CMOs, CBOs) and the JPML transfer order, associated filings, and a scientific & regulatory background layer (described below). You do NOT write the answer, analysis, or summary. You ONLY call tools to collect the right material, then stop.

YOUR TOOLS
  1. search_the_record — semantic + keyword passage retrieval. Returns up to 10 fresh citable passages per call, and automatically pulls a few adjacent passages around the best hits so you get surrounding context for free. Your primary tool for what an order SAYS — its operative text, obligations, holdings, or defined terms — and for the scientific/regulatory background.
  2. read_order — the FULL text of one named order plus any amendment versions (read_order PTO 22 returns PTO 22 AND PTO 22A, date-ordered). Use when the question turns on an order's complete operative text, or to compare a base order against its amendment for precedence. Returns citable passages.
  3. list_orders — the complete list of controlling orders on this matter's docket (type, number, date, title, subject tags, source PDF). Use this for questions that enumerate or survey orders ("list the case management orders", "what CBOs exist", "every order on leadership"). It returns the full matching list, not a sample.
  4. list_deadlines — the matter's key dates and deadlines (date, category, title, who it affects, source order). Use this for calendar/deadline questions ("what hearings are coming up", "list the deadlines for plaintiffs").
  5. lookup_counsel — counsel of record (side, firm, attorney, contact). Use this for roster questions ("who represents the defendants", "list plaintiffs' counsel").
Prefer the structured tools (3-5) when the question is fundamentally an enumeration or a roster/calendar lookup — they are complete and exact. Prefer search_the_record when the question turns on the language or substance of an order, or on the scientific/regulatory record; reach for read_order once you know the specific order whose full text or amendment history matters. You may combine tools across rounds (e.g., list_orders to find the right order, then read_order to pull its full text).

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

const GEMINI_TOOLS = [
  { type: "function", function: { name: "search_the_record", description: SEARCH_TOOL_DESCRIPTION, parameters: SEARCH_TOOL_SCHEMA } },
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
// row. Shared by hybrid_search, expand_neighbors, and order_chunks so every retrieval path
// produces identical shapes. `extra` carries provenance flags (e.g. { neighbor: true }).
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

// Call hybrid_search on the same Supabase, scoped to the matter's case_id. Returns new
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

  // Overfetch then dedup: hybrid_search is deterministic, so a near-identical query in a
  // later round returns the same top rows — which are already in `seen` and would net ZERO
  // new passages. Asking the RPC for more than k (bounded by its internal 50-row pools) lets
  // us skip the already-seen rows and still hand back up to k FRESH passages per call.
  const fetchK = Math.max(k, Math.min(50, k + seen.size));

  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/hybrid_search`, {
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
    throw new Error(`hybrid_search failed (${resp.status}): ${body.slice(0, 300)}`);
  }
  const rows: any[] = await resp.json();
  const { searchResults, chunks, ids } = collectRows(rows, seen, k);
  return { searchResults, chunks, rawCount: rows.length, hitIds: ids };
}

// Neighbor/sibling expansion: pull the chunks adjacent (chunk_index +/- NEIGHBOR_WINDOW,
// same document) to a set of center hits, so the writer sees contiguous context instead of
// isolated snippets. Positional \u2014 no embedding needed.
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
  const range = d.end_date && d.end_date !== d.event_date ? ` \u2192 ${d.end_date}` : "";
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
    throw new Error(`Gemini router ${res.status}: ${t.slice(0, 400)}`);
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
    throw new Error(`Anthropic API ${res.status}: ${t.slice(0, 400)}`);
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

// ---------- handler ----------
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

  let payload: any;
  try { payload = await req.json(); } catch { return new Response("Bad JSON", { status: 400, headers: CORS }); }
  const question = (payload?.question ?? "").toString().trim();
  const embedding = (payload?.embedding ?? "").toString().trim();
  const initialFilter = (payload?.initial_filter && typeof payload.initial_filter === "object") ? payload.initial_filter : {};
  const caseId = (payload?.case_id ?? "").toString().trim() || DEFAULT_CASE_ID;
  const matter: Matter = (payload?.matter && typeof payload.matter === "object")
    ? { ...DEFAULT_MATTER, ...payload.matter }
    : DEFAULT_MATTER;
  const writerSystem = buildWriterSystem(matter);
  const routerSystem = buildRouterSystem(matter);

  if (!question || !embedding) return new Response("Missing question or embedding", { status: 400, headers: CORS });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (o: any) => {
        try { controller.enqueue(encoder.encode(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`)); } catch { /* closed */ }
      };

      const missing: string[] = [];
      if (!GEMINI_API_KEY) missing.push("GEMINI_API_KEY");
      if (!ANTHROPIC_API_KEY) missing.push("ANTHROPIC_API_KEY");
      if (missing.length) {
        emit({ type: "error", message: `${missing.join(" and ")} not set. Add ${missing.length > 1 ? "them" : "it"} in Supabase \u2192 Project Settings \u2192 Edge Functions \u2192 Secrets, then retry.` });
        emit({ type: "done", rounds: 0, chunk_count: 0, citation_count: 0 });
        controller.close();
        return;
      }

      const emittedResults: any[] = [];   // UI chunks, in citation-index order
      const allSearchResults: any[] = []; // Anthropic search_result blocks, same order
      const recordIndexBlocks: string[] = []; // structured-tool output for the writer
      const seen = new Set<string>();
      const searchesLog: any[] = [];
      let rounds = 0, answerText = "", citationCount = 0, finalErr: string | null = null;

      let userText = question;
      if (initialFilter && Object.keys(initialFilter).length) {
        userText += `\n\n[The user applied these filters in the interface; they are enforced on every search and may not be removed: ${JSON.stringify(initialFilter)}.]`;
      }

      // ----- Phase 1: Gemini router gathers the record -----
      // History is plain text (rationale + compact results), never replayed tool-call parts,
      // so Gemini 3's thought_signature requirement never triggers. Router failures are
      // non-fatal: we fall through to the writer with whatever was gathered.
      const routerMessages: any[] = [
        { role: "system", content: routerSystem },
        { role: "user", content: userText },
      ];

      while (rounds < MAX_ROUNDS) {
        const round = rounds + 1;
        emit({ type: "round", round });
        let r: { rationale: string; toolCalls: any[]; finish: string | null };
        try {
          r = await geminiRouterRound(routerMessages, round, emit);
        } catch (e) {
          emit({ type: "search_error", round, message: `Router: ${(e as Error).message}` });
          emit({ type: "round_end", round, stop_reason: "router_error" });
          rounds = round;
          break;
        }
        rounds = round;

        if (!r.toolCalls.length) {
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
            const structuredLike = s.c.name === "read_order" || STRUCTURED_TOOLS.has(s.c.name);
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
      const writerRound = rounds + 1;
      try {
        emit({ type: "round", round: writerRound, writer: true });
        const today = new Date().toISOString().slice(0, 10);
        const haveEvidence = allSearchResults.length > 0 || recordIndexBlocks.length > 0;
        const matterAnchor = `The attorney's question concerns this matter — ${matter.short_name}, MDL ${matter.mdl_number}. Treat the question as pertaining to this matter only; do not assume it relates to any other MDL or litigation, and do not remark on which matter the question is "framed for." Answer it directly from the ${matter.short_name} record.`;
        const leadIn = haveEvidence
          ? `Today's date is ${today}.\n\n${matterAnchor}\n\nQuestion: ${question}\n\nThe material gathered from the ${matter.short_name} (MDL ${matter.mdl_number}) record follows — document passages (citable search results) and, where applicable, a structured record index. Using only that material, answer the question for the attorney, citing each assertion to its source as you write. Reason carefully about dates, order precedence, and deadlines as instructed, synthesize across the passages where the question calls for it, and flag anything the gathered material does not cover.`
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
        // Adaptive thinking lets the writer plan structure and decide which passages support
        // which claims BEFORE writing — materially improving citation coverage. Opus 4.8 uses
        // adaptive thinking + output_config.effort (NOT the legacy enabled/budget_tokens, which
        // 400s). display:"summarized" is required for the reasoning to stream as readable text
        // (the default "omitted" returns empty thinking blocks).
        const body: any = {
          model: MODEL,
          max_tokens: WRITER_MAX_TOKENS,
          thinking: { type: "adaptive", display: "summarized" },
          output_config: { effort: WRITER_EFFORT },
          system: [{ type: "text", text: writerSystem, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: writerUser }],
          stream: true,
        };
        const turn = await streamTurn(
          body, writerRound, emit, emittedResults,
          () => {}, () => { citationCount++; },
        );
        emit({ type: "round_end", round: writerRound, stop_reason: turn.stopReason });
        answerText = turn.text;
        rounds = writerRound;
      } catch (e) {
        finalErr = (e as Error).message;
        emit({ type: "error", message: finalErr });
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
            citation_count: citationCount, model: `${ROUTER_MODEL} -> ${MODEL} (thinking)`, error: finalErr,
          }),
        });
      } catch { /* ignore */ }
    },
  });

  return new Response(stream, {
    headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
});
