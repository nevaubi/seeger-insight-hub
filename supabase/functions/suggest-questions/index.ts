// suggest-questions — cron-driven generator for the "Try a question" starter pool.
//
// For each matter (or a specific matter passed in the payload), gather a compact brief
// from the record (recent orders, upcoming deadlines, tag histogram, party sample) and
// ask Claude Haiku to propose 20 high-value starter questions spread across categories.
// The results are upserted into `question_suggestions`; anything older than 48h is
// pruned so the read view naturally rotates.
//
// Invocation:
//   POST { matter_slug?: string, all?: boolean }
//   Header: `x-cron-secret: <SUGGEST_QUESTIONS_SECRET>` for cron, OR service-role auth.
//
// Secrets required:
//   ANTHROPIC_API_KEY, SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, SUGGEST_QUESTIONS_SECRET

/* eslint-disable @typescript-eslint/no-explicit-any */

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-cron-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const CRON_SECRET = Deno.env.get("SUGGEST_QUESTIONS_SECRET") ?? "";

const CATEGORIES = ["orders", "deadlines", "counsel", "science", "strategy"] as const;
type Category = typeof CATEGORIES[number];

type MatterCfg = {
  slug: string;
  name: string;
  short_name: string;
  mdl_number: string;
  master_case_id: string;
};

// Fallback list if the matter registry table doesn't exist. Keeps parity with the
// frontend `matter-context.tsx` default.
const DEFAULT_MATTERS: MatterCfg[] = [
  {
    slug: "depo-provera",
    name: "In re: Depo-Provera Products Liability Litigation",
    short_name: "Depo-Provera",
    mdl_number: "MDL 3140",
    master_case_id: "3:25-md-03140",
  },
];

async function pgGet(path: string): Promise<any[]> {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
  if (!r.ok) return [];
  return (await r.json()) as any[];
}

async function loadMatters(only?: string): Promise<MatterCfg[]> {
  // Try a matters registry if present; otherwise use the built-in default.
  const rows = await pgGet(`matters?select=slug,name,short_name,mdl_number,master_case_id`);
  const list = rows.length ? (rows as MatterCfg[]) : DEFAULT_MATTERS;
  return only ? list.filter((m) => m.slug === only) : list;
}

async function loadBrief(matter: MatterCfg): Promise<string> {
  const caseFilter = matter.master_case_id
    ? `&or=(case_id.eq.${matter.master_case_id},case_id.is.null)`
    : "";
  const [orders, deadlines] = await Promise.all([
    pgGet(`v_orders?select=order_type,order_number,canonical_title,order_date,tags,summary&order=order_date.desc.nullslast&limit=20${caseFilter}`),
    pgGet(`v_key_dates?select=event_date,title,category,affects,source_order_type,source_order_title&order=event_date.asc&limit=30&event_date=gte.${new Date().toISOString().slice(0, 10)}${caseFilter}`),
  ]);
  const tagHist: Record<string, number> = {};
  for (const o of orders) for (const t of (o.tags ?? [])) tagHist[t] = (tagHist[t] ?? 0) + 1;
  const topTags = Object.entries(tagHist).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([t, n]) => `${t}(${n})`);

  const orderLines = orders.slice(0, 20).map((o: any) => {
    const label = `${o.order_type ?? ""}${o.order_number ? " " + o.order_number : ""}`.trim();
    const d = o.order_date ? ` (${o.order_date})` : "";
    return `- ${label}${d}: ${o.canonical_title ?? ""} ${o.summary ? "— " + String(o.summary).slice(0, 140) : ""}`;
  });
  const dlLines = deadlines.slice(0, 20).map((d: any) => {
    const src = d.source_order_type ? ` [${d.source_order_type}${d.source_order_title ? " – " + d.source_order_title : ""}]` : "";
    return `- ${d.event_date} ${d.category}: ${d.title}${d.affects ? " → " + d.affects : ""}${src}`;
  });

  return [
    `MATTER: ${matter.name} (${matter.mdl_number})`,
    `RECENT / CONTROLLING ORDERS (last 20 by date):`,
    ...orderLines,
    ``,
    `UPCOMING DEADLINES / MILESTONES (next 30):`,
    ...(dlLines.length ? dlLines : ["- (none currently scheduled)"]),
    ``,
    `TAG HISTOGRAM (top): ${topTags.join(", ") || "(none)"}`,
  ].join("\n");
}

async function askHaiku(matter: MatterCfg, brief: string): Promise<{ question: string; category: string }[]> {
  const system = `You are a senior plaintiff-side MDL litigator preparing a research assistant's daily briefing pool. Read the compact matter brief and propose EXACTLY 20 high-value starter questions a partner would plausibly ask an associate about ${matter.short_name} today.

Rules:
- Each question ≤ 90 characters, plain English, concrete, no citations.
- Spread across these categories, roughly 4 per: ${CATEGORIES.join(", ")}.
- Grounded in the brief — reference real orders, deadlines, or issues that appear there. Avoid generic legal-research prompts.
- No duplicates. No lists, no numbering in the question text.

Return ONLY JSON: { "items": [{ "question": "...", "category": "orders|deadlines|counsel|science|strategy" }, ...] }`;
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: "claude-3-5-haiku-latest",
      max_tokens: 2048,
      system,
      messages: [{ role: "user", content: `Matter brief:\n\n${brief}` }],
    }),
  });
  if (!res.ok) throw new Error(`Anthropic ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const j = await res.json();
  const text = (j?.content ?? []).map((b: any) => (b?.type === "text" ? b.text : "")).join("");
  const m = text.match(/\{[\s\S]*\}/);
  if (!m) throw new Error("no JSON in response");
  const parsed = JSON.parse(m[0]);
  const items = Array.isArray(parsed?.items) ? parsed.items : [];
  const seen = new Set<string>();
  const out: { question: string; category: string }[] = [];
  for (const it of items) {
    const q = String(it?.question ?? "").trim();
    if (!q || q.length > 140) continue;
    const key = q.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    let cat = String(it?.category ?? "strategy").toLowerCase();
    if (!(CATEGORIES as readonly string[]).includes(cat)) cat = "strategy";
    out.push({ question: q, category: cat });
    if (out.length >= 20) break;
  }
  return out;
}

async function persist(matterSlug: string, items: { question: string; category: string }[]): Promise<void> {
  if (!items.length) return;
  const now = new Date().toISOString();
  const rows = items.map((it) => ({
    matter_slug: matterSlug,
    question: it.question,
    category: it.category,
    generated_at: now,
  }));
  // Insert fresh batch.
  const ins = await fetch(`${SUPABASE_URL}/rest/v1/question_suggestions`, {
    method: "POST",
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!ins.ok) throw new Error(`insert ${ins.status}: ${(await ins.text()).slice(0, 200)}`);
  // Prune anything older than 96h for this matter (keeps prior batch readable
  // between 48h cron runs in case of delay).
  const cutoff = new Date(Date.now() - 96 * 3600 * 1000).toISOString();
  await fetch(`${SUPABASE_URL}/rest/v1/question_suggestions?matter_slug=eq.${matterSlug}&generated_at=lt.${cutoff}`, {
    method: "DELETE",
    headers: { apikey: SERVICE_KEY, Authorization: `Bearer ${SERVICE_KEY}` },
  });
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405, headers: CORS });

  // Auth: accept EITHER the cron shared secret OR service-role Authorization.
  const cronHeader = req.headers.get("x-cron-secret") ?? "";
  const auth = req.headers.get("authorization") ?? "";
  const isCron = CRON_SECRET && cronHeader === CRON_SECRET;
  const isService = auth === `Bearer ${SERVICE_KEY}`;
  if (!isCron && !isService) {
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: { ...CORS, "Content-Type": "application/json" } });
  }
  if (!ANTHROPIC_API_KEY) {
    return new Response(JSON.stringify({ error: "ANTHROPIC_API_KEY not configured" }), { status: 500, headers: { ...CORS, "Content-Type": "application/json" } });
  }

  let payload: any = {};
  try { payload = await req.json(); } catch { /* body optional */ }
  const only = typeof payload?.matter_slug === "string" && payload.matter_slug.trim() ? payload.matter_slug.trim() : undefined;

  const matters = await loadMatters(only);
  const results: { matter: string; inserted: number; error?: string }[] = [];
  for (const m of matters) {
    try {
      const brief = await loadBrief(m);
      const items = await askHaiku(m, brief);
      await persist(m.slug, items);
      results.push({ matter: m.slug, inserted: items.length });
    } catch (e) {
      results.push({ matter: m.slug, inserted: 0, error: (e as Error).message });
    }
  }
  return new Response(JSON.stringify({ ok: true, results }), {
    headers: { ...CORS, "Content-Type": "application/json" },
  });
});
