// Supabase Edge Function: recap-sync
// Live RECAP docket sync from CourtListener into the existing curated tables.
//
// Given a matter (or case), resolves its CourtListener docket id (cases.cl_docket_id), pages the
// docket-entries newest-first, and upserts each entry + its recap_documents via the transactional
// recap_upsert_entries RPC (idempotent on the cl_* unique indexes — never duplicates or deletes
// curated rows). Records the result in recap_sync_state (and, best-effort, ingestion_jobs).
//
// Request (POST JSON): { case_id?: string, matter_id?: string, max_pages?: number }
//   - Provide matter_id OR case_id; if neither, the default matter is used.
// Response (JSON): { ok, case_id, cl_docket_id, fetched, new, updated, documents, total, last_synced_at }
//
// Secrets: COURTLISTENER_API_KEY (required). SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY auto-injected.

const COURTLISTENER_API_KEY = Deno.env.get("COURTLISTENER_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const CL_BASE = "https://www.courtlistener.com/api/rest/v4";
const DEFAULT_MATTER_SLUG = "depo-provera";
const MAX_PAGES_DEFAULT = 8;     // newest-first pages to pull per sync (~20 entries/page)
const MAX_PAGES_CEIL = 60;       // hard ceiling for an explicit backfill request
const CL_TIMEOUT_MS = 15000;

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

// CourtListener GET (token auth, hard timeout). `urlOrPath` may be a full URL (pagination `next`).
async function clGet(urlOrPath: string): Promise<any> {
  const url = urlOrPath.startsWith("http") ? urlOrPath : `${CL_BASE}${urlOrPath}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), CL_TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      headers: { "Accept": "application/json", "Authorization": `Token ${COURTLISTENER_API_KEY}` },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      const t = await resp.text().catch(() => "");
      throw new Error(`CourtListener ${resp.status}: ${t.slice(0, 200)}`);
    }
    return await resp.json();
  } finally {
    clearTimeout(timer);
  }
}

// Supabase PostgREST GET (service role).
async function sbSelect(path: string): Promise<any[]> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}` },
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Supabase select ${resp.status}: ${t.slice(0, 200)}`);
  }
  return await resp.json();
}

async function sbRpc(fn: string, body: unknown): Promise<any> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/${fn}`, {
    method: "POST",
    headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!resp.ok) {
    const t = await resp.text().catch(() => "");
    throw new Error(`Supabase rpc ${fn} ${resp.status}: ${t.slice(0, 200)}`);
  }
  return await resp.json();
}

// PostgREST upsert (merge-duplicates) into an arbitrary table.
async function sbUpsert(table: string, row: Record<string, unknown>, onConflict: string): Promise<void> {
  await fetch(`${SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: "POST",
    headers: {
      "apikey": SERVICE_KEY,
      "Authorization": `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      "Prefer": "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(row),
  }).catch(() => { /* best-effort */ });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return json({ ok: false, error: "Method not allowed" }, 405);

  if (!COURTLISTENER_API_KEY) {
    return json({ ok: false, error: "COURTLISTENER_API_KEY not configured. Add it in Supabase → Edge Functions → Secrets." }, 400);
  }

  let payload: any = {};
  try { payload = await req.json(); } catch { /* allow empty body */ }
  const inCaseId = (payload?.case_id ?? "").toString().trim();
  const inMatterId = (payload?.matter_id ?? "").toString().trim();
  const maxPages = Math.max(1, Math.min(MAX_PAGES_CEIL, Number.isFinite(payload?.max_pages) ? Math.floor(payload.max_pages) : MAX_PAGES_DEFAULT));

  // ----- Resolve matter + master case + CourtListener docket id -----
  let matterId: string | null = null;
  let caseId: string | null = null;
  try {
    if (inMatterId) {
      const m = await sbSelect(`matters?id=eq.${inMatterId}&select=id,master_case_id`);
      if (!m.length) return json({ ok: false, error: "matter_id not found" }, 404);
      matterId = m[0].id; caseId = m[0].master_case_id;
    } else if (inCaseId) {
      caseId = inCaseId;
      const m = await sbSelect(`matters?master_case_id=eq.${inCaseId}&select=id&limit=1`);
      matterId = m.length ? m[0].id : null;
    } else {
      const m = await sbSelect(`matters?slug=eq.${DEFAULT_MATTER_SLUG}&select=id,master_case_id&limit=1`);
      if (!m.length) return json({ ok: false, error: "default matter not found" }, 404);
      matterId = m[0].id; caseId = m[0].master_case_id;
    }
  } catch (e) {
    return json({ ok: false, error: `Resolve matter failed: ${(e as Error).message}` }, 500);
  }
  if (!caseId) return json({ ok: false, error: "matter has no master case" }, 400);

  let clDocketId: number | null = null;
  try {
    const c = await sbSelect(`cases?id=eq.${caseId}&select=cl_docket_id,case_name,docket_number`);
    if (!c.length || !c[0].cl_docket_id) {
      return json({ ok: false, error: "master case has no cl_docket_id; cannot sync from CourtListener" }, 400);
    }
    clDocketId = c[0].cl_docket_id;
  } catch (e) {
    return json({ ok: false, error: `Resolve case failed: ${(e as Error).message}` }, 500);
  }

  const startedAt = new Date().toISOString();

  // ----- Page the docket entries newest-first and collect -----
  const entries: any[] = [];
  let total = 0;
  try {
    let next: string | null = `/docket-entries/?docket=${clDocketId}&order_by=-recap_sequence_number`;
    let pages = 0;
    while (next && pages < maxPages) {
      const data: any = await clGet(next);
      if (Number.isFinite(data?.count)) total = data.count;
      if (Array.isArray(data?.results)) entries.push(...data.results);
      next = typeof data?.next === "string" ? data.next : null;
      pages++;
    }
  } catch (e) {
    const msg = `${(e as Error).message}`;
    if (matterId) {
      await sbUpsert("recap_sync_state",
        { matter_id: matterId, case_id: caseId, cl_docket_id: clDocketId, last_error: msg, updated_at: new Date().toISOString() },
        "matter_id");
    }
    return json({ ok: false, error: `CourtListener fetch failed: ${msg}` }, 502);
  }

  // ----- Upsert transactionally via the RPC -----
  let counts = { new: 0, updated: 0, documents: 0 };
  try {
    const res = await sbRpc("recap_upsert_entries", { p_case_id: caseId, p_entries: entries });
    if (res && typeof res === "object") {
      counts = { new: res.new ?? 0, updated: res.updated ?? 0, documents: res.documents ?? 0 };
    }
  } catch (e) {
    const msg = `${(e as Error).message}`;
    if (matterId) {
      await sbUpsert("recap_sync_state",
        { matter_id: matterId, case_id: caseId, cl_docket_id: clDocketId, last_error: msg, updated_at: new Date().toISOString() },
        "matter_id");
    }
    return json({ ok: false, error: `Upsert failed: ${msg}` }, 500);
  }

  const finishedAt = new Date().toISOString();

  // ----- Record sync state (authoritative for the UI) + best-effort ingestion job -----
  if (matterId) {
    await sbUpsert("recap_sync_state", {
      matter_id: matterId,
      case_id: caseId,
      cl_docket_id: clDocketId,
      last_synced_at: finishedAt,
      last_entry_count: entries.length,
      last_new_count: counts.new,
      last_updated_count: counts.updated,
      last_error: null,
      updated_at: finishedAt,
    }, "matter_id");
  }
  // ingestion_jobs status is an enum we don't enumerate here; omit it and let its default apply.
  await fetch(`${SUPABASE_URL}/rest/v1/ingestion_jobs`, {
    method: "POST",
    headers: { "apikey": SERVICE_KEY, "Authorization": `Bearer ${SERVICE_KEY}`, "Content-Type": "application/json", "Prefer": "return=minimal" },
    body: JSON.stringify({
      job_type: "recap_docket_sync",
      source: "courtlistener",
      target_ref: caseId,
      query_params: { cl_docket_id: clDocketId, max_pages: maxPages },
      records_found: entries.length,
      records_ingested: counts.new + counts.updated,
      records_failed: 0,
      started_at: startedAt,
      completed_at: finishedAt,
    }),
  }).catch(() => { /* best-effort */ });

  return json({
    ok: true,
    case_id: caseId,
    cl_docket_id: clDocketId,
    fetched: entries.length,
    new: counts.new,
    updated: counts.updated,
    documents: counts.documents,
    total,
    last_synced_at: finishedAt,
  });
});
