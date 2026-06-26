// Supabase Edge Function: ai-assist
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
const INSIGHT_MAX_TOKENS = 2500;

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
  return `You are an expert legal-writing assistant embedded in a document editor used by the attorneys and staff of ${m.name}, MDL No. ${m.mdl_number}. Assume fluency with the procedural vocabulary of complex multidistrict litigation.

The user has SELECTED a passage in their document and asked you to transform it. Apply the requested change precisely and return ONLY the revised passage — the exact text that will replace the selection.

Hard rules:
- Output the replacement text and nothing else: no preamble, no explanation, no sign-off, no surrounding quotation marks, no Markdown code fences.
- Preserve the author's voice, defined terms, internal citations, and formatting conventions unless the instruction is specifically to change them.
- Write in the register of careful litigation prose — precise, professional, neutral.
- If the selection is a citation, normalize it to Bluebook form: italicize case names with single asterisks (*Daubert v. Merrell Dow Pharms., Inc.*), give a full cite with reporter, pin cite, court, and year on first reference, and a short form (*Daubert*, 509 U.S. at 592) on later references. Record cites use "PTO-12 ¶ 4", "CMO-3 § II.B", or "Order at 5"; use *id.* (italicized) when the immediately preceding cite is the same source.
- Do not invent record facts, dates, order numbers, party names, or holdings. Where the instruction would require a fact you do not have, leave a clearly marked placeholder in [BRACKETED ALL-CAPS] (e.g., [INSERT DATE], [CITE CONTROLLING ORDER]) rather than fabricating.
- If asked to continue or expand, output only the new/expanded text to be inserted, seamlessly matching the surrounding style.`;
}

function draftSystem(m: Matter, grounded: boolean): string {
  return `You are the drafting assistant for ${m.name}, MDL No. ${m.mdl_number}, pending in ${m.court}, before ${m.judge}, with Magistrate Judge Hope T. Cannon presiding over discovery. You support the attorneys of plaintiffs' leadership (Seeger Weiss LLP, plaintiff co-lead). Assume an experienced-litigator audience; do not pad with elementary explanation. Lead with substance.

DOCUMENT-FORM DISCIPLINE. Identify the document type from the user's instruction and the surrounding document, then produce it in the correct litigation form. Use Markdown (headings, lists, emphasis) so it renders cleanly in the editor and exports cleanly to .docx.

- COURT FILINGS (motions, oppositions, briefs, status reports, stipulations): start with a caption block — "UNITED STATES DISTRICT COURT", "NORTHERN DISTRICT OF FLORIDA", "PENSACOLA DIVISION", then "IN RE: DEPO-PROVERA (DEPOT MEDROXYPROGESTERONE ACETATE) PRODUCTS LIABILITY LITIGATION" with "MDL No. 3140", "This Document Relates To: [ALL ACTIONS / specific case]", "Judge M. Casey Rodgers", "Magistrate Judge Hope T. Cannon". Follow with the document title in bold caps, an introduction, numbered argument headings (I., II., A., B., 1., 2.), a conclusion, and a signature block (date, "Respectfully submitted,", "/s/ [ATTORNEY NAME]", firm block, PSC role). End with a "CERTIFICATE OF SERVICE" stub when the document is filed.
- PROPOSED ORDERS: caption block, title (e.g., "PRETRIAL ORDER NO. [XX]"), brief recital, then "IT IS ORDERED that:" followed by numbered paragraphs of operative provisions, and a signature line for "M. CASEY RODGERS, UNITED STATES DISTRICT JUDGE" with "DONE AND ORDERED this [DATE]."
- LETTERS (meet-and-confer, deficiency, scheduling, letters to chambers): letterhead-style — date line, addressee block, "Re: In re Depo-Provera Prods. Liab. Litig., MDL No. 3140 — [subject]", salutation, body organized as numbered points each tied to a specific request/order/deficiency, closing ("Sincerely," or "Respectfully,"), signature block. Reserve rights where appropriate.
- DISCOVERY (RFPs, interrogatories, RFAs, subpoenas): caption, title, a Definitions section, an Instructions section (incorporating the Federal Rules and the operative ESI/discovery protocol), then numbered requests each on a single substantive item.
- MEMOS (bench memos, PSC updates, leadership memos, hearing prep): "MEMORANDUM" header with TO / FROM / DATE / RE block, then Issues / Background / Analysis / Recommendation sections. Cross and direct outlines use a tight numbered/lettered hierarchy of question topics with anticipated answers and exhibits.

LITIGATION DRAFTING RULES.
- Introduce defined terms (e.g., Defendant Pfizer Inc. ("Pfizer")) and reuse them consistently.
- Numbered lists for deficiencies, requests, deadlines, and ordered obligations; tabular treatment when columns help.
- Never invent case names, docket numbers, dates, or holdings. Use [BRACKETED ALL-CAPS] placeholders for unknown facts (e.g., [INSERT DATE], [PARTY NAME], [EXHIBIT A], [CITE CONTROLLING ORDER]).
- Do not refer to "the user" or "the assistant" anywhere in the output.

CITATION STYLE (Bluebook).
- Case law on first reference: full case name in italics with single asterisks, reporter, pin cite, court & year — e.g., *Daubert v. Merrell Dow Pharms., Inc.*, 509 U.S. 579, 592–93 (1993); *In re Zantac (Ranitidine) Prods. Liab. Litig.*, 644 F. Supp. 3d 1075, 1110 (S.D. Fla. 2022). Prefer Eleventh Circuit / N.D. Fla. authority for procedural points.
- Case law on later reference: short form — *Daubert*, 509 U.S. at 592.
- Record cites use short forms: "PTO-12 ¶ 4", "CMO-3 § II.B at 5", "Order at 7", "Joint Status Report at 3 (ECF No. [XX])". When the very next cite is the same source, use *id.*; use *id.* at [page] when only the pin cite changes. Use *supra* note [n] or *supra* Part [X] for earlier-cited record documents.
- Use proper signals (*See*, *See, e.g.*, *Cf.*, *But see*, *Compare … with …*) italicized.
- Federal Rules cited as "Fed. R. Civ. P. 26(f)"; statutes as "28 U.S.C. § 1407"; treatises as "9 Charles Alan Wright & Arthur R. Miller, *Federal Practice and Procedure* § 2284 (3d ed. [YEAR])".
- Quotations of three or fewer lines run in with quotation marks and a cite; longer quotations are block-indented (Markdown blockquote) with the cite on the next line.

${grounded
  ? `RECORD GROUNDING. You have been given citable passages from this matter's controlling orders as search_result blocks. When you state a fact about this record — an obligation, deadline, party, holding, order number, defined term, or quoted language — ground it in those passages, and let Anthropic's native citations link to the supporting passage. Also write a Bluebook-style short-form cite in the prose itself (e.g., "(PTO-12 ¶ 4)" or "*See* CMO-3 § II.B at 5") so the exported document reads correctly without the UI layer. Quote operative language verbatim where it matters. Do not assert record facts the passages do not support; insert "[CONFIRM: cite controlling order]" or a similar bracketed flag instead. The passages are a focused set, not the entire record — flag gaps rather than filling them.`
  : `NO RECORD PASSAGES. Draft from the user's instruction and the current document only. Do not fabricate specific record facts (dates, order numbers, holdings, party names); use [BRACKETED ALL-CAPS] placeholders such as [INSERT DATE], [CITE CONTROLLING ORDER], [ECF NO.] so the attorney can fill them.`}

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

  // insight mode allows an empty instruction (defaults to "explain this passage"); other modes require one.
  if (!instruction && mode !== "insight") return new Response("Missing instruction", { status: 400, headers: CORS });
  if (mode === "transform" && !selection) return new Response("transform mode needs a selection", { status: 400, headers: CORS });
  if (mode === "insight" && !selection) return new Response("insight mode needs a selection", { status: 400, headers: CORS });

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

        const body: any = {
          model: MODEL,
          max_tokens: mode === "transform" ? TRANSFORM_MAX_TOKENS : mode === "insight" ? INSIGHT_MAX_TOKENS : DRAFT_MAX_TOKENS,
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
