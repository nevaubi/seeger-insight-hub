
# Depositions v2 — improvements plan

The current page is solid (dual-pane transcript + findings tabs, quote verification, Ask). The gaps are mostly around **workflow speed, cross-depo intelligence, and output**. Below is a prioritized set of upgrades, grouped so you can approve a subset.

## 1. Index page (`depositions.index.tsx`)

**Problem:** Just a flat list. No filtering, no signal about what's inside each depo.
**Changes:**
- Header ledger row: total transcripts, total pages, # analyzed, # helpful vs harmful admissions across the matter.
- Filter bar: witness role, alignment (plaintiff/defendant/expert), status, free-text witness search.
- Per-row preview: mini-counts of admissions / exhibits / quality issues, top 1–2 issue tags, "last analyzed" timestamp.
- Sort: date deposed, date added, # findings.
- Bulk actions: re-run analysis on N selected; delete.
- Drag-and-drop upload zone (currently click-only) + multi-file queue with per-file progress.

## 2. Detail page (`depositions.$id.tsx`)

### Transcript pane
- **Segment-level navigation:** left mini-outline (Q/A blocks + objections + exhibits marked) with jump-to. Today only page headers are sticky.
- **Persistent highlights:** any finding hovered in the right pane lights up its lines on the left (not just click). Add a "pin" so multiple citations stay lit.
- **Search:** current substring search → add regex + speaker filter (Q only / A only / objection) and next/prev match with match count.
- **Copy-as-cite:** select any range → floating button copies `"quote" (Prescott Dep. 42:7–18)`.
- **Split-pane divider:** reuse `src/components/split-pane.tsx` so users can widen either side.
- **Virtualization:** long transcripts (500+ pp) drop frames — swap the map for `@tanstack/react-virtual` on `linesByPage`.

### Findings pane
- **Compare-across-depos:** on any admission, show a "cross-check" button that queries `deposition_findings` across the matter for contradicting/corroborating quotes from other witnesses (uses existing `hybrid_search_v2` scoped by finding embedding, or a simple issue-tag match as v1).
- **Approve / reject with reason:** current review only stores status; add optional note stored in `deposition_findings.review_note` (or JSON `data`).
- **"Send to Draft":** each finding gets a button that stashes the quote + cite in a matter-scoped clipboard (localStorage keyed by `master_case_id`) that the Draft page's Claude sidecar can paste as a block quote with pre-formatted cite.
- **"Send to Ask the Record":** pipes the finding text as a seed question in `/search` (uses existing matter context).
- **Streaming re-analysis:** today `analyzeDeposition` blocks then polls; wire the edge function to SSE like `legal-synthesis` so findings stream in with the same rail UI (`useSynthesisStream` pattern reused).
- **Impeachment view:** new tab that pairs harmful admissions with any conflicting statements from same witness's prior transcripts / documents (uses existing hybrid search).

### Ask tab
- Persist Q&A history for the depo (currently discarded on tab switch); store in `deposition_qa` table (new) or session state as v1.
- Suggested questions per witness role (mirrors `SuggestionDeck` on `/search`).
- Streaming answer + inline cite chips that also scroll the transcript.

### Header
- Add witness photo/avatar slot (optional metadata).
- Add "Exhibits" quick-count chips, "Deposed by" (from segments), duration if we can infer.
- Sticky compact header on scroll.

## 3. Export & sharing
- **Digest PDF/DOCX** using existing `src/lib/file-export.ts`: summary + admissions + chronology + exhibits with pin-cites. Toggleable sections.
- **CSV** of admissions/chronology/exhibits (reuse `review-export.ts` patterns).
- **Copy shareable deep link** to a specific cite (`?jump=42:7`).

## 4. Ingest & analysis quality
- OCR fallback for scanned PDFs (server-side flag, surface "Low OCR confidence" banner in UI).
- Speaker map editor: if the parser mislabels Q/A speakers, let the user reassign a speaker across the transcript — writes back to `deposition_segments`.
- Auto-detect deposition_date / case_no from cover page when user leaves them blank.
- Confidence score per finding + filter "only high-confidence".

## 5. Technical notes
- New client-only additions: react-virtual, split-pane reuse, clipboard state via a `useDepoClipboard` hook (localStorage).
- New edge-function work (out of scope for a pure-frontend pass, flagged separately): SSE variant of `depo-analyze`, `depo-cross-check` RPC.
- New tables (if we go beyond in-session state): `deposition_qa`, optional `review_note` column — will be a separate migration turn on the external Supabase project.
- No changes to `src/integrations/supabase/*` (auto-gen).

## Suggested first slice (if you want to ship fast)

Phase A (frontend-only, no backend changes):
1. Index page filters + counts + drag-and-drop multi-upload.
2. Transcript virtualization + split-pane divider + copy-as-cite + regex/speaker search.
3. Findings: "Send to Draft" clipboard, "Send to Ask", hover-highlight, pin multiple cites.
4. Export digest (DOCX/PDF/CSV).

Phase B (needs edge-function / schema work):
5. Streaming analysis with rail UI.
6. Cross-depo impeachment view + confidence filter.
7. Persistent Ask history + speaker map editor + OCR fallback.

**Which slice do you want me to build first — all of Phase A, or a specific subset?**
