// Client-side .docx import — zero external dependencies, mirroring the zero-dep ethos of
// file-export.ts / zip.ts. A .docx is an ordinary ZIP of OOXML parts; modern browsers ship
// DecompressionStream('deflate-raw'), which is all that's needed to read one. The importer
// extracts word/document.xml (+ footnotes and hyperlink rels when present) and converts it
// to the workspace's Markdown dialect: headings, bold/italic, lists, GFM tables, footnotes.
//
// Fidelity notes (deliberate v1 scope): numbering restarts, images, headers/footers,
// tracked changes, and content controls are not preserved — imports flatten to clean
// Markdown for the memo-mode editor. Word-native round-trip fidelity is the SuperDoc
// Word-mode path; this importer is the fast "open the .docx opposing counsel sent" lane.

// ---------- minimal ZIP reader (stored + deflate) ----------

type ZipEntryMeta = {
  name: string;
  method: number; // 0 = stored, 8 = deflate
  compressedSize: number;
  localHeaderOffset: number;
};

function u16(b: DataView, o: number): number {
  return b.getUint16(o, true);
}
function u32(b: DataView, o: number): number {
  return b.getUint32(o, true);
}

function findEocd(view: DataView): number {
  // EOCD signature 0x06054b50, scanned backwards over the max comment length
  const min = Math.max(0, view.byteLength - 65557);
  for (let i = view.byteLength - 22; i >= min; i--) {
    if (u32(view, i) === 0x06054b50) return i;
  }
  throw new Error('Not a ZIP archive (no end-of-central-directory record)');
}

function readCentralDirectory(buf: ArrayBuffer): ZipEntryMeta[] {
  const view = new DataView(buf);
  const eocd = findEocd(view);
  const count = u16(view, eocd + 10);
  let off = u32(view, eocd + 16);
  if (off === 0xffffffff) throw new Error('ZIP64 archives are not supported');
  const dec = new TextDecoder();
  const entries: ZipEntryMeta[] = [];
  for (let i = 0; i < count; i++) {
    if (u32(view, off) !== 0x02014b50) break;
    const method = u16(view, off + 10);
    const compressedSize = u32(view, off + 20);
    const nameLen = u16(view, off + 28);
    const extraLen = u16(view, off + 30);
    const commentLen = u16(view, off + 32);
    const localHeaderOffset = u32(view, off + 42);
    const name = dec.decode(new Uint8Array(buf, off + 46, nameLen));
    entries.push({ name, method, compressedSize, localHeaderOffset });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function extractEntry(buf: ArrayBuffer, e: ZipEntryMeta): Promise<Uint8Array> {
  const view = new DataView(buf);
  const lho = e.localHeaderOffset;
  if (u32(view, lho) !== 0x04034b50) throw new Error(`Corrupt ZIP local header for ${e.name}`);
  const nameLen = u16(view, lho + 26);
  const extraLen = u16(view, lho + 28);
  const dataStart = lho + 30 + nameLen + extraLen;
  const raw = new Uint8Array(buf, dataStart, e.compressedSize);
  if (e.method === 0) return new Uint8Array(raw); // stored
  if (e.method !== 8) throw new Error(`Unsupported ZIP compression method ${e.method}`);
  const ds = new DecompressionStream('deflate-raw');
  const stream = new Blob([raw as BlobPart]).stream().pipeThrough(ds);
  const out = new Uint8Array(await new Response(stream).arrayBuffer());
  return out;
}

async function readZipText(buf: ArrayBuffer, entries: ZipEntryMeta[], name: string): Promise<string | null> {
  const e = entries.find((x) => x.name === name);
  if (!e) return null;
  const bytes = await extractEntry(buf, e);
  return new TextDecoder().decode(bytes);
}

// ---------- OOXML → Markdown ----------

const W_NS = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';

function parseXml(xml: string): Document {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  if (doc.getElementsByTagName('parsererror').length) throw new Error('Malformed OOXML part');
  return doc;
}

function localChildren(el: Element, local: string): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < el.children.length; i++) {
    const c = el.children[i];
    if (c.localName === local) out.push(c);
  }
  return out;
}

function firstLocal(el: Element, local: string): Element | null {
  for (let i = 0; i < el.children.length; i++) {
    if (el.children[i].localName === local) return el.children[i];
  }
  return null;
}

function wVal(el: Element | null): string | null {
  return el?.getAttributeNS(W_NS, 'val') ?? el?.getAttribute('w:val') ?? null;
}

type RunPiece = { text: string; bold: boolean; italic: boolean };

function readRuns(p: Element, ctx: ImportCtx): RunPiece[] {
  const pieces: RunPiece[] = [];
  const walk = (node: Element, inheritBold: boolean, inheritItalic: boolean) => {
    for (let i = 0; i < node.children.length; i++) {
      const c = node.children[i];
      switch (c.localName) {
        case 'r': {
          const rPr = firstLocal(c, 'rPr');
          const bold = inheritBold || (!!rPr && !!firstLocal(rPr, 'b') && wVal(firstLocal(rPr, 'b')) !== 'false' && wVal(firstLocal(rPr, 'b')) !== '0');
          const italic = inheritItalic || (!!rPr && !!firstLocal(rPr, 'i') && wVal(firstLocal(rPr, 'i')) !== 'false' && wVal(firstLocal(rPr, 'i')) !== '0');
          for (let j = 0; j < c.children.length; j++) {
            const rc = c.children[j];
            if (rc.localName === 't') pieces.push({ text: rc.textContent ?? '', bold, italic });
            else if (rc.localName === 'br' || rc.localName === 'cr') pieces.push({ text: '\n', bold: false, italic: false });
            else if (rc.localName === 'tab') pieces.push({ text: '\t', bold: false, italic: false });
            else if (rc.localName === 'footnoteReference') {
              const id = rc.getAttributeNS(W_NS, 'id') ?? rc.getAttribute('w:id');
              if (id) {
                ctx.footnoteRefs.add(id);
                pieces.push({ text: `[^${id}]`, bold: false, italic: false });
              }
            }
          }
          break;
        }
        case 'hyperlink': {
          const rid = c.getAttributeNS(R_NS, 'id') ?? c.getAttribute('r:id');
          const target = rid ? ctx.rels.get(rid) : undefined;
          const text = piecesToMarkdown(readRuns(c, ctx)).trim();
          if (text) {
            pieces.push({
              text: target ? `[${text}](${target})` : text,
              bold: false,
              italic: false,
            });
          }
          break;
        }
        case 'smartTag':
        case 'ins': // accept tracked insertions as normal text
          walk(c, inheritBold, inheritItalic);
          break;
        // w:del (tracked deletions) intentionally skipped
        default:
          break;
      }
    }
  };
  walk(p, false, false);
  return pieces;
}

function escapeMdText(t: string): string {
  // escape characters that would change Markdown structure mid-line
  return t.replace(/([*_`])/g, '\\$1');
}

function piecesToMarkdown(pieces: RunPiece[]): string {
  // merge adjacent same-format pieces so we don't emit ****
  const merged: RunPiece[] = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last && last.bold === p.bold && last.italic === p.italic) last.text += p.text;
    else merged.push({ ...p });
  }
  return merged
    .map((p) => {
      if (!p.text) return '';
      if (p.text === '\n') return '\n';
      const core = escapeMdText(p.text);
      const t = core.trim() ? core : p.text; // don't wrap pure whitespace
      if (!core.trim()) return t;
      if (p.bold && p.italic) return `***${t}***`;
      if (p.bold) return `**${t}**`;
      if (p.italic) return `*${t}*`;
      return t;
    })
    .join('');
}

type ImportCtx = {
  rels: Map<string, string>;
  footnoteRefs: Set<string>;
  numFormats: Map<string, 'bullet' | 'ordered'>;
};

function headingLevel(p: Element): 1 | 2 | 3 | null {
  const pPr = firstLocal(p, 'pPr');
  const style = wVal(firstLocal(pPr ?? p, 'pStyle'));
  if (style) {
    const m = /heading\s*([1-6])/i.exec(style);
    if (m) {
      const n = Number(m[1]);
      return (n <= 1 ? 1 : n === 2 ? 2 : 3) as 1 | 2 | 3;
    }
    if (/^Title$/i.test(style)) return 1;
  }
  // heuristic for direct-formatted headings (no pStyle): a short paragraph whose runs
  // are ALL bold with an enlarged size reads as a heading; level from the size
  const runs = localChildren(p, 'r');
  if (!runs.length) return null;
  let maxHalf = 0;
  for (const r of runs) {
    const rPr = firstLocal(r, 'rPr');
    const t = firstLocal(r, 't');
    if (!t || !(t.textContent ?? '').trim()) continue;
    const bold = !!rPr && !!firstLocal(rPr, 'b') && wVal(firstLocal(rPr, 'b')) !== 'false' && wVal(firstLocal(rPr, 'b')) !== '0';
    if (!bold) return null;
    const sz = Number(wVal(firstLocal(rPr!, 'sz')) ?? '0');
    maxHalf = Math.max(maxHalf, sz);
  }
  const text = (p.textContent ?? '').trim();
  if (!text || text.length > 120) return null;
  if (maxHalf >= 32) return 1;
  if (maxHalf >= 28) return 2;
  if (maxHalf >= 26) return 3;
  return null;
}

function listInfo(p: Element, ctx: ImportCtx): { kind: 'bullet' | 'ordered'; level: number } | null {
  const pPr = firstLocal(p, 'pPr');
  if (!pPr) return null;
  const numPr = firstLocal(pPr, 'numPr');
  if (!numPr) return null;
  const ilvl = Number(wVal(firstLocal(numPr, 'ilvl')) ?? '0');
  const numId = wVal(firstLocal(numPr, 'numId'));
  const kind = (numId && ctx.numFormats.get(numId)) || 'bullet';
  return { kind, level: Number.isFinite(ilvl) ? Math.min(ilvl, 4) : 0 };
}

function paragraphToMarkdown(p: Element, ctx: ImportCtx, orderedCounters: Map<string, number>): string {
  const text = piecesToMarkdown(readRuns(p, ctx)).replace(/\n/g, '\n');
  const h = headingLevel(p);
  if (h) return `${'#'.repeat(h)} ${text.trim().replace(/^\*\*(.*)\*\*$/s, '$1')}`;
  const li = listInfo(p, ctx);
  if (li) {
    const indent = '  '.repeat(li.level);
    if (li.kind === 'ordered') {
      const key = `${li.level}`;
      const n = (orderedCounters.get(key) ?? 0) + 1;
      orderedCounters.set(key, n);
      return `${indent}${n}. ${text.trim()}`;
    }
    return `${indent}- ${text.trim()}`;
  }
  // literal bullet glyphs (documents written with "• " text instead of real numbering)
  const glyph = /^\s*[•▪◦‣]\s+(.*)$/s.exec(text);
  if (glyph) return `- ${glyph[1].trim()}`;
  orderedCounters.clear();
  return text;
}

function tableToMarkdown(tbl: Element, ctx: ImportCtx): string {
  const rows = localChildren(tbl, 'tr');
  if (!rows.length) return '';
  const cellsOf = (tr: Element, stripBold = false) =>
    localChildren(tr, 'tc').map((tc) => {
      const parts = localChildren(tc, 'p')
        .map((p) => piecesToMarkdown(readRuns(p, ctx)).trim())
        .filter(Boolean);
      let cell = parts.join(' ').replace(/\|/g, '\\|').replace(/\n/g, ' ');
      // header rows are typically bold-formatted; markdown headers are already emphasized
      if (stripBold) cell = cell.replace(/\*\*([^*]+)\*\*/g, '$1');
      return cell;
    });
  const header = cellsOf(rows[0], true);
  const cols = Math.max(1, header.length);
  const lines: string[] = [];
  lines.push(`| ${header.concat(Array(Math.max(0, cols - header.length)).fill('')).join(' | ')} |`);
  lines.push(`|${Array(cols).fill(' --- ').join('|')}|`);
  for (const tr of rows.slice(1)) {
    const cells = cellsOf(tr);
    lines.push(`| ${Array.from({ length: cols }, (_, i) => cells[i] ?? '').join(' | ')} |`);
  }
  return lines.join('\n');
}

function parseNumbering(xml: string | null): Map<string, 'bullet' | 'ordered'> {
  const map = new Map<string, 'bullet' | 'ordered'>();
  if (!xml) return map;
  try {
    const doc = parseXml(xml);
    // abstractNumId → format of level 0
    const abstractFmt = new Map<string, 'bullet' | 'ordered'>();
    const abstracts = doc.getElementsByTagNameNS(W_NS, 'abstractNum');
    for (let i = 0; i < abstracts.length; i++) {
      const a = abstracts[i];
      const id = a.getAttributeNS(W_NS, 'abstractNumId') ?? a.getAttribute('w:abstractNumId');
      if (!id) continue;
      const lvl0 = localChildren(a, 'lvl').find((l) => (l.getAttributeNS(W_NS, 'ilvl') ?? l.getAttribute('w:ilvl')) === '0');
      const fmt = wVal(firstLocal(lvl0 ?? a, 'numFmt'));
      abstractFmt.set(id, fmt === 'bullet' ? 'bullet' : 'ordered');
    }
    const nums = doc.getElementsByTagNameNS(W_NS, 'num');
    for (let i = 0; i < nums.length; i++) {
      const n = nums[i];
      const numId = n.getAttributeNS(W_NS, 'numId') ?? n.getAttribute('w:numId');
      const abstractRef = wVal(firstLocal(n, 'abstractNumId'));
      if (numId && abstractRef && abstractFmt.has(abstractRef)) {
        map.set(numId, abstractFmt.get(abstractRef)!);
      }
    }
  } catch {
    /* numbering is best-effort */
  }
  return map;
}

function parseRels(xml: string | null): Map<string, string> {
  const map = new Map<string, string>();
  if (!xml) return map;
  try {
    const doc = parseXml(xml);
    const rels = doc.getElementsByTagNameNS(REL_NS, 'Relationship');
    for (let i = 0; i < rels.length; i++) {
      const r = rels[i];
      const id = r.getAttribute('Id');
      const target = r.getAttribute('Target');
      const mode = r.getAttribute('TargetMode');
      if (id && target && mode === 'External') map.set(id, target);
    }
  } catch {
    /* hyperlinks degrade to plain text */
  }
  return map;
}

function parseFootnotes(xml: string | null, ctx: ImportCtx): string[] {
  if (!xml) return [];
  const out: string[] = [];
  try {
    const doc = parseXml(xml);
    const notes = doc.getElementsByTagNameNS(W_NS, 'footnote');
    for (let i = 0; i < notes.length; i++) {
      const n = notes[i];
      const id = n.getAttributeNS(W_NS, 'id') ?? n.getAttribute('w:id');
      if (!id || !ctx.footnoteRefs.has(id)) continue; // skip separators/unreferenced
      const text = localChildren(n, 'p')
        .map((p) => piecesToMarkdown(readRuns(p, ctx)).trim())
        .filter(Boolean)
        .join(' ');
      if (text) out.push(`[^${id}]: ${text}`);
    }
  } catch {
    /* footnotes are best-effort */
  }
  return out;
}

export interface DocxImportResult {
  markdown: string;
  title: string | null;
  warnings: string[];
}

/** Import a .docx File/Blob into workspace Markdown. Browser-only. */
export async function importDocx(file: File | Blob, filename?: string): Promise<DocxImportResult> {
  const buf = await file.arrayBuffer();
  const entries = readCentralDirectory(buf);
  const documentXml = await readZipText(buf, entries, 'word/document.xml');
  if (!documentXml) throw new Error('No word/document.xml — is this a .docx file?');

  const warnings: string[] = [];
  const ctx: ImportCtx = {
    rels: parseRels(await readZipText(buf, entries, 'word/_rels/document.xml.rels')),
    footnoteRefs: new Set(),
    numFormats: parseNumbering(await readZipText(buf, entries, 'word/numbering.xml')),
  };

  const doc = parseXml(documentXml);
  const body = doc.getElementsByTagNameNS(W_NS, 'body')[0];
  if (!body) throw new Error('word/document.xml has no body');

  const blocks: string[] = [];
  const orderedCounters = new Map<string, number>();
  for (let i = 0; i < body.children.length; i++) {
    const el = body.children[i];
    if (el.localName === 'p') {
      const md = paragraphToMarkdown(el, ctx, orderedCounters);
      blocks.push(md);
    } else if (el.localName === 'tbl') {
      orderedCounters.clear();
      blocks.push(tableToMarkdown(el, ctx));
    } else if (el.localName === 'sectPr') {
      // section properties — layout only
    }
  }

  // footnote definitions (only for referenced ids)
  const fnDefs = parseFootnotes(await readZipText(buf, entries, 'word/footnotes.xml'), ctx);

  // assemble: collapse runs of empty paragraphs into single blank lines
  const lines: string[] = [];
  for (const b of blocks) {
    if (!b.trim()) {
      if (lines.length && lines[lines.length - 1] === '') continue;
      lines.push('');
    } else {
      lines.push(b, '');
    }
  }
  let markdown = lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (fnDefs.length) markdown += `\n\n${fnDefs.join('\n')}`;

  // title: docProps/core.xml dc:title, else first heading, else filename
  let title: string | null = null;
  const core = await readZipText(buf, entries, 'docProps/core.xml');
  if (core) {
    const m = /<dc:title>([^<]{1,200})<\/dc:title>/.exec(core);
    if (m) title = m[1].trim() || null;
  }
  if (!title) {
    const h = /^#{1,3}\s+(.{3,120})$/m.exec(markdown);
    if (h) title = h[1].trim();
  }
  if (!title && filename) title = filename.replace(/\.docx$/i, '');

  const trackedDel = documentXml.includes('<w:del ') || documentXml.includes('<w:del>');
  if (trackedDel) warnings.push('The source document contained tracked deletions; they were dropped (insertions were kept as accepted text).');
  if (documentXml.includes('<w:drawing') || documentXml.includes('<w:pict')) {
    warnings.push('Images/drawings in the source document were not imported.');
  }

  return { markdown, title, warnings };
}
