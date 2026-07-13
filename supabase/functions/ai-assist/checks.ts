// checks.ts — pure, deterministic document-intelligence scans for ai-assist v12 "check" mode.
// No Deno/network APIs. Each scan returns findings with character spans so the client can
// highlight and jump. LLM judgment is deliberately absent here: these are the mechanical
// passes (placeholder sweep, defined terms, cross-references, record-cite extraction);
// anything requiring judgment routes through redline mode instead.

export interface CheckFinding {
  kind: string;
  state: "ok" | "warning" | "error";
  quote: string;
  start: number;
  end: number;
  note: string;
  term?: string;
  ref?: string;
  // record-cite verification fields (filled by index.ts after DB lookup)
  cite_label?: string;
  cite_page?: string | null;
  resolved_title?: string | null;
  pdf_url?: string | null;
}

const clip = (s: string, n = 120) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

// ---------- placeholder sweep ----------

// [BRACKETED ALL-CAPS] placeholders the drafting prompts enforce, e.g. [INSERT DATE],
// [ATTORNEY NAME], [CONFIRM: cite controlling order]. Requires ≥2 uppercase letters and
// no lowercase inside the brackets; skips markdown links, footnote markers, checkboxes.
const PLACEHOLDER_RE = /\[[^\[\]\n]{2,90}\]/g;

export function scanPlaceholders(doc: string): CheckFinding[] {
  const out: CheckFinding[] = [];
  let m: RegExpExecArray | null;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(doc)) !== null) {
    const inner = m[0].slice(1, -1);
    if (/[a-z]/.test(inner)) continue; // prose in brackets, not a placeholder
    if (!/[A-Z].*[A-Z]/s.test(inner)) continue; // needs at least two capitals
    if (inner.startsWith("^")) continue; // footnote marker
    if (doc[m.index + m[0].length] === "(") continue; // markdown link [text](url)
    out.push({
      kind: "placeholder",
      state: "warning",
      quote: m[0],
      start: m.index,
      end: m.index + m[0].length,
      note: "Unresolved placeholder — fill in before this document leaves the building.",
    });
  }
  return out;
}

// ---------- defined terms ----------

// Quoted-parenthetical definitions: (the "Product"), ("Agreement"),
// (hereinafter "Deficiency Notice"), (collectively, the "Defendants").
const DEF_RE =
  /\(\s*(?:hereinafter\s+|collectively,?\s+|together,?\s+)?(?:the\s+|an?\s+)?["“]([A-Z][A-Za-z0-9 .,&‑–-]{0,60}?)["”]\s*\)/g;

function wholeWordOccurrences(doc: string, term: string): number[] {
  const esc = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`(?<![A-Za-z0-9])${esc}(?![A-Za-z0-9])`, "g");
  const out: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(doc)) !== null) {
    out.push(m.index);
    if (m.index === re.lastIndex) re.lastIndex++;
    if (out.length > 500) break;
  }
  return out;
}

export function scanDefinedTerms(doc: string): CheckFinding[] {
  const out: CheckFinding[] = [];
  const defs = new Map<string, { start: number; end: number }[]>();
  let m: RegExpExecArray | null;
  DEF_RE.lastIndex = 0;
  while ((m = DEF_RE.exec(doc)) !== null) {
    const term = m[1].trim();
    if (term.length < 3) continue;
    const list = defs.get(term) ?? [];
    list.push({ start: m.index, end: m.index + m[0].length });
    defs.set(term, list);
  }

  for (const [term, sites] of defs) {
    const defSite = sites[0];
    if (sites.length > 1) {
      const dup = sites[1];
      out.push({
        kind: "defined_term",
        state: "error",
        term,
        quote: clip(doc.slice(dup.start, dup.end)),
        start: dup.start,
        end: dup.end,
        note: `"${term}" is defined more than once (${sites.length}×). Consolidate to a single definition.`,
      });
    }
    const uses = wholeWordOccurrences(doc, term).filter(
      (i) => i < defSite.start || i >= defSite.end,
    );
    const usesBefore = uses.filter((i) => i < defSite.start);
    const usesAfter = uses.filter((i) => i >= defSite.end);
    if (usesBefore.length > 0) {
      const first = usesBefore[0];
      out.push({
        kind: "defined_term",
        state: "warning",
        term,
        quote: clip(doc.slice(Math.max(0, first - 30), first + term.length + 30)),
        start: first,
        end: first + term.length,
        note: `"${term}" is used before it is defined (definition appears later in the document).`,
      });
    }
    if (usesAfter.length === 0 && usesBefore.length === 0) {
      out.push({
        kind: "defined_term",
        state: "warning",
        term,
        quote: clip(doc.slice(defSite.start, defSite.end)),
        start: defSite.start,
        end: defSite.end,
        note: `"${term}" is defined but never used. Remove the definition or use the defined term.`,
      });
    }
  }
  return out;
}

// ---------- cross-references & footnotes ----------

const ROMAN_RE = /^(?:#{1,6}\s+)?([IVXLCDM]{1,7})\.\s+\S/;
const LETTER_RE = /^(?:#{1,6}\s+)?([A-Z])\.\s+\S/;
const ARABIC_HEADING_RE = /^#{1,6}\s+(\d{1,2})[.)]\s+\S/;

export function scanCrossrefs(doc: string): CheckFinding[] {
  const out: CheckFinding[] = [];
  const romans = new Set<string>();
  const letters = new Set<string>();
  const arabics = new Set<string>();

  // collect section identifiers from heading-shaped lines
  let lineStart = 0;
  for (const line of doc.split("\n")) {
    const t = line.trim();
    if (t.length > 0 && t.length <= 120) {
      const rm = ROMAN_RE.exec(t);
      if (rm) romans.add(rm[1]);
      const lm = LETTER_RE.exec(t);
      if (lm && !rm) letters.add(lm[1]);
      const am = ARABIC_HEADING_RE.exec(t);
      if (am) arabics.add(am[1]);
    }
    lineStart += line.length + 1;
  }

  // references like "Section IV", "Section IV.B", "Part II", "Article III", "Section 3"
  const REF_RE = /\b(?:Section|Part|Article)\s+((?:[IVXLCDM]{1,7}|\d{1,2}|[A-Z]))((?:\.(?:[A-Z]|\d{1,2}))*)\b/g;
  let m: RegExpExecArray | null;
  while ((m = REF_RE.exec(doc)) !== null) {
    const root = m[1];
    const isArabic = /^\d+$/.test(root);
    const isRomanShape = /^[IVXLCDM]+$/.test(root);
    // Single letters like "I" or "V" are ambiguous between roman and lettered headings:
    // accept membership in either set. Only flag when the document actually uses a
    // matching numbering scheme (the corresponding set is non-empty).
    let known: boolean;
    let checkable: boolean;
    if (isArabic) {
      known = arabics.has(root);
      checkable = arabics.size > 0;
    } else if (isRomanShape && root.length > 1) {
      known = romans.has(root);
      checkable = romans.size > 0;
    } else if (isRomanShape) {
      known = romans.has(root) || letters.has(root);
      checkable = romans.size > 0 || letters.size > 0;
    } else {
      known = letters.has(root);
      checkable = letters.size > 0;
    }
    if (checkable && !known) {
      out.push({
        kind: "crossref",
        state: "error",
        ref: m[0],
        quote: clip(doc.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30)),
        start: m.index,
        end: m.index + m[0].length,
        note: `${m[0]} — no heading with that number found in this document.`,
      });
    }
    const sub = m[2];
    if (sub && isRoman && romans.has(root)) {
      const firstSub = sub.split(".")[1];
      if (firstSub && /^[A-Z]$/.test(firstSub) && letters.size > 0 && !letters.has(firstSub)) {
        out.push({
          kind: "crossref",
          state: "warning",
          ref: m[0],
          quote: clip(doc.slice(Math.max(0, m.index - 30), m.index + m[0].length + 30)),
          start: m.index,
          end: m.index + m[0].length,
          note: `${m[0]} — subsection "${firstSub}" was not found among lettered headings.`,
        });
      }
    }
  }

  // footnotes: [^n] markers vs [^n]: definitions
  const markers = new Map<string, number>();
  const definitions = new Map<string, number>();
  const FN_RE = /\[\^(\d{1,3})\](:?)/g;
  while ((m = FN_RE.exec(doc)) !== null) {
    if (m[2] === ":") {
      if (!definitions.has(m[1])) definitions.set(m[1], m.index);
    } else if (!markers.has(m[1])) {
      markers.set(m[1], m.index);
    }
  }
  for (const [n, at] of markers) {
    if (!definitions.has(n)) {
      out.push({
        kind: "footnote",
        state: "error",
        quote: `[^${n}]`,
        start: at,
        end: at + n.length + 3,
        note: `Footnote marker [^${n}] has no definition at the end of the document.`,
      });
    }
  }
  for (const [n, at] of definitions) {
    if (!markers.has(n)) {
      out.push({
        kind: "footnote",
        state: "warning",
        quote: `[^${n}]:`,
        start: at,
        end: at + n.length + 4,
        note: `Footnote definition [^${n}]: is never referenced in the text.`,
      });
    }
  }
  // sequence check
  const nums = Array.from(markers.keys()).map(Number).sort((a, b) => a - b);
  for (let i = 0; i < nums.length; i++) {
    if (nums[i] !== i + 1) {
      const at = markers.get(String(nums[i])) ?? 0;
      out.push({
        kind: "footnote",
        state: "warning",
        quote: `[^${nums[i]}]`,
        start: at,
        end: at,
        note: `Footnote numbering is not sequential (expected [^${i + 1}] next). Renumber before filing.`,
      });
      break;
    }
  }

  return out;
}

// ---------- record citations (extraction; DB verification happens in index.ts) ----------

export interface RecordCiteRef {
  kind: "order" | "docket";
  label: string; // e.g. "PTO 22A" or "Dkt. 214"
  order_type?: string; // PTO | CMO | CBO
  order_number?: string; // "22A"
  entry_number?: number; // docket
  page: string | null; // "4" or "4–5"
  quote: string;
  start: number;
  end: number;
}

const ORDER_CITE_RE =
  /\b(PTO|CMO|CBO)[-\s]?(?:No\.\s*)?(\d{1,3}[A-Z]?)\b(?:\s*(?:,\s*)?(?:at\s+|¶+\s*|p\.\s*|pp\.\s*)(\d{1,4}(?:\s*[–—-]\s*\d{1,4})?))?/g;
const EXPANDED_ORDER_RE =
  /\b(Pretrial Order|Case Management Order|Common Benefit Order)\s+No\.\s*(\d{1,3}[A-Z]?)\b(?:\s*(?:,\s*)?(?:at\s+)(\d{1,4}(?:\s*[–—-]\s*\d{1,4})?))?/g;
const DOCKET_CITE_RE = /\b(?:Dkt\.?|ECF\s+No\.?|D\.E\.|Doc\.?)\s*(\d{1,5})\b(?:\s*(?:at\s+)(\d{1,4}))?/g;

const KIND_MAP: Record<string, string> = {
  "Pretrial Order": "PTO",
  "Case Management Order": "CMO",
  "Common Benefit Order": "CBO",
};

export function scanRecordCites(doc: string): RecordCiteRef[] {
  const out: RecordCiteRef[] = [];
  const seenSpans = new Set<string>();
  const push = (r: RecordCiteRef) => {
    const key = `${r.start}:${r.end}`;
    if (seenSpans.has(key)) return;
    seenSpans.add(key);
    out.push(r);
  };
  let m: RegExpExecArray | null;
  ORDER_CITE_RE.lastIndex = 0;
  while ((m = ORDER_CITE_RE.exec(doc)) !== null) {
    push({
      kind: "order",
      label: `${m[1].toUpperCase()} ${m[2]}`,
      order_type: m[1].toUpperCase(),
      order_number: m[2],
      page: m[3] ? m[3].replace(/\s*[–—-]\s*/g, "–") : null,
      quote: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  EXPANDED_ORDER_RE.lastIndex = 0;
  while ((m = EXPANDED_ORDER_RE.exec(doc)) !== null) {
    const t = KIND_MAP[m[1]] ?? m[1];
    push({
      kind: "order",
      label: `${t} ${m[2]}`,
      order_type: t,
      order_number: m[2],
      page: m[3] ? m[3].replace(/\s*[–—-]\s*/g, "–") : null,
      quote: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  DOCKET_CITE_RE.lastIndex = 0;
  while ((m = DOCKET_CITE_RE.exec(doc)) !== null) {
    push({
      kind: "docket",
      label: `Dkt. ${m[1]}`,
      entry_number: Number(m[1]),
      page: m[2] ?? null,
      quote: m[0],
      start: m.index,
      end: m.index + m[0].length,
    });
  }
  out.sort((a, b) => a.start - b.start);
  return out;
}
