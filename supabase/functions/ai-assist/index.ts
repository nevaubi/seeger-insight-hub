// Supabase Edge Function: ai-assist (v12)
// The drafting workspace's writing engine. Five modes:
//   - "transform": rewrite/expand/shorten/retone/continue a SELECTED passage in the editor.
//                  Returns clean replacement text only (no citations, no preamble).
//   - "draft":     generate or revise document content from an instruction + the current
//                  document, optionally GROUNDED in the matter's record (controlling orders)
//                  with native sentence-level citations.
//   - "insight":   explain/analyze a SELECTED passage. Concise analytical prose.
//   - "redline":   v12 — review the document (or a selection) and return edits as VERIFIED
//                  TRACKED-CHANGE suggestions. The model streams NDJSON edit objects, each
//                  anchored to a verbatim quote; the server locates every anchor in the
//                  submitted text before emitting it (SSE `edit` events). Anchors that fail
//                  verification are surfaced as `edit_failed` events, never silently applied.
//                  This extends the Tabular Review verbatim-verification gate to revision.
//   - "check":     v12 — deterministic document-intelligence passes. Returns JSON (not SSE):
//                  check_type = "placeholders" | "defined_terms" | "crossrefs" | "citations".
//                  "citations" additionally verifies record cites (PTO/CMO/CBO/Dkt.) against
//                  court_orders / docket_entries for this case. External reporter cites are
//                  the cite-check function's job (CourtListener citation-lookup).
//
// v12 — REDLINE + CHECKS + PRACTICE PROFILE + MULTI-PROVIDER RESILIENCE:
//   - Practice profile injection: the matter's practice_profiles row (profile_md) is fetched
//     server-side and appended to every mode's system prompt; `meta.profile` echoes
//     { name, updated_at } so the UI can show a truthful "Playbook consulted" chip.
//   - Redline cite tiers: a suggestion's cite whose label matches a grounded record passage
//     is tiered "record" (with pdf_url); anything else is tiered "model" for the client's
//     [verify] treatment. Grounding for redline reuses the draft-mode hybrid_search_v2 flow.
//   - Redline writer chain: Anthropic Opus → Anthropic Sonnet → (if OPENAI_API_KEY secret is
//     set) OpenAI → (if FIREWORKS_API_KEY is set) Fireworks serverless. The chain advances on
//     any failure while ZERO edit lines have streamed; once edits have streamed, an
//     interruption is surfaced instead (partial results remain valid — every emitted edit was
//     independently verified). draft/insight/transform keep the v11 Opus→Sonnet behavior.
//   - transform/draft/insight remain wire-compatible with v11 clients (meta gains additive
//     profile/run_id fields only).
//
// v11 (retained): voyage-law-2 self-embedding for grounding; hybrid_search_v2 retrieval;
//   transient-failure retry with backoff + Retry-After; graceful grounding degradation.
//
// Request (POST JSON):
//   { mode: "transform" | "draft" | "insight" | "redline" | "check",
//     instruction: string,
//     selection?: string,                  // transform/insight: the highlighted text
//     selection_start?: number,            // redline: scope edits to document[start,end)
//     selection_end?: number,
//     document?: string,
//     messages?: { role, content }[],      // draft: prior chat turns
//     ground?: boolean,                    // draft/redline: retrieve from the record
//     check_type?: string,                 // check mode
//     run_id?: string,                     // redline: echoed in meta (client audit trail)
//     case_id?: string, matter?: { name, short_name, mdl_number, court, judge } }
//
// Response: text/event-stream for transform/draft/insight/redline
//   (events: meta, chunks, text, citation, edit, edit_failed, error, done);
//   application/json for check mode.
//
// Secrets: ANTHROPIC_API_KEY (required), VOYAGE_API_KEY (required for grounding),
//   OPENAI_API_KEY + FIREWORKS_API_KEY (optional writer fallbacks; inert when absent),
//   WRITER_FALLBACK_MODEL / OPENAI_FALLBACK_MODEL / FIREWORKS_FALLBACK_MODEL (optional
//   model overrides). SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (auto).

import {
  ClaimSet,
  locateAnchor,
  normalizeOrderLabel,
  parseEditLine,
  type RawEdit,
} from "./anchor.ts";
import {
  scanCrossrefs,
  scanDefinedTerms,
  scanPlaceholders,
  scanRecordCites,
  type CheckFinding,
  type RecordCiteRef,
} from "./checks.ts";

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const VOYAGE_API_KEY = Deno.env.get("VOYAGE_API_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const FIREWORKS_API_KEY = Deno.env.get("FIREWORKS_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MODEL = "claude-opus-4-8";
const WRITER_FALLBACK_MODEL = Deno.env.get("WRITER_FALLBACK_MODEL") ?? "claude-sonnet-4-6";
const OPENAI_FALLBACK_MODEL = Deno.env.get("OPENAI_FALLBACK_MODEL") ?? "gpt-5.1";
const FIREWORKS_FALLBACK_MODEL =
  Deno.env.get("FIREWORKS_FALLBACK_MODEL") ?? "accounts/fireworks/models/kimi-k2-instruct-0905";
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_MODEL = "voyage-law-2";
const VOYAGE_TIMEOUT_MS = 20000;

const GROUND_K = 8;            // grounding passages per request
const GROUND_MIN_SIM = 0.35;   // vector-only floor, tuned for voyage-law-2
const TRANSFORM_MAX_TOKENS = 4000;
const DRAFT_MAX_TOKENS = 8000;
const INSIGHT_MAX_TOKENS = 2500;
const REDLINE_MAX_TOKENS = 8000;
const REDLINE_MAX_EDITS = 40;
const REDLINE_DOC_CAP = 24000;   // chars of document shown to the redline writer
const PROFILE_MAX_CHARS = 8000;  // practice-profile injection cap

const WRITER_MAX_ATTEMPTS = 3;    // draft/insight/transform attempts (v11 behavior)
const EMBED_MAX_ATTEMPTS = 2;
const RETRY_BASE_DELAY_MS = 2000;
const RETRY_MAX_DELAY_MS = 15000;

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

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" },
  });
}

type Matter = {
  name: string;
  short_name: string;
  mdl_number: string;
  court: string;
  judge: string;
};

// ---------- retry primitives (v11) ----------

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

// ---------- Voyage query embedding (v11) ----------

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

// ---------- retrieval helpers (v11) ----------

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

function mapRow(r: any): { searchResult: any; chunk: any } {
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
    order_type: r.order_type ?? null,
    order_number: r.order_number ?? null,
    order_date: r.order_date ?? null,
    page_start: r.page_start ?? null,
    page_end: r.page_end ?? null,
    pdf_url: r.pdf_url ?? null,
    content: (r.content ?? "").toString(),
  };
  return { searchResult, chunk };
}

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

// ---------- practice profile (v12) ----------

type Profile = { name: string | null; md: string; updated_at: string | null };

async function fetchPracticeProfile(caseId: string): Promise<Profile | null> {
  try {
    const resp = await fetch(
      `${SUPABASE_URL}/rest/v1/practice_profiles?case_id=eq.${encodeURIComponent(caseId)}&select=name,profile_md,updated_at&limit=1`,
      { headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` } },
    );
    if (!resp.ok) return null;
    const rows = await resp.json();
    const row = Array.isArray(rows) ? rows[0] : null;
    const md = (row?.profile_md ?? "").toString().trim();
    if (!md) return null;
    return {
      name: row?.name ?? null,
      md: md.slice(0, PROFILE_MAX_CHARS),
      updated_at: row?.updated_at ?? null,
    };
  } catch {
    return null;
  }
}

function withProfile(system: string, profile: Profile | null): string {
  if (!profile) return system;
  return (
    system +
    `\n\nPRACTICE PROFILE — this team's playbook for the matter (conventions, preferences, positions). Follow it wherever applicable; where it conflicts with an explicit user instruction, the instruction wins:\n<practice_profile${profile.name ? ` name="${profile.name}"` : ""}>\n${profile.md}\n</practice_profile>`
  );
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

function redlineSystem(m: Matter, grounded: boolean): string {
  return `You are the markup engine of the drafting workspace for ${m.name}, MDL No. ${m.mdl_number}, pending in ${m.court}, before ${m.judge}. A litigator has asked you to review document text and propose edits AS TRACKED CHANGES for attorney accept/reject review. You do not rewrite documents; you produce precise, anchored suggestions.

OUTPUT PROTOCOL (strict — violations are discarded):
- Emit ONE JSON object per line (NDJSON). No prose, no markdown, no code fences, nothing outside the JSON lines.
- Edit line shape:
  {"op":"replace","anchor":"<verbatim quote from the document>","occurrence":1,"text":"<replacement>","rationale":"<why, under 140 chars>","cite":{"label":"PTO 22","page":"4"},"confidence":"high"}
  "occurrence" only when the anchor text appears more than once (1-based from the top).
  "cite" only when a provided record passage supports the edit; otherwise omit it.
  "confidence" is "high" or "needs_review".
- Allowed op values: "replace" (text replaces anchor), "delete" (anchor removed; omit text), "insert_before" / "insert_after" (text inserted adjacent to the anchor — include any needed spacing or newlines in text; the anchor itself is unchanged), "comment" (no text change; text is a margin note for the reviewer).
- After all edits, emit exactly one final line: {"type":"summary","text":"<2-4 sentence summary of the markup>"}

ANCHOR RULES (the server verifies every anchor against the document; failures are discarded and shown to the reviewer as failed suggestions):
- "anchor" must be copied CHARACTER-FOR-CHARACTER from the document — exact punctuation, capitalization, spacing. Never paraphrase. Never re-wrap.
- 6-200 characters; the smallest span that uniquely locates the edit. Do not span paragraph breaks.
- Anchors of content-changing edits must not overlap one another.

EDITING DISCIPLINE:
- Smallest sufficient edits. Preserve the author's voice, defined terms, numbering, and citation forms unless the instruction targets them.
- Never invent record facts, dates, order numbers, or holdings. Where a needed fact is missing, insert a [BRACKETED ALL-CAPS] placeholder, or raise it with a "comment" op.
${grounded
  ? `- RECORD PASSAGES are provided with bracketed labels (e.g. [PTO 22 · p.4]). When an edit rests on the record, cite it: {"label":"PTO 22","page":"4"} using the label exactly. Do not cite sources that were not provided; if you must rely on memory, prefer a "comment" op flagging the point for verification.`
  : `- No record passages were provided. Do not assert record facts; use placeholders or "comment" ops flagging points for verification instead.`}
- At most ${REDLINE_MAX_EDITS} edits; prioritize substance. If the instruction asks only for review commentary, emit "comment" ops only.
- If a SELECTION is marked, propose edits only within it.`;
}

// ---------- Anthropic streaming turn (v11 — draft/insight/transform path) ----------

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

// ---------- plain-text streaming writers (v12 — redline provider chain) ----------

async function anthropicTextStream(
  model: string,
  system: string,
  userText: string,
  maxTokens: number,
  onDelta: (t: string) => void,
): Promise<void> {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system,
      messages: [{ role: "user", content: [{ type: "text", text: userText }] }],
      stream: true,
    }),
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
      if (ev.type === "content_block_delta" && ev.delta?.type === "text_delta") onDelta(ev.delta.text);
      else if (ev.type === "error") throw new Error(ev.error?.message || "Anthropic stream error");
    }
  }
}

async function openAICompatTextStream(
  url: string,
  apiKey: string,
  model: string,
  system: string,
  userText: string,
  maxTokens: number,
  onDelta: (t: string) => void,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      stream: true,
      messages: [
        { role: "system", content: system },
        { role: "user", content: userText },
      ],
    }),
  });
  if (!res.ok || !res.body) {
    const t = await res.text().catch(() => "");
    const ra = res.headers.get("retry-after");
    const raMs = ra && Number.isFinite(Number(ra)) ? Number(ra) * 1000 : null;
    throw new ApiError(`${new URL(url).hostname} ${res.status}: ${t.slice(0, 400)}`, res.status, raMs);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf("\n")) !== -1) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith("data:")) continue;
      const payloadStr = line.slice(5).trim();
      if (!payloadStr || payloadStr === "[DONE]") continue;
      let ev: any;
      try { ev = JSON.parse(payloadStr); } catch { continue; }
      const delta = ev?.choices?.[0]?.delta?.content;
      if (typeof delta === "string" && delta) onDelta(delta);
    }
  }
}

type Provider = { kind: "anthropic" | "openai" | "fireworks"; model: string };

function redlineProviders(): Provider[] {
  const p: Provider[] = [
    { kind: "anthropic", model: MODEL },
    { kind: "anthropic", model: WRITER_FALLBACK_MODEL },
  ];
  if (OPENAI_API_KEY) p.push({ kind: "openai", model: OPENAI_FALLBACK_MODEL });
  if (FIREWORKS_API_KEY) p.push({ kind: "fireworks", model: FIREWORKS_FALLBACK_MODEL });
  return p;
}

function providerStream(
  p: Provider,
  system: string,
  userText: string,
  maxTokens: number,
  onDelta: (t: string) => void,
): Promise<void> {
  if (p.kind === "anthropic") return anthropicTextStream(p.model, system, userText, maxTokens, onDelta);
  if (p.kind === "openai") {
    return openAICompatTextStream(
      "https://api.openai.com/v1/chat/completions",
      OPENAI_API_KEY,
      p.model,
      system,
      userText,
      maxTokens,
      onDelta,
    );
  }
  return openAICompatTextStream(
    "https://api.fireworks.ai/inference/v1/chat/completions",
    FIREWORKS_API_KEY,
    p.model,
    system,
    userText,
    maxTokens,
    onDelta,
  );
}

// ---------- check mode: record-cite DB verification ----------

async function verifyRecordCites(caseId: string, refs: RecordCiteRef[]): Promise<CheckFinding[]> {
  const findings: CheckFinding[] = [];
  if (!refs.length) return findings;

  // orders for this case (with page_count when the FK embed is available)
  let orders: any[] = [];
  try {
    let resp = await fetch(
      `${SUPABASE_URL}/rest/v1/court_orders?case_id=eq.${encodeURIComponent(caseId)}&select=order_type,order_number,canonical_title,pdf_url,documents(page_count)`,
      { headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` } },
    );
    if (!resp.ok) {
      resp = await fetch(
        `${SUPABASE_URL}/rest/v1/court_orders?case_id=eq.${encodeURIComponent(caseId)}&select=order_type,order_number,canonical_title,pdf_url`,
        { headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` } },
      );
    }
    if (resp.ok) orders = await resp.json();
  } catch { /* orders stay empty; cites report as unverifiable */ }

  const byKey = new Map<string, any>();
  for (const o of orders) {
    const key = `${String(o.order_type ?? "").toUpperCase()}|${String(o.order_number ?? "").toUpperCase()}`;
    if (!byKey.has(key)) byKey.set(key, o);
  }

  // docket entry numbers actually referenced
  const dktNums = Array.from(new Set(refs.filter((r) => r.kind === "docket").map((r) => r.entry_number)))
    .filter((n): n is number => Number.isFinite(n as number));
  const dktSet = new Set<number>();
  if (dktNums.length) {
    try {
      const resp = await fetch(
        `${SUPABASE_URL}/rest/v1/docket_entries?case_id=eq.${encodeURIComponent(caseId)}&entry_number=in.(${dktNums.join(",")})&select=entry_number`,
        { headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` } },
      );
      if (resp.ok) {
        const rows = await resp.json();
        for (const r of rows) if (Number.isFinite(r?.entry_number)) dktSet.add(Number(r.entry_number));
      }
    } catch { /* docket cites report as unverifiable */ }
  }

  const ordersLoaded = orders.length > 0;
  for (const r of refs) {
    if (r.kind === "order") {
      const hit = byKey.get(`${r.order_type}|${String(r.order_number).toUpperCase()}`);
      if (hit) {
        const pageCount = Number(hit?.documents?.page_count ?? NaN);
        let state: CheckFinding["state"] = "ok";
        let note = `${r.label} resolves to “${hit.canonical_title ?? r.label}”.`;
        if (r.page && Number.isFinite(pageCount)) {
          const pins = r.page.split("–").map((s) => Number(s.trim())).filter(Number.isFinite);
          const maxPin = pins.length ? Math.max(...pins) : NaN;
          if (Number.isFinite(maxPin) && maxPin > pageCount) {
            state = "error";
            note = `${r.label} exists, but the pin cite (at ${r.page}) exceeds its ${pageCount} pages.`;
          }
        }
        findings.push({
          kind: "record_cite", state, quote: r.quote, start: r.start, end: r.end, note,
          cite_label: r.label, cite_page: r.page,
          resolved_title: hit.canonical_title ?? null, pdf_url: hit.pdf_url ?? null,
        });
      } else {
        findings.push({
          kind: "record_cite",
          state: ordersLoaded ? "error" : "warning",
          quote: r.quote, start: r.start, end: r.end,
          note: ordersLoaded
            ? `${r.label} was not found in this matter's order register.`
            : `${r.label} could not be verified (order register unavailable).`,
          cite_label: r.label, cite_page: r.page, resolved_title: null, pdf_url: null,
        });
      }
    } else {
      const ok = dktSet.has(r.entry_number as number);
      findings.push({
        kind: "record_cite",
        state: ok ? "ok" : "warning",
        quote: r.quote, start: r.start, end: r.end,
        note: ok
          ? `${r.label} exists on the synced docket.`
          : `${r.label} was not found among synced docket entries (the sync may trail the live docket).`,
        cite_label: r.label, cite_page: r.page, resolved_title: null, pdf_url: null,
      });
    }
  }
  return findings;
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
  const runId = (payload?.run_id ?? "").toString().slice(0, 64) || null;

  // ----- check mode: deterministic scans, JSON response -----
  if (mode === "check") {
    const checkType = (payload?.check_type ?? "").toString();
    if (!document.trim()) return json({ ok: false, error: "check mode needs a document" }, 400);
    try {
      let findings: CheckFinding[] = [];
      if (checkType === "placeholders") findings = scanPlaceholders(document);
      else if (checkType === "defined_terms") findings = scanDefinedTerms(document);
      else if (checkType === "crossrefs") findings = scanCrossrefs(document);
      else if (checkType === "citations") findings = await verifyRecordCites(caseId, scanRecordCites(document));
      else return json({ ok: false, error: `Unknown check_type "${checkType}"` }, 400);
      const counts = {
        total: findings.length,
        ok: findings.filter((f) => f.state === "ok").length,
        warnings: findings.filter((f) => f.state === "warning").length,
        errors: findings.filter((f) => f.state === "error").length,
      };
      return json({ ok: true, check_type: checkType, findings, counts });
    } catch (e) {
      return json({ ok: false, error: (e as Error).message }, 500);
    }
  }

  // insight mode allows an empty instruction; other modes require one.
  if (!instruction && mode !== "insight") return new Response("Missing instruction", { status: 400, headers: CORS });
  if (mode === "transform" && !selection) return new Response("transform mode needs a selection", { status: 400, headers: CORS });
  if (mode === "insight" && !selection) return new Response("insight mode needs a selection", { status: 400, headers: CORS });
  if (mode === "redline" && !document.trim()) return new Response("redline mode needs a document", { status: 400, headers: CORS });

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
        // ----- practice profile (v12: all streaming modes) -----
        const profile = await fetchPracticeProfile(caseId);
        const profileMeta = profile ? { name: profile.name, updated_at: profile.updated_at } : null;

        const emittedResults: any[] = [];
        const searchResultBlocks: any[] = [];

        // ----- grounding (draft + redline) -----
        const doGround = (mode === "draft" || mode === "redline") && ground;
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
            emit({ type: "meta", grounded: true, passages: g.chunks.length, profile: profileMeta, run_id: runId });
            if (g.chunks.length) {
              emit({ type: "chunks", chunks: g.chunks.map(({ content: _c, ...rest }: any) => rest) });
            }
          } catch (e) {
            emit({ type: "meta", grounded: false, passages: 0, profile: profileMeta, run_id: runId, ground_error: (e as Error).message });
          }
        } else {
          emit({ type: "meta", grounded: false, passages: 0, profile: profileMeta, run_id: runId });
        }

        // =====================================================================
        // redline mode (v12)
        // =====================================================================
        if (mode === "redline") {
          const grounded = doGround && emittedResults.length > 0;
          const system = withProfile(redlineSystem(matter, grounded), profile);

          // selection scoping
          let selStart = Number(payload?.selection_start);
          let selEnd = Number(payload?.selection_end);
          const hasSelection =
            Number.isFinite(selStart) && Number.isFinite(selEnd) &&
            selStart >= 0 && selEnd > selStart && selEnd <= document.length;
          if (!hasSelection) { selStart = 0; selEnd = document.length; }

          // document window shown to the writer (token budget)
          let winStart = 0;
          let winEnd = document.length;
          if (document.length > REDLINE_DOC_CAP) {
            if (hasSelection) {
              const mid = Math.floor((selStart + selEnd) / 2);
              winStart = Math.max(0, mid - Math.floor(REDLINE_DOC_CAP / 2));
              winEnd = Math.min(document.length, winStart + REDLINE_DOC_CAP);
              winStart = Math.max(0, winEnd - REDLINE_DOC_CAP);
              // the window must contain the whole selection
              winStart = Math.min(winStart, selStart);
              winEnd = Math.max(winEnd, selEnd);
            } else {
              winEnd = REDLINE_DOC_CAP;
            }
          }
          const window = document.slice(winStart, winEnd);

          // anchor search space: the selection when provided, else the window
          const spaceBase = hasSelection ? selStart : winStart;
          const space = hasSelection ? document.slice(selStart, selEnd) : window;

          // grounded labels for cite tiering
          const groundedByLabel = new Map<string, any>();
          for (const ch of emittedResults) {
            const norm = normalizeOrderLabel(ch.order_label ?? "");
            if (norm && !groundedByLabel.has(norm)) groundedByLabel.set(norm, ch);
          }
          const tierCite = (cite: RawEdit["cite"]) => {
            if (!cite?.label) return null;
            const hit = groundedByLabel.get(normalizeOrderLabel(cite.label));
            if (hit) {
              return { label: cite.label, page: cite.page ?? null, tier: "record", pdf_url: hit.pdf_url ?? null };
            }
            return { label: cite.label, page: cite.page ?? null, tier: "model", pdf_url: null };
          };

          // user message (plain text; provider-agnostic)
          const parts: string[] = [];
          if (grounded) {
            const passages = emittedResults
              .map((ch) => `[${ch.order_label}${pageCite(ch) ? ` · ${pageCite(ch)}` : ""}]\n${(ch.content ?? "").slice(0, 1500)}`)
              .join("\n\n");
            parts.push(`RECORD PASSAGES you may cite (use the bracketed label exactly):\n\n${passages}`);
          }
          parts.push(
            `<document>\n${window}\n</document>` +
            (winStart > 0 || winEnd < document.length
              ? `\n(The document was windowed for review; propose edits only within the text shown.)`
              : ""),
          );
          if (hasSelection) {
            parts.push(`The reviewer selected this passage. Propose edits ONLY within it:\n<selection>\n${document.slice(selStart, Math.min(selEnd, selStart + 8000))}\n</selection>`);
          }
          parts.push(`Markup instruction: ${instruction}`);
          const userText = parts.join("\n\n");

          // NDJSON consumption with the verbatim anchor gate
          const claims = new ClaimSet();
          let editCount = 0;
          let failedCount = 0;
          let protocolErrors = 0;
          let capped = false;
          let lineBuf = "";
          let anyLine = false;

          const handleLine = (line: string) => {
            const parsed = parseEditLine(line);
            if (parsed.kind === "skip") return;
            anyLine = true;
            if (parsed.kind === "error") { protocolErrors++; return; }
            if (parsed.kind === "summary") {
              if (parsed.text) emit({ type: "text", text: parsed.text });
              return;
            }
            const e = parsed.edit;
            if (editCount >= REDLINE_MAX_EDITS) {
              capped = true;
              return;
            }
            const id = `e${editCount + failedCount + 1}`;
            const loc = locateAnchor(space, e.anchor, e.occurrence);
            if (!loc.ok) {
              failedCount++;
              emit({
                type: "edit_failed",
                id, op: e.op,
                anchor: e.anchor.slice(0, 200),
                reason: loc.reason,
                count: loc.count ?? null,
                rationale: e.rationale ?? "",
                cite: tierCite(e.cite),
              });
              return;
            }
            const absStart = spaceBase + loc.start;
            const absEnd = spaceBase + loc.end;
            const span = ClaimSet.spanFor(e.op, absStart, absEnd);
            if (span && !claims.tryClaim(span[0], span[1])) {
              failedCount++;
              emit({
                type: "edit_failed",
                id, op: e.op,
                anchor: e.anchor.slice(0, 200),
                reason: "overlaps_previous_edit",
                count: null,
                rationale: e.rationale ?? "",
                cite: tierCite(e.cite),
              });
              return;
            }
            editCount++;
            emit({
              type: "edit",
              id,
              op: e.op,
              anchor: document.slice(absStart, absEnd) || e.anchor,
              occurrence: e.occurrence ?? null,
              start: absStart,
              end: absEnd,
              text: e.text ?? "",
              rationale: e.rationale ?? "",
              cite: tierCite(e.cite),
              confidence: e.confidence ?? "high",
              match_mode: loc.mode,
            });
          };

          const onDelta = (t: string) => {
            lineBuf += t;
            let i: number;
            while ((i = lineBuf.indexOf("\n")) !== -1) {
              const line = lineBuf.slice(0, i);
              lineBuf = lineBuf.slice(i + 1);
              handleLine(line);
            }
          };

          const providers = redlineProviders();
          let lastErr: unknown = null;
          let succeeded = false;
          let interrupted = false;
          for (let i = 0; i < providers.length; i++) {
            const p = providers[i];
            try {
              await providerStream(p, system, userText, REDLINE_MAX_TOKENS, onDelta);
              succeeded = true;
              break;
            } catch (e) {
              lastErr = e;
              if (anyLine || editCount > 0 || failedCount > 0) {
                // partial markup already streamed — surface it; verified edits remain usable
                interrupted = true;
                emit({
                  type: "error",
                  partial: true,
                  message: `The markup stream was interrupted (${(e as Error).message}). ${editCount} verified suggestion${editCount === 1 ? "" : "s"} arrived before the interruption and remain valid.`,
                });
                break;
              }
              if (i < providers.length - 1) {
                if (isRetryableError(e)) await sleep(retryDelayMs(i + 1, e));
                continue;
              }
            }
          }
          if (lineBuf.trim()) handleLine(lineBuf);
          if (!succeeded && !interrupted && editCount === 0 && failedCount === 0) {
            throw (lastErr instanceof Error ? lastErr : new Error("Markup writer produced no output"));
          }
          emit({
            type: "done",
            citation_count: 0,
            edit_count: editCount,
            failed_count: failedCount,
            protocol_errors: protocolErrors,
            capped,
          });
          return;
        }

        // =====================================================================
        // transform / draft / insight (v11 behavior + profile injection)
        // =====================================================================
        const system = withProfile(
          mode === "transform"
            ? transformSystem(matter)
            : mode === "insight"
              ? insightSystem(matter)
              : draftSystem(matter, doGround && emittedResults.length > 0),
          profile,
        );

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

        // ----- writer with bounded retry + model fallback (v11) -----
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
          ? `The writer model is temporarily overloaded upstream (${msg}). Multiple attempts were made, including fallbacks. Re-run the request in a moment.`
          : msg;
        emit({ type: "error", message: friendly });
        emit({ type: "done", citation_count: 0 });
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: { ...CORS, "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive" },
  });
});
