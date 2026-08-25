// Exports for attorney work product on a deposition: the designation chart
// (XLSX + DOCX exchange copy + CSV import) and the highlights/notes digest.

import type { Deposition } from '@/lib/supabase';
import {
  buildDocx,
  downloadBlob,
  downloadCsv,
  downloadXlsx,
  exportFilename,
  markdownToBlocks,
  type Cell,
  type Sheet,
} from '@/lib/file-export';
import { fmtDate } from '@/components/case-ui';
import {
  citeLabel,
  estimateMinutes,
  tagLabel,
  type DepoDesignation,
  type DepoHighlight,
  type DesignationKind,
} from '@/lib/depo-annotations';

function witnessLast(name: string | null | undefined): string {
  if (!name) return 'witness';
  return (name.split(/\s+/).slice(-1)[0] || name).toLowerCase();
}

function esc(s: string | null | undefined): string {
  return (s ?? '').replace(/\|/g, '\\|').replace(/\s*\n\s*/g, ' ').trim();
}

// ------------------------------------------------------------ designations

const DESIGNATION_HEADERS = [
  'Party',
  'Type',
  'Begin',
  'End',
  'Testimony',
  'Objection',
  'Basis',
  'Ruling',
];

function designationRows(designations: DepoDesignation[]): Cell[][] {
  return designations.map((d) => [
    d.party || '',
    d.kind === 'affirmative' ? 'Affirmative' : 'Counter',
    `${d.page_start}:${d.line_start}`,
    `${d.page_end}:${d.line_end}`,
    d.text,
    d.objection || '',
    d.basis || '',
    '',
  ]);
}

export function downloadDesignationsXlsx(
  depo: Deposition,
  designations: DepoDesignation[],
): void {
  const chart: Sheet = {
    name: 'Designations',
    columns: [
      { header: 'Party', width: 18 },
      { header: 'Type', width: 14 },
      { header: 'Begin', width: 10 },
      { header: 'End', width: 10 },
      { header: 'Testimony', width: 70 },
      { header: 'Objection', width: 18 },
      { header: 'Basis', width: 28 },
      { header: 'Ruling', width: 14 },
    ],
    rows: designationRows(designations),
  };
  const summary: Sheet = {
    name: 'Summary',
    columns: [
      { header: 'Field', width: 26 },
      { header: 'Value', width: 52 },
    ],
    rows: [
      ['Witness', depo.witness_name || ''],
      ['Deposition date', depo.deposition_date ? fmtDate(depo.deposition_date) : ''],
      ['Case', depo.individual_case_no || depo.mdl_case_no || ''],
      ['MDL', depo.mdl_number || ''],
      ['Affirmative designations', designations.filter((d) => d.kind === 'affirmative').length],
      ['Counter designations', designations.filter((d) => d.kind === 'counter').length],
      ['Estimated runtime (min)', Number(estimateMinutes(designations).toFixed(1))],
      ['Generated', new Date().toLocaleString()],
    ],
  };
  downloadXlsx(`${witnessLast(depo.witness_name)}-designations`, [summary, chart]);
}

export function downloadDesignationsCsv(
  depo: Deposition,
  designations: DepoDesignation[],
): void {
  downloadCsv(
    `${witnessLast(depo.witness_name)}-designations`,
    DESIGNATION_HEADERS,
    designationRows(designations),
  );
}

export function buildDesignationMarkdown(
  depo: Deposition,
  designations: DepoDesignation[],
): string {
  const out: string[] = [];
  out.push(`# Deposition Designations — ${depo.witness_name || 'Witness'}`);
  const meta = [
    depo.deposition_date ? `Deposed ${fmtDate(depo.deposition_date)}` : null,
    depo.individual_case_no,
    depo.mdl_number ? `MDL ${depo.mdl_number}` : null,
    `${designations.length} designated spans`,
    `≈ ${estimateMinutes(designations).toFixed(1)} min`,
  ].filter(Boolean);
  out.push('', meta.join(' · '), '');

  const section = (kind: DesignationKind, heading: string) => {
    const rows = designations.filter((d) => d.kind === kind);
    if (rows.length === 0) return;
    out.push(`## ${heading}`, '');
    out.push('| Party | Begin | End | Testimony | Objection | Basis | Ruling |');
    out.push('|---|---|---|---|---|---|---|');
    for (const d of rows) {
      out.push(
        `| ${esc(d.party)} | ${d.page_start}:${d.line_start} | ${d.page_end}:${d.line_end} | ${esc(
          d.text,
        )} | ${esc(d.objection)} | ${esc(d.basis)} |  |`,
      );
    }
    out.push('');
  };

  section('affirmative', 'Affirmative designations');
  section('counter', 'Counter designations');
  return out.join('\n');
}

export function downloadDesignationsDocx(
  depo: Deposition,
  designations: DepoDesignation[],
): void {
  const blocks = markdownToBlocks(buildDesignationMarkdown(depo, designations));
  downloadBlob(
    exportFilename(`${witnessLast(depo.witness_name)}-designations`, 'docx'),
    buildDocx(blocks),
  );
}

/** Parse an exchanged designation chart (CSV) back into designation rows. */
export function parseDesignationCsv(
  text: string,
): Omit<DepoDesignation, 'id' | 'deposition_id' | 'created_at'>[] {
  const rows = splitCsv(text);
  if (rows.length === 0) return [];
  const header = rows[0].map((h) => h.trim().toLowerCase());
  const idx = (name: string) => header.findIndex((h) => h === name);
  const iParty = idx('party');
  const iType = idx('type');
  const iBegin = idx('begin');
  const iEnd = idx('end');
  const iText = idx('testimony');
  const iObj = idx('objection');
  const iBasis = idx('basis');
  const out: Omit<DepoDesignation, 'id' | 'deposition_id' | 'created_at'>[] = [];
  for (const r of rows.slice(1)) {
    const begin = parsePl(r[iBegin] ?? '');
    const end = parsePl(r[iEnd] ?? '') ?? begin;
    if (!begin || !end) continue;
    const type = (r[iType] ?? '').toLowerCase();
    out.push({
      kind: type.startsWith('counter') ? 'counter' : 'affirmative',
      party: iParty >= 0 ? (r[iParty] ?? '') : '',
      objection: iObj >= 0 ? (r[iObj] ?? '') : '',
      basis: iBasis >= 0 ? (r[iBasis] ?? '') : '',
      text: iText >= 0 ? (r[iText] ?? '') : '',
      page_start: begin.page,
      line_start: begin.line,
      page_end: end.page,
      line_end: end.line,
    });
  }
  return out;
}

function parsePl(v: string): { page: number; line: number } | null {
  const m = /(\d+)\s*[:.\-]\s*(\d+)/.exec(v.trim());
  if (!m) return null;
  return { page: Number(m[1]), line: Number(m[2]) };
}

function splitCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i++;
        } else quoted = false;
      } else cell += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(cell);
      cell = '';
    } else if (c === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
    } else if (c !== '\r') cell += c;
  }
  if (cell || row.length) {
    row.push(cell);
    rows.push(row);
  }
  return rows.filter((r) => r.some((x) => x.trim()));
}

// ------------------------------------------------------------- notes

export function buildNotesMarkdown(depo: Deposition, highlights: DepoHighlight[]): string {
  const out: string[] = [];
  out.push(`# Attorney Notes — ${depo.witness_name || 'Witness'}`, '');
  out.push('| # | Issue | Passage | Note | Cite |');
  out.push('|---|---|---|---|---|');
  highlights.forEach((h, i) => {
    out.push(
      `| ${i + 1} | ${esc(tagLabel(h.tag))} | \u201C${esc(h.text)}\u201D | ${esc(h.note)} | ${citeLabel(h)} |`,
    );
  });
  out.push('');
  return out.join('\n');
}

export function downloadNotesDocx(depo: Deposition, highlights: DepoHighlight[]): void {
  const blocks = markdownToBlocks(buildNotesMarkdown(depo, highlights));
  downloadBlob(
    exportFilename(`${witnessLast(depo.witness_name)}-deposition-notes`, 'docx'),
    buildDocx(blocks),
  );
}
