// Deposition digest exports (Markdown → DOCX/PDF, plus multi-sheet XLSX).
// Reuses the in-house file-export pipeline; produces one polished digest per
// deposition, with toggleable sections.

import type {
  Deposition,
  DepositionFinding,
  FindingStance,
} from '@/lib/supabase';
import {
  buildDocx,
  downloadBlob,
  downloadCsv,
  downloadXlsx,
  exportFilename,
  markdownToBlocks,
  printDocument,
  blocksToHtml,
  type Sheet,
  type Cell,
} from '@/lib/file-export';
import { fmtDate } from '@/components/case-ui';

export interface DigestOptions {
  summary: boolean;
  admissions: boolean;
  chronology: boolean;
  exhibits: boolean;
  quality: boolean;
}

const DEFAULTS: DigestOptions = {
  summary: true,
  admissions: true,
  chronology: true,
  exhibits: true,
  quality: true,
};

function witnessLast(name: string | null | undefined): string {
  if (!name) return 'Witness';
  return name.split(/\s+/).slice(-1)[0] || name;
}

function shortCite(
  f: Pick<DepositionFinding, 'page_start' | 'line_start' | 'page_end' | 'line_end' | 'cite'>,
): string {
  if (f.cite) return f.cite;
  const p1 = f.page_start, l1 = f.line_start;
  if (p1 == null || l1 == null) return '';
  const p2 = f.page_end ?? p1;
  const l2 = f.line_end ?? l1;
  if (p1 === p2 && l1 === l2) return `${p1}:${l1}`;
  if (p1 === p2) return `${p1}:${l1}\u2013${l2}`;
  return `${p1}:${l1}\u2013${p2}:${l2}`;
}

function stanceLabel(s: FindingStance | null): string {
  if (!s) return '';
  if (s === 'harmful') return 'Adverse';
  if (s === 'helpful') return 'Helpful';
  return 'Neutral';
}

/** Escape a value for a markdown pipe-table cell. */
function tc(v: string | number | null | undefined): string {
  const s = String(v ?? '').trim();
  if (!s) return '';
  return s
    .replace(/\|/g, '\\|')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s{2,}/g, ' ');
}

function curlyQuote(q: string): string {
  const t = q.trim().replace(/^["\u201C]+|["\u201D]+$/g, '');
  return `\u201C${t}\u201D`;
}

/** Group findings by finding_type for convenience. */
export function groupFindings(findings: DepositionFinding[]): Record<string, DepositionFinding[]> {
  const out: Record<string, DepositionFinding[]> = {};
  for (const f of findings) (out[f.finding_type] ??= []).push(f);
  return out;
}

/** Build a markdown digest. Pure function — good for preview + export. */
export function buildDigestMarkdown(
  depo: Deposition,
  findings: DepositionFinding[],
  opts: Partial<DigestOptions> = {},
): string {
  const o = { ...DEFAULTS, ...opts };
  const g = groupFindings(findings);
  const witness = depo.witness_name || depo.filename || 'Witness';
  const lines: string[] = [];

  lines.push(`# ${witness} — Deposition Digest`);
  const subtitle = [
    depo.witness_role,
    depo.party_alignment,
    depo.deposition_date ? `Deposed ${fmtDate(depo.deposition_date)}` : null,
    depo.individual_case_no,
    depo.mdl_number ? `MDL ${depo.mdl_number}` : null,
    depo.page_count != null ? `${depo.page_count} pp` : null,
  ].filter(Boolean).join(' · ');
  if (subtitle) lines.push(`_${subtitle}_`);
  lines.push('');

  if (o.summary) {
    const exec = (g['exec_summary'] ?? [])[0];
    const profile = (g['witness_profile'] ?? [])[0];
    if (exec?.detail || profile?.detail) {
      lines.push('## Executive Summary');
      if (exec?.detail) { lines.push(exec.detail.trim()); lines.push(''); }
      if (profile?.detail) { lines.push(profile.detail.trim()); lines.push(''); }
    }
  }

  // ---- Admissions: table ----
  if (o.admissions && (g['admission']?.length ?? 0) > 0) {
    lines.push('## Admissions');
    lines.push('| # | Topic | Stance | Admission | Cite |');
    lines.push('|---|---|---|---|---|');
    g['admission'].forEach((f, i) => {
      const topic = f.title?.trim() || 'Admission';
      const stance = stanceLabel(f.stance);
      const parts: string[] = [];
      if (f.detail) parts.push(f.detail.trim());
      if (f.quote) parts.push(curlyQuote(f.quote));
      const body = parts.join(' — ');
      lines.push(`| ${i + 1} | ${tc(topic)} | ${tc(stance)} | ${tc(body)} | ${tc(shortCite(f))} |`);
    });
    lines.push('');
  }

  // ---- Chronology: two-column timeline ----
  if (o.chronology && (g['chronology']?.length ?? 0) > 0) {
    lines.push('## Chronology');
    lines.push('| When | Event |');
    lines.push('|---|---|');
    for (const f of g['chronology']) {
      const when = String(
        (f.data?.date as string | undefined) ||
          (f.data?.when as string | undefined) ||
          '',
      );
      const title = f.title?.trim() || 'Event';
      const detail = f.detail ? ` — ${f.detail.trim()}` : '';
      const cite = shortCite(f);
      const right = `**${title}**${detail}${cite ? `  _(${cite})_` : ''}`;
      lines.push(`| ${tc(when ? `**${when}**` : '·')} | ${tc(right)} |`);
    }
    lines.push('');
  }

  // ---- Exhibits: table ----
  if (o.exhibits && (g['exhibit']?.length ?? 0) > 0) {
    lines.push('## Exhibits');
    lines.push('| Ex. | Title | Description | Cite |');
    lines.push('|---|---|---|---|');
    for (const f of g['exhibit']) {
      const num = (f.data?.exhibit_number as number | string | undefined) ?? '';
      const title = f.title?.trim() || (num ? `Ex. ${num}` : 'Exhibit');
      const desc = f.detail?.trim() || '';
      lines.push(`| ${tc(num)} | ${tc(title)} | ${tc(desc)} | ${tc(shortCite(f))} |`);
    }
    lines.push('');
  }

  // ---- Quality notes: table ----
  if (o.quality && (g['quality_note']?.length ?? 0) > 0) {
    lines.push('## Quality Notes');
    lines.push('| # | Note | Cite |');
    lines.push('|---|---|---|');
    g['quality_note'].forEach((f, i) => {
      const note = f.detail?.trim() || f.title?.trim() || 'Note';
      lines.push(`| ${i + 1} | ${tc(note)} | ${tc(shortCite(f))} |`);
    });
    lines.push('');
  }

  return lines.join('\n');
}

function digestBase(depo: Deposition): string {
  const w = witnessLast(depo.witness_name).toLowerCase();
  return `${w}-deposition-digest`;
}

export function downloadDigestDocx(
  depo: Deposition,
  findings: DepositionFinding[],
  opts?: Partial<DigestOptions>,
): void {
  const md = buildDigestMarkdown(depo, findings, opts);
  const blocks = markdownToBlocks(md);
  downloadBlob(exportFilename(digestBase(depo), 'docx'), buildDocx(blocks));
}

export function downloadDigestMarkdown(
  depo: Deposition,
  findings: DepositionFinding[],
  opts?: Partial<DigestOptions>,
): void {
  const md = buildDigestMarkdown(depo, findings, opts);
  downloadBlob(
    exportFilename(digestBase(depo), 'md'),
    new Blob([md], { type: 'text/markdown;charset=utf-8' }),
  );
}

export function printDigest(
  depo: Deposition,
  findings: DepositionFinding[],
  opts?: Partial<DigestOptions>,
): boolean {
  const md = buildDigestMarkdown(depo, findings, opts);
  const blocks = markdownToBlocks(md);
  const html = blocksToHtml(blocks);
  const meta = [
    depo.deposition_date ? `Deposed ${fmtDate(depo.deposition_date)}` : null,
    depo.individual_case_no,
    depo.mdl_number ? `MDL ${depo.mdl_number}` : null,
  ].filter(Boolean).join(' · ');
  return printDocument({
    title: `${depo.witness_name || 'Deposition'} — Digest`,
    metaLine: meta || undefined,
    bodyHtml: html,
  });
}

// ============================================================
// XLSX workbook — one sheet per section + a union sheet.
// ============================================================

function sizeColumns(headers: string[], rows: Cell[][]): { header: string; width: number }[] {
  return headers.map((h, i) => {
    const max = Math.max(h.length, ...rows.map((r) => String(r[i] ?? '').length));
    return { header: h, width: Math.min(60, Math.max(12, max + 2)) };
  });
}

function findingTypeLabel(t: DepositionFinding['finding_type']): string {
  switch (t) {
    case 'admission': return 'Admission';
    case 'chronology': return 'Chronology';
    case 'exhibit': return 'Exhibit';
    case 'quality_note': return 'Quality note';
    case 'exec_summary': return 'Executive summary';
    case 'witness_profile': return 'Witness profile';
    default: return t;
  }
}

function summarySheet(depo: Deposition, findings: DepositionFinding[]): Sheet {
  const counts: Record<string, number> = {};
  for (const f of findings) counts[f.finding_type] = (counts[f.finding_type] ?? 0) + 1;
  const rows: Cell[][] = [
    ['Witness', depo.witness_name ?? ''],
    ['Role', depo.witness_role ?? ''],
    ['Party alignment', depo.party_alignment ?? ''],
    ['Deposed', depo.deposition_date ? fmtDate(depo.deposition_date) : ''],
    ['MDL number', depo.mdl_number ?? ''],
    ['MDL case no.', depo.mdl_case_no ?? ''],
    ['Individual case no.', depo.individual_case_no ?? ''],
    ['Court', depo.court ?? ''],
    ['Judge', depo.judge ?? ''],
    ['Reporter', depo.reporter ?? ''],
    ['Pages', depo.page_count ?? ''],
    ['Source file', depo.filename ?? ''],
    ['Status', depo.status ?? ''],
    ['Updated', depo.updated_at ? fmtDate(depo.updated_at) : ''],
    ['', ''],
    ['Finding counts', ''],
    ['  Admissions', counts['admission'] ?? 0],
    ['  Chronology', counts['chronology'] ?? 0],
    ['  Exhibits', counts['exhibit'] ?? 0],
    ['  Quality notes', counts['quality_note'] ?? 0],
    ['  Executive summary', counts['exec_summary'] ?? 0],
    ['  Witness profile', counts['witness_profile'] ?? 0],
    ['  Total', findings.length],
  ];
  return { name: 'Summary', columns: [{ header: 'Field', width: 24 }, { header: 'Value', width: 60 }], rows };
}

function admissionsSheet(depo: Deposition, findings: DepositionFinding[]): Sheet {
  const headers = [
    'Witness', 'Topic', 'Stance', 'Detail', 'Quote', 'Cite',
    'Page start', 'Line start', 'Page end', 'Line end',
    'Tags', 'Confidence', 'Verify', 'Review',
  ];
  const rows: Cell[][] = findings
    .filter((f) => f.finding_type === 'admission')
    .map((f) => [
      depo.witness_name ?? '',
      f.title ?? '',
      stanceLabel(f.stance),
      f.detail ?? '',
      f.quote ?? '',
      shortCite(f),
      f.page_start ?? '',
      f.line_start ?? '',
      f.page_end ?? '',
      f.line_end ?? '',
      (f.issue_tags || []).join('; '),
      f.confidence ?? '',
      f.verify_status ?? '',
      f.review_status ?? '',
    ]);
  return { name: 'Admissions', columns: sizeColumns(headers, rows), rows };
}

function chronologySheet(depo: Deposition, findings: DepositionFinding[]): Sheet {
  const headers = ['Witness', 'Date', 'Event', 'Detail', 'Cite', 'Page start', 'Line start', 'Tags'];
  const rows: Cell[][] = findings
    .filter((f) => f.finding_type === 'chronology')
    .map((f) => [
      depo.witness_name ?? '',
      String(f.data?.date ?? f.data?.when ?? ''),
      f.title ?? '',
      f.detail ?? '',
      shortCite(f),
      f.page_start ?? '',
      f.line_start ?? '',
      (f.issue_tags || []).join('; '),
    ]);
  return { name: 'Chronology', columns: sizeColumns(headers, rows), rows };
}

function exhibitsSheet(depo: Deposition, findings: DepositionFinding[]): Sheet {
  const headers = ['Witness', 'Ex. #', 'Title', 'Description', 'Cite', 'Page start', 'Line start', 'Tags'];
  const rows: Cell[][] = findings
    .filter((f) => f.finding_type === 'exhibit')
    .map((f) => [
      depo.witness_name ?? '',
      String(f.data?.exhibit_number ?? ''),
      f.title ?? '',
      f.detail ?? '',
      shortCite(f),
      f.page_start ?? '',
      f.line_start ?? '',
      (f.issue_tags || []).join('; '),
    ]);
  return { name: 'Exhibits', columns: sizeColumns(headers, rows), rows };
}

function qualitySheet(depo: Deposition, findings: DepositionFinding[]): Sheet {
  const headers = ['Witness', 'Note', 'Detail', 'Cite', 'Page start', 'Line start'];
  const rows: Cell[][] = findings
    .filter((f) => f.finding_type === 'quality_note')
    .map((f) => [
      depo.witness_name ?? '',
      f.title ?? '',
      f.detail ?? '',
      shortCite(f),
      f.page_start ?? '',
      f.line_start ?? '',
    ]);
  return { name: 'Quality Notes', columns: sizeColumns(headers, rows), rows };
}

function allFindingsSheet(depo: Deposition, findings: DepositionFinding[]): Sheet {
  const headers = [
    'Witness', 'Type', 'Title', 'Detail', 'Quote', 'Cite', 'Stance',
    'Tags', 'Confidence', 'Verify', 'Review',
    'Page start', 'Line start', 'Page end', 'Line end',
  ];
  const rows: Cell[][] = findings.map((f) => [
    depo.witness_name ?? '',
    findingTypeLabel(f.finding_type),
    f.title ?? '',
    f.detail ?? '',
    f.quote ?? '',
    shortCite(f),
    stanceLabel(f.stance),
    (f.issue_tags || []).join('; '),
    f.confidence ?? '',
    f.verify_status ?? '',
    f.review_status ?? '',
    f.page_start ?? '',
    f.line_start ?? '',
    f.page_end ?? '',
    f.line_end ?? '',
  ]);
  return { name: 'All Findings', columns: sizeColumns(headers, rows), rows };
}

/** Full multi-sheet Excel workbook covering every finding type. */
export function downloadDigestXlsx(depo: Deposition, findings: DepositionFinding[]): void {
  const sheets: Sheet[] = [
    summarySheet(depo, findings),
    admissionsSheet(depo, findings),
    chronologySheet(depo, findings),
    exhibitsSheet(depo, findings),
    qualitySheet(depo, findings),
    allFindingsSheet(depo, findings),
  ];
  const base = `${witnessLast(depo.witness_name).toLowerCase()}-deposition-workbook`;
  downloadXlsx(base, sheets);
}

/** CSV of admissions with witness, cite, stance, tags. Kept for quick exports. */
export function downloadAdmissionsCsv(
  depo: Deposition,
  findings: DepositionFinding[],
): void {
  const admissions = findings.filter((f) => f.finding_type === 'admission');
  const rows = admissions.map((f) => [
    depo.witness_name || '',
    f.title || '',
    f.detail || '',
    f.quote || '',
    shortCite(f),
    stanceLabel(f.stance),
    (f.issue_tags || []).join('; '),
    f.confidence != null ? f.confidence : '',
    f.verify_status || '',
    f.review_status || '',
  ]);
  downloadCsv(
    `${witnessLast(depo.witness_name).toLowerCase()}-admissions`,
    ['Witness', 'Title', 'Detail', 'Quote', 'Cite', 'Stance', 'Tags', 'Confidence', 'Verify', 'Review'],
    rows,
  );
}
