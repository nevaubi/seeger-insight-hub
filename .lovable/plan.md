# Tabular Review → Caseload Review

Turn the review grid from a "drop 25 files in a box" tool into a matter-level document-review workspace that pulls straight from the docket and the deposition library, scales to real caseload volumes, and extracts litigation-specific structure.

## Current state

- One review set at a time, created ad hoc; files only arrive by manual upload (hard cap of 25, 25MB each).
- Uploads are transcribed one-by-one in a serial loop through the `tabular-ingest` function; no queue, no retry, no progress beyond a per-row status.
- Columns come from 9 generic templates; extraction runs per cell with page citations and a source preview drawer.
- Export supports CSV / XLSX / Markdown; "Ask" runs cross-document questions.
- No connection to docket orders or the deposition library, and no view above the level of a single set.

---

## Phase 1 — Intake at caseload scale

**Docket picker.** New "Add from docket" dialog: browse the matter's orders and filings (type, number, date, tags, page count), multi-select, add to a review set. These documents already have extracted page text, so they skip transcription entirely and are review-ready instantly.

**Deposition import.** "Add from depositions" pulls transcripts already in the matter's library into the grid the same way — no re-upload, no re-OCR.

**Bulk upload.** Folder/multi-file drop with a real ingest queue: bounded concurrency, per-file progress, automatic retry on transient failure, a failures tray with one-click retry-all, and dedupe by content hash so the same PDF is never ingested twice. Raise the per-set cap well past 25 (target several hundred) and virtualize the file list.

**Set setup.** Creating a set asks for a name, a document class (orders / motions / transcripts / discovery / medical / pleadings), and a template — the class drives the default column set and downstream defaults.

## Phase 2 — Litigation intelligence

- **Docket-aware templates**: motion-practice, order/CMO, discovery-log and transcript templates pre-wired to the class chosen at set creation, plus per-matter saved templates.
- **Obligation & deadline extraction**: a first-class column type that pulls dated obligations out of orders and motions and can push them to the matter's key-dates view.
- **Cross-document rollups**: a summary band above the grid — counts by enum column, date range, missing-value coverage, and outliers — so a 200-row set is readable at a glance.
- **Contradiction / consistency flags**: detect cells that disagree across documents that should agree (dates, party names, order numbers) and surface them as a review queue.
- **Confidence + verification**: every cell keeps its extraction confidence and a verified/unverified state; low-confidence cells are triaged in a "needs review" filter, and accepting a cell records it as attorney-verified.
- **Better Ask**: cross-document questions scoped to the current filter/selection, answers cited to file + page, one-click "turn this answer into a column".

## Phase 3 — Grid UX and matter workspace

- **Matter workspace**: `/review` becomes a list of the matter's review sets (name, class, doc count, completion, last run) with search, plus quick entry into any set.
- **Saved views**: filter + sort + column-visibility combinations saved per set and shared across the matter.
- **Denser grid**: virtualized rows and columns, sticky first column, resizable columns, row grouping by any enum column, and column filters as chips.
- **Keyboard-first**: arrow-key cell navigation, `Enter` to open the source pane, `Space` to accept a cell, `/` to filter, `Cmd+K` for column actions.
- **Inline source pane**: source preview docks beside the grid instead of a drawer, so a reviewer can walk cells while the cited page stays open.
- **Bulk actions**: select rows to re-run, delete, export, or apply a column across just the selection.

---

## Technical notes

- Docket and deposition imports add rows to `review_files` that reference existing page text rather than storage objects — this needs a nullable `storage_path` plus `source_kind` / `source_ref` columns, and `review_file_pages` populated by copy rather than by `tabular-ingest`. Requires a schema migration on the review database.
- Set-level fields (`document_class`, saved views, saved templates) and cell-level fields (`confidence`, `verified_at`) are also migrations.
- Bulk upload replaces the serial `for` loop in the upload handler with a bounded worker pool (6-way, matching the extraction pool already in use) and a persisted queue state so a page refresh does not lose progress.
- `tabular-extract` gains obligation extraction and consistency checks; contradiction detection runs as a set-level pass after extraction completes.
- Exports extend to cover rollups and the flag queue as extra sheets.

## Sequence

Phase 1 first — intake is the bottleneck, and the docket/deposition pull is where the caseload-specific value is. Phase 2 and 3 land after, each on its own pass.
