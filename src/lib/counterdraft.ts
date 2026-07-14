// Counter-draft workflow helpers.
//
// A "counter-draft" is a workspace document created from an opposing party's
// draft. We section the opposing text (headings first, outline markers as a
// fallback), stash section metadata locally per doc, and let the user issue
// per-section "Suggest counter-language" runs that land as tracked changes in
// the editor.

import type { Editor } from '@tiptap/react';

export type CounterSectionStatus =
  | 'pending'
  | 'drafting'
  | 'ready'
  | 'accepted'
  | 'rejected';

export type CounterSection = {
  id: string;
  heading: string;
  level: number; // 1..3, or 0 for auto/outline blocks
  markdown: string;
  status: CounterSectionStatus;
  changeIds: string[];
};

export type CounterdraftState = {
  version: 1;
  source: 'docx' | 'text';
  originalTitle: string | null;
  originalMarkdown: string; // read-only reference copy
  sections: CounterSection[];
  createdAt: number;
};

const KEY = (docId: string) => `counterdraft:v1:${docId}`;

export function loadCounterdraft(docId: string): CounterdraftState | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(KEY(docId));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as CounterdraftState;
    if (parsed?.version !== 1) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveCounterdraft(docId: string, state: CounterdraftState): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY(docId), JSON.stringify(state));
  } catch {
    /* quota exceeded — silently drop */
  }
}

export function clearCounterdraft(docId: string): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.removeItem(KEY(docId));
  } catch {
    /* noop */
  }
}

export function isCounterdraft(docId: string | null): boolean {
  if (!docId) return false;
  return loadCounterdraft(docId) !== null;
}

// ---------- sectioning ----------

let nextIdSeed = 0;
function sid(): string {
  nextIdSeed = (nextIdSeed + 1) % 1_000_000;
  return `s${Date.now().toString(36).slice(-4)}${nextIdSeed.toString(36)}`;
}

const OUTLINE_RE = /^\s*(?:[IVXLCDM]{1,6}\.|[A-Z]\.|\d+\.|\(\w{1,3}\))\s+\S/;

/**
 * Segment markdown into sections. Preference order:
 *   1. ATX headings (`#`/`##`/`###`)
 *   2. Outline markers at line start (Roman/letter/digit/paren)
 *   3. ~600-word rolling windows
 * Every returned section's `markdown` (heading + body) will re-serialize to the
 * original document if concatenated with `\n\n`.
 */
export function sectionize(md: string): CounterSection[] {
  const src = md.replace(/\r\n/g, '\n').trim();
  if (!src) return [];

  // Try headings first
  const headed = sectionizeByHeadings(src);
  if (headed.length >= 2) return headed;

  const outlined = sectionizeByOutline(src);
  if (outlined.length >= 2) return outlined;

  return sectionizeByWindow(src, 600);
}

function sectionizeByHeadings(md: string): CounterSection[] {
  const lines = md.split('\n');
  const out: CounterSection[] = [];
  let currentHeading = '';
  let currentLevel = 0;
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join('\n').trim();
    if (!body && !currentHeading) return;
    const heading = currentHeading || firstMeaningfulLine(body) || 'Untitled section';
    const markdown = currentHeading
      ? `${'#'.repeat(Math.max(1, currentLevel))} ${currentHeading}\n\n${body}`.trim()
      : body;
    out.push({
      id: sid(),
      heading: trim(heading, 120),
      level: currentLevel || 2,
      markdown,
      status: 'pending',
      changeIds: [],
    });
  };
  for (const line of lines) {
    const m = /^(#{1,3})\s+(.+?)\s*$/.exec(line);
    if (m) {
      flush();
      currentHeading = m[2].trim();
      currentLevel = m[1].length;
      buf = [];
      continue;
    }
    buf.push(line);
  }
  flush();
  return out;
}

function sectionizeByOutline(md: string): CounterSection[] {
  const lines = md.split('\n');
  const out: CounterSection[] = [];
  let currentHeading = '';
  let buf: string[] = [];
  const flush = () => {
    const body = buf.join('\n').trim();
    if (!body) return;
    out.push({
      id: sid(),
      heading: trim(currentHeading || firstMeaningfulLine(body) || 'Section', 120),
      level: 2,
      markdown: body,
      status: 'pending',
      changeIds: [],
    });
  };
  for (const line of lines) {
    if (OUTLINE_RE.test(line) && buf.length && wordCount(buf.join(' ')) > 40) {
      flush();
      currentHeading = line.trim();
      buf = [line];
      continue;
    }
    if (!currentHeading && OUTLINE_RE.test(line)) currentHeading = line.trim();
    buf.push(line);
  }
  flush();
  return out;
}

function sectionizeByWindow(md: string, targetWords: number): CounterSection[] {
  const paras = md.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const out: CounterSection[] = [];
  let buf: string[] = [];
  let words = 0;
  const flush = () => {
    if (!buf.length) return;
    const body = buf.join('\n\n');
    out.push({
      id: sid(),
      heading: trim(firstMeaningfulLine(body) || `Section ${out.length + 1}`, 120),
      level: 2,
      markdown: body,
      status: 'pending',
      changeIds: [],
    });
    buf = [];
    words = 0;
  };
  for (const p of paras) {
    buf.push(p);
    words += wordCount(p);
    if (words >= targetWords) flush();
  }
  flush();
  return out;
}

function firstMeaningfulLine(s: string): string {
  for (const line of s.split('\n')) {
    const t = line.replace(/^#+\s*/, '').trim();
    if (t.length >= 3) return t;
  }
  return '';
}
function trim(s: string, n: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}
function wordCount(s: string): number {
  return s.trim() ? s.trim().split(/\s+/).length : 0;
}

// ---------- editor range lookup ----------

/**
 * Locate a section inside a live Tiptap editor by matching the first ~80 chars
 * of its markdown against the editor's plain text. Returns ProseMirror
 * positions bracketing that section (end = position where the next section
 * begins, or doc end). Returns null if the section text cannot be found.
 */
export function sectionRange(
  editor: Editor,
  sections: CounterSection[],
  targetIndex: number,
): { from: number; to: number } | null {
  const target = sections[targetIndex];
  if (!target) return null;

  const doc = editor.state.doc;
  const text = doc.textBetween(0, doc.content.size, '\n', '\n');
  const needle = probe(target);
  if (!needle) return null;

  const from = findIndexIgnoringWhitespace(text, needle);
  if (from < 0) return null;

  // Compute the end: start of the next locatable section, or doc end.
  let to = text.length;
  for (let i = targetIndex + 1; i < sections.length; i++) {
    const nx = probe(sections[i]);
    if (!nx) continue;
    const at = findIndexIgnoringWhitespace(text, nx, from + needle.length);
    if (at >= 0) {
      to = at;
      break;
    }
  }

  // Map plain-text offsets → PM positions by walking text nodes.
  return mapTextRangeToDoc(editor, from, to);
}

function probe(sec: CounterSection): string {
  // Strip leading markdown heading markers so the needle matches editor plain text.
  const first = sec.markdown.replace(/^#{1,6}\s+/, '').split('\n')[0].trim();
  return first.slice(0, 80).replace(/\s+/g, ' ');
}

function findIndexIgnoringWhitespace(hay: string, needle: string, from = 0): number {
  const h = hay.slice(from).replace(/\s+/g, ' ');
  const n = needle.replace(/\s+/g, ' ');
  const idx = h.indexOf(n);
  if (idx < 0) return -1;
  // Best-effort remap into original hay: count non-collapsed characters up to idx.
  let originalIdx = from;
  let collapsed = 0;
  let prevWs = false;
  while (originalIdx < hay.length && collapsed < idx) {
    const ch = hay[originalIdx];
    const isWs = /\s/.test(ch);
    if (isWs) {
      if (!prevWs) collapsed++;
      prevWs = true;
    } else {
      collapsed++;
      prevWs = false;
    }
    originalIdx++;
  }
  return originalIdx;
}

function mapTextRangeToDoc(
  editor: Editor,
  textFrom: number,
  textTo: number,
): { from: number; to: number } {
  const doc = editor.state.doc;
  let cursor = 0;
  let pmFrom = 0;
  let pmTo = doc.content.size;
  let seenFrom = false;
  let seenTo = false;
  doc.descendants((node, pos) => {
    if (seenFrom && seenTo) return false;
    if (node.isText) {
      const len = node.text!.length;
      const next = cursor + len;
      if (!seenFrom && textFrom <= next) {
        pmFrom = pos + Math.max(0, textFrom - cursor);
        seenFrom = true;
      }
      if (!seenTo && textTo <= next) {
        pmTo = pos + Math.max(0, textTo - cursor);
        seenTo = true;
      }
      cursor = next;
    } else if (node.isBlock && cursor > 0) {
      // Block boundaries add a synthetic "\n" in textBetween.
      cursor += 1;
    }
    return true;
  });
  return { from: Math.min(pmFrom, pmTo), to: Math.max(pmFrom, pmTo) };
}

// ---------- prompt ----------

export const COUNTERDRAFT_INSTRUCTION =
  "You are counsel for Plaintiffs' Co-Lead. Rewrite the following passage from " +
  'opposing counsel to advance our position: contest asserted facts and legal ' +
  'conclusions, narrow overbroad language, broaden concessions in our favor, ' +
  "and preserve neutral structural language. Cite controlling MDL orders " +
  '(PTO/CMO/CBO) where directly on point. Return only the rewritten passage — ' +
  'no preamble, no meta commentary. Keep paragraph and list structure.';
