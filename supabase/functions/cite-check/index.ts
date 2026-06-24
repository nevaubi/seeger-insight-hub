// Supabase Edge Function: cite-check
// Verify the legal citations in a draft against CourtListener's citation-lookup API
// (eyecite extraction + resolution to real opinions). For each citation found in the text it
// reports whether it resolves to an actual case, the authoritative case name + reporter, a
// CourtListener link, and the character span in the source text (for inline highlighting).
//
// Request (POST JSON): { text: string }
// Response (JSON): { ok, count, valid, not_found, ambiguous, results: [ {
//   citation, start, end, status, state ('valid'|'not_found'|'ambiguous'|'invalid'|'error'),
//   case_name, url, year, citation_count, message } ] }
//
// Secrets: COURTLISTENER_API_KEY (required).

const COURTLISTENER_API_KEY = Deno.env.get("COURTLISTENER_API_KEY") ?? "";
const CL_LOOKUP = "https://www.courtlistener.com/api/rest/v4/citation-lookup/";
const CL_WEB = "https://www.courtlistener.com";
const MAX_TEXT = 50000;       // CourtListener accepts up to ~64k; keep a safe margin
const CL_TIMEOUT_MS = 30000;  // citation-lookup can be slower for long text

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
}

function yearFrom(dateFiled: unknown): number | null {
  const m = /^(\d{4})/.exec(String(dateFiled ?? ""));
  return m ? Number(m[1]) : null;
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);
  if (!COURTLISTENER_API_KEY) {
    return json({ ok: false, error: "COURTLISTENER_API_KEY not configured. Add it in Supabase → Edge Functions → Secrets." }, 400);
  }

  let payload: any = {};
  try { payload = await req.json(); } catch { return json({ ok: false, error: "Bad JSON" }, 400); }
  let text = (payload?.text ?? "").toString();
  if (!text.trim()) return json({ ok: false, error: "No text provided" }, 400);
  const truncated = text.length > MAX_TEXT;
  if (truncated) text = text.slice(0, MAX_TEXT);

  // Call CourtListener citation-lookup (form-encoded `text`).
  let data: any[];
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CL_TIMEOUT_MS);
  try {
    const resp = await fetch(CL_LOOKUP, {
      method: "POST",
      headers: {
        "Authorization": `Token ${COURTLISTENER_API_KEY}`,
        "Content-Type": "application/x-www-form-urlencoded",
        "Accept": "application/json",
      },
      body: new URLSearchParams({ text }).toString(),
      signal: ctrl.signal,
    });
    if (resp.status === 429) {
      return json({ ok: false, error: "CourtListener citation-lookup rate limit reached (60/min). Try again shortly." }, 429);
    }
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      return json({ ok: false, error: `CourtListener ${resp.status}: ${t.slice(0, 200)}` }, 502);
    }
    data = await resp.json();
  } catch (e) {
    return json({ ok: false, error: `Citation lookup failed: ${(e as Error).message}` }, 502);
  } finally {
    clearTimeout(timer);
  }

  if (!Array.isArray(data)) data = [];

  const results = data.map((r: any) => {
    const status = Number(r?.status);
    const clusters: any[] = Array.isArray(r?.clusters) ? r.clusters : [];
    let state: string;
    if (status === 200 && clusters.length === 1) state = "valid";
    else if (status === 200 && clusters.length > 1) state = "ambiguous";
    else if (status === 300 || clusters.length > 1) state = "ambiguous";
    else if (status === 404) state = "not_found";
    else if (status === 400) state = "invalid";
    else state = clusters.length ? "valid" : "error";

    const top = clusters[0] || null;
    const caseName = top?.case_name || top?.case_name_full || null;
    const url = top?.absolute_url ? `${CL_WEB}${top.absolute_url}` : null;
    return {
      citation: r?.citation ?? null,
      normalized: Array.isArray(r?.normalized_citations) ? r.normalized_citations : null,
      start: Number.isFinite(r?.start_index) ? r.start_index : null,
      end: Number.isFinite(r?.end_index) ? r.end_index : null,
      status: Number.isFinite(status) ? status : null,
      state,
      case_name: caseName,
      url,
      year: top ? yearFrom(top.date_filed) : null,
      citation_count: top && Number.isFinite(top.citation_count) ? top.citation_count : null,
      match_count: clusters.length,
      message: r?.error_message || null,
    };
  });

  const summary = {
    ok: true,
    truncated,
    count: results.length,
    valid: results.filter((r) => r.state === "valid").length,
    not_found: results.filter((r) => r.state === "not_found").length,
    ambiguous: results.filter((r) => r.state === "ambiguous").length,
    invalid: results.filter((r) => r.state === "invalid").length,
    results,
  };
  return json(summary);
});
