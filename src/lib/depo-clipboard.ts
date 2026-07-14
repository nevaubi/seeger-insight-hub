// Cross-page handoffs for the depositions workspace.
// * Draft queue: markdown blocks to append the next time /draft mounts.
// * Ask seed:  a question to prefill on the next /search visit.
//
// Both are localStorage-backed so a full navigation round-trip works. They are
// deliberately one-shot: readers must call `drain*` to consume + clear.

const DRAFT_QUEUE_KEY = 'depo.draftQueue.v1';
const ASK_SEED_KEY = 'depo.askSeed.v1';

export interface DraftPaste {
  markdown: string;
  source?: string; // e.g. "Prescott Dep. 42:7–18"
}

function safeGet(key: string): string | null {
  if (typeof window === 'undefined') return null;
  try { return window.localStorage.getItem(key); } catch { return null; }
}
function safeSet(key: string, value: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    if (value == null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
  } catch { /* ignore */ }
}

// ---- Draft queue ----

export function queueDraftPaste(item: DraftPaste): void {
  const raw = safeGet(DRAFT_QUEUE_KEY);
  const list: DraftPaste[] = raw ? safeParse(raw) : [];
  list.push(item);
  safeSet(DRAFT_QUEUE_KEY, JSON.stringify(list));
}

export function drainDraftQueue(): DraftPaste[] {
  const raw = safeGet(DRAFT_QUEUE_KEY);
  if (!raw) return [];
  safeSet(DRAFT_QUEUE_KEY, null);
  return safeParse(raw);
}

function safeParse(raw: string): DraftPaste[] {
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => x && typeof x.markdown === 'string') : [];
  } catch { return []; }
}

// ---- Ask seed ----

export function seedAskQuestion(q: string): void {
  safeSet(ASK_SEED_KEY, q);
}

export function drainAskSeed(): string | null {
  const raw = safeGet(ASK_SEED_KEY);
  if (raw) safeSet(ASK_SEED_KEY, null);
  return raw;
}

// ---- Formatting helpers ----

/** Build a Bluebook-ish deposition citation, e.g. "Prescott Dep. 42:7–18". */
export function depoCiteLabel(
  witnessName: string | null | undefined,
  span: { page_start: number | null; line_start: number | null; page_end: number | null; line_end: number | null },
): string {
  const name = (witnessName || 'Witness').split(/\s+/).slice(-1)[0] || 'Witness';
  const p1 = span.page_start;
  const l1 = span.line_start;
  if (p1 == null || l1 == null) return `${name} Dep.`;
  const p2 = span.page_end ?? p1;
  const l2 = span.line_end ?? l1;
  const range =
    p1 === p2 && l1 === l2 ? `${p1}:${l1}` :
    p1 === p2 ? `${p1}:${l1}\u2013${l2}` :
    `${p1}:${l1}\u2013${p2}:${l2}`;
  return `${name} Dep. ${range}`;
}

/** Render a block-quote markdown paste with a parenthetical cite. */
export function formatQuoteBlock(quote: string, cite: string): string {
  const clean = quote.trim().replace(/^["\u201C]|["\u201D]$/g, '');
  const bq = clean.split('\n').map((l) => `> ${l}`).join('\n');
  return `${bq}\n>\n> — ${cite}\n`;
}
