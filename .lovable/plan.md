## Goal

Make the drafting assistant feel like a tool built by litigators: a real catalog of MDL document types with form-correct starter prompts, and citations that obey Bluebook conventions (parentheticals, pin cites, short forms, *id.*) with flexible insert options.

## 1. Expanded, MDL-aware template catalog (`src/routes/draft.tsx`)

Replace the four-card `DRAFT_TEMPLATES` with a categorized catalog rendered as a small tabbed launcher (Correspondence · Motions & Briefs · Discovery · Case Management · Hearing Prep · Leadership / PSC). Each template carries: `category`, `icon`, `title`, `docType` (e.g. "Letter", "Motion", "Stipulation", "Bench Memo"), `summary`, and a structured `prompt` that tells the assistant the form to produce — caption block, headings, signature block, certificate of service where applicable.

Catalog (≈18 templates, all MDL 3140 / N.D. Fla. flavored):

- **Correspondence** — Meet-and-confer letter (discovery deficiencies); Rule 26(f) follow-up letter; Deposition-scheduling letter; Litigation-hold reminder to client group; Letter to Magistrate Judge Cannon re: discovery dispute (per the controlling discovery order's pre-motion procedure).
- **Motions & Briefs** — Motion to compel (outline w/ argument headings + governing standard in the Eleventh Circuit); Opposition to motion to quash subpoena; Daubert / Rule 702 response section (general causation, ties to the gating hearing); Motion for leave to exceed page limit; Motion to seal under the operative confidentiality order.
- **Discovery** — Plaintiffs' First RFPs to Defendants (numbered, with definitions/instructions block); Subpoena duces tecum to non-party; ESI protocol stipulation (skeleton, tracks the CMO); Protective-order stipulation amendment.
- **Case Management** — Joint status report to Judge Rodgers; Proposed PTO/CMO draft (caption + ordered paragraphs); Status-conference agenda; Deadline & obligations summary keyed to current CMO.
- **Hearing Prep** — Bench memo for upcoming hearing; Cross-examination outline (expert witness); Oral-argument outline w/ anticipated questions.
- **Leadership / PSC** — Common-benefit time-submission memo to participating firms; PSC update memo to co-leads; Lone Pine / threshold-proof compliance analysis memo.

Each `prompt` is a few sentences telling the assistant: the document type, who it's from/to (PSC / Seeger Weiss / Judge Rodgers / Magistrate Cannon as appropriate), the form to follow (caption header for court filings, letterhead block for letters, numbered ordered paragraphs for proposed orders), required sections, and an instruction to insert `[BRACKETED]` placeholders for facts not in the record. Example for the meet-and-confer letter prompt:

> "Draft a meet-and-confer letter from Seeger Weiss LLP to defense liaison counsel addressing outstanding discovery deficiencies. Use full letter form: date line, addressee block, `Re:` line referencing *In re Depo-Provera*, MDL No. 3140, salutation, body organized as numbered deficiency items each citing the controlling discovery order and the specific request at issue, a proposal of meet-and-confer times within the next seven days, and a closing signature block for [ATTORNEY NAME], Seeger Weiss LLP. Reserve all rights. Insert `[BRACKETED]` placeholders for any fact not in the record."

The empty-state grid becomes a compact two-row tab strip + scrollable card list (still no DB changes; pure UI).

## 2. Stronger system prompts (`supabase/functions/ai-assist/index.ts`)

Rewrite `draftSystem(matter, grounded)` to enforce document-form discipline. Additions:

- Identify the document type from the user instruction and produce the correct form: court filings get a proper caption block (court, division, *In re:* line, MDL No. 3140, Case No., Judge Rodgers, Mag. Judge Cannon) followed by document title, body with numbered headings (I., II., A., B.), signature block, and a Certificate of Service stub when filed. Letters get date / addressee / `Re:` / salutation / numbered body / sign-off. Proposed orders get caption + "IT IS ORDERED that…" numbered paragraphs + signature line for the Court.
- Use defined terms once introduced; tabular-friendly numbered lists for deficiencies, requests, deadlines.
- Citation style is Bluebook: parenthetical *signal*, full case name italics on first cite, pin cite, court & year (`Daubert v. Merrell Dow Pharms., Inc., 509 U.S. 579, 592–93 (1993)`); record cites use short forms (`PTO-12 ¶ 4`, `CMO-3 § II.B`, `Order at 5`). Use `*id.*` for an immediately repeated source and `*supra*` for an earlier-cited record document.
- When grounded passages exist, cite them inline using Anthropic's native citations (already wired) and *also* render the human Bluebook short-form in the prose so the exported document reads correctly without a UI layer; flag unsupported claims with `[CONFIRM: cite controlling order]` rather than fabricating.
- Never invent case names, docket numbers, or dates. Placeholders use `[BRACKETED ALL-CAPS]`.

`transformSystem` gains a one-liner: if the selection appears to be a citation, normalize it to Bluebook short form.

## 3. Citation UI upgrades (`src/routes/draft.tsx`)

The `[n]` chips stay, but each chip's `+` button becomes a small menu (popover or dropdown) offering three insertion variants:

- **Inline parenthetical** — ` (PTO-12, at 4)` (current behavior, refined formatting)
- **Full citation** — ` (Pretrial Order No. 12, *Case Management Order*, at 4 (N.D. Fla. [DATE]))` built from `order_label` + `title` + `page`
- **Footnote-style** — appends `[^n]` at cursor and a `[^n]: …` definition at the document end (one round-trip via the existing `onAppend`)

Citation-chip hover shows the cited quote (already there) plus a "Copy Bluebook" action that copies the formatted short form.

Repeated-source handling: when the user inserts the same source twice in a row, the second insertion suggests `*id.* at [page]` (and `*id.*` with no pin if the page matches). Detection is a simple scan of the text immediately preceding the cursor.

The Sources strip under each assistant message gains a "Copy as Sources appendix" button that emits a Markdown list ready to paste at the end of a brief, matching the `synthesis-export.ts` style.

## 4. Out of scope (call out)

- No schema or RPC changes.
- The cite-check (CourtListener) flow is unchanged; this PR only changes how the assistant produces and inserts citations, not how they're verified.
- No new dependencies.

## Technical notes

- Template catalog lives next to `DRAFT_TEMPLATES` as a typed array; tab state is local to `AssistantPane`.
- The Bluebook short-form formatter is a small pure helper (`formatShortCite(chip)`) reused by chip insertion and the "Copy Bluebook" action.
- `*id.*` detection: regex over the last ~200 chars of `content` before `selectionStart`.
- All edits are confined to `src/routes/draft.tsx` and `supabase/functions/ai-assist/index.ts`.
