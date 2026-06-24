// Supabase Edge Function: tabular-extract
// Fill one column of the Tabular Review grid: for each ready file in the review, extract the
// typed field value from that document's transcribed pages using Claude with forced tool-use
// (structured output). Every value must be supported by a verbatim quote, which we re-verify
// against the source text server-side (the anti-hallucination backstop) before marking a cell
// "done". Unsupported values become "needs_review"; absent values become "not_found".
//
// Request (POST JSON): { review_set_id: string, column_id: string, file_ids?: string[] }
// Response (JSON): { ok, column_id, results: [{ file_id, state, value, confidence }] }
//
// Secrets: ANTHROPIC_API_KEY (already configured). SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY auto-injected.

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const EXTRACT_MODEL = Deno.env.get("EXTRACT_MODEL") ?? "claude-opus-4-8";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MAX_DOC_CHARS = 240000;     // ~60k tokens; bounds context for very long docs
const CONCURRENCY = 4;
const ANTHROPIC_TIMEOUT_MS = 90000;

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

function typeHint(dataType: string, enumOptions: string[] | null): string {
  switch (dataType) {
    case "number": return "a single number (digits only, no units or commas)";
    case "currency": return "a monetary amount as a number (no currency symbol or commas)";
    case "date": return "a date in ISO format YYYY-MM-DD";
    case "boolean": return "a boolean true or false";
    case "list": return "a JSON array of short strings";
    case "enum": return `exactly one of these options: ${(enumOptions ?? []).join(", ") || "(none provided)"}`;
    default: return "a concise text value";
  }
}

// Normalize for verbatim-quote verification (whitespace + case + smart quotes).
function norm(s: string): string {
  return (s || "")
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function coerceValue(dataType: string, value: unknown, enumOptions: string[] | null): { text: string | null; jsonVal: unknown; typeOk: boolean } {
  if (value === null || value === undefined || value === "") return { text: null, jsonVal: null, typeOk: true };
  try {
    switch (dataType) {
      case "number":
      case "currency": {
        const n = typeof value === "number" ? value : Number(String(value).replace(/[^0-9.\-]/g, ""));
        if (!Number.isFinite(n)) return { text: String(value), jsonVal: value, typeOk: false };
        return { text: String(n), jsonVal: n, typeOk: true };
      }
      case "boolean": {
        const b = typeof value === "boolean" ? value : /^(true|yes|y)$/i.test(String(value).trim());
        return { text: b ? "Yes" : "No", jsonVal: b, typeOk: true };
      }
      case "date": {
        const s = String(value).trim();
        return { text: s, jsonVal: s, typeOk: /^\d{4}-\d{2}-\d{2}/.test(s) };
      }
      case "list": {
        const arr = Array.isArray(value) ? value : String(value).split(/[;,]/).map((x) => x.trim()).filter(Boolean);
        return { text: arr.join("; "), jsonVal: arr, typeOk: true };
      }
      case "enum": {
        const s = String(value).trim();
        const ok = !enumOptions?.length || enumOptions.some((o) => o.toLowerCase() === s.toLowerCase());
        return { text: s, jsonVal: s, typeOk: ok };
      }
      default:
        return { text: String(value), jsonVal: value, typeOk: true };
    }
  } catch {
    return { text: String(value), jsonVal: value, typeOk: false };
  }
}

interface ExtractOut {
  found: boolean;
  value: unknown;
  confidence: number;
  citations: { page: number; quote: string }[];
}

async function callClaude(systemPrompt: string, userContent: string): Promise<ExtractOut> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ANTHROPIC_TIMEOUT_MS);
  try {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "x-api-key": ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: EXTRACT_MODEL,
        max_tokens: 1500,
        temperature: 0,
        system: systemPrompt,
        messages: [{ role: "user", content: userContent }],
        tools: [{
          name: "record_extraction",
          description: "Record the extracted field value and the verbatim source quotes that support it.",
          input_schema: {
            type: "object",
            properties: {
              found: { type: "boolean", description: "true only if the document explicitly contains the answer" },
              value: { description: "the extracted value in the requested format; null if not found" },
              confidence: { type: "number", description: "0.0 to 1.0 confidence in the extracted value" },
              citations: {
                type: "array",
                description: "supporting evidence; each quote MUST be copied verbatim from the document",
                items: {
                  type: "object",
                  properties: {
                    page: { type: "integer", description: "the page number the quote appears on" },
                    quote: { type: "string", description: "a short verbatim excerpt from that page" },
                  },
                  required: ["page", "quote"],
                },
              },
            },
            required: ["found", "value", "confidence", "citations"],
          },
        }],
        tool_choice: { type: "tool", name: "record_extraction" },
      }),
    });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      throw new Error(`Anthropic ${res.status}: ${t.slice(0, 300)}`);
    }
    const data = await res.json();
    const block = (data?.content ?? []).find((b: any) => b.type === "tool_use" && b.name === "record_extraction");
    if (!block?.input) throw new Error("No structured output returned");
    const inp = block.input;
    return {
      found: !!inp.found,
      value: inp.value ?? null,
      confidence: Number.isFinite(inp.confidence) ? Math.max(0, Math.min(1, inp.confidence)) : 0.5,
      citations: Array.isArray(inp.citations)
        ? inp.citations.filter((c: any) => c && c.quote).map((c: any) => ({ page: Number(c.page) || 0, quote: String(c.quote) }))
        : [],
    };
  } finally {
    clearTimeout(timer);
  }
}

async function upsertCell(setId: string, fileId: string, columnId: string, patch: Record<string, unknown>): Promise<string | null> {
  const res = await sbFetch(`/rest/v1/review_cells?on_conflict=review_column_id,review_file_id`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Prefer: "resolution=merge-duplicates,return=representation" },
    body: JSON.stringify({ review_set_id: setId, review_file_id: fileId, review_column_id: columnId, ...patch }),
  });
  if (!res.ok) return null;
  const rows = await res.json().catch(() => []);
  return rows?.[0]?.id ?? null;
}

async function processCell(
  setId: string,
  column: any,
  file: any,
): Promise<{ file_id: string; state: string; value: string | null; confidence: number | null }> {
  const columnId = column.id;
  const fileId = file.id;
  await upsertCell(setId, fileId, columnId, { state: "running", error: null });

  // Assemble page-marked document text.
  let docText = "";
  try {
    const r = await sbFetch(`/rest/v1/review_file_pages?review_file_id=eq.${fileId}&select=page_number,text&order=page_number.asc`);
    const pages: any[] = await r.json();
    docText = (pages ?? [])
      .map((p) => `=== PAGE ${p.page_number} ===\n${p.text ?? ""}`)
      .join("\n\n")
      .slice(0, MAX_DOC_CHARS);
  } catch (e) {
    await upsertCell(setId, fileId, columnId, { state: "error", error: `Load pages: ${(e as Error).message}`, run_at: new Date().toISOString() });
    return { file_id: fileId, state: "error", value: null, confidence: null };
  }
  if (!docText.trim()) {
    await upsertCell(setId, fileId, columnId, { state: "not_found", value_text: null, value_json: null, confidence: 0, model: EXTRACT_MODEL, run_at: new Date().toISOString() });
    return { file_id: fileId, state: "not_found", value: null, confidence: 0 };
  }

  const hint = typeHint(column.data_type, column.enum_options);
  const system =
    "You extract a single field from a legal document for a structured review table. " +
    "Use ONLY the provided document pages. Do not use outside knowledge or infer beyond the text. " +
    "Every value you report MUST be directly supported by at least one verbatim quote copied exactly " +
    "from the pages, with the correct page number. If the document does not contain the answer, set " +
    "found=false and value=null — never guess. Return the value as " + hint + ".";
  const user =
    `FIELD: ${column.name}\n` +
    (column.prompt ? `INSTRUCTION: ${column.prompt}\n` : "") +
    `EXPECTED FORMAT: ${hint}\n\n` +
    `DOCUMENT (\"${file.filename}\"):\n${docText}`;

  let out: ExtractOut;
  try {
    out = await callClaude(system, user);
  } catch (e) {
    await upsertCell(setId, fileId, columnId, { state: "error", error: `${(e as Error).message}`, run_at: new Date().toISOString() });
    return { file_id: fileId, state: "error", value: null, confidence: null };
  }

  const cellId = await upsertCell(setId, fileId, columnId, { model: EXTRACT_MODEL, run_at: new Date().toISOString() });

  // Verify each quote is verbatim-present in the doc; persist citations with a verified flag.
  const docNorm = norm(docText);
  const verifiedCites = out.citations.map((c) => ({ ...c, verified: docNorm.includes(norm(c.quote)) }));
  if (cellId) {
    await sbFetch(`/rest/v1/review_cell_citations?cell_id=eq.${cellId}`, { method: "DELETE", headers: { Prefer: "return=minimal" } });
    if (verifiedCites.length) {
      await sbFetch(`/rest/v1/review_cell_citations`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Prefer: "return=minimal" },
        body: JSON.stringify(verifiedCites.map((c) => ({ cell_id: cellId, page_number: c.page, quote: c.quote, verified: c.verified }))),
      });
    }
  }

  // Decide final state.
  let state: string;
  let coerced = coerceValue(column.data_type, out.value, column.enum_options);
  const hasVerified = verifiedCites.some((c) => c.verified);
  if (!out.found || coerced.text === null) {
    state = "not_found";
    coerced = { text: null, jsonVal: null, typeOk: true };
  } else if (!hasVerified || !coerced.typeOk) {
    state = "needs_review"; // value present but unsupported by a verbatim quote, or wrong type
  } else {
    state = "done";
  }

  await upsertCell(setId, fileId, columnId, {
    state,
    value_text: coerced.text,
    value_json: coerced.jsonVal,
    confidence: out.confidence,
    model: EXTRACT_MODEL,
    error: null,
    run_at: new Date().toISOString(),
  });
  return { file_id: fileId, state, value: coerced.text, confidence: out.confidence };
}

// Bounded-concurrency map.
async function mapPool<T, R>(items: T[], limit: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx]);
    }
  });
  await Promise.all(workers);
  return out;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  if (!ANTHROPIC_API_KEY) return json({ ok: false, error: "ANTHROPIC_API_KEY not configured." }, 400);

  let payload: any = {};
  try { payload = await req.json(); } catch { return json({ ok: false, error: "Bad JSON" }, 400); }
  const setId = (payload?.review_set_id ?? "").toString().trim();
  const columnId = (payload?.column_id ?? "").toString().trim();
  const fileIds: string[] | null = Array.isArray(payload?.file_ids) ? payload.file_ids : null;
  if (!setId || !columnId) return json({ ok: false, error: "review_set_id and column_id required" }, 400);

  // Load the column.
  let column: any;
  try {
    const r = await sbFetch(`/rest/v1/review_columns?id=eq.${columnId}&select=*`);
    const rows = await r.json();
    if (!Array.isArray(rows) || !rows.length) return json({ ok: false, error: "column not found" }, 404);
    column = rows[0];
  } catch (e) {
    return json({ ok: false, error: `Load column: ${(e as Error).message}` }, 500);
  }

  // Load ready files (optionally filtered).
  let files: any[];
  try {
    let q = `/rest/v1/review_files?review_set_id=eq.${setId}&status=eq.ready&select=id,filename&order=sort_order.asc,created_at.asc`;
    if (fileIds?.length) q += `&id=in.(${fileIds.join(",")})`;
    const r = await sbFetch(q);
    files = await r.json();
  } catch (e) {
    return json({ ok: false, error: `Load files: ${(e as Error).message}` }, 500);
  }
  if (!Array.isArray(files) || !files.length) return json({ ok: true, column_id: columnId, results: [] });

  const results = await mapPool(files, CONCURRENCY, (f) => processCell(setId, column, f));
  return json({ ok: true, column_id: columnId, results });
});
