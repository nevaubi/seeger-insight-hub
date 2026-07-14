
## Counter-draft workflow

Adds a new lane on the Drafting page: upload an opposing party's draft (.docx / .pdf / paste), the platform segments it by section, and — per section — produces a redline (original ↔ our counter-language) plus a rationale grounded in the matter record. Reuses the existing `ai-assist` `redline` mode, docx importer, and track-changes marks.

### 1. Entry point (Draft page)

`src/routes/_authenticated/draft.tsx`
- Add a "Counter opposing draft" action to the "New document" dropdown next to existing template picks.
- Opens a `CounterDraftDialog` (new component) with three tabs: **Upload .docx**, **Upload PDF**, **Paste text**.
- On import, create a workspace document typed `counterdraft` (existing `workspace_documents.kind` if present, else store as regular doc with a `meta.source = 'opposing-draft'` flag on the row) and route the editor into **Counter-draft mode**.

### 2. Ingest + sectioning

New: `src/lib/counterdraft.ts`
- `ingestOpposing(file | text): Promise<{ title, sections: Section[] }>`.
- .docx path → existing `importDocx` (already handles headings, lists, tables). PDF path → send bytes to a small new server function `pdf-extract` (or reuse `tabular-extract` text pipeline if it already exposes plain text; will inspect and pick one — no new backend if `tabular-extract` suffices).
- Sectioning heuristic (pure client):
  1. Split on ATX headings (`#`/`##`/`###`).
  2. Fallback: split on Roman/Arabic outline markers at line start (`I.`, `A.`, `1.`, `(a)`) with a min block size.
  3. Fallback: 400–800 word rolling windows.
- Each `Section` = `{ id, heading, level, markdown, start, end }` where `start/end` are offsets into the full document.

### 3. Counter-draft editor mode

New: `src/components/editor/counterdraft-panel.tsx`
- Rendered next to `LegalEditor` via existing `SplitPane` (left: opposing draft read-only preview; right: our working counter-draft).
- Section list rail on the far left: heading, status pill (`pending | drafting | ready | accepted | rejected`), diff counters (`+adds / −dels`).
- Per section actions:
  - **Suggest counter-language** → calls `ai-assist` `mode: "redline"` with `selection_start/end` scoped to that section, `ground: true`, `run_id`, and a new `intent: "counterdraft"` hint added to the instruction ("Rewrite from the perspective of Plaintiffs' Co-Lead; preserve neutral structural language, contest asserted facts and legal conclusions, propose narrower/broader language as appropriate, cite controlling PTO/CMO where relevant.").
  - Streamed `edit` events land as `insertion`/`deletion` marks (existing `newChangeId` + track-changes plumbing) — no new mark types needed.
  - `edit_failed` surfaces inline under the section as a warning row (same treatment as review).
- Section header shows the model's rationale (first sentence of the streamed `analysis` field) and record citations as `CiteChip`s (reuses `ProposalCard` chip renderer).
- Accept / Reject / Regenerate at both section and change level (reuse `acceptChange` / `rejectChange` / `acceptAll` / `rejectAll` scoped to the section's range via `findMarkRange` filtered by `changeId` prefix `sec_<sectionId>_`).

### 4. Backend touch (minimal)

`supabase/functions/ai-assist/index.ts`
- Accept a new optional field `intent?: "counterdraft"` and, when set, prepend a counterdraft-flavored system preface to the existing redline prompt (no schema change to edit events).
- Everything else — anchor verification, cite tiering, writer fallback chain — is reused unchanged.

### 5. Export

`src/lib/file-export.ts`
- Add `exportCounterdraftDocx(sections, { showRedlines: boolean })`:
  - `showRedlines = true` → renders `<w:ins>` / `<w:del>` OOXML runs from remaining insertion/deletion marks so Word opens it as tracked changes.
  - `showRedlines = false` → current clean-accepted behavior.
- Add a menu item on the Counter-draft toolbar: "Export redline (.docx)" and "Export clean counter-draft (.docx)".

### 6. Persistence

- Store per-section metadata on the workspace document as JSON in an existing free-form field (e.g. `meta` / `body_meta`). If no such column exists, keep it session-local for v1 (matches current pending-diff semantics) and note it in the section rail as "Suggestions are session-local until accepted".

### Technical notes

- No new tables, no migrations.
- Reuses: `LegalEditor`, `SplitPane`, `Insertion`/`Deletion` marks, `useAiAssist` (add `intent` passthrough), `importDocx`, `ProposalCard` chips, `ChangePill`.
- New files: `src/lib/counterdraft.ts`, `src/components/editor/counterdraft-panel.tsx`, `src/components/editor/counterdraft-dialog.tsx`.
- Touched files: `src/routes/_authenticated/draft.tsx` (entry + mode toggle), `src/lib/useAiAssist.ts` (intent field), `src/lib/file-export.ts` (redline .docx), `supabase/functions/ai-assist/index.ts` (intent preface).
- PDF ingestion: I'll first check if `tabular-extract` already returns plain text I can reuse; if not, I'll add a tiny `pdf-extract` edge function that returns `{ text }`.

### Out of scope for this pass

- Cross-document conflict detection against our own filings (candidate for follow-up).
- Clause-library matching / preferred-language playbook (candidate follow-up; hooks in via the practice profile that `ai-assist` already injects).
- Multi-turn negotiation view (side-by-side markup exchange history).
