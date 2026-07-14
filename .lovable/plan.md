# Drafting polish: Bluebook citations + court-ready DOCX + formatting

Three coordinated upgrades to the drafting workspace. All changes are frontend + export-layer only; the existing `cite-check` edge function (CourtListener) is reused as-is.

## 1. Bluebook cite normalizer (pre-export pass)

New: `src/lib/bluebook.ts` — pure functions, no network.

**Normalizations applied on export and on-demand via a toolbar action:**
- **Reporter abbreviations** — `F.Supp.3d`/`F. Supp. 3d`/`F.Supp.3d.` → canonical `F. Supp. 3d`; same for `F.`, `F.2d`, `F.3d`, `F.4th`, `U.S.`, `S. Ct.`, `L. Ed. 2d`, `A.2d/3d`, `N.E.2d/3d`, `S.E.2d/3d`, `So. 2d/3d`, `P.2d/3d`, `Cal.`, `N.Y.`, etc. (table-driven).
- **Short-form promotion** — after the first full cite of a case, subsequent full repeats collapse to `Smith, 123 F.3d at 45` short form. Tracks a per-document citation ledger by normalized reporter+volume+page.
- **`Id.` insertion** — when the immediately preceding citation in the same paragraph refers to the same case (same volume+reporter+page), replace with `Id.` (with pincite: `Id. at 47`). Never crosses headings or block quotes.
- **`supra` for treatises / non-case authorities** — repeat references to secondary sources (detected by pattern: author name + title + pin) become `Author, supra note N, at X` when a footnote number is present; otherwise `Author, supra, at X`.
- **Signal spacing** — `see,` / `See ,` / `see  also` → `See also`; correct comma/italics placement for `see`, `see also`, `cf.`, `but see`, `accord`, `e.g.`.
- **Pincite hygiene** — `at 45-47` → `at 45–47` (en-dash); `pp. 45` → `at 45`; strip stray periods after reporter volumes.
- **Case-name italics** — mark case names (detected via `v.` between capitalized tokens) with `italic: true` runs so DOCX/PDF renders them italicized. Skips names already inside italic runs.
- **Court + year normalization** — `(D.C. Cir. 2019)` retained; strip double spaces; add missing parenthesis on unambiguous patterns.

**Report object returned to UI:**
```ts
type BluebookReport = {
  changes: { kind: 'reporter' | 'id' | 'supra' | 'short' | 'signal' | 'pincite' | 'italic'; before: string; after: string; blockIndex: number }[];
  totals: Record<Kind, number>;
}
```

## 2. Court-ready DOCX styling

Extend `src/lib/file-export.ts`:

**New export mode** — `exportCourtReadyDocx(blocks, opts)` where `opts` includes:
- `caption`: `{ court, division, caseName, caseNumber, judge, docType }` — renders the N.D. Fla. pleading caption block (two-column table: parties left, case metadata right, `)` divider column) at the top.
- `pageNumbers`: default `true` — footer with `Page X of Y` centered, using Word's `PAGE`/`NUMPAGES` fields.
- `lineNumbers`: default `false` — adds `<w:lnNumType w:countBy="1" w:restart="newPage"/>` to the section for pleading line numbering.
- `doubleSpace`: default `true` for body paragraphs (`w:line="480" w:lineRule="auto"`).
- `firstLineIndent`: default `720` DXA (0.5") on body paragraphs; headings unindented.
- `certificateOfService`: optional trailing block auto-appended.
- `signatureBlock`: `{ attorney, firm, address, phone, email, barNumber }` rendered right-aligned above COS.

**Style upgrades to the existing styles.xml:**
- Add explicit `Heading1`/`Heading2`/`Heading3` styles with outline levels (fixes Word's Navigation Pane).
- Add `BlockQuote` style: 0.5" left+right indent, single-spaced, 11pt.
- Add `Footnote` style — enables footnote export (see §3).
- Add `Caption` and `Signature` styles used by the court-ready block.
- Widow/orphan control on all body paragraphs.
- `keepNext` on all headings (already partial; extend to H2/H3).

**Page setup:**
- US Letter 12240×15840, 1" margins (unchanged).
- Header offset 720, footer 720 (unchanged).
- Add page numbers via footer part (new `word/footer1.xml` + rel + content-type entry).

## 3. Document formatting polish (editor + export)

**Markdown → block improvements** (`file-export.ts` block parser):
- Recognize `> ` block quotes → new `blockquote` block type; renders in DOCX/HTML with `BlockQuote` style (indented, no first-line indent).
- Recognize footnote syntax `[^1]` inline + `[^1]: text` at doc end → real Word footnotes (`w:footnoteReference` + `word/footnotes.xml` part). PDF path renders as numbered list under `<h2>Footnotes</h2>`.
- Recognize `---` on its own line → thematic break (already `rule`, verify path).
- Preserve smart quotes on export: `'` → `’`, `"` → `“/”` (open/close aware), `--` → `—`, `...` → `…`.
- Non-breaking space between citation atoms: `123 U.S. 456` → `123\u00a0U.S.\u00a0456` in export.
- Small-caps run flag (new `smallcaps` on `Run`) mapped to `<w:smallCaps/>` in DOCX and `font-variant: small-caps` in HTML — used by Bluebook normalizer for author names in secondary sources.

**Editor-side (LegalEditor):**
- Add a `Format polish` toolbar action that runs Bluebook normalize + smart-quote pass over the current doc and streams the diff as tracked changes (reuses existing `insertion`/`deletion` marks so the user can accept/reject each fix).
- Add a right-side toolbar chip showing citation stats: `12 cites · 2 short · 1 Id.` — clicking opens a summary popover.

**New Export menu entries** (replace current single "Word (.docx)"):
- **Word — Draft** (current clean export).
- **Word — Court-ready** (Part 2, opens a small options dialog: doc type, caption, line numbers).
- **Word — Redlined** (existing tracked changes preserved as `w:ins`/`w:del`).
- **PDF — Print preview** (current path).

## Technical notes

- No new backend, no migrations, no new edge functions.
- New files: `src/lib/bluebook.ts`, `src/lib/court-docx.ts` (thin wrapper on `file-export`), `src/components/editor/court-ready-dialog.tsx`.
- Touched: `src/lib/file-export.ts` (blockquote/footnote/smartquote/smallcaps + styles), `src/routes/_authenticated/draft.tsx` (export menu split + polish action + citation chip), `src/components/editor/legal-editor.tsx` (toolbar hook for polish action).
- Bluebook pass is deterministic and local — no LLM call, no cost.
- Court-ready caption defaults pulled from `matter-context` (matter name, court, judge, MDL number) so most fields prefill.

## Out of scope for this pass

- Bluebook 21st-ed edge cases for foreign authorities.
- Automated pinpoint verification against the source PDF (that's the cite-check panel — separate feature).
- Multi-jurisdiction local-rules templates beyond N.D. Fla. (add on request).
