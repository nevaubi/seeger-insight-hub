// Bluebook citation normalizer — pure, deterministic, no network.
//
// Operates on a markdown string and returns { markdown, report } where report
// summarizes what changed. Safe to run repeatedly (idempotent on already-clean
// input). Skips fenced code blocks and inline code spans.

export type BluebookKind =
  | 'reporter'
  | 'id'
  | 'supra'
  | 'short'
  | 'signal'
  | 'pincite'
  | 'italic'
  | 'smart';

export type BluebookChange = { kind: BluebookKind; before: string; after: string };

export type BluebookReport = {
  changes: BluebookChange[];
  totals: Record<BluebookKind, number>;
  citeCount: number;
  shortFormCount: number;
  idCount: number;
};

const emptyTotals = (): Record<BluebookKind, number> => ({
  reporter: 0,
  id: 0,
  supra: 0,
  short: 0,
  signal: 0,
  pincite: 0,
  italic: 0,
  smart: 0,
});

// ---------- reporter canonicalization ----------
// Map of loose → canonical spelling. Keys must be regex-safe (dots escaped by caller).
const REPORTERS: Array<[RegExp, string]> = [
  [/\bF\s*\.\s*Supp\s*\.\s*3d\b\.?/g, 'F. Supp. 3d'],
  [/\bF\s*\.\s*Supp\s*\.\s*2d\b\.?/g, 'F. Supp. 2d'],
  [/\bF\s*\.\s*Supp\b\.?/g, 'F. Supp.'],
  [/\bF\s*\.\s*4th\b/g, 'F.4th'],
  [/\bF\s*\.\s*3d\b/g, 'F.3d'],
  [/\bF\s*\.\s*2d\b/g, 'F.2d'],
  [/\bU\s*\.\s*S\s*\.\s*(?=\s*\d)/g, 'U.S. '],
  [/\bS\s*\.\s*Ct\b\.?/g, 'S. Ct.'],
  [/\bL\s*\.\s*Ed\s*\.\s*2d\b/g, 'L. Ed. 2d'],
  [/\bL\s*\.\s*Ed\b\.?/g, 'L. Ed.'],
  [/\bA\s*\.\s*3d\b/g, 'A.3d'],
  [/\bA\s*\.\s*2d\b/g, 'A.2d'],
  [/\bN\s*\.\s*E\s*\.\s*3d\b/g, 'N.E.3d'],
  [/\bN\s*\.\s*E\s*\.\s*2d\b/g, 'N.E.2d'],
  [/\bS\s*\.\s*E\s*\.\s*2d\b/g, 'S.E.2d'],
  [/\bS\s*\.\s*W\s*\.\s*3d\b/g, 'S.W.3d'],
  [/\bS\s*\.\s*W\s*\.\s*2d\b/g, 'S.W.2d'],
  [/\bN\s*\.\s*W\s*\.\s*2d\b/g, 'N.W.2d'],
  [/\bSo\s*\.\s*3d\b/g, 'So. 3d'],
  [/\bSo\s*\.\s*2d\b/g, 'So. 2d'],
  [/\bP\s*\.\s*3d\b/g, 'P.3d'],
  [/\bP\s*\.\s*2d\b/g, 'P.2d'],
  [/\bCal\s*\.\s*Rptr\s*\.\s*3d\b/g, 'Cal. Rptr. 3d'],
  [/\bFed\s*\.\s*R\s*\.\s*Civ\s*\.\s*P\b\.?/g, 'Fed. R. Civ. P.'],
  [/\bFed\s*\.\s*R\s*\.\s*Evid\b\.?/g, 'Fed. R. Evid.'],
];

// Signals: comma+italics normalization done at the *start of a citation clause*.
const SIGNALS: Array<[RegExp, string]> = [
  [/\bSee\s+also\b/g, 'See also'],
  [/\bsee\s+also\b/g, 'see also'],
  [/\bSee\s+e\.?\s*g\.?/g, 'See, e.g.,'],
  [/\bsee\s+e\.?\s*g\.?/g, 'see, e.g.,'],
  [/\bbut\s+see\b/g, 'but see'],
  [/\bcf\s*\.\s*/g, 'cf. '],
  [/\baccord\b/g, 'accord'],
];

// Case-name detection: `Word v. Word` (upper-cased, permissive on middle tokens).
// Captures the whole span so we can wrap in *italics*.
const CASE_NAME_RE =
  /\b([A-Z][A-Za-z.'&-]+(?:\s+(?:[A-Z][A-Za-z.'&-]+|of|and|the|de|van|von))*\s+v\.\s+[A-Z][A-Za-z.'&-]+(?:\s+(?:[A-Z][A-Za-z.'&-]+|of|and|the|de|van|von))*)\b/g;

// Full citation after a case name: `, 123 F.3d 456` (optional pin).
const FULL_CITE_TAIL_RE =
  /,\s+(\d+)\s+([A-Z][A-Za-z.\s]*?\d?[a-z]{0,3}\.?)\s+(\d+)(?:,\s*(\d+(?:[-\u2013]\d+)?))?/;

// ---------- protection: skip fenced/inline code ----------
type Segment = { text: string; frozen: boolean };
function splitProtected(md: string): Segment[] {
  const out: Segment[] = [];
  const re = /```[\s\S]*?```|`[^`\n]+`/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    if (m.index > last) out.push({ text: md.slice(last, m.index), frozen: false });
    out.push({ text: m[0], frozen: true });
    last = m.index + m[0].length;
  }
  if (last < md.length) out.push({ text: md.slice(last), frozen: false });
  return out;
}

// ---------- individual passes ----------

function passReporters(text: string, changes: BluebookChange[]): string {
  let out = text;
  for (const [re, canon] of REPORTERS) {
    out = out.replace(re, (m) => {
      if (m === canon) return m;
      changes.push({ kind: 'reporter', before: m, after: canon });
      return canon;
    });
  }
  return out;
}

function passSignals(text: string, changes: BluebookChange[]): string {
  let out = text;
  for (const [re, canon] of SIGNALS) {
    out = out.replace(re, (m) => {
      if (m === canon) return m;
      changes.push({ kind: 'signal', before: m, after: canon });
      return canon;
    });
  }
  return out;
}

function passPincites(text: string, changes: BluebookChange[]): string {
  let out = text;
  // en-dash for page ranges
  out = out.replace(/\bat\s+(\d+)\s*-\s*(\d+)\b/g, (m, a, b) => {
    const rep = `at ${a}\u2013${b}`;
    if (m !== rep) changes.push({ kind: 'pincite', before: m, after: rep });
    return rep;
  });
  // pp. N → at N
  out = out.replace(/\bpp?\.\s*(\d+)/g, (m, n) => {
    const rep = `at ${n}`;
    changes.push({ kind: 'pincite', before: m, after: rep });
    return rep;
  });
  return out;
}

function passItalicCaseNames(text: string, changes: BluebookChange[]): string {
  // Wrap case names in *italics* unless already inside an emphasis run.
  return text.replace(CASE_NAME_RE, (m, offset) => {
    const src = text;
    // Bail if surrounded by * or _ already (rough check).
    const before = src[Number(offset) - 1] ?? '';
    if (before === '*' || before === '_') return m;
    // Bail if the substring itself already contains an asterisk (partial italic).
    if (m.includes('*')) return m;
    const wrapped = `*${m}*`;
    changes.push({ kind: 'italic', before: m, after: wrapped });
    return wrapped;
  });
}

function passIdAndShort(text: string, changes: BluebookChange[]): {
  text: string;
  citeCount: number;
  shortFormCount: number;
  idCount: number;
} {
  // Walk paragraph by paragraph. Track "last full cite" = short name + volume+reporter+page.
  const paragraphs = text.split(/\n{2,}/);
  const ledger = new Map<string, { shortName: string; volume: string; reporter: string; page: string }>();
  let lastKey: string | null = null;
  let citeCount = 0;
  let shortFormCount = 0;
  let idCount = 0;

  const out = paragraphs.map((para) => {
    // Skip headings/lists/tables from Id. logic (they still get reporter normalization).
    const isBlock = /^\s*(#|>|\||[-*+]\s|\d+\.\s)/.test(para);
    if (isBlock) {
      // Reset lastKey across headings — Id. can't cross them.
      if (/^\s*#/.test(para)) lastKey = null;
      return para;
    }

    // Find full cites and rewrite subsequent same-case refs.
    let localText = para;
    let match: RegExpExecArray | null;
    const seenInPara: string[] = [];
    // Reset the regex — need lastIndex.
    const caseRe = new RegExp(CASE_NAME_RE.source, 'g');
    while ((match = caseRe.exec(localText)) !== null) {
      const caseName = match[1];
      const tail = FULL_CITE_TAIL_RE.exec(localText.slice(match.index + match[0].length));
      if (!tail) continue;
      citeCount += 1;
      const shortName = deriveShortName(caseName);
      const [_all, volume, reporter, page] = tail;
      const key = `${volume}|${reporter.trim()}|${page}`;
      const already = ledger.get(key);
      const absStart = match.index;
      const absEnd = match.index + match[0].length + tail[0].length;

      if (already) {
        // Subsequent full re-cite → short form OR Id.
        const isImmediate = lastKey === key;
        const original = localText.slice(absStart, absEnd);
        if (isImmediate) {
          const pin = tail[4] ? ` at ${tail[4]}` : '';
          const replacement = `*Id.*${pin}`;
          localText = localText.slice(0, absStart) + replacement + localText.slice(absEnd);
          idCount += 1;
          changes.push({ kind: 'id', before: original, after: replacement });
          caseRe.lastIndex = absStart + replacement.length;
        } else {
          const pin = tail[4] ? `, at ${tail[4]}` : '';
          const replacement = `*${shortName}*, ${volume} ${reporter.trim()}${pin || ` at ${page}`}`;
          localText = localText.slice(0, absStart) + replacement + localText.slice(absEnd);
          shortFormCount += 1;
          changes.push({ kind: 'short', before: original, after: replacement });
          caseRe.lastIndex = absStart + replacement.length;
        }
      } else {
        ledger.set(key, { shortName, volume, reporter: reporter.trim(), page });
        seenInPara.push(key);
      }
      lastKey = key;
    }
    return localText;
  });

  return { text: out.join('\n\n'), citeCount, shortFormCount, idCount };
}

function deriveShortName(fullCase: string): string {
  // Bluebook short form uses the first party (or defendant if plaintiff is US/State).
  const parts = fullCase.split(/\s+v\.\s+/);
  const plaintiff = (parts[0] ?? '').trim();
  const defendant = (parts[1] ?? '').trim();
  const generic = /^(United States|State|People|Commonwealth|Commissioner|In re)\b/i;
  const pick = generic.test(plaintiff) ? defendant : plaintiff;
  // First surname-like word.
  const first = pick.split(/\s+/)[0] ?? pick;
  return first.replace(/[,.]$/, '');
}

function passSmartQuotes(text: string, changes: BluebookChange[]): string {
  let out = text;
  const before = out;
  // straight quotes → curly (open/close aware)
  out = out.replace(/(^|[\s(\[{"“‘])"/g, '$1\u201C').replace(/"/g, '\u201D');
  out = out.replace(/(^|[\s(\[{"“‘])'/g, '$1\u2018').replace(/'/g, '\u2019');
  // em/en dash and ellipsis
  out = out.replace(/---/g, '\u2014').replace(/(\w)--(\w)/g, '$1\u2014$2');
  out = out.replace(/\.\.\./g, '\u2026');
  if (out !== before) changes.push({ kind: 'smart', before: '…', after: '…' });
  return out;
}

// ---------- public entry ----------

export function normalizeBluebook(
  md: string,
  opts: { smartQuotes?: boolean } = {},
): { markdown: string; report: BluebookReport } {
  const changes: BluebookChange[] = [];
  const totals = emptyTotals();
  let citeCount = 0;
  let shortFormCount = 0;
  let idCount = 0;

  const segments = splitProtected(md ?? '');
  const rebuilt = segments
    .map((seg) => {
      if (seg.frozen) return seg.text;
      let t = seg.text;
      t = passReporters(t, changes);
      t = passSignals(t, changes);
      t = passPincites(t, changes);
      t = passItalicCaseNames(t, changes);
      const idRes = passIdAndShort(t, changes);
      t = idRes.text;
      citeCount += idRes.citeCount;
      shortFormCount += idRes.shortFormCount;
      idCount += idRes.idCount;
      if (opts.smartQuotes !== false) t = passSmartQuotes(t, changes);
      return t;
    })
    .join('');

  for (const c of changes) totals[c.kind] += 1;

  return {
    markdown: rebuilt,
    report: { changes, totals, citeCount, shortFormCount, idCount },
  };
}

/** Cheap stats-only pass for the toolbar chip. Doesn't modify text. */
export function countCitations(md: string): { total: number; shortForm: number; id: number } {
  const src = md ?? '';
  const total = (src.match(/\b\d+\s+[A-Z][A-Za-z.\s]{0,10}\d?[a-z]{0,3}\.?\s+\d+/g) || []).length;
  const shortForm = (src.match(/\b[A-Z][A-Za-z]+,\s+\d+\s+[A-Z][A-Za-z.\s]{0,10}\d?[a-z]{0,3}\.?\s+at\s+\d+/g) || [])
    .length;
  const id = (src.match(/\*?Id\.\*?/g) || []).length;
  return { total, shortForm, id };
}
