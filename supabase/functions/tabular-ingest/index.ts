// Supabase Edge Function: tabular-ingest
// Transcribe an uploaded review file into page-marked text for the Tabular Review grid.
//
// PDFs and images are transcribed with Gemini 3.1 Flash vision (OCR + layout-aware, handles
// scans, tables, stamps, handwriting). Plain text/markdown is stored directly. Pages are split
// on explicit page markers so downstream extraction can cite by page number.
//
// Request (POST JSON): { review_file_id: string }
// Response (JSON): { ok, review_file_id, status, page_count, char_count }
//
// Secrets: GEMINI_API_KEY (already configured). SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY auto-injected.

import { encodeBase64 } from "https://deno.land/std@0.224.0/encoding/base64.ts";

const GEMINI_API_KEY = Deno.env.get("GEMINI_API_KEY") ?? "";
const VISION_MODEL = Deno.env.get("VISION_MODEL") ?? "gemini-3.1-flash";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const BUCKET = "review-files";
const GEMINI_GEN_URL = `https://generativelanguage.googleapis.com/v1beta/models/${VISION_MODEL}:generateContent`;
const MAX_BYTES = 20 * 1024 * 1024;     // inline-data request ceiling
const GEMINI_TIMEOUT_MS = 120000;
const PAGE_RE = /===\s*PAGE\s+(\d+)\s*===/gi;

const TRANSCRIBE_PROMPT =
  "You are a meticulous legal document transcriber. Transcribe this document to clean Markdown, " +
  "page by page, EXACTLY as written. For every page output a line of the form `=== PAGE n ===` " +
  "(n = 1-based page number) followed by that page's full content. Transcribe ALL text verbatim — " +
  "headings, body, footnotes, headers/footers, page numbers, tables (as Markdown tables), stamps, " +
  "handwriting, and signature blocks. Do NOT summarize, paraphrase, translate, or omit anything. " +
  "Preserve reading order. If a page is genuinely blank, output its marker then `(blank page)`.";

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
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      ...(init.headers ?? {}),
    },
  });
}

async function patchFile(id: string, patch: Record<string, unknown>): Promise<void> {
  await sbFetch(`/rest/v1/review_files?id=eq.${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
    body: JSON.stringify({ ...patch, updated_at: new Date().toISOString() }),
  }).catch(() => {});
}

// Split a Gemini transcription into { page_number, text } using the `=== PAGE n ===` markers.
function splitPages(transcript: string): { page_number: number; text: string }[] {
  const out: { page_number: number; text: string }[] = [];
  const matches = [...transcript.matchAll(PAGE_RE)];
  if (matches.length === 0) {
    const t = transcript.trim();
    return t ? [{ page_number: 1, text: t }] : [];
  }
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const n = Number(m[1]) || i + 1;
    const start = (m.index ?? 0) + m[0].length;
    const end = i + 1 < matches.length ? (matches[i + 1].index ?? transcript.length) : transcript.length;
    const text = transcript.slice(start, end).trim();
    out.push({ page_number: n, text });
  }
  return out;
}

async function geminiTranscribe(base64: string, mimeType: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), GEMINI_TIMEOUT_MS);
  try {
    const resp = await fetch(GEMINI_GEN_URL, {
      method: "POST",
      headers: { "x-goog-api-key": GEMINI_API_KEY, "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify({
        contents: [{
          role: "user",
          parts: [
            { inline_data: { mime_type: mimeType, data: base64 } },
            { text: TRANSCRIBE_PROMPT },
          ],
        }],
        generationConfig: { temperature: 0, maxOutputTokens: 32768 },
      }),
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`Gemini ${resp.status}: ${t.slice(0, 300)}`);
    }
    const data = await resp.json();
    const cand = data?.candidates?.[0];
    const parts = cand?.content?.parts ?? [];
    const text = parts.map((p: any) => p?.text ?? "").join("");
    if (!text.trim()) {
      const reason = cand?.finishReason || data?.promptFeedback?.blockReason || "empty response";
      throw new Error(`Gemini returned no text (${reason})`);
    }
    return text;
  } finally {
    clearTimeout(timer);
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  if (!GEMINI_API_KEY) return json({ ok: false, error: "GEMINI_API_KEY not configured." }, 400);

  let payload: any = {};
  try { payload = await req.json(); } catch { return json({ ok: false, error: "Bad JSON" }, 400); }
  const fileId = (payload?.review_file_id ?? "").toString().trim();
  if (!fileId) return json({ ok: false, error: "review_file_id required" }, 400);

  // Load the file row.
  let file: any;
  try {
    const r = await sbFetch(`/rest/v1/review_files?id=eq.${fileId}&select=*`);
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return json({ ok: false, error: "review_file not found" }, 404);
    file = rows[0];
  } catch (e) {
    return json({ ok: false, error: `Load failed: ${(e as Error).message}` }, 500);
  }

  await patchFile(fileId, { status: "transcribing", error: null });

  // Download the object bytes.
  let bytes: Uint8Array;
  try {
    const r = await sbFetch(`/storage/v1/object/${BUCKET}/${file.storage_path}`);
    if (!r.ok) throw new Error(`storage ${r.status}`);
    bytes = new Uint8Array(await r.arrayBuffer());
  } catch (e) {
    await patchFile(fileId, { status: "error", error: `Download failed: ${(e as Error).message}` });
    return json({ ok: false, error: `Download failed: ${(e as Error).message}` }, 502);
  }
  if (bytes.byteLength > MAX_BYTES) {
    await patchFile(fileId, { status: "error", error: `File exceeds ${MAX_BYTES / 1024 / 1024}MB limit` });
    return json({ ok: false, error: "File too large" }, 413);
  }

  const mime = (file.mime_type ?? "").toLowerCase();
  const name = (file.filename ?? "").toLowerCase();
  const isText = mime.startsWith("text/") || /\.(txt|md|markdown)$/.test(name);
  const isPdf = mime === "application/pdf" || /\.pdf$/.test(name);
  const isImage = mime.startsWith("image/") || /\.(png|jpe?g|webp|gif|tiff?)$/.test(name);

  // Produce page-marked text.
  let pages: { page_number: number; text: string }[] = [];
  let source = "plain";
  try {
    if (isText) {
      const raw = new TextDecoder().decode(bytes).trim();
      // Split on form-feed page breaks if present, else one page.
      const parts = raw.split(/\f/).map((s) => s.trim()).filter(Boolean);
      pages = (parts.length ? parts : [raw]).map((t, i) => ({ page_number: i + 1, text: t }));
      source = "plain";
    } else if (isPdf || isImage) {
      const b64 = encodeBase64(bytes);
      const visionMime = isPdf ? "application/pdf" : (mime.startsWith("image/") ? mime : "image/png");
      const transcript = await geminiTranscribe(b64, visionMime);
      pages = splitPages(transcript);
      source = "gemini_vision";
    } else {
      await patchFile(fileId, { status: "error", error: `Unsupported file type: ${mime || name}` });
      return json({ ok: false, error: `Unsupported file type: ${mime || name}` }, 415);
    }
  } catch (e) {
    await patchFile(fileId, { status: "error", error: `Transcription failed: ${(e as Error).message}` });
    return json({ ok: false, error: `Transcription failed: ${(e as Error).message}` }, 502);
  }

  if (!pages.length) {
    await patchFile(fileId, { status: "error", error: "No text could be extracted" });
    return json({ ok: false, error: "No text extracted" }, 422);
  }

  // Replace any prior pages (idempotent re-ingest), then insert.
  try {
    await sbFetch(`/rest/v1/review_file_pages?review_file_id=eq.${fileId}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    const rows = pages.map((p) => ({ review_file_id: fileId, page_number: p.page_number, text: p.text, source }));
    const ins = await sbFetch(`/rest/v1/review_file_pages`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(rows),
    });
    if (!ins.ok) throw new Error(`insert pages ${ins.status}: ${(await ins.text()).slice(0, 200)}`);
  } catch (e) {
    await patchFile(fileId, { status: "error", error: `Store pages failed: ${(e as Error).message}` });
    return json({ ok: false, error: `Store pages failed: ${(e as Error).message}` }, 500);
  }

  const charCount = pages.reduce((n, p) => n + (p.text?.length ?? 0), 0);
  await patchFile(fileId, { status: "ready", page_count: pages.length, char_count: charCount, error: null });

  return json({ ok: true, review_file_id: fileId, status: "ready", page_count: pages.length, char_count: charCount });
});
