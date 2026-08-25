# Depositions: audit and upgrade plan

## Where we are today

The workspace (`/depositions/$id`) already does the hard part well:

- PDF ingest with page:line fidelity, speaker/examination segmentation, exhibit metadata.
- Auto-analysis on upload producing six finding types (witness profile, exec summary, chronology, admissions, exhibit hits, quality notes), each with a page:line cite, stance, confidence, verify status and review status.
- Split-pane transcript + findings, transcript search with regex and speaker filters, jump-to-cite.
- Ask-the-transcript Q&A with quoted citations.
- Digest export to DOCX / Markdown / print-PDF and a six-sheet XLSX workbook.

That puts us at parity with the "AI transcript summary" layer of Steno Transcript Genius, Nextpoint and Everlaw's deposition analyzer. What those platforms have that we do not is the **work-product layer around** the summary: designations, cross-transcript comparison, human annotations, and a prep deliverable.

## Gaps vs. leading tools

1. **No transcript library.** One deposition at a time; `/depositions` is upload-only. Nothing lists prior transcripts for the matter, so nothing can be compared.
2. **No designations workflow.** Everlaw Storybuilder, Epiq Narrate and Nextpoint all treat affirmative/counter designations plus objections as the core trial deliverable. We cannot mark a page:line range for trial at all.
3. **No user annotations.** Every mark in our app is AI-generated. There is no highlight, no note, no manual issue-code on a passage.
4. **No cross-examination outline.** The digest is a report, not a prep document. Litigators want a Q-and-cite outline they can carry to the next depo.
5. **No contradiction detection.** No comparison of a witness against their own earlier testimony, against another witness, or against a document.
6. **No word index / concordance.** Standard in transcript tools: every significant term with its page:line hits.
7. **Ask is one-shot.** No saved threads, no promoting an answer into findings or the outline.

## Proposed build order

### Phase 1 — Transcript library and manual work product

- **Library view** at `/depositions`: keep upload as the hero, add a table below of the matter's transcripts (witness, alignment, date, pages, status, findings count, last analyzed) with search, alignment filter and row-click into the workspace.
- **Highlights and notes**: select any transcript range in the left pane to create a highlight with a colour-coded issue tag and an optional note. Renders as a margin rail in the transcript and as a "My notes" tab beside the AI findings; included in exports.
- **Promote to finding**: turn a highlight into an admission-style entry so hand-found testimony sits alongside AI output with the same cite/review chrome.

### Phase 2 — Designations

- Mark a page:line span as **affirmative** or **counter**, with party, objection code (hearsay, 403, foundation, ...) and a free-text basis.
- Designation tab listing all spans, sortable by page, with overlap detection and running "minutes of testimony" estimate.
- Exports: designation chart XLSX (Party / Begin / End / Testimony / Objection / Ruling), a DOCX exchange version, and CSV import so opposing counsel's chart can be loaded and counter-designated.

### Phase 3 — Cross-examination prep kit

- Generate a structured outline from selected findings: topic clusters, the locking question, the supporting quote and cite, and anticipated dodges.
- Editable before export; ships as DOCX with the court-ready formatting presets already in `format-presets.ts`, or pushes into the Drafting workspace.

### Phase 4 — Contradiction and cross-transcript intelligence

- **Self-contradiction pass**: within one transcript, flag answers that conflict with earlier answers, with both cites side by side.
- **Cross-witness compare**: pick two transcripts in the matter and get an agreement/conflict grid by topic.
- **Testimony vs. record**: check admissions against the existing corpus search so a witness statement can be contradicted with an order or produced document.

### Phase 5 — Retrieval and navigation polish

- Word index tab: significant terms with hit counts and clickable page:line lists.
- Persistent Ask threads per deposition, with "add answer to outline" and "save as finding".
- Keyboard command bar inside the workspace (jump to page:line, next finding, next highlight).

## Technical notes

- Library, highlights, designations and outlines each need new tables in the external Supabase project plus a read path; the app is read-only today, so this is the first place we write. Confirm whether writes are acceptable there or whether they should live in a separate app-owned store.
- Contradiction passes and outline generation extend the existing `depo-analyze` edge function rather than adding new client logic.
- Exports reuse `file-export.ts` (DOCX/XLSX/print) and `depo-export.ts` patterns; no new dependencies.
- Highlights need a stable anchor: store `page_start/line_start/page_end/line_end` plus the matched text, not DOM offsets.

## Out of scope

- Video-synced transcripts and clip export (no video source in the pipeline).
- Realtime multi-user collaboration and permissions.
- Court reporter integrations / live feeds.
