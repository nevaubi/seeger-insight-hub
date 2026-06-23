// Supabase Edge Function: ai-assist
// A focused, single-turn writing assistant for the drafting workspace. Two modes:
//   - "transform": rewrite/expand/shorten/retone/continue a SELECTED passage in the editor.
//                  Returns clean replacement text only (no citations, no preamble).
//   - "draft":     generate or revise document content from an instruction + the current
//                  document, optionally GROUNDED in the matter's record (controlling orders)
//                  with native sentence-level citations.
//
// Unlike legal-synthesis (multi-round Gemini router + Claude writer), this is one Claude
// Opus 4.8 turn. Grounding, when requested, runs a single hybrid_search against the same
// matter-scoped record and injects citable search_result blocks.
//
// Request (POST JSON):
//   { mode: "transform" | "draft",
//     instruction: string,                 // what to do (command or chat prompt)
//     selection?: string,                  // transform: the highlighted text
//     document?: string,                   // current editor contents (context)
//     messages?: { role: "user"|"assistant", content: string }[],  // draft: prior chat turns
//     ground?: boolean,                    // draft: retrieve from the record and cite
//     embedding?: string ("[...]" 384-dim),// required when ground is true
//     case_id?: string, matter?: { name, short_name, mdl_number, court, judge } }
// Response: text/event-stream (events: meta, text, citation, error, done).
//
// Secrets: ANTHROPIC_API_KEY (required), SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY (auto).

const ANTHROPIC_API_KEY = Deno.env.get("ANTHROPIC_API_KEY") ?? "";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "";
const SERVICE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const MODEL = "claude-opus-4-8";

const GROUND_K = 8;            // grounding passages per draft request
const GROUND_MIN_SIM = 0.2;    // vector floor (matches legal-synthesis)
const TRANSFORM_MAX_TOKENS = 4000;
const DRAFT_MAX_TOKENS = 8000;

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

// ---------- retrieval helpers (mirrors legal-synthesis shapes) ----------

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
  };
  return { searchResult, chunk };
}

// Single matter-scoped hybrid_search for grounding a draft.
async function groundSearch(
  query: string,
  embedding: string,
  caseId: string,
): Promise<{ searchResults: any[]; chunks: any[] }> {
  const resp = await fetch(`${SUPABASE_URL}/rest/v1/rpc/hybrid_search`, {
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
    throw new Error(`hybrid_search failed (${resp.status}): ${body.slice(0, 200)}`);
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

// ---------- Anthropic streaming turn ----------

async function streamAnthropic(
  body: any,
  emittedResults: any[],
  emit: (o: any) => void,
  nextCiteNum: () => number,
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
    throw new Error(`Anthropic API ${res.status}: ${t.slice(0, 400)}`);
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
  const embedding = (payload?.embedding ?? "").toString().trim();
  const caseId = (payload?.case_id ?? "").toString().trim() || DEFAULT_CASE_ID;
  const matter: Matter = (payload?.matter && typeof payload.matter === "object")
    ? { ...DEFAULT_MATTER, ...payload.matter }
    : DEFAULT_MATTER;
  const history: any[] = Array.isArray(payload?.messages) ? payload.messages : [];

  if (!instruction) return new Response("Missing instruction", { status: 400, headers: CORS });
  if (mode === "transform" && !selection) return new Response("transform mode needs a selection", { status: 400, headers: CORS });

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
        const doGround = mode === "draft" && ground && !!embedding;
        if (doGround) {
          const query = instruction + (document ? "\n" + document.slice(0, 1000) : "");
          try {
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
          : draftSystem(matter, doGround && emittedResults.length > 0);

        const messages: any[] = [];

        if (mode === "transform") {
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

        const body: any = {
          model: MODEL,
          max_tokens: mode === "transform" ? TRANSFORM_MAX_TOKENS : DRAFT_MAX_TOKENS,
          system,
          messages,
          stream: true,
        };

        const { citationCount } = await streamAnthropic(body, emittedResults, emit, nextCiteNum);
        emit({ type: "done", citation_count: citationCount });
      } catch (e) {
        emit({ type: "error", message: (e as Error).message });
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
