// Deno edge function source: depo-analyze (v2 — parallel multi-model specialist graph)
//
// Deploy target: the EXTERNAL Supabase backend (same place depo-ingest / depo-ask live).
// This repo cannot host new Supabase function folders, so the deployable source is kept here.
//   supabase functions deploy depo-analyze --project-ref <ref>   (run from a copy of this file
//   placed at supabase/functions/depo-analyze/index.ts in your backend repo)
//
// Pipeline (replaces the single sequential pass):
//   1. Chunker      — overlapping windows over deposition_segments (Q/A pairs kept intact)
//   2. Extractors   — every facet in flight at once, bounded concurrency per facet, routed
//                     across Gemini / Anthropic / OpenAI / Fireworks so no single provider
//                     rate limit serializes the run; per-facet failover
//   3. Reduce       — dedupe + rank per facet
//   4. Verifier     — every quote string-matched against deposition_lines; the true page:line
//                     span is derived from the match, never trusted from the model
//   5. Incremental  — each facet's findings are inserted as soon as it finishes, and
//                     depositions.metadata.analysis carries per-facet progress for the UI
//
// Request  (POST JSON): { deposition_id: string, facets?: string[] }
// Response (JSON):      { ok, deposition_id, counts, dropped, progress, elapsed_ms }
//
// Secrets: GEMINI_API_KEY, ANTHROPIC_API_KEY, OPENAI_API_KEY, FIREWORKS_API_KEY (any subset —
// facets whose provider is missing fall back to Gemini, then Anthropic).
// SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are auto-injected.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const OPENAI_API_KEY = Deno.env.get("OPENAI_API_KEY") ?? "";
const FIREWORKS_API_KEY = Deno.env.get("FIREWORKS_API_KEY") ?? "";

const GEMINI_FAST = Deno.env.get("GEMINI_FAST_MODEL") ?? "gemini-3.1-flash-lite";
const GEMINI_REDUCE = Deno.env.get("GEMINI_REDUCE_MODEL") ?? "gemini-3.5-flash";
const ANTHROPIC_FAST = Deno.env.get("ANTHROPIC_FAST_MODEL") ?? "claude-haiku-4-5";
const OPENAI_FAST = Deno.env.get("OPENAI_FAST_MODEL") ?? "gpt-5-mini";
const FIREWORKS_FAST =
  Deno.env.get("FIREWORKS_FAST_MODEL") ??
  "accounts/fireworks/models/llama4-maverick-instruct-basic";

const WINDOW_CHARS = 14000;
const WINDOW_OVERLAP_SEGMENTS = 2;
const FACET_CONCURRENCY = 6;
const MODEL_TIMEOUT_MS = 120000;
const MAX_PER_FACET = 60;

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

// ---------------------------------------------------------------- supabase REST

async function sb(path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      ...(init.headers ?? {}),
    },
  });
}

async function sbSelect<T>(path: string): Promise<T[]> {
  const r = await sb(`/rest/v1/${path}`);
  if (!r.ok) throw new Error(`select ${path} → ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as T[];
}

async function sbPatch(table: string, filter: string, patch: unknown): Promise<void> {
  const r = await sb(`/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(patch),
  });
  if (!r.ok) console.error(`patch ${table} ${r.status}: ${(await r.text()).slice(0, 200)}`);
}

async function sbInsert(table: string, rows: unknown[]): Promise<Response> {
  return await sb(`/rest/v1/${table}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(rows),
  });
}

// ---------------------------------------------------------------- model providers

type Provider = "gemini" | "anthropic" | "openai" | "fireworks";

function providerAvailable(p: Provider): boolean {
  return p === "gemini"
    ? !!GEMINI_API_KEY
    : p === "anthropic"
      ? !!ANTHROPIC_API_KEY
      : p === "openai"
        ? !!OPENAI_API_KEY
        : !!FIREWORKS_API_KEY;
}

async function withTimeout<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), MODEL_TIMEOUT_MS);
  try {
    return await fn(ctrl.signal);
  } finally {
    clearTimeout(t);
  }
}

async function callGemini(model: string, system: string, user: string): Promise<string> {
  return await withTimeout(async (signal) => {
    const r = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        signal,
        headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: "user", parts: [{ text: user }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 16384,
            responseMimeType: "application/json",
          },
        }),
      },
    );
    if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text()).slice(0, 240)}`);
    const d = await r.json();
    const parts = d?.candidates?.[0]?.content?.parts ?? [];
    return parts.map((p: { text?: string }) => p?.text ?? "").join("");
  });
}

async function callAnthropic(model: string, system: string, user: string): Promise<string> {
  return await withTimeout(async (signal) => {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal,
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        max_tokens: 8192,
        temperature: 0,
        system,
        messages: [{ role: "user", content: user }],
      }),
    });
    if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 240)}`);
    const d = await r.json();
    return (d?.content ?? []).map((c: { text?: string }) => c?.text ?? "").join("");
  });
}

async function callOpenAICompatible(
  url: string,
  key: string,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  return await withTimeout(async (signal) => {
    const r = await fetch(url, {
      method: "POST",
      signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
        response_format: { type: "json_object" },
      }),
    });
    if (!r.ok) throw new Error(`${model} ${r.status}: ${(await r.text()).slice(0, 240)}`);
    const d = await r.json();
    return d?.choices?.[0]?.message?.content ?? "";
  });
}

async function callModel(
  provider: Provider,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  switch (provider) {
    case "gemini":
      return await callGemini(model, system, user);
    case "anthropic":
      return await callAnthropic(model, system, user);
    case "openai":
      return await callOpenAICompatible(
        "https://api.openai.com/v1/chat/completions",
        OPENAI_API_KEY,
        model,
        system,
        user,
      );
    case "fireworks":
      return await callOpenAICompatible(
        "https://api.fireworks.ai/inference/v1/chat/completions",
        FIREWORKS_API_KEY,
        model,
        system,
        user,
      );
  }
}

/** Call the facet's preferred provider; on failure degrade to Gemini, then Anthropic. */
async function callWithFailover(
  preferred: { provider: Provider; model: string },
  system: string,
  user: string,
): Promise<string> {
  const chain: { provider: Provider; model: string }[] = [preferred];
  if (preferred.provider !== "gemini") chain.push({ provider: "gemini", model: GEMINI_FAST });
  if (preferred.provider !== "anthropic")
    chain.push({ provider: "anthropic", model: ANTHROPIC_FAST });

  let lastErr: unknown = null;
  for (const step of chain) {
    if (!providerAvailable(step.provider)) continue;
    try {
      return await callModel(step.provider, step.model, system, user);
    } catch (e) {
      lastErr = e;
      console.error(
        `[depo-analyze] ${step.provider}/${step.model} failed: ${(e as Error).message}`,
      );
    }
  }
  throw new Error(`all providers failed: ${(lastErr as Error)?.message ?? "unknown"}`);
}

// ---------------------------------------------------------------- json parsing

function parseJsonLoose(text: string): unknown {
  const t = (text ?? "").trim().replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  if (!t) return null;
  try {
    return JSON.parse(t);
  } catch {
    /* fall through */
  }
  const candidates = [t.indexOf("{"), t.indexOf("[")].filter((n) => n >= 0);
  const first = candidates.length ? Math.min(...candidates) : -1;
  const last = Math.max(t.lastIndexOf("}"), t.lastIndexOf("]"));
  if (first >= 0 && first < last) {
    try {
      return JSON.parse(t.slice(first, last + 1));
    } catch {
      /* ignore */
    }
  }
  return null;
}

function asItems(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) return parsed as Record<string, unknown>[];
  if (parsed && typeof parsed === "object") {
    const o = parsed as Record<string, unknown>;
    for (const k of ["items", "findings", "results", "data", "output"]) {
      if (Array.isArray(o[k])) return o[k] as Record<string, unknown>[];
    }
  }
  return [];
}

// ---------------------------------------------------------------- transcript model

interface Line {
  page: number;
  line: number;
  text: string;
}

interface Segment {
  id: string;
  ordinal: number;
  kind: string;
  speaker: string | null;
  page_start: number;
  line_start: number;
  page_end: number;
  line_end: number;
  text: string;
  exhibit_number: number | null;
}

function normalize(s: string): string {
  return (s ?? "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201C\u201D]/g, '"')
    .replace(/[\u2013\u2014]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** Normalized transcript text with a char-offset → page:line index for quote verification. */
class LineIndex {
  text = "";
  private spans: { start: number; end: number; page: number; line: number }[] = [];

  constructor(lines: Line[]) {
    const parts: string[] = [];
    let pos = 0;
    for (const l of lines) {
      const t = normalize(l.text) + " ";
      this.spans.push({ start: pos, end: pos + t.length, page: l.page, line: l.line });
      parts.push(t);
      pos += t.length;
    }
    this.text = parts.join("");
  }

  /** Find `quote` verbatim (normalized). Returns the true span, or null when unverifiable. */
  locate(
    quote: string,
  ): { page_start: number; line_start: number; page_end: number; line_end: number } | null {
    const q = normalize(quote);
    if (q.length < 12) return null;
    let i = this.text.indexOf(q);
    if (i >= 0) return this.spanFor(i, i + q.length);
    // Retry on a trimmed core — models often clip a leading/trailing word.
    const words = q.split(" ");
    if (words.length < 8) return null;
    const core = words.slice(1, -1).join(" ");
    i = this.text.indexOf(core);
    if (i < 0) return null;
    return this.spanFor(i, i + core.length);
  }

  private spanFor(start: number, end: number) {
    let a: { page: number; line: number } | null = null;
    let b: { page: number; line: number } | null = null;
    for (const s of this.spans) {
      if (!a && s.end > start) a = { page: s.page, line: s.line };
      if (s.start < end) b = { page: s.page, line: s.line };
      if (s.start >= end) break;
    }
    if (!a || !b) return null;
    return { page_start: a.page, line_start: a.line, page_end: b.page, line_end: b.line };
  }
}

function citeLabel(p1: number, l1: number, p2: number, l2: number): string {
  if (p1 === p2 && l1 === l2) return `${p1}:${l1}`;
  if (p1 === p2) return `${p1}:${l1}\u2013${l2}`;
  return `${p1}:${l1}\u2013${p2}:${l2}`;
}

interface Window {
  idx: number;
  page_start: number;
  page_end: number;
  text: string;
  segment_ids: string[];
}

function renderSegment(s: Segment): string {
  const k = (s.kind || "").toLowerCase();
  const tag =
    k === "question"
      ? "Q"
      : k === "answer"
        ? "A"
        : k === "objection"
          ? "OBJECTION"
          : (s.speaker || k || "").toUpperCase();
  return `[${s.page_start}:${s.line_start}] ${tag}: ${s.text}`;
}

function buildWindows(segments: Segment[]): Window[] {
  const out: Window[] = [];
  let cur: Segment[] = [];
  let size = 0;

  const flush = () => {
    if (!cur.length) return;
    out.push({
      idx: out.length,
      page_start: cur[0].page_start,
      page_end: cur[cur.length - 1].page_end,
      segment_ids: cur.map((s) => s.id),
      text: cur.map(renderSegment).join("\n"),
    });
  };

  for (const s of segments) {
    const rendered = renderSegment(s);
    if (size + rendered.length > WINDOW_CHARS && cur.length) {
      flush();
      cur = cur.slice(-WINDOW_OVERLAP_SEGMENTS);
      size = cur.reduce((n, x) => n + renderSegment(x).length, 0);
    }
    cur.push(s);
    size += rendered.length;
  }
  flush();
  return out;
}

// ---------------------------------------------------------------- facets

type FacetKey =
  | "admission"
  | "chronology"
  | "exhibit"
  | "quality_note"
  | "impeachment"
  | "objection"
  | "case_theme"
  | "topic";

interface FacetSpec {
  key: FacetKey;
  label: string;
  provider: Provider;
  model: string;
  instruction: string;
  fields: string;
}

const SHARED_CONTRACT = `
You are a litigation analyst reading a certified deposition transcript excerpt. Every line is
prefixed with its [page:line] anchor.

Return STRICT JSON of the form {"items": [ ... ]}. Each item MUST have:
  "title":  short noun phrase (<= 80 chars)
  "detail": one or two sentences of attorney-useful analysis
  "quote":  the EXACT verbatim words from the transcript, copied character-for-character with no
            ellipses, no paraphrase, no bracketed edits, and no [page:line] prefix. 15-400 chars.
  "page":   page number of the first quoted line (integer)
  "line":   line number of the first quoted line (integer)
  "stance": "helpful" | "harmful" | "neutral" — from the PLAINTIFF's perspective
  "confidence": 0.0-1.0
  "tags":   array of short lowercase issue tags

Rules:
- If nothing in this excerpt qualifies, return {"items": []}. Never invent material.
- A quote that is not verbatim will be discarded, so copy, do not compose.
- Prefer few high-value items over many marginal ones. Maximum 8 items per excerpt.
`.trim();

const FACETS: FacetSpec[] = [
  {
    key: "admission",
    label: "Admissions",
    provider: "gemini",
    model: GEMINI_FAST,
    fields: "",
    instruction:
      "Extract ADMISSIONS: concessions by the witness bearing on liability, causation, notice, " +
      "corporate knowledge, duty, or damages — damaging concessions and helpful ones alike.",
  },
  {
    key: "chronology",
    label: "Chronology",
    provider: "gemini",
    model: GEMINI_FAST,
    fields: `Also include "date": the date or time reference as stated (string, "" if none).`,
    instruction:
      "Extract CHRONOLOGY events: dated or sequenced facts the witness establishes (employment, " +
      "study milestones, label changes, meetings, submissions, adverse-event reports).",
  },
  {
    key: "exhibit",
    label: "Exhibits",
    provider: "gemini",
    model: GEMINI_FAST,
    fields: `Also include "exhibit_number": integer or null, and "authenticated": true|false.`,
    instruction:
      "Extract EXHIBIT handling: each exhibit marked, shown, identified, authenticated, or " +
      "disputed, with what the witness said about it.",
  },
  {
    key: "impeachment",
    label: "Impeachment",
    provider: "anthropic",
    model: ANTHROPIC_FAST,
    fields: `Also include "kind": "contradiction" | "prior_statement" | "evasive" | "memory_failure".`,
    instruction:
      "Extract IMPEACHMENT material: internal contradictions, answers conflicting with a prior " +
      "statement or document put to the witness, evasive or non-responsive answers, and " +
      "conspicuous memory failures on matters the witness should know.",
  },
  {
    key: "objection",
    label: "Objections",
    provider: "openai",
    model: OPENAI_FAST,
    fields: `Also include "ground": the stated ground (form, foundation, privilege, ...) and "instructed_not_to_answer": true|false.`,
    instruction:
      "Extract the OBJECTION log: every objection with its stated ground, every instruction not " +
      "to answer, and any question left unanswered that is worth re-noticing.",
  },
  {
    key: "case_theme",
    label: "Case themes",
    provider: "gemini",
    model: GEMINI_REDUCE,
    fields: `Also include "theme": one of "warnings_labeling" | "corporate_knowledge" | "safer_alternative" | "causation" | "regulatory" | "other".`,
    instruction:
      "Extract CASE-THEME evidence for the Depo-Provera (medroxyprogesterone acetate) meningioma " +
      "MDL: warnings and labeling adequacy, corporate knowledge of meningioma risk, the " +
      "Depo-SubQ Provera 104 safer-alternative theory, general and specific causation, and " +
      "regulatory interactions.",
  },
  {
    key: "quality_note",
    label: "Quality",
    provider: "fireworks",
    model: FIREWORKS_FAST,
    fields: `Also include "category": "transcript_error" | "off_record" | "coaching" | "exhibit_gap" | "other".`,
    instruction:
      "Extract TRANSCRIPT HYGIENE notes: garbled or suspect transcription, unexplained off-record " +
      "breaks, apparent witness coaching, missing exhibits, and reporter irregularities.",
  },
];

// ---------------------------------------------------------------- concurrency

async function pool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

// ---------------------------------------------------------------- extraction

interface Candidate {
  facet: FacetKey;
  title: string;
  detail: string;
  quote: string;
  stance: "helpful" | "harmful" | "neutral";
  confidence: number;
  tags: string[];
  data: Record<string, unknown>;
  segment_ids: string[];
}

function coerceCandidate(
  facet: FacetKey,
  raw: Record<string, unknown>,
  win: Window,
): Candidate | null {
  const quote = String(raw.quote ?? "").trim();
  const title = String(raw.title ?? "").trim();
  if (!quote && !title) return null;
  const stanceRaw = String(raw.stance ?? "neutral").toLowerCase();
  const stance =
    stanceRaw === "helpful" || stanceRaw === "harmful"
      ? (stanceRaw as "helpful" | "harmful")
      : "neutral";
  const conf = Number(raw.confidence);
  const known = new Set([
    "title",
    "detail",
    "quote",
    "page",
    "line",
    "stance",
    "confidence",
    "tags",
  ]);
  const data: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(raw)) if (!known.has(k)) data[k] = v;
  data.window = win.idx;
  return {
    facet,
    title: title.slice(0, 160) || "Finding",
    detail: String(raw.detail ?? "").trim(),
    quote,
    stance,
    confidence: Number.isFinite(conf) ? Math.max(0, Math.min(1, conf)) : 0.6,
    tags: Array.isArray(raw.tags) ? raw.tags.map((t) => String(t).slice(0, 40)).slice(0, 6) : [],
    data,
    segment_ids: win.segment_ids,
  };
}

async function extractFacet(
  spec: FacetSpec,
  windows: Window[],
  header: string,
): Promise<Candidate[]> {
  const system = `${SHARED_CONTRACT}\n\nTASK: ${spec.instruction}\n${spec.fields}`;
  const results = await pool(windows, FACET_CONCURRENCY, async (win) => {
    try {
      const user = `${header}\n\nEXCERPT (pages ${win.page_start}-${win.page_end}):\n\n${win.text}`;
      const text = await callWithFailover(
        { provider: spec.provider, model: spec.model },
        system,
        user,
      );
      return asItems(parseJsonLoose(text))
        .map((raw) => coerceCandidate(spec.key, raw, win))
        .filter((c): c is Candidate => !!c);
    } catch (e) {
      console.error(`[depo-analyze] ${spec.key} window ${win.idx}: ${(e as Error).message}`);
      return [] as Candidate[];
    }
  });
  return results.flat();
}

/** Dedupe near-identical candidates by normalized quote / title. */
function dedupe(cands: Candidate[]): Candidate[] {
  const seen = new Map<string, Candidate>();
  for (const c of cands) {
    const key = normalize(c.quote).slice(0, 120) || normalize(c.title);
    const prev = seen.get(key);
    if (!prev || c.confidence > prev.confidence) seen.set(key, c);
  }
  return [...seen.values()];
}

// ---------------------------------------------------------------- verify + persist

interface Verified extends Candidate {
  page_start: number;
  line_start: number;
  page_end: number;
  line_end: number;
  cite: string;
  verify_status: "verified" | "failed";
}

function verifyAll(cands: Candidate[], index: LineIndex): { kept: Verified[]; dropped: number } {
  const kept: Verified[] = [];
  let dropped = 0;
  for (const c of cands) {
    const loc = index.locate(c.quote);
    if (!loc) {
      dropped++;
      continue;
    }
    kept.push({
      ...c,
      ...loc,
      cite: citeLabel(loc.page_start, loc.line_start, loc.page_end, loc.line_end),
      verify_status: "verified",
    });
  }
  return { kept, dropped };
}

function rank(v: Verified[]): Verified[] {
  const weight = (x: Verified) => x.confidence + (x.stance === "neutral" ? 0 : 0.15);
  return [...v].sort((a, b) => weight(b) - weight(a)).slice(0, MAX_PER_FACET);
}

/**
 * Insert findings. `finding_type` may be a Postgres enum in some deployments; when the new facet
 * values are rejected the batch is retried as `quality_note` carrying `data.facet`, so nothing is
 * lost. Run the ALTER TYPE snippet in README-sql.md to get first-class rows.
 */
async function insertFindings(
  depositionId: string,
  caseId: string | null,
  facet: FacetKey,
  items: Verified[],
  startOrdinal: number,
): Promise<number> {
  if (!items.length) return 0;
  const build = (type: string) =>
    items.map((f, i) => ({
      deposition_id: depositionId,
      case_id: caseId,
      finding_type: type,
      title: f.title,
      detail: f.detail || null,
      quote: f.quote || null,
      page_start: f.page_start,
      line_start: f.line_start,
      page_end: f.page_end,
      line_end: f.line_end,
      cite: f.cite,
      segment_ids: f.segment_ids,
      issue_tags: f.tags,
      stance: f.stance,
      confidence: f.confidence,
      verify_status: f.verify_status,
      review_status: "unreviewed",
      ordinal: startOrdinal + i,
      data: { ...f.data, facet },
    }));

  let r = await sbInsert("deposition_findings", build(facet));
  if (!r.ok) {
    console.error(`[depo-analyze] insert ${facet} ${r.status}: ${(await r.text()).slice(0, 300)}`);
    r = await sbInsert("deposition_findings", build("quality_note"));
    if (!r.ok) {
      console.error(
        `[depo-analyze] fallback insert ${facet} failed: ${(await r.text()).slice(0, 200)}`,
      );
      return 0;
    }
  }
  return items.length;
}

// ---------------------------------------------------------------- overview pass

async function overviewPass(
  depo: Record<string, unknown>,
  segments: Segment[],
  header: string,
): Promise<{ exec: string; profile: string; topics: Record<string, unknown>[] }> {
  // A skim: the opening, the close, and every ~14th segment in between.
  const skim = segments
    .filter((_, i) => i < 30 || i > segments.length - 20 || i % 14 === 0)
    .map(renderSegment)
    .join("\n")
    .slice(0, 90000);

  const system = `You are a litigation analyst. Return STRICT JSON:
{
  "exec_summary": "3-6 sentence executive summary of what this deposition established",
  "witness_profile": "3-5 sentences: background, qualifications, role, and any bias or interest indicators",
  "topics": [ { "title": "topic", "detail": "what was covered and how thoroughly", "coverage": "thorough"|"partial"|"thin", "page_start": 1 } ]
}
At most 12 topics. Never invent facts.`;

  try {
    const text = await callWithFailover(
      { provider: "gemini", model: GEMINI_REDUCE },
      system,
      `${header}\n\nTRANSCRIPT SKIM:\n\n${skim}`,
    );
    const parsed = (parseJsonLoose(text) ?? {}) as Record<string, unknown>;
    return {
      exec: String(parsed.exec_summary ?? "").trim(),
      profile: String(parsed.witness_profile ?? "").trim(),
      topics: Array.isArray(parsed.topics) ? (parsed.topics as Record<string, unknown>[]) : [],
    };
  } catch (e) {
    console.error(`[depo-analyze] overview failed: ${(e as Error).message}`);
    return { exec: "", profile: "", topics: [] };
  }
}

// ---------------------------------------------------------------- handler

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  const started = Date.now();
  let payload: Record<string, unknown> = {};
  try {
    payload = await req.json();
  } catch {
    return json({ ok: false, error: "Bad JSON" }, 400);
  }
  const depositionId = String(payload.deposition_id ?? "").trim();
  if (!depositionId) return json({ ok: false, error: "deposition_id required" }, 400);
  if (!GEMINI_API_KEY && !ANTHROPIC_API_KEY && !OPENAI_API_KEY && !FIREWORKS_API_KEY) {
    return json({ ok: false, error: "No model provider key configured" }, 400);
  }

  const only = Array.isArray(payload.facets) ? new Set(payload.facets.map(String)) : null;
  const specs = only ? FACETS.filter((f) => only.has(f.key)) : FACETS;

  // ---- load
  let depo: Record<string, unknown>;
  let lines: Line[];
  let segments: Segment[];
  try {
    const rows = await sbSelect<Record<string, unknown>>(
      `depositions?id=eq.${depositionId}&select=*&limit=1`,
    );
    if (!rows.length) return json({ ok: false, error: "deposition not found" }, 404);
    depo = rows[0];
    lines = await sbSelect<Line>(
      `deposition_lines?deposition_id=eq.${depositionId}&select=page,line,text&order=page.asc,line.asc&limit=200000`,
    );
    segments = await sbSelect<Segment>(
      `deposition_segments?deposition_id=eq.${depositionId}&select=*&order=ordinal.asc&limit=100000`,
    );
  } catch (e) {
    return json({ ok: false, error: `Load failed: ${(e as Error).message}` }, 500);
  }
  if (!segments.length) {
    await sbPatch("depositions", `id=eq.${depositionId}`, {
      status: "error",
      error: "Transcript has no segments — re-ingest required",
    });
    return json({ ok: false, error: "no segments" }, 422);
  }

  const caseId = (depo.case_id as string | null) ?? null;
  const index = new LineIndex(lines);
  const windows = buildWindows(segments);
  const header = [
    `WITNESS: ${depo.witness_name ?? "Unknown"}${depo.witness_role ? ` (${depo.witness_role})` : ""}`,
    depo.party_alignment ? `ALIGNMENT: ${depo.party_alignment}` : null,
    depo.mdl_caption ? `MATTER: ${depo.mdl_caption}` : null,
    depo.deposition_date ? `DATE: ${depo.deposition_date}` : null,
  ]
    .filter(Boolean)
    .join("\n");

  // ---- clear prior analysis so a re-run is idempotent
  await sb(`/rest/v1/deposition_findings?deposition_id=eq.${depositionId}`, {
    method: "DELETE",
    headers: { Prefer: "return=minimal" },
  });

  const progress: Record<string, string> = { overview: "running" };
  for (const s of specs) progress[s.key] = "running";
  const metadata = { ...((depo.metadata as Record<string, unknown>) ?? {}) };
  const writeProgress = async (status: "analyzing" | null = "analyzing") => {
    await sbPatch("depositions", `id=eq.${depositionId}`, {
      ...(status ? { status, error: null } : {}),
      metadata: { ...metadata, analysis: { ...progress, updated_at: new Date().toISOString() } },
    });
  };
  await writeProgress();

  const counts: Record<string, number> = {};
  let dropped = 0;
  let ordinal = 0;

  // ---- overview (exec summary + witness profile + topic map), parallel with the facets
  const overviewJob = (async () => {
    const ov = await overviewPass(depo, segments, header);
    const rows: Record<string, unknown>[] = [];
    if (ov.exec) {
      rows.push({
        deposition_id: depositionId,
        case_id: caseId,
        finding_type: "exec_summary",
        title: "Executive summary",
        detail: ov.exec,
        segment_ids: [],
        issue_tags: [],
        verify_status: "unverified",
        review_status: "unreviewed",
        ordinal: 0,
        data: {},
      });
    }
    if (ov.profile) {
      rows.push({
        deposition_id: depositionId,
        case_id: caseId,
        finding_type: "witness_profile",
        title: depo.witness_name ? String(depo.witness_name) : "Witness profile",
        detail: ov.profile,
        segment_ids: [],
        issue_tags: [],
        verify_status: "unverified",
        review_status: "unreviewed",
        ordinal: 0,
        data: {},
      });
    }
    if (rows.length) {
      const r = await sbInsert("deposition_findings", rows);
      if (!r.ok) console.error(`[depo-analyze] overview insert ${r.status}`);
      counts["exec_summary"] = ov.exec ? 1 : 0;
      counts["witness_profile"] = ov.profile ? 1 : 0;
    }

    if (ov.topics.length) {
      const topicRows: Verified[] = ov.topics.slice(0, 12).map((t, i) => ({
        facet: "topic",
        title: String(t.title ?? `Topic ${i + 1}`).slice(0, 160),
        detail: String(t.detail ?? ""),
        quote: "",
        stance: "neutral",
        confidence: 0.7,
        tags: t.coverage ? [String(t.coverage)] : [],
        data: { coverage: t.coverage ?? null },
        segment_ids: [],
        page_start: Number(t.page_start) || 0,
        line_start: 1,
        page_end: Number(t.page_start) || 0,
        line_end: 1,
        cite: Number(t.page_start) ? `${Number(t.page_start)}:1` : "",
        verify_status: "verified",
      }));
      counts["topic"] = await insertFindings(depositionId, caseId, "topic", topicRows, 0);
    }
    progress.overview = "done";
    await writeProgress();
  })();

  // ---- facet fan-out: every facet in flight at once
  const facetJobs = specs.map(async (spec) => {
    try {
      const cands = dedupe(await extractFacet(spec, windows, header));
      const { kept, dropped: d } = verifyAll(cands, index);
      dropped += d;
      const ranked = rank(kept);
      const base = ordinal;
      ordinal += ranked.length;
      counts[spec.key] = await insertFindings(depositionId, caseId, spec.key, ranked, base);
      progress[spec.key] = "done";
    } catch (e) {
      console.error(`[depo-analyze] facet ${spec.key} failed: ${(e as Error).message}`);
      progress[spec.key] = "error";
      counts[spec.key] = 0;
    }
    await writeProgress();
  });

  await Promise.all([overviewJob, ...facetJobs]);

  const elapsed = Date.now() - started;
  const anySucceeded = Object.values(progress).some((v) => v === "done");

  await sbPatch("depositions", `id=eq.${depositionId}`, {
    status: anySucceeded ? "analyzed" : "error",
    error: anySucceeded ? null : "All analysis passes failed",
    metadata: { ...metadata, analysis: { ...progress, updated_at: new Date().toISOString() } },
  });

  const runRes = await sbInsert("deposition_runs", [
    {
      deposition_id: depositionId,
      kind: "analyze",
      stats: {
        version: 2,
        counts,
        dropped,
        progress,
        windows: windows.length,
        segments: segments.length,
        elapsed_ms: elapsed,
      },
    },
  ]);
  if (!runRes.ok) console.error(`[depo-analyze] run insert ${runRes.status}`);

  return json({
    ok: anySucceeded,
    deposition_id: depositionId,
    counts,
    dropped,
    progress,
    elapsed_ms: elapsed,
  });
});
