// Supabase Edge Function: ai-assist (v11)
// A focused, single-turn writing assistant for the drafting workspace. Three modes:
//   - "transform": rewrite/expand/shorten/retone/continue a SELECTED passage in the editor.
//                  Returns clean replacement text only (no citations, no preamble).
//   - "draft":     generate or revise document content from an instruction + the current
//                  document, optionally GROUNDED in the matter's record (controlling orders)
//                  with native sentence-level citations.
//   - "insight":   explain/analyze a SELECTED passage (e.g. an evidence passage from the
//                  search view), optionally answering a specific question about it. Returns
//                  concise analytical prose grounded in the passage itself.
//
// Unlike legal-synthesis (multi-round Gemini router + Claude writer), this is one Claude
// Opus 4.8 turn. Grounding, when requested, runs a single hybrid_search_v2 against the same
// matter-scoped record and injects citable search_result blocks.
//
// v11 — VOYAGE RETRIEVAL + TRANSIENT-FAILURE RESILIENCE (mirrors legal-synthesis v28/v29):
//   - Grounding now retrieves via hybrid_search_v2 (chunks.embedding_v2, vector(1024)); the
//     query embedding is generated INSIDE this function with voyage-law-2 (input_type
//     'query'). The legacy client `embedding` field is honored only when it is already a
//     1024-dim vector; a 384-dim bge vector is ignored and the function self-embeds. This
//     removes the in-browser model dependency and makes the entire courtlistener corpus
//     (v2-only chunks) reachable for grounded drafting.
//   - GROUND_MIN_SIM retuned to 0.35 for voyage-law-2's score distribution (relevant hits
//     typically score 0.4–0.7; lexical hits bypass the floor inside the RPC).
//   - The Anthropic writer call retries on transient upstream failures (HTTP 408/429/5xx/529
//     and mid-stream overloaded/rate-limit SSE errors) with exponential backoff, honoring
//     Retry-After. Up to WRITER_MAX_ATTEMPTS total attempts; the FINAL attempt falls back to
//     WRITER_FALLBACK_MODEL. A retry only fires while ZERO answer text has streamed — once
//     any text is visible, a rerun would duplicate it, so the interruption is surfaced.
//   - The voyage query embedding retries once on transient failure; if embedding cannot be
//     produced (or VOYAGE_API_KEY is missing), grounding degrades gracefully to an
//     ungrounded draft (meta.grounded=false with ground_error) instead of failing the run.
//
// Request (POST JSON):
//   { mode: "transform" | "draft" | "insight",
//     instruction: string,                 // what to do (command, chat prompt, or question)
//     selection?: string,                  // transform/insight: the highlighted text
//     document?: string,                   // current editor contents (context)
//     messages?: { role: "user"|"assistant", content: string }[],  // draft: prior chat turns
//     ground?: boolean,                    // draft: retrieve from the record and cite
//     embedding?: string,                  // optional — honored only if 1024-dim; otherwise
//                                          //   the function self-embeds via voyage-law-2
//     case_id?: string, matter?: { name, short_name, mdl_number, court, judge } }
// Response: text/event-stream (events: meta, chunks, text, citation, error, done).
//
// Secrets: ANTHROPIC_API_KEY (required), VOYAGE_API_KEY (required for grounding; without it
//   grounded drafts degrade to ungrounded), WRITER_FALLBACK_MODEL optional (default
//   claude-sonnet-4-6). SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (auto).

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const VOYAGE_API_KEY = Deno.env.get("VOYAGE_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MODEL = "claude-opus-4-8";
const WRITER_FALLBACK_MODEL = Deno.env.get("WRITER_FALLBACK_MODEL") ?? "claude-sonnet-4-6";
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_MODEL = "voyage-law-2";
const VOYAGE_TIMEOUT_MS = 20000;

const GROUND_K = 8;            // grounding passages per draft request
const GROUND_MIN_SIM = 0.35;   // vector-only floor, tuned for voyage-law-2 (lexical hits bypass it)
const TRANSFORM_MAX_TOKENS = 4000;
const DRAFT_MAX_TOKENS = 8000;
const INSIGHT_MAX_TOKENS = 2500;

// v11: transient-failure handling (mirrors legal-synthesis v29)
const WRITER_MAX_ATTEMPTS = 3;    // total writer attempts; the final one uses WRITER_FALLBACK_MODEL
const EMBED_MAX_ATTEMPTS = 2;     // total voyage query-embedding attempts
const RETRY_BASE_DELAY_MS = 2000; // backoff base: ~2s, then ~5s (plus jitter)
const RETRY_MAX_DELAY_MS = 15000; // hard cap on any single backoff wait

const DEFAULT_CASE_ID = "4ea28a93-3e76-4b10-b6da-6794fef3c7c1";
const DEFAULT_MATTER = {
  name: "In re: Depo-Provera Products Liability Litigation",
  short_name: "Depo-Provera",
  mdl_number: "3140",
  court: "the United States District Court for the Northern District of Florida, Pensacola Division",
  judge: "the Honorable M. Casey Rodgers",
};

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Matter = {
  name: string;
  short_name: string;
  mdl_number: string;
  court: string;
  judge: string;
};

// ---------- v11: retry primitives ----------
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

// ---------- Voyage query embedding (v11) ----------
// Embeds the grounding query server-side with the SAME model family that embedded the
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

// ---------- retrieval helpers (mirrors legal-synthesis shapes) ----------

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

function mapRow(r: any): { searchResult: any; chunk: any } {
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
    order_type: r.order_type ?? null,
    order_number: r.order_number ?? null,
    order_date: r.order_date ?? null,
    page_start: r.page_start ?? null,
    page_end: r.page_end ?? null,
    pdf_url: r.pdf_url ?? null,
  };
  return { searchResult, chunk };
}

// Single matter-scoped hybrid_search_v2 for grounding a draft.
async function groundSearch(
  query: string,
  embedding: string,
  caseId: string,
): Promise<{ searchResults: any[]; chunks: any[] }> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/hybrid_search_v2`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      q: query,
      query_embedding: embedding,
      filter: { case_id: caseId },
      k: GROUND_K,
      min_sim: GROUND_MIN_SIM,
    }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`hybrid_search_v2 failed (${resp.status}): ${body.slice(0, 200)}`);
  }
  const rows: any[] = await resp.json();
  const seen = new Set<string>();
  const searchResults: any[] = [];
  const chunks: any[] = [];
  for (const r of rows) {
    if (seen.has(r.id)) continue;
    seen.add(r.id);
    const { searchResult, chunk } = mapRow(r);
    searchResults.push(searchResult);
    chunks.push(chunk);
  }
  return { searchResults, chunks };
}

// ---------- system prompts ----------

function transformSystem(m: Matter): string {
  return `You are an expert legal-writing assistant embedded directly in a document editor used by the attorneys and staff of ${m.name}, MDL No. ${m.mdl_number}. The user works on complex multidistrict litigation; assume fluency with its procedural vocabulary.

The user has SELECTED a passage in their document and asked you to transform it. Apply the requested change precisely and return ONLY the revised passage — the exact text that will replace the selection.

Hard rules:
- Output the replacement text and nothing else: no preamble, no explanation, no sign-off, no surrounding quotation marks, and no Markdown code fences.
- Preserve the author's voice, defined terms, internal citations, and formatting conventions unless the instruction is specifically to change them.
- Write in the register of careful litigation prose — precise, professional, neutral.
- Do not invent record facts, dates, order numbers, or holdings. If the instruction would require a fact you do not have, leave a clearly marked placeholder (e.g., [INSERT DATE]) rather than fabricating.
- If asked to continue or expand, output only the new/expanded text to be inserted, seamlessly matching the surrounding style.`;
}

function draftSystem(m: Matter, grounded: boolean): string {
  return `You are the drafting assistant for ${m.name}, MDL No. ${m.mdl_number}, pending in ${m.court}, before ${m.judge}. You help the attorneys of plaintiffs' leadership draft and revise litigation documents — memos, letters, outlines, motion sections, and the like. Assume an experienced-litigator audience; do not pad with elementary explanation.

Produce clean, well-structured document content in Markdown (headings, lists, emphasis as appropriate). Write in precise, professional, neutral litigation prose. Lead with substance.

${grounded
  ? `RECORD GROUNDING: You have been given citable passages from the matter's controlling orders as search results. When you state a fact about this record — an obligation, deadline, party, holding, order number, or quoted term — ground it in those passages and cite them as you write so each assertion is traceable. Do not assert record facts that the provided passages do not support; if the passages do not cover something the draft needs, insert a clearly marked placeholder (e.g., [CONFIRM: cite controlling order]) rather than inventing it. The passages are a focused set, not the entire record — flag gaps rather than filling them.`
  : `You have NOT been given record passages for this request. Draft from the user's instruction and the current document only. Do not fabricate specific record facts (dates, order numbers, holdings, party names); where the draft needs one, insert a clearly marked placeholder (e.g., [INSERT DATE], [CITE ORDER]) for the attorney to fill.`}

Return only the requested document content — no meta-commentary about what you did unless the user explicitly asks.`;
}

function insightSystem(m: Matter): string {
  return `You are a litigation analyst for ${m.name}, MDL No. ${m.mdl_number}, pending in ${m.court}, before ${m.judge}. You support the attorneys of plaintiffs' leadership. The user is reading the record and has selected a single passage from a controlling order or filing; they want a fast, precise read on it.

Analyze ONLY the selected passage (plus any question the user asks about it). Be concise and concrete — the register of a careful associate giving a partner a quick read:
- Say what the passage actually requires, establishes, or means in plain terms.
- Surface the operative language, defined terms, any deadline or trigger, and who it binds.
- Flag ambiguities, conditions, or open questions a litigator would want to check.
- Note where the passage is silent if the user's question reaches beyond it.

Stay disciplined to the passage: do not invent surrounding context, other orders, dates, or holdings that are not in the selected text. If answering the question requires material outside the passage, say so and point the attorney to where to look. Do not restate the passage verbatim; interpret it. Use brief Markdown (short paragraphs, the occasional list). Keep it tight.`;
}

// ---------- Anthropic streaming turn ----------

async function streamAnthropic(
  body: any,
  emittedResults: any[],
  emit: (o: any) => void,
  nextCiteNum: () => number,
  onTextDelta: () => void,
): Promise<{ text: string; citationCount: number }> {
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
  let text = "";
  let citationCount = 0;

  const handle = (ev: any) => {
    switch (ev.type) {
      case "content_block_delta": {
        const d = ev.delta || {};
        if (d.type === "text_delta") {
          text += d.text;
          onTextDelta();
          emit({ type: "text", block_id: ev.index, text: d.text });
        } else if (d.type === "citations_delta") {
          const c = d.citation;
          if (!c) break;
          citationCount++;
          const r = emittedResults[c.search_result_index];
          emit({
            type: "citation",
            block_id: ev.index,
            num: nextCiteNum(),
            ref: r?.ref ?? null,
            order_label: r?.order_label ?? c.title ?? null,
            page: r ? pageCite(r) : null,
            cited_text: c.cited_text,
            source: c.source,
            title: c.title,
          });
        }
        break;
      }
      case "error":
        throw new Error(ev.error?.message || "Anthropic stream error");
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n\n")) !== -1) {
      const raw = buf.slice(0, i);
      buf = buf.slice(i + 2);
      let dataStr = "";
      for (const line of raw.split("\n")) if (line.startsWith("data:")) dataStr += line.slice(5).trim();
      if (!dataStr) continue;
      let ev: any;
      try { ev = JSON.parse(dataStr); } catch { continue; }
      handle(ev);
    }
  }
  return { text, citationCount };
}

// ---------- handler ----------

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

  let payload: any;
  try { payload = await req.json(); } catch { return new Response("Bad JSON", { status: 400, headers: CORS }); }

  const mode = (payload?.mode ?? "draft").toString();
  const instruction = (payload?.instruction ?? "").toString().trim();
  const selection = (payload?.selection ?? "").toString();
  const document = (payload?.document ?? "").toString();
  const ground = !!payload?.ground;
  const clientEmbedding = (payload?.embedding ?? "").toString().trim();
  const caseId = (payload?.case_id ?? "").toString().trim() || DEFAULT_CASE_ID;
  const matter: Matter = (payload?.matter && typeof payload.matter === "object")
    ? { ...DEFAULT_MATTER, ...payload.matter }
    : DEFAULT_MATTER;
  const history: any[] = Array.isArray(payload?.messages) ? payload.messages : [];

  // insight mode allows an empty instruction (defaults to "explain this passage"); other modes require one.
  if (!instruction && mode !== "insight") return new Response("Missing instruction", { status: 400, headers: CORS });
  if (mode === "transform" && !selection) return new Response("transform mode needs a selection", { status: 400, headers: CORS });
  if (mode === "insight" && !selection) return new Response("insight mode needs a selection", { status: 400, headers: CORS });

  // v11: a client-supplied embedding is honored only when it is already in the corpus's
  // vector space (1024-dim voyage-law-2); anything else (including legacy 384-dim bge
  // vectors from older frontends) is ignored and the function embeds the query itself.
  const hasClientVec = vecDims(clientEmbedding) === 1024;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (o: any) => {
        try { controller.enqueue(encoder.encode(`event: ${o.type}\ndata: ${JSON.stringify(o)}\n\n`)); } catch { /* closed */ }
      };
      let citeCounter = 0;
      const nextCiteNum = () => ++citeCounter;

      if (!ANTHROPIC_API_KEY) {
        emit({ type: "error", message: "ANTHROPIC_API_KEY not set. Add it in Supabase → Edge Functions → Secrets, then retry." });
        emit({ type: "done", citation_count: 0 });
        controller.close();
        return;
      }

      try {
        const emittedResults: any[] = [];   // grounding chunks in citation-index order
        const searchResultBlocks: any[] = []; // Anthropic search_result blocks, same order

        // ----- Grounding (draft mode only) -----
        // v11: grounding no longer depends on a client embedding — the function resolves the
        // query vector itself (client 1024-dim vector if supplied, otherwise voyage-law-2
        // self-embed with one retry). Any failure degrades to an ungrounded draft.
        const doGround = mode === "draft" && ground;
        if (doGround) {
          const query = instruction + (document ? "\n" + document.slice(0, 1000) : "");
          try {
            let embedding = hasClientVec ? clientEmbedding : "";
            if (!embedding) {
              let lastErr: unknown = null;
              for (let attempt = 1; attempt <= EMBED_MAX_ATTEMPTS && !embedding; attempt++) {
                try {
                  embedding = await voyageEmbedQuery(query);
                } catch (e) {
                  lastErr = e;
                  if (attempt >= EMBED_MAX_ATTEMPTS || !isRetryableError(e)) throw e;
                  await sleep(retryDelayMs(attempt, e));
                }
              }
              if (!embedding) throw (lastErr instanceof Error ? lastErr : new Error("embedding unavailable"));
            }
            const g = await groundSearch(query, embedding, caseId);
            for (const ch of g.chunks) emittedResults.push(ch);
            for (const b of g.searchResults) searchResultBlocks.push(b);
            emit({ type: "meta", grounded: true, passages: g.chunks.length });
            if (g.chunks.length) emit({ type: "chunks", chunks: g.chunks });
          } catch (e) {
            emit({ type: "meta", grounded: false, passages: 0, ground_error: (e as Error).message });
          }
        } else {
          emit({ type: "meta", grounded: false, passages: 0 });
        }

        // ----- Build the Anthropic request -----
        const system = mode === "transform"
          ? transformSystem(matter)
          : mode === "insight"
            ? insightSystem(matter)
            : draftSystem(matter, doGround && emittedResults.length > 0);

        const messages: any[] = [];

        if (mode === "insight") {
          const question = instruction || "Explain this passage: what it requires or establishes, its significance, and any ambiguities a litigator should check.";
          messages.push({
            role: "user",
            content: [{
              type: "text",
              text: `Selected passage from the record:\n\n<passage>\n${selection.slice(0, 12000)}\n</passage>\n\n${question}`,
            }],
          });
        } else if (mode === "transform") {
          const userBlocks: any[] = [];
          if (document.trim()) {
            userBlocks.push({
              type: "text",
              text: `For context, here is the full document the selection comes from:\n\n<document>\n${document.slice(0, 12000)}\n</document>`,
            });
          }
          userBlocks.push({
            type: "text",
            text: `Here is the SELECTED passage to transform:\n\n<selection>\n${selection}\n</selection>\n\nInstruction: ${instruction}\n\nReturn only the revised replacement text for the selection.`,
          });
          messages.push({ role: "user", content: userBlocks });
        } else {
          // draft mode: prior chat turns, then the current instruction + grounding + document
          for (const h of history.slice(-8)) {
            if (h && (h.role === "user" || h.role === "assistant") && typeof h.content === "string" && h.content.trim()) {
              messages.push({ role: h.role, content: h.content });
            }
          }
          const userBlocks: any[] = [];
          if (searchResultBlocks.length) {
            userBlocks.push({
              type: "text",
              text: "Grounding passages from the matter's controlling orders (cite these where you state record facts):",
            });
            for (const b of searchResultBlocks) userBlocks.push(b);
          }
          if (document.trim()) {
            userBlocks.push({
              type: "text",
              text: `Current document the user is editing (revise or extend it as the instruction asks):\n\n<document>\n${document.slice(0, 16000)}\n</document>`,
            });
          }
          userBlocks.push({ type: "text", text: instruction });
          messages.push({ role: "user", content: userBlocks });
        }

        const maxTokens = mode === "transform" ? TRANSFORM_MAX_TOKENS : mode === "insight" ? INSIGHT_MAX_TOKENS : DRAFT_MAX_TOKENS;

        // ----- Writer with bounded retry + model fallback (v11) -----
        // Transient upstream failures (429/5xx/529 and mid-stream overloaded/rate-limit SSE
        // errors) back off and retry; the FINAL attempt falls back to WRITER_FALLBACK_MODEL.
        // A retry only fires while ZERO answer text has streamed — once any text is visible,
        // a rerun would duplicate it in the client, so the interruption is surfaced instead.
        let result: { text: string; citationCount: number } | null = null;
        let lastErr: unknown = null;
        for (let attempt = 1; attempt <= WRITER_MAX_ATTEMPTS; attempt++) {
          const writerModel = attempt === WRITER_MAX_ATTEMPTS ? WRITER_FALLBACK_MODEL : MODEL;
          const body: any = {
            model: writerModel,
            max_tokens: maxTokens,
            system,
            messages,
            stream: true,
          };
          let sawText = false;
          try {
            result = await streamAnthropic(body, emittedResults, emit, nextCiteNum, () => { sawText = true; });
            break;
          } catch (e) {
            lastErr = e;
            if (sawText) {
              throw new Error(`The output stream was interrupted mid-write (${(e as Error).message}). Re-run the request to get a complete result.`);
            }
            if (attempt >= WRITER_MAX_ATTEMPTS || !isRetryableError(e)) throw e;
            await sleep(retryDelayMs(attempt, e));
          }
        }
        if (!result) {
          throw (lastErr instanceof Error ? lastErr : new Error("Writer produced no output"));
        }
        emit({ type: "done", citation_count: result.citationCount });
      } catch (e) {
        const msg = (e as Error).message;
        const friendly = isRetryableError(e)
          ? `The writer model is temporarily overloaded upstream (${msg}). ${WRITER_MAX_ATTEMPTS} attempts were made, including a fallback model. Re-run the request in a moment.`
          : msg;
        emit({ type: "error", message: friendly });
        emit({ type: "done", citation_count: 0 });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
});
