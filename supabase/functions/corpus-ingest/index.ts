// Supabase Edge Function: corpus-ingest (v4)
// RAG ingestion + embedding migration for the litigation corpus, using Voyage AI voyage-law-2
// (1024-dim, legal-domain model). All embedding is a plain HTTPS call.
//
// v3 — TEXT QUALITY + PAGE METADATA:
//   - QUALITY GATE: CourtListener plain_text is checked for broken PDF extractions before
//     anything is embedded — literal "(cid:N)" tokens, control-character glyph IDs (fonts
//     with no ToUnicode map), and low alphabetic density all mark the text unusable.
//   - PDF FALLBACK: when plain_text is unusable or missing, the actual PDF is fetched from
//     CourtListener storage (documents.filepath_local) and text is extracted with pdf.js
//     (unpdf serverless build), which decodes through the embedded font program and usually
//     recovers readable text where pdftotext emitted CIDs. Extraction is per-page, so those
//     documents get exact page numbers. If the fallback text is also unusable, the document
//     is skipped with an explicit reason — garbage is never embedded.
//   - REAL PAGE NUMBERS: plain_text is split on form-feed (\f) page separators; every chunk
//     carries page_start/page_end. When no page boundaries are detectable, page fields stay
//     null rather than being guessed.
//   - documents.page_count is repaired from the CourtListener record when null/0.
//   - reingest / reingest_all actions purge and rebuild previously ingested documents.
//
// v4 — EXTERNAL-TEXT INLET (ingest_text):
//   Some court PDFs use a custom-encoded font with no ToUnicode map: the glyphs render
//   correctly to a human but every text-layer extractor (pdftotext, pdf.js, pypdf,
//   pdfminer) emits "(cid:N)" tokens or raw control bytes. Those documents can only be
//   recovered by OCR, which is not available in this runtime. The ingest_text action lets
//   an external worker (which CAN OCR) hand pre-extracted page text back into the SAME
//   pipeline: it runs the quality gate, page-aware chunking, Voyage embedding, and the
//   chunk write — so OCR-recovered documents are indexed identically to natively-extracted
//   ones. It targets an existing documents.id, purges that document's current chunks first
//   (idempotent), and does not touch court_orders (the caller decides whether a court_orders
//   row is warranted).
//
// Vector space: chunks.embedding_v2 vector(1024). Documents embed with input_type 'document';
// queries with input_type 'query'. Retrieval via match_chunks_v2 / hybrid_search_v2.
//
// Actions (POST JSON):
//   { action:'candidates', case_id }                       -> order-like entries with available
//                                                             docs not yet in the corpus
//   { action:'ingest_one', case_id, entry_number }         -> ingest that entry's main document
//   { action:'backfill',  case_id, limit? (<=5, def 3) }   -> ingest up to N pending candidates
//   { action:'reingest',  case_id, entry_number }          -> purge + rebuild one ingested doc
//   { action:'reingest_all', case_id, limit? (<=5, def 4) }-> purge + rebuild up to N v2-era docs
//   { action:'ingest_text', case_id, document_id, pages:[..],
//            doc_label?, order_type?, order_number?, order_date?, source_tag? (def 'ocr_recovered'),
//            page_count? }                                 -> embed + write externally-extracted
//                                                             (e.g. OCR) page text for one document
//   { action:'reembed',   limit? (<=600, def 480) }        -> re-embed chunks missing embedding_v2
//   { action:'embed_query', query }                        -> 1024-dim query vector (pgvector text)
//   { action:'search_test', query, case_id?, k? }          -> embed query + match_chunks_v2 sanity run
//
// Idempotent ingestion: documents already in court_orders (by documents.id) are skipped.
// tsv is GENERATED — never written. Secrets: VOYAGE_API_KEY, COURTLISTENER_API_KEY;
// SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY auto-injected.

import { getDocumentProxy, extractText } from "npm:unpdf";

const VOYAGE_API_KEY = Deno.env.get("VOYAGE_API_KEY") ?? "";
const COURTLISTENER_API_KEY = Deno.env.get("COURTLISTENER_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CL_BASE = "https://www.courtlistener.com/api/rest/v4";
const CL_STORAGE = "https://storage.courtlistener.com";
const VOYAGE_URL = "https://api.voyageai.com/v1/embeddings";
const VOYAGE_MODEL = "voyage-law-2";
const CL_TIMEOUT_MS = 45000;
const PDF_TIMEOUT_MS = 40000;
const PDF_MAX_BYTES = 26_000_000;   // hard cap on fetched PDF size
const VOYAGE_TIMEOUT_MS = 60000;
const CHUNK_TARGET = 1600;      // chars per chunk
const CHUNK_OVERLAP = 200;      // trailing-context overlap
const MAX_CHUNKS_PER_DOC = 120; // voyage batching makes larger docs cheap
const MIN_TEXT_CHARS = 400;     // below this, not worth ingesting
const VOYAGE_BATCH = 96;        // inputs per embeddings request

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}
async function sbFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return await fetch(`${SUPABASE_URL}${path}`, {
    ...init,
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}`, ...(init.headers ?? {}) },
  });
}
async function clGet(path: string): Promise<any> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CL_TIMEOUT_MS);
  try {
    const resp = await fetch(`${CL_BASE}${path}`, {
      headers: { Accept: "application/json", Authorization: `Token ${COURTLISTENER_API_KEY}` },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`CourtListener ${resp.status}: ${t.slice(0, 200)}`);
    }
    return await resp.json();
  } finally { clearTimeout(timer); }
}

// ---------- Voyage embeddings ----------
function toVec(v: number[]): string {
  return "[" + v.map((x) => Number(x).toFixed(6)).join(",") + "]";
}
async function voyageEmbed(inputs: string[], inputType: "document" | "query"): Promise<string[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), VOYAGE_TIMEOUT_MS);
  try {
    const resp = await fetch(VOYAGE_URL, {
      method: "POST",
      signal: ctrl.signal,
      headers: { Authorization: `Bearer ${VOYAGE_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ input: inputs, model: VOYAGE_MODEL, input_type: inputType, truncation: true }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`Voyage ${resp.status}: ${t.slice(0, 300)}`);
    }
    const data = await resp.json();
    const arr: string[] = new Array(inputs.length);
    for (const item of data?.data ?? []) arr[item.index] = toVec(item.embedding as number[]);
    for (let i = 0; i < arr.length; i++) if (!arr[i]) throw new Error(`Voyage returned no embedding for input ${i}`);
    return arr;
  } finally { clearTimeout(timer); }
}
async function voyageEmbedAll(inputs: string[], inputType: "document" | "query"): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < inputs.length; i += VOYAGE_BATCH) {
    const batch = inputs.slice(i, i + VOYAGE_BATCH);
    out.push(...await voyageEmbed(batch, inputType));
  }
  return out;
}

// ---------- text quality (v3) ----------
// Detects the two broken-PDF-extraction signatures seen in this corpus — literal "(cid:N)"
// tokens and raw control-character glyph IDs (fonts lacking a ToUnicode map) — plus a
// general low-alphabetic-density check. Evaluated on a bounded sample for speed.
function textQuality(t: string): { usable: boolean; cid: number; ctrl_ratio: number; alpha_ratio: number } {
  const sample = (t ?? "").slice(0, 30000);
  const len = Math.max(sample.length, 1);
  const cid = (sample.match(/\(cid:\d+\)/g) || []).length;
  const ctrl = (sample.match(/[\x00-\x08\x0B\x0E-\x1F]/g) || []).length;
  const alpha = (sample.match(/[A-Za-z]/g) || []).length;
  const ctrl_ratio = ctrl / len;
  const alpha_ratio = alpha / len;
  const usable = cid < 5 && ctrl_ratio < 0.02 && alpha_ratio > 0.35;
  return { usable, cid, ctrl_ratio: Number(ctrl_ratio.toFixed(4)), alpha_ratio: Number(alpha_ratio.toFixed(4)) };
}

// ---------- classification ----------
function classify(text: string): { order_type: string; significant: boolean } {
  const t = (text || "").toLowerCase();
  if (/case management order/.test(t)) return { order_type: "CMO", significant: true };
  if (/pretrial order|pre-trial order/.test(t)) return { order_type: "PTO", significant: true };
  if (/memorandum decision|memorandum opinion|memorandum and order|report and recommendation/.test(t)) return { order_type: "opinion", significant: true };
  if (/\border\b/.test(t) && !/proposed order/.test(t)) return { order_type: "order", significant: true };
  if (/\bopinion\b/.test(t) && !/experts?'? opinions?/.test(t)) return { order_type: "opinion", significant: true };
  if (/motion to exclude|daubert|rule 702/.test(t)) return { order_type: "motion", significant: true };
  if (/transcript/.test(t)) return { order_type: "transcript", significant: false };
  return { order_type: "filing", significant: false };
}
function extractOrderNumber(text: string): string | null {
  const m = (text || "").match(/(?:order|cmo|pto)\s*(?:no\.?|number|#)\s*(\d+[A-Za-z]?)/i);
  return m ? m[1] : null;
}

// ---------- page-aware chunking (v3) ----------
interface Piece { content: string; char_start: number; char_end: number; page_start: number | null; page_end: number | null }

function cleanPage(p: string): string {
  return p.replace(/\r\n/g, "\n").replace(/[ \t]+\n/g, "\n").replace(/\n{4,}/g, "\n\n\n");
}

// Split CourtListener plain_text into pages on form-feed separators (pdftotext inserts \f
// between pages). Returns null when no page structure is detectable.
function splitPlainTextPages(raw: string): string[] | null {
  if (!raw.includes("\f")) return null;
  const pages = raw.split("\f").map(cleanPage);
  return pages.length > 1 ? pages : null;
}

// Chunk a document given its pages. When `pages` has real page structure, every chunk gets
// exact page_start/page_end; when the document arrives as one undifferentiated blob
// (pagesKnown=false), page fields stay null — an unknown page is better than a wrong cite.
function chunkPaged(pages: string[], pagesKnown: boolean): Piece[] {
  const cleaned = pages.map(cleanPage);
  // Build the joined text and the starting offset of each page within it.
  const boundaries: number[] = [];
  let joined = "";
  for (let i = 0; i < cleaned.length; i++) {
    boundaries.push(joined.length);
    joined += cleaned[i];
    if (i < cleaned.length - 1) joined += "\n";
  }
  const pageOf = (offset: number): number => {
    let lo = 0, hi = boundaries.length - 1, ans = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (boundaries[mid] <= offset) { ans = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return ans + 1; // 1-based page numbers
  };

  const out: Piece[] = [];
  let pos = 0;
  while (pos < joined.length && out.length < MAX_CHUNKS_PER_DOC) {
    let end = Math.min(pos + CHUNK_TARGET, joined.length);
    if (end < joined.length) {
      const windowStart = pos + Math.floor(CHUNK_TARGET * 0.5);
      const para = joined.lastIndexOf("\n\n", end);
      const sent = Math.max(joined.lastIndexOf(". ", end), joined.lastIndexOf(".\n", end));
      const space = joined.lastIndexOf(" ", end);
      if (para > windowStart) end = para;
      else if (sent > windowStart) end = sent + 1;
      else if (space > windowStart) end = space;
    }
    const content = joined.slice(pos, end).trim();
    if (content.length > 40) {
      out.push({
        content,
        char_start: pos,
        char_end: end,
        page_start: pagesKnown ? pageOf(pos) : null,
        page_end: pagesKnown ? pageOf(Math.max(end - 1, pos)) : null,
      });
    }
    if (end >= joined.length) break;
    pos = Math.max(end - CHUNK_OVERLAP, pos + 1);
  }
  return out;
}

// ---------- PDF fallback extraction (v3) ----------
// Fetches the document's PDF from CourtListener storage and extracts text per page with
// pdf.js (unpdf). Used when plain_text is unusable or missing. Best-effort: returns null
// on any failure so the caller can decide to skip.
async function extractPdfPages(filepathLocal: string): Promise<string[] | null> {
  const path = (filepathLocal ?? "").toString().trim();
  if (!path) return null;
  const url = `${CL_STORAGE}/${path.replace(/^\//, "")}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PDF_TIMEOUT_MS);
  try {
    const resp = await fetch(url, { signal: ctrl.signal });
    if (!resp.ok) return null;
    const buf = await resp.arrayBuffer();
    if (buf.byteLength === 0 || buf.byteLength > PDF_MAX_BYTES) return null;
    const pdf = await getDocumentProxy(new Uint8Array(buf));
    const { text } = await extractText(pdf, { mergePages: false });
    const pages = (Array.isArray(text) ? text : [String(text ?? "")]).map((p) => (p ?? "").toString());
    if (!pages.length) return null;
    return pages;
  } catch (_e) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// ---------- candidate discovery ----------
interface Candidate {
  docket_entry_id: string; entry_number: number | null; date_filed: string | null;
  descr: string; document_id: string; cl_recap_document_id: number; order_type: string;
}
function toCandidate(e: any, main: any): Candidate | null {
  if (!main?.cl_recap_document_id) return null;
  const descr = [e.description_clean, e.description_raw, main.short_description]
    .map((s: any) => (s ?? "").toString().trim()).filter(Boolean).join(" \u2014 ");
  const cls = classify(descr);
  return {
    docket_entry_id: e.id, entry_number: e.entry_number ?? null, date_filed: e.date_filed ?? null,
    descr, document_id: main.id, cl_recap_document_id: main.cl_recap_document_id, order_type: cls.order_type,
  };
}
function mainDoc(e: any): any {
  const docs = Array.isArray(e.documents) ? e.documents : [];
  return docs.find((d: any) => d.attachment_number == null) ?? docs[0];
}
async function findCandidates(caseId: string, limit: number): Promise<Candidate[]> {
  const eRes = await sbFetch(
    `/rest/v1/docket_entries?case_id=eq.${caseId}` +
    `&select=id,entry_number,date_filed,description_clean,description_raw,` +
    `documents(id,cl_recap_document_id,short_description,attachment_number,is_available_remote)` +
    `&order=date_filed.desc.nullslast,entry_number.desc.nullslast&limit=400`,
  );
  const entries = (await eRes.json().catch(() => [])) as any[];
  if (!Array.isArray(entries)) return [];

  const oRes = await sbFetch(`/rest/v1/court_orders?case_id=eq.${caseId}&select=document_id`);
  const existing = new Set(((await oRes.json().catch(() => [])) as any[]).map((r) => r.document_id).filter(Boolean));

  const out: Candidate[] = [];
  for (const e of entries) {
    const main = mainDoc(e);
    if (!main?.cl_recap_document_id) continue;
    if (main.is_available_remote === false) continue;
    if (existing.has(main.id)) continue;
    const descr = [e.description_clean, e.description_raw, main.short_description].map((s: any) => (s ?? "").toString().trim()).filter(Boolean).join(" \u2014 ");
    const cls = classify(descr);
    if (!cls.significant) continue;
    const c = toCandidate(e, main);
    if (c) out.push(c);
    if (out.length >= limit) break;
  }
  return out;
}

// Build a Candidate for a specific entry straight from our own tables (used by reingest,
// which must not depend on the newest-400 candidate scan or the significance filter).
async function candidateFromDb(caseId: string, entryNumber: number): Promise<Candidate | null> {
  const eRes = await sbFetch(
    `/rest/v1/docket_entries?case_id=eq.${caseId}&entry_number=eq.${entryNumber}` +
    `&select=id,entry_number,date_filed,description_clean,description_raw,` +
    `documents(id,cl_recap_document_id,short_description,attachment_number,is_available_remote)&limit=1`,
  );
  const rows = (await eRes.json().catch(() => [])) as any[];
  if (!Array.isArray(rows) || !rows.length) return null;
  const e = rows[0];
  const main = mainDoc(e);
  if (!main?.cl_recap_document_id) return null;
  return toCandidate(e, main);
}

// ---------- ingestion ----------
async function ingestCandidate(caseId: string, c: Candidate): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  // 1) full text from CourtListener (plain_text + PDF location + page count)
  let doc: any;
  try {
    doc = await clGet(`/recap-documents/${c.cl_recap_document_id}/?fields=plain_text,page_count,absolute_url,filepath_local,is_available`);
  } catch (e) {
    return { entry: c.entry_number, ok: false, reason: `cl_fetch: ${(e as Error).message}` };
  }
  const plain = (doc?.plain_text ?? "").toString();
  const clPageCount = Number.isFinite(doc?.page_count) ? doc.page_count : null;

  // 2) choose a usable text source (quality gate + PDF fallback)
  let pages: string[] | null = null;
  let pagesKnown = false;
  let textSource = "courtlistener_plain";
  let quality = textQuality(plain);

  if (plain.trim().length >= MIN_TEXT_CHARS && quality.usable) {
    const split = splitPlainTextPages(plain);
    if (split) { pages = split; pagesKnown = true; }
    else { pages = [plain]; pagesKnown = clPageCount === 1; }
  } else {
    // plain_text is missing or a broken extraction — try the PDF itself
    const pdfPages = await extractPdfPages(doc?.filepath_local);
    if (pdfPages) {
      const pdfJoined = pdfPages.join("\n");
      const pdfQuality = textQuality(pdfJoined);
      if (pdfJoined.trim().length >= MIN_TEXT_CHARS && pdfQuality.usable) {
        pages = pdfPages;
        pagesKnown = true;
        textSource = "pdf_extract";
        quality = pdfQuality;
      }
    }
  }

  if (!pages) {
    return {
      entry: c.entry_number, ok: false, reason: "unusable_text",
      detail: { plain_chars: plain.trim().length, quality },
    };
  }

  // 3) chunk + embed BEFORE registering, so a Voyage failure leaves no partial state
  const pieces = chunkPaged(pages, pagesKnown);
  if (!pieces.length) {
    return { entry: c.entry_number, ok: false, reason: "no_chunks_after_cleaning" };
  }
  let vectors: string[];
  try {
    vectors = await voyageEmbedAll(pieces.map((p) => p.content), "document");
  } catch (e) {
    return { entry: c.entry_number, ok: false, reason: `voyage: ${(e as Error).message}` };
  }

  // 4) register in court_orders
  const title = c.descr.slice(0, 300) || `Docket entry ${c.entry_number}`;
  const baseTags = ["auto_ingested", "courtlistener"];
  if (textSource === "pdf_extract") baseTags.push("pdf_extracted");
  const orderRow = {
    case_id: caseId,
    document_id: c.document_id,
    order_type: c.order_type,
    order_number: extractOrderNumber(c.descr),
    canonical_title: title,
    order_date: c.date_filed,
    summary: null,
    source_page_url: doc?.absolute_url ? `https://www.courtlistener.com${doc.absolute_url}` : null,
    pdf_url: doc?.filepath_local ? `${CL_STORAGE}/${String(doc.filepath_local).replace(/^\//, "")}` : null,
    recap_document_number: c.entry_number,
    tags: baseTags,
  };
  const insO = await sbFetch(`/rest/v1/court_orders`, {
    method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=representation" },
    body: JSON.stringify(orderRow),
  });
  if (!insO.ok) {
    const t = await insO.text().catch(() => "");
    return { entry: c.entry_number, ok: false, reason: `court_orders insert ${insO.status}: ${t.slice(0, 150)}` };
  }
  const courtOrderId = ((await insO.json().catch(() => [])) as any[])?.[0]?.id ?? null;

  // 5) insert chunks (embedding_v2 only — the 384-dim column is legacy)
  const rows: Record<string, unknown>[] = pieces.map((p, i) => ({
    case_id: caseId,
    court_order_id: courtOrderId,
    document_id: c.document_id,
    chunk_index: i,
    content: p.content,
    char_start: p.char_start,
    char_end: p.char_end,
    page_start: p.page_start,
    page_end: p.page_end,
    token_count: Math.round(p.content.length / 4),
    embedding_v2: vectors[i],
    doc_source: "courtlistener",
    doc_label: title,
    order_type: c.order_type,
    order_number: extractOrderNumber(c.descr),
    order_date: c.date_filed,
    tags: ["auto_ingested"],
  }));
  const insC = await sbFetch(`/rest/v1/chunks`, {
    method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!insC.ok) {
    const t = await insC.text().catch(() => "");
    if (courtOrderId) await sbFetch(`/rest/v1/court_orders?id=eq.${courtOrderId}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    return { entry: c.entry_number, ok: false, reason: `chunks insert ${insC.status}: ${t.slice(0, 150)}` };
  }

  // 6) repair documents.page_count when the DB row lacks it
  const bestPageCount = clPageCount ?? (pagesKnown ? pages.length : null);
  if (bestPageCount) {
    await sbFetch(`/rest/v1/documents?id=eq.${c.document_id}&or=(page_count.is.null,page_count.eq.0)`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ page_count: bestPageCount }),
    }).catch(() => {});
  }

  return {
    entry: c.entry_number, ok: true, order_type: c.order_type, title: title.slice(0, 90),
    chunks: rows.length, chars: pages.join("\n").length, pages: pagesKnown ? pages.length : null,
    text_source: textSource, truncated: pieces.length >= MAX_CHUNKS_PER_DOC, ms: Date.now() - t0,
  };
}

// ---------- ingest_text (v4): embed + write externally-extracted (e.g. OCR) page text ----------
// The caller supplies the ordered page text for one existing documents.id. We run the same
// quality gate, page-aware chunking, and Voyage embedding as the native path, purge that
// document's current chunks, and write fresh ones. court_orders is left to the caller.
async function ingestText(payload: any): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const caseId = (payload?.case_id ?? "").toString().trim();
  const documentId = (payload?.document_id ?? "").toString().trim();
  const pagesIn = Array.isArray(payload?.pages) ? payload.pages : null;
  if (!caseId) return { ok: false, reason: "case_id required" };
  if (!documentId) return { ok: false, reason: "document_id required" };
  if (!pagesIn || !pagesIn.length) return { ok: false, reason: "pages[] required (ordered page text)" };

  const pages = pagesIn.map((p: any) => (p ?? "").toString());
  const joined = pages.join("\n");
  const quality = textQuality(joined);
  if (joined.trim().length < MIN_TEXT_CHARS || !quality.usable) {
    return { ok: false, reason: "unusable_text", detail: { chars: joined.trim().length, quality } };
  }

  // Page structure is authoritative: the caller extracted per page, so pagesKnown=true.
  const pieces = chunkPaged(pages, true);
  if (!pieces.length) return { ok: false, reason: "no_chunks_after_cleaning" };

  let vectors: string[];
  try {
    vectors = await voyageEmbedAll(pieces.map((p) => p.content), "document");
  } catch (e) {
    return { ok: false, reason: `voyage: ${(e as Error).message}` };
  }

  const label = (payload?.doc_label ?? "").toString().trim() || null;
  const orderType = (payload?.order_type ?? "").toString().trim() || null;
  const orderNumber = (payload?.order_number ?? "").toString().trim() || null;
  const orderDate = (payload?.order_date ?? "").toString().trim() || null;
  const sourceTag = (payload?.source_tag ?? "ocr_recovered").toString().trim() || "ocr_recovered";

  // Keep the court_order linkage if one already exists for this document (so recovered chunks
  // stay attached to their order); otherwise write document-layer chunks (court_order_id null).
  let courtOrderId: string | null = null;
  try {
    const oRes = await sbFetch(`/rest/v1/court_orders?case_id=eq.${caseId}&document_id=eq.${documentId}&select=id&limit=1`);
    const orders = (await oRes.json().catch(() => [])) as any[];
    courtOrderId = orders?.[0]?.id ?? null;
  } catch (_e) { courtOrderId = null; }

  // Purge existing chunks for this document (idempotent re-run).
  await sbFetch(`/rest/v1/chunks?document_id=eq.${documentId}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });

  const rows: Record<string, unknown>[] = pieces.map((p, i) => ({
    case_id: caseId,
    court_order_id: courtOrderId,
    document_id: documentId,
    chunk_index: i,
    content: p.content,
    char_start: p.char_start,
    char_end: p.char_end,
    page_start: p.page_start,
    page_end: p.page_end,
    token_count: Math.round(p.content.length / 4),
    embedding_v2: vectors[i],
    doc_source: "courtlistener",
    doc_label: label,
    order_type: orderType,
    order_number: orderNumber,
    order_date: orderDate,
    tags: [sourceTag],
  }));
  const insC = await sbFetch(`/rest/v1/chunks`, {
    method: "POST", headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify(rows),
  });
  if (!insC.ok) {
    const t = await insC.text().catch(() => "");
    return { ok: false, reason: `chunks insert ${insC.status}: ${t.slice(0, 150)}` };
  }

  // Repair documents.page_count from the caller's count when the DB row lacks it.
  const pageCount = Number.isFinite(payload?.page_count) ? Math.floor(payload.page_count) : pages.length;
  if (pageCount) {
    await sbFetch(`/rest/v1/documents?id=eq.${documentId}&or=(page_count.is.null,page_count.eq.0)`, {
      method: "PATCH", headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify({ page_count: pageCount }),
    }).catch(() => {});
  }

  return {
    ok: true, document_id: documentId, chunks: rows.length, pages: pages.length,
    linked_court_order: courtOrderId, quality, source_tag: sourceTag, ms: Date.now() - t0,
  };
}

// ---------- reingest (v3): purge + rebuild one previously ingested document ----------
async function reingestEntry(caseId: string, entryNumber: number): Promise<Record<string, unknown>> {
  const cand = await candidateFromDb(caseId, entryNumber);
  if (!cand) return { entry: entryNumber, ok: false, reason: "entry_or_document_not_found" };

  // Purge the existing registration (chunks first, then the order row).
  const oRes = await sbFetch(`/rest/v1/court_orders?case_id=eq.${caseId}&document_id=eq.${cand.document_id}&select=id`);
  const orders = (await oRes.json().catch(() => [])) as any[];
  for (const o of (Array.isArray(orders) ? orders : [])) {
    await sbFetch(`/rest/v1/chunks?court_order_id=eq.${o.id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    await sbFetch(`/rest/v1/court_orders?id=eq.${o.id}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
  }
  const res = await ingestCandidate(caseId, cand);
  return { ...res, reingested: true, purged_orders: Array.isArray(orders) ? orders.length : 0 };
}

// Find v2-era ingested documents (their chunks have null page_start) for a case, oldest first.
async function v2EraEntries(caseId: string, limit: number): Promise<number[]> {
  const oRes = await sbFetch(
    `/rest/v1/court_orders?case_id=eq.${caseId}&tags=cs.{auto_ingested}` +
    `&select=id,recap_document_number&order=created_at.asc&limit=100`,
  );
  const orders = (await oRes.json().catch(() => [])) as any[];
  const out: number[] = [];
  for (const o of (Array.isArray(orders) ? orders : [])) {
    if (out.length >= limit) break;
    if (o.recap_document_number == null) continue;
    const cRes = await sbFetch(`/rest/v1/chunks?court_order_id=eq.${o.id}&page_start=is.null&select=id&limit=1`);
    const rows = (await cRes.json().catch(() => [])) as any[];
    if (Array.isArray(rows) && rows.length) out.push(o.recap_document_number);
  }
  return out;
}

// ---------- migration: re-embed existing corpus ----------
async function reembed(limit: number): Promise<Record<string, unknown>> {
  const t0 = Date.now();
  const res = await sbFetch(`/rest/v1/chunks?embedding_v2=is.null&select=id,content&order=id&limit=${limit}`);
  const rows = (await res.json().catch(() => [])) as { id: string; content: string }[];
  if (!Array.isArray(rows) || rows.length === 0) {
    return { processed: 0, remaining: 0, done: true };
  }
  let processed = 0;
  for (let i = 0; i < rows.length; i += VOYAGE_BATCH) {
    const batch = rows.slice(i, i + VOYAGE_BATCH);
    const vecs = await voyageEmbed(batch.map((r) => (r.content ?? "").toString().slice(0, 12000)), "document");
    const payload = batch.map((r, j) => ({ id: r.id, emb: vecs[j] }));
    const upd = await sbFetch(`/rest/v1/rpc/set_chunk_embeddings_v2`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rows: payload }),
    });
    if (!upd.ok) {
      const t = await upd.text().catch(() => "");
      throw new Error(`bulk update ${upd.status}: ${t.slice(0, 200)}`);
    }
    processed += batch.length;
  }
  const cRes = await sbFetch(`/rest/v1/chunks?embedding_v2=is.null&select=id&limit=1`, {
    method: "HEAD", headers: { Prefer: "count=exact" },
  });
  const remaining = Number((cRes.headers.get("content-range") ?? "/0").split("/")[1] ?? "0");
  return { processed, remaining, done: remaining === 0, ms: Date.now() - t0 };
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  if (!VOYAGE_API_KEY) return json({ ok: false, error: "VOYAGE_API_KEY not configured" }, 400);

  let payload: any = {};
  try { payload = await req.json(); } catch { return json({ ok: false, error: "Bad JSON" }, 400); }
  const action = (payload?.action ?? "").toString();
  const caseId = (payload?.case_id ?? "").toString().trim();

  try {
    if (action === "embed_query") {
      const q = (payload?.query ?? "").toString().trim();
      if (!q) return json({ ok: false, error: "query required" }, 400);
      const [vec] = await voyageEmbed([q.slice(0, 8000)], "query");
      return json({ ok: true, embedding: vec, dims: 1024, model: VOYAGE_MODEL });
    }

    if (action === "search_test") {
      const q = (payload?.query ?? "").toString().trim();
      if (!q) return json({ ok: false, error: "query required" }, 400);
      const k = Math.max(1, Math.min(20, Number(payload?.k) || 6));
      const [vec] = await voyageEmbed([q.slice(0, 8000)], "query");
      const filter: Record<string, unknown> = {};
      if (caseId) filter.case_id = caseId;
      const rpc = await sbFetch(`/rest/v1/rpc/match_chunks_v2`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ query_embedding: vec, filter, k }),
      });
      const hits = (await rpc.json().catch(() => [])) as any[];
      return json({
        ok: true, query: q,
        hits: (Array.isArray(hits) ? hits : []).map((h) => ({
          score: h.score, label: (h.doc_label ?? "").slice(0, 80), type: h.order_type,
          date: h.order_date, pages: [h.page_start, h.page_end], snippet: (h.content ?? "").slice(0, 140),
        })),
      });
    }

    if (action === "ingest_text") {
      const res = await ingestText(payload);
      console.log(`[corpus-ingest v4] ingest_text ${JSON.stringify({ doc: res.document_id, ok: res.ok, n: res.chunks, why: res.reason ?? null })}`);
      return json({ ok: res.ok !== false, result: res }, res.ok === false ? 422 : 200);
    }

    if (action === "reembed") {
      const limit = Math.max(96, Math.min(600, Number(payload?.limit) || 480));
      const res = await reembed(limit);
      console.log(`[corpus-ingest v4] reembed ${JSON.stringify(res)}`);
      return json({ ok: true, ...res });
    }

    if (!caseId) return json({ ok: false, error: "case_id required" }, 400);

    if (action === "candidates") {
      const cands = await findCandidates(caseId, 40);
      return json({ ok: true, count: cands.length, candidates: cands.map((c) => ({ entry: c.entry_number, date: c.date_filed, type: c.order_type, descr: c.descr.slice(0, 110) })) });
    }

    if (action === "ingest_one") {
      const entryNumber = Number(payload?.entry_number);
      if (!Number.isFinite(entryNumber)) return json({ ok: false, error: "entry_number required" }, 400);
      const cands = await findCandidates(caseId, 400);
      const c = cands.find((x) => x.entry_number === entryNumber);
      if (!c) return json({ ok: false, error: "entry not found among pending candidates (already ingested, no available document, or not order-like)" }, 404);
      const res = await ingestCandidate(caseId, c);
      console.log(`[corpus-ingest v4] ingest_one ${JSON.stringify(res)}`);
      return json({ ok: true, result: res });
    }

    if (action === "backfill") {
      const limit = Math.max(1, Math.min(5, Number.isFinite(payload?.limit) ? Math.floor(payload.limit) : 3));
      const cands = await findCandidates(caseId, limit);
      const results: Record<string, unknown>[] = [];
      for (const c of cands) results.push(await ingestCandidate(caseId, c));
      console.log(`[corpus-ingest v4] backfill ${JSON.stringify(results.map((r) => ({ e: r.entry, ok: r.ok, n: r.chunks, src: r.text_source ?? null })))}`);
      return json({ ok: true, attempted: results.length, results });
    }

    if (action === "reingest") {
      const entryNumber = Number(payload?.entry_number);
      if (!Number.isFinite(entryNumber)) return json({ ok: false, error: "entry_number required" }, 400);
      const res = await reingestEntry(caseId, entryNumber);
      console.log(`[corpus-ingest v4] reingest ${JSON.stringify(res)}`);
      return json({ ok: true, result: res });
    }

    if (action === "reingest_all") {
      const limit = Math.max(1, Math.min(5, Number.isFinite(payload?.limit) ? Math.floor(payload.limit) : 4));
      const entries = await v2EraEntries(caseId, limit);
      const results: Record<string, unknown>[] = [];
      for (const n of entries) results.push(await reingestEntry(caseId, n));
      const remaining = (await v2EraEntries(caseId, 100)).length;
      console.log(`[corpus-ingest v4] reingest_all ${JSON.stringify({ done: results.map((r) => ({ e: r.entry, ok: r.ok, n: r.chunks, src: r.text_source ?? null, why: r.reason ?? null })), remaining })}`);
      return json({ ok: true, attempted: results.length, results, remaining });
    }

    return json({ ok: false, error: "unknown action (candidates | ingest_one | backfill | reingest | reingest_all | ingest_text | reembed | embed_query | search_test)" }, 400);
  } catch (e) {
    console.error(`[corpus-ingest v4] ${action} failed: ${(e as Error).message}`);
    return json({ ok: false, action, error: (e as Error).message }, 500);
  }
});
