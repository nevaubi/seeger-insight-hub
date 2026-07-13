// anchor.ts — pure anchor-location + redline-protocol logic for ai-assist v12.
// No Deno/network APIs: everything here is deterministic string work so it can be
// unit-tested locally (node --experimental-strip-types) and reasoned about in isolation.
//
// The redline contract: the model proposes edits as NDJSON lines, each carrying an
// `anchor` — a verbatim quote from the document. An edit is only emitted to the client
// after the anchor is located in the document text (exact match first, then a
// whitespace/quote/dash-tolerant match that must resolve uniquely). Anything that cannot
// be anchored is surfaced as a failed suggestion, never silently applied. This extends
// the platform's Tabular Review verbatim-verification gate from extraction to revision.

export type EditOp = "replace" | "delete" | "insert_before" | "insert_after" | "comment";

export const EDIT_OPS: ReadonlySet<string> = new Set([
  "replace",
  "delete",
  "insert_before",
  "insert_after",
  "comment",
]);

export interface RawEdit {
  op: EditOp;
  anchor: string;
  occurrence?: number;
  text?: string;
  rationale?: string;
  cite?: { label?: string; page?: string } | null;
  confidence?: "high" | "needs_review";
}

export type ParsedLine =
  | { kind: "edit"; edit: RawEdit }
  | { kind: "summary"; text: string }
  | { kind: "skip" }
  | { kind: "error"; reason: string; line: string };

export type LocateResult =
  | { ok: true; start: number; end: number; mode: "exact" | "normalized" }
  | { ok: false; reason: "anchor_too_short" | "anchor_not_found" | "ambiguous_anchor" | "occurrence_out_of_range"; count?: number };

export const MIN_ANCHOR_LEN = 6;
export const MAX_ANCHOR_LEN = 400;

// ---------- occurrence search ----------

/** Non-overlapping exact occurrences of `needle` in `space` (document order). */
export function findOccurrences(space: string, needle: string): number[] {
  const out: number[] = [];
  if (!needle) return out;
  let i = 0;
  while (true) {
    const at = space.indexOf(needle, i);
    if (at === -1) break;
    out.push(at);
    i = at + needle.length;
    if (out.length > 200) break; // pathological repetition; enough to call it ambiguous
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whitespace/typography-tolerant matches: runs of whitespace match any whitespace
 * (so an anchor that collapses a line break still resolves), straight/curly quotes
 * are interchangeable, and hyphen/en/em dashes are interchangeable. The matched span
 * boundaries always come from the ACTUAL document text.
 */
export function normalizedFind(space: string, needle: string): { start: number; end: number }[] {
  const trimmed = needle.trim();
  if (!trimmed) return [];
  // Build the pattern character-by-character so tolerance classes never collide
  // with regex escaping.
  let pat = "";
  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i];
    if (/\s/.test(ch)) {
      pat += "\\s+";
      while (i < trimmed.length && /\s/.test(trimmed[i])) i++;
      continue;
    }
    if (ch === "'" || ch === "‘" || ch === "’") pat += "['‘’]";
    else if (ch === '"' || ch === "“" || ch === "”") pat += "[\"“”]";
    else if (ch === "-" || ch === "–" || ch === "—") pat += "[-–—]";
    else pat += escapeRegex(ch);
    i++;
  }
  let re: RegExp;
  try {
    re = new RegExp(pat, "g");
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

/**
 * Locate an anchor within `space`. Exact matches win; if none, a normalized match is
 * accepted only when it resolves uniquely (or the model disambiguated with `occurrence`).
 */
export function locateAnchor(space: string, anchor: string, occurrence?: number): LocateResult {
  const a = (anchor ?? "").trim();
  if (a.length < MIN_ANCHOR_LEN) return { ok: false, reason: "anchor_too_short" };
  const wanted = occurrence && occurrence >= 1 ? Math.floor(occurrence) : undefined;

  const exact = findOccurrences(space, a);
  if (exact.length > 0) {
    if (wanted === undefined && exact.length > 1) {
      return { ok: false, reason: "ambiguous_anchor", count: exact.length };
    }
    const idx = exact[(wanted ?? 1) - 1];
    if (idx === undefined) return { ok: false, reason: "occurrence_out_of_range", count: exact.length };
    return { ok: true, start: idx, end: idx + a.length, mode: "exact" };
  }

  const norm = normalizedFind(space, a);
  if (norm.length === 1 && wanted === undefined) {
    return { ok: true, ...norm[0], mode: "normalized" };
  }
  if (norm.length >= 1 && wanted !== undefined) {
    const hit = norm[wanted - 1];
    if (!hit) return { ok: false, reason: "occurrence_out_of_range", count: norm.length };
    return { ok: true, ...hit, mode: "normalized" };
  }
  if (norm.length > 1) return { ok: false, reason: "ambiguous_anchor", count: norm.length };
  return { ok: false, reason: "anchor_not_found" };
}

// ---------- claimed-range bookkeeping (overlap rejection) ----------

/**
 * Tracks character ranges already claimed by verified edits so later edits that would
 * collide are rejected deterministically. Content-changing ops claim their anchor span;
 * inserts claim a zero-width boundary; comments claim nothing.
 */
export class ClaimSet {
  private claims: Array<[number, number]> = [];

  tryClaim(start: number, end: number): boolean {
    for (const [s, e] of this.claims) {
      // zero-width claims collide only with ranges that strictly contain them
      const overlaps = start < e && end > s;
      const zeroWidthCollision =
        (start === end && start > s && start < e) || (s === e && s > start && s < end);
      if (overlaps || zeroWidthCollision) return false;
    }
    this.claims.push([start, end]);
    return true;
  }

  static spanFor(op: EditOp, start: number, end: number): [number, number] | null {
    switch (op) {
      case "replace":
      case "delete":
        return [start, end];
      case "insert_before":
        return [start, start];
      case "insert_after":
        return [end, end];
      case "comment":
        return null;
    }
  }
}

// ---------- NDJSON line parsing ----------

/** Parse one line of model output into a redline protocol message. */
export function parseEditLine(rawLine: string): ParsedLine {
  let line = rawLine.trim();
  if (!line) return { kind: "skip" };
  if (/^```/.test(line)) return { kind: "skip" }; // stray code fences
  // tolerate an SSE-style or list-style prefix if a model adds one
  line = line.replace(/^(?:data:\s*|[-*]\s+)/, "");
  if (!line.startsWith("{")) return { kind: "error", reason: "not_json", line: rawLine.slice(0, 200) };
  let obj: Record<string, unknown>;
  try {
    obj = JSON.parse(line) as Record<string, unknown>;
  } catch {
    return { kind: "error", reason: "bad_json", line: rawLine.slice(0, 200) };
  }
  const type = String(obj.type ?? obj.op ?? "");
  if (type === "summary") {
    return { kind: "summary", text: String(obj.text ?? "").trim() };
  }
  const op = String(obj.op ?? "");
  if (!EDIT_OPS.has(op)) return { kind: "error", reason: "unknown_op", line: rawLine.slice(0, 200) };
  const anchor = typeof obj.anchor === "string" ? obj.anchor : "";
  if (!anchor.trim()) return { kind: "error", reason: "missing_anchor", line: rawLine.slice(0, 200) };
  const text = typeof obj.text === "string" ? obj.text : undefined;
  if ((op === "replace" || op === "insert_before" || op === "insert_after" || op === "comment") && !text) {
    return { kind: "error", reason: "missing_text", line: rawLine.slice(0, 200) };
  }
  const occurrenceRaw = obj.occurrence;
  const occurrence =
    typeof occurrenceRaw === "number" && Number.isFinite(occurrenceRaw) && occurrenceRaw >= 1
      ? Math.floor(occurrenceRaw)
      : undefined;
  let cite: RawEdit["cite"] = null;
  if (obj.cite && typeof obj.cite === "object") {
    const c = obj.cite as Record<string, unknown>;
    const label = typeof c.label === "string" ? c.label.trim() : "";
    if (label) cite = { label, page: typeof c.page === "string" || typeof c.page === "number" ? String(c.page) : undefined };
  }
  const confidence = obj.confidence === "needs_review" ? "needs_review" : "high";
  const rationale = typeof obj.rationale === "string" ? obj.rationale.slice(0, 300) : "";
  return {
    kind: "edit",
    edit: {
      op: op as EditOp,
      anchor: anchor.slice(0, MAX_ANCHOR_LEN),
      occurrence,
      text,
      rationale,
      cite,
      confidence,
    },
  };
}

// ---------- order-label normalization (citation tiering) ----------

/**
 * Normalize record-order labels so "PTO-22", "PTO 22", and "Pretrial Order No. 22"
 * compare equal when deciding whether a model cite matches a grounded source.
 */
export function normalizeOrderLabel(label: string): string {
  let s = (label ?? "").toUpperCase().trim();
  s = s
    .replace(/PRETRIAL\s+ORDER/g, "PTO")
    .replace(/CASE\s+MANAGEMENT\s+ORDER/g, "CMO")
    .replace(/COMMON\s+BENEFIT\s+ORDER/g, "CBO")
    .replace(/TRANSFER\s+ORDER/g, "JPML")
    .replace(/\bNO\.?\s*/g, "")
    .replace(/[^A-Z0-9]/g, "");
  return s;
}
