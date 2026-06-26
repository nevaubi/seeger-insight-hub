// Pure export helpers for Tabular Review. No DOM, no React.
import * as XLSX from 'xlsx';
import type { ReviewColumn, ReviewFile, ReviewCell, ReviewCellCitation } from '@/lib/supabase';

export type CellWithCites = ReviewCell & { review_cell_citations: ReviewCellCitation[] };

function normalize(value: string | null, type: ReviewColumn['data_type']): string {
  if (value == null) return '';
  const v = value.trim();
  if (!v) return '';
  if (type === 'date') {
    const d = new Date(v);
    return isNaN(d.getTime()) ? v : d.toISOString().slice(0, 10);
  }
  if (type === 'number' || type === 'currency') return v.replace(/[^\d.\-]/g, '') || v;
  if (type === 'boolean') return /^(true|yes|y|1)$/i.test(v) ? 'Yes' : /^(false|no|n|0)$/i.test(v) ? 'No' : v;
  if (type === 'list') return v.replace(/\s*[,;|]\s*/g, '; ');
  return v;
}

function buildRows(
  files: ReviewFile[],
  columns: ReviewColumn[],
  cellMap: Map<string, CellWithCites>,
): { header: string[]; rows: (string | number)[][] } {
  const header = ['Document', ...columns.map((c) => c.name)];
  const rows = files.map((f) => {
    const row: (string | number)[] = [f.filename];
    for (const col of columns) {
      const cell = cellMap.get(`${f.id}:${col.id}`);
      if (!cell || cell.state === 'pending' || cell.state === 'running') row.push('');
      else if (cell.state === 'not_found') row.push('Not found');
      else if (cell.state === 'error') row.push('Error');
      else row.push(normalize(cell.value_text, col.data_type));
    }
    return row;
  });
  return { header, rows };
}

function buildCitations(
  files: ReviewFile[],
  columns: ReviewColumn[],
  cellMap: Map<string, CellWithCites>,
): { header: string[]; rows: (string | number)[][] } {
  const header = ['Document', 'Field', 'Page', 'Quote', 'Verified'];
  const rows: (string | number)[][] = [];
  const fileById = new Map(files.map((f) => [f.id, f]));
  const colById = new Map(columns.map((c) => [c.id, c]));
  for (const cell of cellMap.values()) {
    const f = fileById.get(cell.review_file_id);
    const c = colById.get(cell.review_column_id);
    if (!f || !c) continue;
    for (const cite of cell.review_cell_citations ?? []) {
      rows.push([f.filename, c.name, cite.page_number ?? '', cite.quote ?? '', cite.verified ? 'Yes' : 'No']);
    }
  }
  return { header, rows };
}

function csvEscape(v: string | number): string {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function toCsvString(header: string[], rows: (string | number)[][]): string {
  return [header, ...rows].map((r) => r.map(csvEscape).join(',')).join('\n');
}

export function toCsvDownloads(
  setName: string,
  files: ReviewFile[],
  columns: ReviewColumn[],
  cellMap: Map<string, CellWithCites>,
): { name: string; blob: Blob }[] {
  const { header, rows } = buildRows(files, columns, cellMap);
  const cites = buildCitations(files, columns, cellMap);
  const slug = setName.replace(/[^\w]+/g, '_').toLowerCase();
  return [
    { name: `${slug}.csv`, blob: new Blob([toCsvString(header, rows)], { type: 'text/csv;charset=utf-8' }) },
    {
      name: `${slug}-citations.csv`,
      blob: new Blob([toCsvString(cites.header, cites.rows)], { type: 'text/csv;charset=utf-8' }),
    },
  ];
}

export function toXlsxBlob(
  setName: string,
  files: ReviewFile[],
  columns: ReviewColumn[],
  cellMap: Map<string, CellWithCites>,
): Blob {
  const wb = XLSX.utils.book_new();

  const values = buildRows(files, columns, cellMap);
  const wsValues = XLSX.utils.aoa_to_sheet([values.header, ...values.rows]);
  // Column widths
  wsValues['!cols'] = values.header.map((h, i) => {
    const max = Math.max(h.length, ...values.rows.map((r) => String(r[i] ?? '').length));
    return { wch: Math.min(60, Math.max(12, max + 2)) };
  });
  // Freeze header
  wsValues['!freeze'] = { xSplit: 1, ySplit: 1 } as never;
  XLSX.utils.book_append_sheet(wb, wsValues, 'Values');

  const cites = buildCitations(files, columns, cellMap);
  const wsCites = XLSX.utils.aoa_to_sheet([cites.header, ...cites.rows]);
  wsCites['!cols'] = [{ wch: 28 }, { wch: 22 }, { wch: 6 }, { wch: 80 }, { wch: 10 }];
  XLSX.utils.book_append_sheet(wb, wsCites, 'Citations');

  const out = XLSX.write(wb, { bookType: 'xlsx', type: 'array' });
  return new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
}

export function toMarkdownTable(
  files: ReviewFile[],
  columns: ReviewColumn[],
  cellMap: Map<string, CellWithCites>,
): string {
  const { header, rows } = buildRows(files, columns, cellMap);
  const esc = (s: string | number) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ');
  const lines: string[] = [];
  lines.push(`| ${header.map(esc).join(' | ')} |`);
  lines.push(`| ${header.map(() => '---').join(' | ')} |`);
  for (const r of rows) lines.push(`| ${r.map(esc).join(' | ')} |`);
  return lines.join('\n');
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
