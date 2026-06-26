
# Tabular Review — Phase 2 Build Plan

Four features, scoped to ship together. All frontend-first; minimal backend additions where strictly needed.

---

## 1. Source preview pane (verification drawer)

**Goal:** Click any cell → side drawer opens with the cited page and the quote highlighted in context. Lawyers verify in one click instead of opening the PDF.

**Behavior**
- Click a cell value (or the existing `Quote` chip) → right-side `Sheet` drawer (60% width) opens.
- Header: filename · page X of N · prev/next page arrows · "Open original PDF" link (signed URL from `REVIEW_FILES_BUCKET`).
- Body: rendered page transcript from `document_pages.extracted_text` for that `review_file_id` + `page_number`, with the cited `quote` wrapped in `<mark>` (case- and whitespace-insensitive match).
- Sidebar inside drawer: list of all citations for that cell; clicking one jumps to its page + highlight.
- "Mark verified" / "Mark wrong" buttons → write to `review_cells.human_verdict` (`verified` | `wrong` | null) and flip row tint accordingly.

**Files**
- `src/components/review/source-preview-drawer.tsx` (new)
- `src/routes/review.tsx` — wire `onClick` from `CellView` + `DocCell` to open the drawer with `{ fileId, page, quote }`.

**Backend**
- Migration: `ALTER TABLE review_cells ADD COLUMN human_verdict text CHECK (human_verdict IN ('verified','wrong'))`.
- No new tables. Reads from existing `document_pages`.

---

## 2. CSV / XLSX export

**Goal:** One-click download of the current review set as a spreadsheet — values for analysis, citations preserved for audit.

**Behavior**
- "Export" dropdown in `PageHeader` next to "Run all": **CSV**, **Excel (.xlsx)**, **Copy as Markdown table**.
- CSV: one row per file; columns = Document, then each review column. Values are normalized (dates → ISO, numbers → numeric, lists → `;`-joined). Second file `…-citations.csv` emitted alongside with `(document, column, page, quote, verified)`.
- XLSX (built with `xlsx` / SheetJS in the browser — no server round-trip): two sheets — `Values` and `Citations`. Header row bold, freeze top row, autosize columns, `needs_review` cells tinted amber.
- Markdown: copy GFM pipe table to clipboard so it pastes straight into the Drafting page (which already renders tables via the recent file-export work).

**Files**
- `src/lib/review-export.ts` (new) — pure functions: `toCsv(set)`, `toXlsxBlob(set)`, `toMarkdown(set)`.
- `src/routes/review.tsx` — add `ExportMenu` to the header.

**Backend:** none.

---

## 3. Cross-document questions ("Ask this review")

**Goal:** A scoped synthesis bar above the table that answers questions grounded *only* in the files in the active review set — leveraging the existing streaming infra.

**Behavior**
- Slim composer pinned above the table: "Ask across these N documents…" with a Send button.
- Submitting opens a collapsible answer panel below the composer (not a full route change). Streams using the existing `useSynthesisStream` hook.
- Scope: pass the set's `review_file_id` list and (server-side) resolve to the corresponding `document_id`s so retrieval is constrained to those documents only.
- Answer renders with inline citation chips `[file • p.X]` that click through to the source preview drawer (reuses #1).
- "Recent questions" list (last 5) persisted to a new `review_questions` table per set.

**Files**
- `src/components/review/ask-review.tsx` (new)
- `src/routes/review.tsx` — mount above the table when files exist.
- `src/lib/useSynthesisStream.ts` — accept optional `scope: { review_set_id, document_ids }` and forward to the synthesis endpoint body.

**Backend**
- Migration: `review_questions(id, review_set_id, question, answer_jsonb, created_at)` + grants + RLS.
- The existing synthesis edge function needs a `document_ids` filter in its retrieval step. (If it doesn't already support that, this is the only meaningful server change in the whole plan.)

---

## 4. Document-level metadata columns

**Goal:** Auto-extract a small set of universal fields on ingest so every row has useful context before the user adds any columns.

**Behavior**
- On a file transitioning `transcribing → ready`, queue a one-shot metadata extraction that fills system columns:
  - `Document type` (enum: Order, Motion, Brief, Letter, Agreement, Expert Report, Deposition, Email, Other)
  - `Title / caption`
  - `Date` (date)
  - `Parties` (list)
  - `Court / forum` (text, nullable)
  - `Page count` (number; already known from ingest — just surface it)
- Rendered as the first columns in the table, marked with a small "auto" badge and a slightly muted header. User can hide them via the column kebab → "Hide system columns".
- Stored alongside other cells so existing citations/verification UI works unchanged.

**Files**
- `src/routes/review.tsx` — recognise `column.kind = 'system'`, render badge, add hide toggle (persisted in `localStorage` per matter).
- `src/lib/supabase.ts` — extend `ReviewColumn` type with optional `kind: 'system' | 'user'`.

**Backend**
- Migration: `ALTER TABLE review_columns ADD COLUMN kind text NOT NULL DEFAULT 'user'`.
- Edge function `tabular-ingest` (existing): after transcription completes, upsert the 6 system columns for the set (idempotent on `(review_set_id, name, kind='system')`) and enqueue extraction for the new file. Re-uses the existing `tabular-extract` flow — no new extraction code path.

---

## Build order

1. **#4 metadata columns** first — it's the smallest backend change and the system columns benefit everything else (export gets useful headers; cross-doc Q&A gets better retrieval hints).
2. **#1 source preview drawer** — biggest UX win, frontend-only except a one-column migration.
3. **#2 export** — purely frontend once #4 has populated useful columns.
4. **#3 cross-doc questions** — last, since it needs the synthesis endpoint to accept a `document_ids` scope.

---

## Out of scope (defer)

- Realtime subscription replacement, self-consistency sampling, per-cell retries, drag-to-reorder columns, saved column templates, bulk selection. We'll return to those if you want a reliability pass next.

---

## Open questions before I start

1. **Synthesis endpoint scoping (item #3):** does the current synthesis edge function already accept a `document_ids` filter? If not, I'll need to update it — confirm that's OK.
2. **Metadata column visibility:** show system columns by default, or hidden behind a toggle?
3. **XLSX library:** OK to add `xlsx` (SheetJS community build, ~600KB) as a dep, or prefer a smaller alternative like `exceljs`?
