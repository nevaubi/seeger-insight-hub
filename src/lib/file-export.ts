// Client-side file generation — Excel (.xlsx), CSV, Word (.docx), and print-to-PDF.
// Zero external dependencies: Office files are assembled as OOXML and packed with the
// in-house ZIP writer (./zip). All functions are browser-only and safe to call from event
// handlers (never during SSR).

import { zipSync, utf8, xmlEscape, type ZipEntry } from './zip';

// ---------- generic download ----------

export function downloadBlob(filename: string, blob: Blob): void {
  if (typeof window === 'undefined') return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

const stamp = () => new Date().toISOString().slice(0, 10);
const slug = (s: string) =>
  (s || 'export').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) ||
  'export';

export function exportFilename(base: string, ext: string): string {
  return `${slug(base)}-${stamp()}.${ext}`;
}

// ---------- CSV ----------

export type Cell = string | number | null | undefined;

function csvField(v: Cell): string {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function buildCsv(headers: string[], rows: Cell[][]): string {
  const lines = [headers.map(csvField).join(',')];
  for (const r of rows) lines.push(r.map(csvField).join(','));
  // BOM so Excel reads UTF-8 correctly
  return '﻿' + lines.join('\r\n');
}

export function downloadCsv(base: string, headers: string[], rows: Cell[][]): void {
  downloadBlob(exportFilename(base, 'csv'), new Blob([buildCsv(headers, rows)], { type: 'text/csv;charset=utf-8' }));
}

// ---------- XLSX ----------

export type Sheet = {
  name: string;
  columns: { header: string; width?: number }[];
  rows: Cell[][];
};

function colRef(i: number): string {
  let s = '';
  let n = i + 1;
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

function cellXml(ref: string, value: Cell, styleId?: number): string {
  if (value == null || value === '') return '';
  const s = styleId ? ` s="${styleId}"` : '';
  if (typeof value === 'number' && Number.isFinite(value)) {
    return `<c r="${ref}"${s}><v>${value}</v></c>`;
  }
  return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${xmlEscape(String(value))}</t></is></c>`;
}

function sheetXml(sheet: Sheet): string {
  const colCount = sheet.columns.length;
  const cols = sheet.columns
    .map((c, i) => `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 22}" customWidth="1"/>`)
    .join('');
  const headerCells = sheet.columns.map((c, i) => cellXml(`${colRef(i)}1`, c.header, 1)).join('');
  const dataRows = sheet.rows
    .map((row, r) => {
      const rn = r + 2;
      const cells = [];
      for (let i = 0; i < colCount; i++) cells.push(cellXml(`${colRef(i)}${rn}`, row[i]));
      return `<row r="${rn}">${cells.join('')}</row>`;
    })
    .join('');
  return (
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
    `<cols>${cols}</cols>` +
    `<sheetData><row r="1">${headerCells}</row>${dataRows}</sheetData>` +
    `</worksheet>`
  );
}

const XLSX_STYLES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">` +
  `<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font></fonts>` +
  `<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>` +
  `<fill><patternFill patternType="solid"><fgColor rgb="FF1F2A44"/><bgColor indexed="64"/></patternFill></fill></fills>` +
  `<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>` +
  `<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>` +
  `<cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>` +
  `<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"><alignment vertical="center"/></xf></cellXfs>` +
  `<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>` +
  `</styleSheet>`;

export function buildXlsx(sheets: Sheet[]): Blob {
  const sh = sheets.length ? sheets : [{ name: 'Sheet1', columns: [{ header: '' }], rows: [] }];
  const sheetOverrides = sh
    .map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`)
    .join('');
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>` +
    `<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>` +
    sheetOverrides +
    `</Types>`;
  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>` +
    `</Relationships>`;
  const sheetsXml = sh
    .map((s, i) => `<sheet name="${xmlEscape(s.name.slice(0, 31) || `Sheet${i + 1}`)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`)
    .join('');
  const workbook =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">` +
    `<sheets>${sheetsXml}</sheets></workbook>`;
  const stylesRelId = sh.length + 1;
  const workbookRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    sh.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('') +
    `<Relationship Id="rId${stylesRelId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;

  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: utf8(contentTypes) },
    { name: '_rels/.rels', data: utf8(rootRels) },
    { name: 'xl/workbook.xml', data: utf8(workbook) },
    { name: 'xl/_rels/workbook.xml.rels', data: utf8(workbookRels) },
    { name: 'xl/styles.xml', data: utf8(XLSX_STYLES) },
    ...sh.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: utf8(sheetXml(s)) })),
  ];
  return new Blob([zipSync(entries)], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  });
}

export function downloadXlsx(base: string, sheets: Sheet[]): void {
  downloadBlob(exportFilename(base, 'xlsx'), buildXlsx(sheets));
}

// ---------- document model (shared by DOCX + print) ----------

export type Run = { text: string; bold?: boolean; italic?: boolean; smallCaps?: boolean };
export type TableAlign = 'left' | 'center' | 'right' | null;
export type DocBlock =
  | { type: 'heading'; level: 1 | 2 | 3; runs: Run[] }
  | { type: 'paragraph'; runs: Run[] }
  | { type: 'bullet'; runs: Run[] }
  | { type: 'ordered'; index: number; runs: Run[] }
  | { type: 'blockquote'; runs: Run[] }
  | { type: 'rule' }
  | { type: 'spacer' }
  | { type: 'table'; header: Run[][]; rows: Run[][][]; align: TableAlign[] };

// Inline tokenizer: **bold**, *italic* / _italic_, `code` (rendered as plain).
function parseInline(text: string): Run[] {
  const runs: Run[] = [];
  const re = /(\*\*([^*]+)\*\*|__([^_]+)__|\*([^*]+)\*|_([^_]+)_|`([^`]+)`)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) runs.push({ text: text.slice(last, m.index) });
    if (m[2] != null || m[3] != null) runs.push({ text: m[2] ?? m[3] ?? '', bold: true });
    else if (m[4] != null || m[5] != null) runs.push({ text: m[4] ?? m[5] ?? '', italic: true });
    else if (m[6] != null) runs.push({ text: m[6] });
    last = m.index + m[0].length;
  }
  if (last < text.length) runs.push({ text: text.slice(last) });
  return runs.length ? runs : [{ text }];
}

// ---------- GFM pipe-table helpers ----------

const TABLE_SEP_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const TABLE_ROW_RE = /\|/;

function splitTableCells(line: string): string[] {
  // Strip a single leading/trailing pipe (with optional whitespace), then split on
  // unescaped `|`. Backslash-escaped pipes (`\|`) are unescaped into literal pipes.
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|') && !s.endsWith('\\|')) s = s.slice(0, -1);
  const out: string[] = [];
  let buf = '';
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '\\' && s[i + 1] === '|') {
      buf += '|';
      i++;
      continue;
    }
    if (ch === '|') {
      out.push(buf.trim());
      buf = '';
    } else {
      buf += ch;
    }
  }
  out.push(buf.trim());
  return out;
}

function parseTableAlign(sepLine: string, colCount: number): TableAlign[] {
  const parts = splitTableCells(sepLine);
  const out: TableAlign[] = [];
  for (let i = 0; i < colCount; i++) {
    const p = (parts[i] ?? '').trim();
    const left = p.startsWith(':');
    const right = p.endsWith(':');
    if (left && right) out.push('center');
    else if (right) out.push('right');
    else if (left) out.push('left');
    else out.push(null);
  }
  return out;
}

function normalizeRow(cells: string[], colCount: number): Run[][] {
  const out: Run[][] = [];
  for (let i = 0; i < colCount; i++) out.push(parseInline(cells[i] ?? ''));
  return out;
}

/** Lightweight Markdown → DocBlock parser (headings, lists, rules, paragraphs, GFM tables, inline bold/italic). */
export function markdownToBlocks(md: string): DocBlock[] {
  const out: DocBlock[] = [];
  const lines = (md ?? '').replace(/\r\n/g, '\n').split('\n');
  let orderedIdx = 0;
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      orderedIdx = 0;
      out.push({ type: 'spacer' });
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      out.push({ type: 'rule' });
      continue;
    }
    // GFM pipe table: current line has a pipe AND the next line is a separator row.
    const nextLine = lines[li + 1] ?? '';
    if (TABLE_ROW_RE.test(line) && TABLE_SEP_RE.test(nextLine)) {
      const headerCells = splitTableCells(line);
      const colCount = headerCells.length;
      const align = parseTableAlign(nextLine, colCount);
      const header = normalizeRow(headerCells, colCount);
      const rows: Run[][][] = [];
      let j = li + 2;
      while (j < lines.length) {
        const rl = lines[j].replace(/\s+$/, '');
        if (!rl.trim() || !TABLE_ROW_RE.test(rl)) break;
        if (TABLE_SEP_RE.test(rl)) break;
        rows.push(normalizeRow(splitTableCells(rl), colCount));
        j++;
      }
      out.push({ type: 'table', header, rows, align });
      li = j - 1;
      orderedIdx = 0;
      continue;
    }
    const h = /^(#{1,3})\s+(.*)$/.exec(line);
    if (h) {
      orderedIdx = 0;
      out.push({ type: 'heading', level: h[1].length as 1 | 2 | 3, runs: parseInline(h[2]) });
      continue;
    }
    const ol = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (ol) {
      orderedIdx += 1;
      out.push({ type: 'ordered', index: orderedIdx, runs: parseInline(ol[1]) });
      continue;
    }
    const ul = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (ul) {
      orderedIdx = 0;
      out.push({ type: 'bullet', runs: parseInline(ul[1]) });
      continue;
    }
    const bq = /^\s*>\s?(.*)$/.exec(line);
    if (bq) {
      orderedIdx = 0;
      out.push({ type: 'blockquote', runs: parseInline(bq[1]) });
      continue;
    }
    orderedIdx = 0;
    out.push({ type: 'paragraph', runs: parseInline(line) });
  }
  // collapse leading/trailing/duplicate spacers
  const compact: DocBlock[] = [];
  for (const b of out) {
    if (b.type === 'spacer' && (compact.length === 0 || compact[compact.length - 1].type === 'spacer')) continue;
    compact.push(b);
  }
  while (compact.length && compact[compact.length - 1].type === 'spacer') compact.pop();
  return compact;
}

// ---------- DOCX ----------

function runXml(r: Run): string {
  const props =
    `${r.bold ? '<w:b/>' : ''}${r.italic ? '<w:i/>' : ''}${r.smallCaps ? '<w:smallCaps/>' : ''}`;
  const rPr = props ? `<w:rPr>${props}</w:rPr>` : '';
  return `<w:r>${rPr}<w:t xml:space="preserve">${xmlEscape(r.text)}</w:t></w:r>`;
}

function headingRunXml(r: Run, half: number): string {
  return `<w:r><w:rPr><w:b/>${r.italic ? '<w:i/>' : ''}<w:sz w:val="${half}"/><w:szCs w:val="${half}"/></w:rPr><w:t xml:space="preserve">${xmlEscape(r.text)}</w:t></w:r>`;
}

function blockToDocxXml(b: DocBlock): string {
  switch (b.type) {
    case 'spacer':
      return `<w:p/>`;
    case 'rule':
      return `<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="C9C2B4"/></w:pBdr></w:pPr></w:p>`;
    case 'heading': {
      const half = b.level === 1 ? 32 : b.level === 2 ? 28 : 24;
      const before = b.level === 1 ? 360 : 240;
      return `<w:p><w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="120"/></w:pPr>${b.runs.map((r) => headingRunXml(r, half)).join('')}</w:p>`;
    }
    case 'bullet':
      return `<w:p><w:pPr><w:spacing w:after="60"/><w:ind w:left="360" w:hanging="240"/></w:pPr>${runXml({ text: '• ' })}${b.runs.map(runXml).join('')}</w:p>`;
    case 'ordered':
      return `<w:p><w:pPr><w:spacing w:after="60"/><w:ind w:left="360" w:hanging="240"/></w:pPr>${runXml({ text: `${b.index}. ` })}${b.runs.map(runXml).join('')}</w:p>`;
    case 'blockquote':
      return `<w:p><w:pPr><w:spacing w:before="80" w:after="120" w:line="240" w:lineRule="auto"/><w:ind w:left="720" w:right="720"/></w:pPr>${b.runs.map((r) => runXml({ ...r, italic: true })).join('')}</w:p>`;
    case 'paragraph':
      return `<w:p><w:pPr><w:spacing w:after="160"/><w:jc w:val="both"/></w:pPr>${b.runs.map(runXml).join('')}</w:p>`;
    case 'table':
      return tableXml(b);
  }
}

function alignToJc(a: TableAlign): string {
  if (a === 'center') return '<w:jc w:val="center"/>';
  if (a === 'right') return '<w:jc w:val="right"/>';
  return '';
}

function tableCellXml(runs: Run[], width: number, align: TableAlign, isHeader: boolean): string {
  const shd = isHeader ? `<w:shd w:val="clear" w:color="auto" w:fill="F4EFE3"/>` : '';
  const tcPr = `<w:tcPr><w:tcW w:type="dxa" w:w="${width}"/>${shd}</w:tcPr>`;
  const pPr = `<w:pPr><w:spacing w:before="0" w:after="0"/>${alignToJc(align)}</w:pPr>`;
  const cellRuns = (runs.length ? runs : [{ text: '' }])
    .map((r) => (isHeader ? { ...r, bold: true } : r))
    .map(runXml)
    .join('');
  return `<w:tc>${tcPr}<w:p>${pPr}${cellRuns}</w:p></w:tc>`;
}

function tableXml(b: { header: Run[][]; rows: Run[][][]; align: TableAlign[] }): string {
  const colCount = Math.max(1, b.header.length);
  const total = 9360; // content width in DXA (US Letter, 1" margins)
  const base = Math.floor(total / colCount);
  const widths: number[] = [];
  for (let i = 0; i < colCount; i++) widths.push(i === colCount - 1 ? total - base * (colCount - 1) : base);
  const bd = (side: string) => `<w:${side} w:val="single" w:sz="4" w:space="0" w:color="C9C2B4"/>`;
  const tblPr =
    `<w:tblPr>` +
    `<w:tblW w:type="dxa" w:w="${total}"/>` +
    `<w:tblLayout w:type="fixed"/>` +
    `<w:tblBorders>${bd('top')}${bd('left')}${bd('bottom')}${bd('right')}${bd('insideH')}${bd('insideV')}</w:tblBorders>` +
    `<w:tblCellMar><w:top w:w="80" w:type="dxa"/><w:left w:w="120" w:type="dxa"/><w:bottom w:w="80" w:type="dxa"/><w:right w:w="120" w:type="dxa"/></w:tblCellMar>` +
    `</w:tblPr>`;
  const grid = `<w:tblGrid>${widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('')}</w:tblGrid>`;
  const headerCells = b.header.map((cell, i) => tableCellXml(cell, widths[i], b.align[i] ?? null, true)).join('');
  const headerRow = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${headerCells}</w:tr>`;
  const bodyRows = b.rows
    .map((row) => {
      const cells: string[] = [];
      for (let i = 0; i < colCount; i++) cells.push(tableCellXml(row[i] ?? [], widths[i], b.align[i] ?? null, false));
      return `<w:tr>${cells.join('')}</w:tr>`;
    })
    .join('');
  // Trailing empty paragraph keeps following blocks from being absorbed into the table.
  return `<w:tbl>${tblPr}${grid}${headerRow}${bodyRows}</w:tbl><w:p><w:pPr><w:spacing w:after="120"/></w:pPr></w:p>`;
}

const DOCX_STYLES =
  `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
  `<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">` +
  `<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Times New Roman" w:hAnsi="Times New Roman" w:cs="Times New Roman"/><w:sz w:val="24"/><w:szCs w:val="24"/></w:rPr></w:rPrDefault>` +
  `<w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>` +
  `</w:styles>`;

export function buildDocx(blocks: DocBlock[]): Blob {
  const body =
    blocks.map(blockToDocxXml).join('') +
    `<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>`;
  const document =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`;
  const contentTypes =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
    `<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>` +
    `<Default Extension="xml" ContentType="application/xml"/>` +
    `<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>` +
    `<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>` +
    `</Types>`;
  const rootRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>` +
    `</Relationships>`;
  const docRels =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">` +
    `<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>` +
    `</Relationships>`;
  const entries: ZipEntry[] = [
    { name: '[Content_Types].xml', data: utf8(contentTypes) },
    { name: '_rels/.rels', data: utf8(rootRels) },
    { name: 'word/document.xml', data: utf8(document) },
    { name: 'word/_rels/document.xml.rels', data: utf8(docRels) },
    { name: 'word/styles.xml', data: utf8(DOCX_STYLES) },
  ];
  return new Blob([zipSync(entries)], {
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  });
}

export function downloadDocx(base: string, blocks: DocBlock[]): void {
  downloadBlob(exportFilename(base, 'docx'), buildDocx(blocks));
}

// ---------- print-to-PDF ----------

function runHtml(r: Run): string {
  let t = xmlEscape(r.text);
  if (r.bold) t = `<strong>${t}</strong>`;
  if (r.italic) t = `<em>${t}</em>`;
  return t;
}

export function blocksToHtml(blocks: DocBlock[]): string {
  const out: string[] = [];
  let listBuf: string[] = [];
  let listTag: 'ul' | 'ol' | null = null;
  const flush = () => {
    if (listTag) {
      out.push(`<${listTag}>${listBuf.join('')}</${listTag}>`);
      listBuf = [];
      listTag = null;
    }
  };
  for (const b of blocks) {
    if (b.type === 'bullet' || b.type === 'ordered') {
      const want = b.type === 'bullet' ? 'ul' : 'ol';
      if (listTag !== want) flush();
      listTag = want;
      listBuf.push(`<li>${b.runs.map(runHtml).join('')}</li>`);
      continue;
    }
    flush();
    if (b.type === 'heading') out.push(`<h${b.level}>${b.runs.map(runHtml).join('')}</h${b.level}>`);
    else if (b.type === 'rule') out.push('<hr/>');
    else if (b.type === 'spacer') out.push('');
    else if (b.type === 'table') {
      const styleFor = (a: TableAlign) => (a ? ` style="text-align:${a}"` : '');
      const thead = `<thead><tr>${b.header
        .map((cell, i) => `<th${styleFor(b.align[i] ?? null)}>${cell.map(runHtml).join('')}</th>`)
        .join('')}</tr></thead>`;
      const tbody = `<tbody>${b.rows
        .map(
          (row) =>
            `<tr>${b.header
              .map((_h, i) => `<td${styleFor(b.align[i] ?? null)}>${(row[i] ?? []).map(runHtml).join('')}</td>`)
              .join('')}</tr>`,
        )
        .join('')}</tbody>`;
      out.push(`<table class="doc-table">${thead}${tbody}</table>`);
    } else if (b.type === 'blockquote') {
      out.push(`<blockquote>${b.runs.map(runHtml).join('')}</blockquote>`);
    } else out.push(`<p>${b.runs.map(runHtml).join('')}</p>`);
  }
  flush();
  return out.join('\n');
}

const PRINT_CSS = `
  @page { size: letter; margin: 1in; }
  * { box-sizing: border-box; }
  body { font-family: 'Source Serif 4', Georgia, 'Times New Roman', serif; color: #1a1a1a; font-size: 12pt; line-height: 1.55; max-width: 7in; margin: 0 auto; padding: 0.5in 0; }
  .doc-meta { font-family: Inter, system-ui, sans-serif; color: #555; font-size: 9pt; text-transform: uppercase; letter-spacing: 0.08em; border-bottom: 1px solid #ddd; padding-bottom: 8px; margin-bottom: 20px; }
  .doc-meta .matter { font-weight: 600; color: #1f2a44; }
  h1 { font-size: 18pt; margin: 0 0 6px; line-height: 1.2; }
  h2 { font-size: 14pt; margin: 22px 0 6px; }
  h3 { font-size: 12pt; margin: 16px 0 4px; }
  p { margin: 0 0 10px; text-align: justify; }
  ul, ol { margin: 0 0 10px; padding-left: 22px; }
  li { margin: 0 0 4px; }
  hr { border: none; border-top: 1px solid #c9c2b4; margin: 16px 0; }
  blockquote { margin: 12px 0 12px 0.5in; padding: 0 0.4in; font-style: italic; color: #2a2a2a; border-left: 2px solid #c9c2b4; }
  table.doc-table { width: 100%; border-collapse: collapse; margin: 4px 0 14px; font-size: 10.5pt; page-break-inside: auto; }
  .doc-table th, .doc-table td { border: 1px solid #c9c2b4; padding: 6px 9px; vertical-align: top; text-align: left; }
  .doc-table thead th { background: #f4efe3; font-family: Inter, sans-serif; font-size: 9.5pt; text-transform: uppercase; letter-spacing: 0.04em; color: #1f2a44; }
  .doc-table tr { page-break-inside: avoid; }
  .doc-table thead { display: table-header-group; }
  .sources { margin-top: 28px; padding-top: 12px; border-top: 1px solid #ddd; font-size: 10.5pt; }
  .sources h2 { font-size: 11pt; text-transform: uppercase; letter-spacing: 0.08em; font-family: Inter, sans-serif; }
  .cite { font-family: Inter, sans-serif; font-size: 8pt; vertical-align: super; color: #1f2a44; font-weight: 600; }
`;

/** Open a clean print window and trigger the browser's print / "Save as PDF" dialog. */
export function printDocument(opts: { title: string; metaLine?: string; bodyHtml: string }): boolean {
  if (typeof window === 'undefined') return false;
  const w = window.open('', '_blank', 'width=900,height=1100');
  if (!w) return false; // popup blocked
  const meta = opts.metaLine ? `<div class="doc-meta">${opts.metaLine}</div>` : '';
  w.document.open();
  w.document.write(
    `<!doctype html><html><head><meta charset="utf-8"/><title>${xmlEscape(opts.title)}</title>` +
      `<link rel="preconnect" href="https://fonts.googleapis.com"/>` +
      `<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Source+Serif+4:ital,wght@0,400;0,600;1,400&family=Inter:wght@400;600&display=swap"/>` +
      `<style>${PRINT_CSS}</style></head><body>${meta}${opts.bodyHtml}</body></html>`,
  );
  w.document.close();
  w.focus();
  const fire = () => {
    try {
      w.print();
    } catch {
      /* ignore */
    }
  };
  // print after fonts/layout settle; onload may already have passed for written docs
  w.onload = fire;
  setTimeout(fire, 600);
  return true;
}
