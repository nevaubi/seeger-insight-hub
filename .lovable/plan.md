## 1. Clearer labels for the transcript search bar
File: `src/routes/_authenticated/depositions.$id.tsx` (search toolbar ~ lines 831–893).

- Add a small caption row above the controls: `"Search transcript"` on the left, and on the right a subtle "Filter" label preceding the speaker pill group.
- Replace the cryptic speaker pill labels (`All / Q / A / Obj`) with full words:
  - `Any speaker` · `Question` · `Answer` · `Objection`
  - Keep the compact pill styling; widen slightly to fit. On very narrow widths, show the current short letters and add a `title=` tooltip with the full name.
- Regex toggle: replace the icon-only button with an icon + short label pill (`.*` icon + "Regex") plus `aria-label="Toggle regular expression search"` and a `title` tooltip: "Regex on — match with a regular expression" / "Regex off — plain text search".
- Placeholder in the input becomes: `"Search words or phrases…"` (plain) / `"Regex, e.g. \b(risk|warn\w+)\b"` (regex on) — already present, keep.
- Match counter line: prefix with `Matches:` for clarity (e.g. `Matches: 3 / 27`).

No other logic changes — same state, same handlers.

## 2. Redesigned DOCX / PDF digest with tables + chronology timeline
File: `src/lib/depo-export.ts` (rewrite `buildDigestMarkdown` sections).

Leverage the existing GFM pipe-table support in `file-export.ts` (`markdownToBlocks` + `tableXml`) so both DOCX and print/PDF output pick up the tables and timeline styling automatically.

- **Admissions** → a compact table:

  ```
  | # | Topic | Stance | Admission | Cite |
  |---|-------|--------|-----------|------|
  | 1 | Warning label | Adverse | "…" — plain quote | 42:7–43:12 |
  ```

  - Detail + quote combined into one wrapped cell; quote wrapped in curly quotes.
  - Stance rendered as short label (Adverse / Neutral / Helpful) instead of italics.
  - Empty section is skipped.

- **Chronology** → vertical timeline rendered as a two-column table with left "date rail" and right "event":

  ```
  |     |     |
  |-----|-----|
  | **2018-04** | **FDA correspondence** — witness confirmed receipt.  _(112:3)_ |
  | **2019-08** | **Warning revision** — declined to update label.  _(145:9)_ |
  ```

  - Header row is empty so it reads as a rail visually; the left column uses bold dates for a timeline feel.
  - Also add a small CSS tweak in `blocksToHtml` styles for `.doc-table td:first-child { white-space: nowrap; color: hsl of oxblood-ish accent; border-right: 2px solid; }` to give the timeline its rail. (Edit inside `file-export.ts` `blocksToHtml` `<style>` block — scoped, tiny, safe.)

- **Exhibits** → table:

  ```
  | Ex. | Title | Description | Cite |
  |-----|-------|-------------|------|
  | 12  | Warning label draft | Marked and identified by witness. | 89:2–90:14 |
  ```

- **Quality notes** → table:

  ```
  | # | Note | Cite |
  |---|------|------|
  | 1 | Coaching objection sustained | 55:11 |
  ```

- **Executive Summary** / **Witness Profile** stay as prose paragraphs at the top (unchanged).
- Keep markdown pipe-safe escaping helper (`|` → `\|`, newlines → spaces).

The PDF path uses `printDigest → blocksToHtml`, so the same tables render there — no separate PDF code path.

## 3. Full multi-sheet Excel export
File: `src/lib/depo-export.ts` — replace `downloadAdmissionsCsv` with `downloadDigestXlsx(depo, findings)` (keep the CSV helper as a thin wrapper if desired, or remove).

Use `downloadXlsx(base, sheets)` from `@/lib/file-export`. Workbook contains:

1. **Summary** — key/value: witness, role, alignment, date, MDL, case no, page count, analyzed_at, counts per finding type.
2. **Admissions** — Witness, Topic, Stance, Detail, Quote, Cite (P:L), Page Start, Line Start, Page End, Line End, Tags, Confidence, Verify, Review.
3. **Chronology** — Date, Event Title, Detail, Cite, Page Start, Line Start, Tags.
4. **Exhibits** — Ex. Number, Title, Description, Cite, Page Start, Line Start, Tags.
5. **Quality Notes** — Note, Detail, Cite, Page Start, Line Start.
6. **All Findings** — union sheet: Type, Title, Detail, Quote, Cite, Stance, Tags, Confidence, Verify, Review, Page Start, Line Start, Page End, Line End.

Each sheet uses `columns: [{header, width}]` sized by content max (mirroring `review-export.ts` pattern). Empty sheets are still created with just the header row so the workbook shape is predictable.

File name: `<witness-last>-deposition-workbook.xlsx`.

## 4. Wire the new export into the menu
File: `src/routes/_authenticated/depositions.$id.tsx` (~ lines 785–794).

- Rename the "Data" section to `Spreadsheet`.
- Replace the single `Admissions .csv` item with:
  - `Full workbook (.xlsx)` → `downloadDigestXlsx(depo, findings)` (disabled only if `!analyzed`).
  - Keep `Admissions .csv` as a secondary quick option.
- Update the `Deposition digest` section labels to `.docx / .md / Print (PDF)` — copy only.

## Out of scope
- No changes to analysis, findings schema, edge functions, or transcript viewer internals.
- No new dependencies (uses existing `file-export.ts` pipeline).
