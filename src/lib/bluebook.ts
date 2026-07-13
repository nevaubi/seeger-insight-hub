// Bluebook-style record-citation formatting for the Drafting Workspace.
// Extracted from the draft route so the palette, chat, and suggestion rail share one
// citation vocabulary. Record cites only (PTO/CMO/CBO/JPML label conventions).

import type { AiAssistChunk, AiAssistCitation } from '@/lib/useAiAssist';

export type CiteChip = {
  num: number;
  order_label: string | null;
  page: string | null;
  title?: string;
  cited_text?: string;
  pdf_url: string | null;
};

/** Short-form record cite: "(PTO-12, at 4)" */
export function formatShortCite(c: CiteChip): string {
  const label = c.order_label || c.title || 'Order';
  const page = c.page ? formatPagePin(c.page) : '';
  return page ? ` (${label}, at ${page})` : ` (${label})`;
}

/** Full-form record cite: "(Pretrial Order No. 12, *Case Management Order*, at 4)" */
export function formatFullCite(c: CiteChip): string {
  const label = c.order_label || 'Order';
  const title = c.title && c.title !== c.order_label ? `, *${stripLabelEcho(c.title, label)}*` : '';
  const page = c.page ? `, at ${formatPagePin(c.page)}` : '';
  return ` (${expandLabel(label)}${title}${page})`;
}

/** Markdown footnote pieces. Caller inserts inline marker and appends definition. */
export function formatFootnoteCite(c: CiteChip, n: number): { marker: string; definition: string } {
  const label = c.order_label || c.title || 'Order';
  const page = c.page ? `, at ${formatPagePin(c.page)}` : '';
  const url = c.pdf_url ? ` <${c.pdf_url}>` : '';
  return {
    marker: `[^${n}]`,
    definition: `[^${n}]: ${expandLabel(label)}${page}.${url}`,
  };
}

/** "*Id.* at 5" / "*Id.*" for an immediately repeated source. */
export function formatIdCite(prev: CiteChip, c: CiteChip): string | null {
  const sameSource = (prev.order_label || prev.title) === (c.order_label || c.title);
  if (!sameSource) return null;
  if (c.page && c.page !== prev.page) return ` (*Id.* at ${formatPagePin(c.page)})`;
  return ' (*Id.*)';
}

export function expandLabel(label: string): string {
  // "PTO-12" → "Pretrial Order No. 12"; "CMO-3" → "Case Management Order No. 3"
  const m = label.match(/^(PTO|CMO|CBO|JPML)[-\s]?(\d+[A-Z]?)$/i);
  if (!m) return label;
  const kind = m[1].toUpperCase();
  const num = m[2];
  const expanded: Record<string, string> = {
    PTO: 'Pretrial Order No.',
    CMO: 'Case Management Order No.',
    CBO: 'Common Benefit Order No.',
    JPML: 'JPML Transfer Order No.',
  };
  return `${expanded[kind] ?? label} ${num}`;
}

export function formatPagePin(page: string): string {
  // "p.4" → "4"; "p.4–5" → "4–5"; "4-5" → "4–5"
  return page.replace(/^p\.?\s*/i, '').replace(/-/g, '–');
}

export function stripLabelEcho(title: string, label: string): string {
  return title.replace(new RegExp(`^${label}[\\s:·—-]+`, 'i'), '').trim() || title;
}

export function citeSourceKey(c: CiteChip): string {
  return `${c.order_label ?? ''}|${c.title ?? ''}`;
}

export function dedupeCitations(
  citations?: AiAssistCitation[],
  chunks?: AiAssistChunk[],
): CiteChip[] {
  if (!citations?.length) return [];
  const byRef = new Map((chunks ?? []).map((c) => [c.ref, c]));
  const seen = new Map<string, CiteChip>();
  for (const c of citations) {
    const key = `${c.order_label ?? c.title ?? ''}|${c.page ?? ''}`;
    if (seen.has(key)) continue;
    const chunk = c.ref ? byRef.get(c.ref) : undefined;
    seen.set(key, {
      num: c.num,
      order_label: c.order_label,
      page: c.page,
      title: c.title,
      cited_text: c.cited_text,
      pdf_url: chunk?.pdf_url ?? null,
    });
  }
  return Array.from(seen.values());
}
