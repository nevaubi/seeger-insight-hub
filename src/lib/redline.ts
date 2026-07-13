// Client-side redline engine for the Drafting Workspace.
//
// The server (ai-assist v12 `redline` mode) verifies every AI edit against the document
// verbatim before it reaches the client. This module is the client half: it re-locates a
// suggestion's anchor in the CURRENT document (content may have drifted since the run —
// typing, or earlier accepts shifting offsets), applies accepted edits, and builds the
// inline ins/del segment model the RedlineView renders. Anchor + occurrence is always the
// source of truth; server offsets are advisory hints only.
//
// locateAnchor / findOccurrences / normalizedFind intentionally mirror
// supabase/functions/ai-assist/anchor.ts (the Deno edge module can't be imported into the
// browser bundle; keep the two in sync when the matching rules change).

export type RedlineOp = 'replace' | 'delete' | 'insert_before' | 'insert_after' | 'comment';
export type CiteTier = 'record' | 'connector' | 'model';

export interface SuggestionCite {
  label: string;
  page: string | null;
  tier: CiteTier;
  pdf_url: string | null;
}

export type SuggestionStatus = 'pending' | 'accepted' | 'rejected';

export interface Suggestion {
  id: string;
  dbId: string; // client-generated uuid used for document_suggestions persistence
  op: RedlineOp;
  anchor: string;
  occurrence: number | null;
  start: number; // offsets into the document as submitted for the run (advisory)
  end: number;
  text: string;
  rationale: string;
  cite: SuggestionCite | null;
  confidence: 'high' | 'needs_review';
  match_mode: 'exact' | 'normalized';
  status: SuggestionStatus;
  source: 'redline' | 'transform';
}

export interface FailedSuggestion {
  id: string;
  op: RedlineOp;
  anchor: string;
  reason: string;
  count: number | null;
  rationale: string;
  cite: SuggestionCite | null;
}

export const FAIL_REASON_LABELS: Record<string, string> = {
  anchor_not_found: 'Anchor text not found in the document',
  ambiguous_anchor: 'Anchor text appears more than once',
  occurrence_out_of_range: 'Anchor occurrence out of range',
  anchor_too_short: 'Anchor too short to locate safely',
  overlaps_previous_edit: 'Overlaps an earlier suggestion',
};

// ---------- anchor location (mirrors edge anchor.ts) ----------

const MIN_ANCHOR_LEN = 6;

export function findOccurrences(space: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = 0;
  while (true) {
    const at = space.indexOf(needle, i);
    if (at === -1) break;
    out.push(at);
    i = at + needle.length;
    if (out.length > 200) break;
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function normalizedFind(space: string, needle: string): { start: number; end: number }[] {
  const trimmed = needle.trim();
  if (!trimmed) return [];
  let pat = '';
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (/\s/.test(ch)) {
      pat += '\\s+';
      while (i < trimmed.length && /\s/.test(trimmed[i])) i++;
      continue;
    }
    if (ch === "'" || ch === '‘' || ch === '’') pat += "['‘’]";
    else if (ch === '"' || ch === '“' || ch === '”') pat += '["“”]';
    else if (ch === '-' || ch === '–' || ch === '—') pat += '[-–—]';
    else pat += escapeRegex(ch);
    i++;
  }
  let re: RegExp;
  try {
    re = new RegExp(pat, 'g');
  } catch {
    return [];
  }
  const out: { start: number; end: number }[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(space)) !== null) {
    out.push({ start: m.index, end: m.index + m[0].length });
    if (m.index === re.lastIndex) re.lastIndex++;
    if (out.length > 200) break;
  }
  return out;
}

export function locateAnchor(
  space: string,
  anchor: string,
  occurrence?: number | null,
): { start: number; end: number } | null {
  const a = (anchor ?? '').trim();
  if (a.length < MIN_ANCHOR_LEN) return null;
  const wanted = occurrence && occurrence >= 1 ? Math.floor(occurrence) : undefined;

  const exact = findOccurrences(space, a);
  if (exact.length > 0) {
    if (wanted === undefined && exact.length > 1) return null;
    const idx = exact[(wanted ?? 1) - 1];
    if (idx === undefined) return null;
    return { start: idx, end: idx + a.length };
  }
  const norm = normalizedFind(space, a);
  if (norm.length === 1 && wanted === undefined) return norm[0];
  if (norm.length >= 1 && wanted !== undefined) return norm[wanted - 1] ?? null;
  return null;
}

/** Locate a suggestion in the current document. Prefers the advisory offsets when the
 *  anchor still sits exactly there (fast path, and robust to duplicate anchors). */
export function locateSuggestion(doc: string, s: Suggestion): { start: number; end: number } | null {
  if (
    s.start >= 0 &&
    s.end <= doc.length &&
    s.end > s.start &&
    doc.slice(s.start, s.end) === s.anchor
  ) {
    return { start: s.start, end: s.end };
  }
  return locateAnchor(doc, s.anchor, s.occurrence);
}

// ---------- applying suggestions ----------

export function applySuggestion(doc: string, s: Suggestion): { next: string; caret: number } | null {
  if (s.op === 'comment') return { next: doc, caret: -1 }; // resolving a comment changes nothing
  const loc = locateSuggestion(doc, s);
  if (!loc) return null;
  const { start, end } = loc;
  switch (s.op) {
    case 'replace':
      return { next: doc.slice(0, start) + s.text + doc.slice(end), caret: start + s.text.length };
    case 'delete':
      return { next: doc.slice(0, start) + doc.slice(end), caret: start };
    case 'insert_before':
      return { next: doc.slice(0, start) + s.text + doc.slice(start), caret: start + s.text.length };
    case 'insert_after':
      return { next: doc.slice(0, end) + s.text + doc.slice(end), caret: end + s.text.length };
    default:
      return null;
  }
}

// ---------- inline render model (RedlineView) ----------

export type RedlineSegment =
  | { kind: 'text'; text: string }
  | { kind: 'del'; text: string; suggestion: Suggestion }
  | { kind: 'ins'; text: string; suggestion: Suggestion }
  | { kind: 'comment'; text: string; suggestion: Suggestion };

/** Build the segment list for inline redline rendering. Unlocatable or overlapping
 *  pending suggestions are skipped (they remain in the Changes rail). */
export function buildSegments(doc: string, pending: Suggestion[]): {
  segments: RedlineSegment[];
  placed: Set<string>;
} {
  const located = pending
    .map((s) => {
      const loc = locateSuggestion(doc, s);
      return loc ? { s, ...loc } : null;
    })
    .filter((x): x is { s: Suggestion; start: number; end: number } => !!x)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const chosen: typeof located = [];
  let lastEnd = -1;
  for (const item of located) {
    const isZeroWidth = item.s.op === 'insert_before' || item.s.op === 'insert_after';
    const effStart = item.s.op === 'insert_after' ? item.end : item.start;
    if (effStart < lastEnd) continue; // overlap with an earlier suggestion — rail-only
    chosen.push(item);
    lastEnd = isZeroWidth ? effStart : item.end;
  }

  const segments: RedlineSegment[] = [];
  const placed = new Set<string>();
  let cursor = 0;
  for (const { s, start, end } of chosen) {
    placed.add(s.id);
    const anchorText = doc.slice(start, end);
    switch (s.op) {
      case 'replace':
        if (start > cursor) segments.push({ kind: 'text', text: doc.slice(cursor, start) });
        segments.push({ kind: 'del', text: anchorText, suggestion: s });
        segments.push({ kind: 'ins', text: s.text, suggestion: s });
        cursor = end;
        break;
      case 'delete':
        if (start > cursor) segments.push({ kind: 'text', text: doc.slice(cursor, start) });
        segments.push({ kind: 'del', text: anchorText, suggestion: s });
        cursor = end;
        break;
      case 'insert_before':
        if (start > cursor) segments.push({ kind: 'text', text: doc.slice(cursor, start) });
        segments.push({ kind: 'ins', text: s.text, suggestion: s });
        cursor = start;
        break;
      case 'insert_after':
        if (end > cursor) segments.push({ kind: 'text', text: doc.slice(cursor, end) });
        segments.push({ kind: 'ins', text: s.text, suggestion: s });
        cursor = end;
        break;
      case 'comment':
        if (start > cursor) segments.push({ kind: 'text', text: doc.slice(cursor, start) });
        segments.push({ kind: 'comment', text: anchorText, suggestion: s });
        cursor = end;
        break;
    }
  }
  if (cursor < doc.length) segments.push({ kind: 'text', text: doc.slice(cursor) });
  return { segments, placed };
}

// ---------- occurrence bookkeeping for client-made (transform) suggestions ----------

/** 1-based occurrence index of the occurrence of `needle` that begins at `start`. */
export function occurrenceAt(doc: string, needle: string, start: number): number {
  const all = findOccurrences(doc, needle);
  const idx = all.indexOf(start);
  return idx === -1 ? 1 : idx + 1;
}

// ---------- local placeholder sweep (export gate; mirrors edge checks.ts) ----------

export interface PlaceholderHit {
  quote: string;
  start: number;
  end: number;
}

const PLACEHOLDER_RE = /\[[^\[\]\n]{2,90}\]/g;

export function scanPlaceholdersLocal(doc: string): PlaceholderHit[] {
  const out: PlaceholderHit[] = [];
  let m: RegExpExecArray | null;
  PLACEHOLDER_RE.lastIndex = 0;
  while ((m = PLACEHOLDER_RE.exec(doc)) !== null) {
    const inner = m[0].slice(1, -1);
    if (/[a-z]/.test(inner)) continue;
    if (!/[A-Z][\s\S]*[A-Z]/.test(inner)) continue;
    if (inner.startsWith('^')) continue;
    if (doc[m.index + m[0].length] === '(') continue;
    out.push({ quote: m[0], start: m.index, end: m.index + m[0].length });
  }
  return out;
}
