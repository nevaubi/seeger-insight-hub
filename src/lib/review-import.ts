// Import documents that already live in the matter (docket orders/filings and
// deposition transcripts) straight into a Tabular Review set.
//
// These sources already have extracted page text, so they skip the
// `tabular-ingest` transcription pass entirely: we copy the page text into
// `review_file_pages` and mark the file ready.

import { supabase, type ReviewFile } from '@/lib/supabase';

export const DOCKET_PATH_PREFIX = 'docket:';
export const DEPO_PATH_PREFIX = 'deposition:';

/** True for review files that reference matter content rather than a storage object. */
export function isImportedPath(path: string | null | undefined): boolean {
  return !!path && (path.startsWith(DOCKET_PATH_PREFIX) || path.startsWith(DEPO_PATH_PREFIX));
}

export interface DocketCandidate {
  id: string;
  document_id: string;
  order_type: string | null;
  order_number: string | null;
  canonical_title: string | null;
  order_date: string | null;
  page_count: number | null;
  tags: string[] | null;
}

export interface DepoCandidate {
  id: string;
  witness_name: string | null;
  witness_role: string | null;
  party_alignment: string | null;
  deposition_date: string | null;
  page_count: number | null;
  filename: string | null;
  status: string | null;
}

export async function fetchDocketCandidates(caseId: string): Promise<DocketCandidate[]> {
  const { data, error } = await supabase
    .from('v_orders')
    .select('id, document_id, order_type, order_number, canonical_title, order_date, page_count, tags, case_id')
    .eq('case_id', caseId)
    .not('document_id', 'is', null)
    .order('order_date', { ascending: false })
    .limit(500);
  if (error) throw error;
  return (data ?? []) as unknown as DocketCandidate[];
}

export async function fetchDepoCandidates(caseId: string): Promise<DepoCandidate[]> {
  const { data, error } = await supabase
    .from('depositions')
    .select('id, witness_name, witness_role, party_alignment, deposition_date, page_count, filename, status')
    .eq('case_id', caseId)
    .order('deposition_date', { ascending: false })
    .limit(200);
  if (error) throw error;
  return (data ?? []) as unknown as DepoCandidate[];
}

function docketLabel(o: DocketCandidate): string {
  const num = o.order_number ? `${(o.order_type ?? '').toUpperCase()} ${o.order_number}`.trim() : null;
  const title = (o.canonical_title ?? 'Docket document').replace(/\s+/g, ' ').trim();
  const label = num ? `${num} — ${title}` : title;
  return label.length > 160 ? `${label.slice(0, 157)}…` : label;
}

function depoLabel(d: DepoCandidate): string {
  const who = d.witness_name?.trim() || d.filename || 'Deposition';
  return d.deposition_date ? `${who} — Depo. ${d.deposition_date}` : `${who} — Deposition`;
}

async function insertPages(
  reviewFileId: string,
  pages: { page_number: number; text: string }[],
  source: string,
): Promise<void> {
  const CHUNK = 25;
  for (let i = 0; i < pages.length; i += CHUNK) {
    const rows = pages.slice(i, i + CHUNK).map((p) => ({
      review_file_id: reviewFileId,
      page_number: p.page_number,
      text: p.text,
      source,
    }));
    const { error } = await supabase.from('review_file_pages').insert(rows);
    if (error) throw error;
  }
}

async function registerFile(
  setId: string,
  filename: string,
  storagePath: string,
  mime: string,
): Promise<ReviewFile> {
  const { data, error } = await supabase
    .from('review_files')
    .insert({
      review_set_id: setId,
      filename,
      storage_path: storagePath,
      mime_type: mime,
      status: 'transcribing',
    })
    .select('*')
    .single();
  if (error) throw error;
  return data as ReviewFile;
}

async function finalize(fileId: string, pages: { text: string }[]): Promise<void> {
  const chars = pages.reduce((n, p) => n + (p.text?.length ?? 0), 0);
  await supabase
    .from('review_files')
    .update({ status: 'ready', page_count: pages.length, char_count: chars, error: null })
    .eq('id', fileId);
}

async function markError(fileId: string, message: string): Promise<void> {
  await supabase.from('review_files').update({ status: 'error', error: message.slice(0, 400) }).eq('id', fileId);
}

/** Copy a docket document's extracted pages into the review set. */
export async function importDocketDocument(setId: string, order: DocketCandidate): Promise<void> {
  const file = await registerFile(
    setId,
    docketLabel(order),
    `${DOCKET_PATH_PREFIX}${order.document_id}`,
    'application/pdf',
  );
  try {
    const { data, error } = await supabase
      .from('document_pages')
      .select('page_number, extracted_text')
      .eq('document_id', order.document_id)
      .order('page_number', { ascending: true });
    if (error) throw error;
    const pages = (data ?? [])
      .map((p: any) => ({ page_number: p.page_number as number, text: (p.extracted_text ?? '').trim() }))
      .filter((p) => p.text.length > 0);
    if (!pages.length) throw new Error('No extracted text on the docket for this document');
    await insertPages(file.id, pages, 'docket');
    await finalize(file.id, pages);
  } catch (e) {
    await markError(file.id, (e as Error).message);
    throw e;
  }
}

/** Copy a deposition transcript (page:line text) into the review set. */
export async function importDeposition(setId: string, depo: DepoCandidate): Promise<void> {
  const file = await registerFile(setId, depoLabel(depo), `${DEPO_PATH_PREFIX}${depo.id}`, 'text/plain');
  try {
    const byPage = new Map<number, string[]>();
    const PAGE_SIZE = 2000;
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await supabase
        .from('deposition_lines')
        .select('page, line, text')
        .eq('deposition_id', depo.id)
        .order('page', { ascending: true })
        .order('line', { ascending: true })
        .range(from, from + PAGE_SIZE - 1);
      if (error) throw error;
      const rows = (data ?? []) as { page: number; line: number; text: string }[];
      for (const r of rows) {
        const arr = byPage.get(r.page) ?? [];
        arr.push(`${String(r.line).padStart(2, ' ')}  ${r.text ?? ''}`);
        byPage.set(r.page, arr);
      }
      if (rows.length < PAGE_SIZE) break;
    }
    const pages = Array.from(byPage.entries())
      .sort((a, b) => a[0] - b[0])
      .map(([page_number, lines]) => ({ page_number, text: lines.join('\n').trim() }))
      .filter((p) => p.text.length > 0);
    if (!pages.length) throw new Error('This transcript has no indexed lines yet');
    await insertPages(file.id, pages, 'deposition');
    await finalize(file.id, pages);
  } catch (e) {
    await markError(file.id, (e as Error).message);
    throw e;
  }
}

/** Run imports with bounded concurrency; resolves with per-item outcomes. */
export async function runImports(
  tasks: (() => Promise<void>)[],
  concurrency = 4,
): Promise<{ ok: number; failed: number; firstError: string | null }> {
  const queue = [...tasks];
  let ok = 0;
  let failed = 0;
  let firstError: string | null = null;
  const worker = async () => {
    while (queue.length) {
      const t = queue.shift();
      if (!t) break;
      try {
        await t();
        ok++;
      } catch (e) {
        failed++;
        firstError ??= (e as Error).message;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, Math.max(queue.length, 1)) }, worker));
  return { ok, failed, firstError };
}
