# Table-aware export (DOCX + PDF)

Right now `src/lib/file-export.ts` has no table handling at all. `markdownToBlocks` only knows headings, lists, rules, paragraphs — every GFM pipe table the editor preview renders gets flattened to plain paragraphs of `| col | col |` text on export. Goal of this pass: pipe tables in the editor export cleanly to both Word and the print-to-PDF path, without touching the editor surface, the AI prompts, or any other behavior.

## Scope (only this)

- Parse GFM pipe tables in `markdownToBlocks`.
- Render them as real Word tables in `buildDocx`.
- Render them as styled `<table>` in `blocksToHtml` + `PRINT_CSS` so print-to-PDF matches the on-screen look.
- Touch nothing else: no editor changes, no AI changes, no schema changes, no new deps.

## Changes (all in `src/lib/file-export.ts`)

### 1. Extend the doc model
Add one new block type alongside the existing ones:

```ts
type TableAlign = 'left' | 'center' | 'right' | null;
| { type: 'table';
    header: Run[][];           // one cell = Run[]
    rows: Run[][][];           // rows × cells × runs
    align: TableAlign[];       // per column
  }
```

Existing `DocBlock` consumers (`blockToDocxXml`, `blocksToHtml`) get one extra case each. No existing case changes.

### 2. Parse pipe tables in `markdownToBlocks`
GFM table = header line `| a | b |`, separator line `| --- | :--: |`, then ≥0 body lines. Implementation:
- Convert the line walker to an index loop so we can lookahead one line.
- When the current line matches a pipe row AND the next line matches the separator pattern `^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$`, consume header + separator, then keep consuming body rows while they still look like pipe rows.
- Split cells on unescaped `|`, trim, strip leading/trailing pipe; reuse `parseInline` for cell contents so bold/italic still work.
- Derive `align[]` from the separator (`:---` left, `:---:` center, `---:` right, `---` null).
- Pad short rows / truncate long rows to header length so column counts stay consistent.
- Malformed table (no separator, ragged) → fall through to existing paragraph handling. Safe fallback.

### 3. DOCX rendering (`blockToDocxXml` table case)
Produce a standard WordprocessingML `<w:tbl>`:
- `<w:tblPr>` with `<w:tblW w:type="pct" w:w="5000"/>` (full content width), `<w:tblLayout w:type="fixed"/>`, and a complete `<w:tblBorders>` block (single, sz=4, color="C9C2B4" — matches existing rule color) so all four sides + insideH/insideV render in Word and Google Docs.
- `<w:tblGrid>` with N equal `<w:gridCol w:w="…"/>` summing to 9360 DXA (content width inside 1" margins on US Letter — matches the existing `sectPr`).
- Header row: `<w:trPr><w:tblHeader/></w:trPr>` so it repeats on page break; cells get a light fill (`<w:shd w:val="clear" w:color="auto" w:fill="F4EFE3"/>`) and bold runs.
- Body rows: cell `<w:p>` uses `<w:jc>` derived from column alignment.
- Each cell `<w:tc>` gets `<w:tcW w:type="dxa" w:w="…"/>` matching grid, plus a single paragraph wrapping `runXml(...)` output.

Spec sanity-checks (per docx skill notes): every `<w:tc>` carries its own width; table width and grid widths agree; shading uses `clear`, not `solid`; border color is hex without `#`.

### 4. HTML/PDF rendering (`blocksToHtml` + `PRINT_CSS`)
- New table case emits:
  ```html
  <table class="doc-table">
    <thead><tr><th style="text-align:left">…</th>…</tr></thead>
    <tbody><tr><td style="text-align:…">…</td>…</tr>…</tbody>
  </table>
  ```
  Cell text uses the same `runHtml` helper (so bold/italic survive). Alignment style only emitted when non-null.
- `PRINT_CSS` gains a small block:
  ```css
  table.doc-table { width: 100%; border-collapse: collapse; margin: 0 0 14px; font-size: 10.5pt; page-break-inside: avoid; }
  .doc-table th, .doc-table td { border: 1px solid #c9c2b4; padding: 6px 9px; vertical-align: top; text-align: left; }
  .doc-table thead th { background: #f4efe3; font-family: Inter, sans-serif; font-size: 9.5pt; text-transform: uppercase; letter-spacing: 0.04em; }
  .doc-table tr { page-break-inside: avoid; }
  ```
  Matches the existing parchment palette and Inter/Source Serif type system already in the print CSS.

### 5. Same flow, no API changes
Public exports stay identical (`markdownToBlocks`, `buildDocx`, `downloadDocx`, `blocksToHtml`, `printDocument`). Callers in `src/routes/draft.tsx` and `src/components/export-menu.tsx` need no edits.

## Safety

- Pure additive code path: only the new `table` block triggers new branches; every other block flows through the existing code unchanged.
- Pipe-table detection requires the separator line, so accidental matches on prose with `|` are extremely rare; on any malformed table the parser falls through to the existing paragraph branch.
- No new dependencies, no schema/migration, no edge-function changes, no editor changes.
- Will smoke-test by exporting a draft containing: a heading, a paragraph, a 3×4 GFM table with mixed alignment and bold/italic cells, a bullet list, and a rule — verifying DOCX opens in Word/Google Docs with borders + header shading, and Print preview shows the matching styled table.

## Out of scope (deferred per your instruction)

Slash-command table inserter, table-aware AI actions, Table of Authorities, inline diff accept/reject, ProseMirror migration, comment threads. None of those are touched here.
