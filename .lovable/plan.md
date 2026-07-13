
# Drafting fixes — inline transforms land in place, no auto-scroll, cleaner Claude column

Frontend only. Three files: `src/components/editor/legal-editor.tsx`, `src/routes/_authenticated/draft.tsx`, `src/components/editor/proposal-card.tsx` (+ tiny `src/styles.css` tweak for the wider column measure).

## 1. Refined text now lands where the selection is (not at the bottom)

Root cause: `runInlineTransform` calls `content.indexOf(selected)` on the markdown source. The selection comes from the rendered Tiptap document (plain text of a list item, an inline-formatted run, a bullet, etc.). It rarely matches the raw markdown string byte-for-byte — bullets, `**bold**` markers, list numbers, hard line breaks all differ — so `indexOf` returns `-1` and the code falls into the "append to end of document" fallback. That is the "output appears at the bottom" bug.

Fix by carrying the ProseMirror positions across the boundary instead of doing a fragile string search:

- Extend `LegalEditor`'s `onVoiceAction` payload to include the actual editor range: `onVoiceAction({ instruction, selectionText, from, to })`.
- Also expose the editor instance via a ref (`editorRef`) from `LegalEditor` so `DraftPage` can call Tiptap commands directly. (Ref forwarded through a new `onReady?: (editor: Editor) => void` prop — simpler and avoids `useImperativeHandle` boilerplate.)
- Rewrite `runInlineTransform` in `draft.tsx` to operate on the editor range, not on markdown:
  - Capture `{ from, to }` at click time (already stable because the BubbleMenu still has focus).
  - Stream deltas into a scratch buffer.
  - On each flush (rAF-throttled), call `editor.chain().insertContentAt({ from, to: from + prevInsertedLen }, markdownToHtml(buffer), { updateSelection: false }).run()` — replaces only the previously-inserted span, never the whole doc.
  - Do NOT call `.focus()` or pass `scrollIntoView`. `insertContentAt` alone does not scroll when `updateSelection: false`.
  - After completion, do one final replace with the sanitized final text; sync markdown back via the editor's normal `onUpdate` path (already wired), so the persisted markdown stays authoritative without us doing `setContent` on the whole document.
- Remove the "fallback: append at end" branch entirely. If the range is somehow invalid (empty selection), just no-op with a toast — never dump refined text at the document bottom.

## 2. No more auto-scroll after highlight + Claude improve

Two things drive the jump today:
1. `setContent(before + acc + after)` on every delta reflows the entire ProseMirror doc; Tiptap resets viewport in some paths.
2. Toast + focus stealing.

Fixes:
- The new range-based `insertContentAt` above is local, so ProseMirror does not reflow the whole doc.
- Wrap the streaming updates in a scroll-preservation guard on `.legal-editor-content`: capture `scrollTop` before each flush, restore it after (belt-and-suspenders for any residual jump).
- In `LegalEditor`, when a voice action fires, do NOT call `editor.commands.focus()` afterwards. Keep the BubbleMenu closed by clearing the selection to a collapsed cursor at `to` only after the final flush, with `{ scrollIntoView: false }`.
- Sidecar auto-scroll: `ClaudeSidecar` currently scrolls its own panel to the newest proposal on every append. That is fine for chat, but should NOT run for the inline-transform path (which does not create a proposal card). No change needed there since inline transforms don't touch `proposals`, but confirm by leaving the sidecar untouched in this path.

## 3. Claude column — wider, denser, better aligned

Sidecar column and proposal cards are cramped at `w-[440px]` with `text-[13.5px]` inside a narrow measure.

- Widen the sidecar: `lg:w-[520px] xl:w-[560px]` (still comfortably fits at 1280 with rail open; sidecar remains user-collapsible via the top-bar toggle).
- Proposal card body:
  - Bump content padding to `px-4 pb-3.5`, header to `px-4 py-3`.
  - Prose: `text-[14px] leading-[1.7]`, `max-w-none`, `hyphens-auto`, `text-pretty` for balanced wrapping.
  - Tables inside answers: `w-full text-[12.5px]` with `th` uppercase tracking, zebra rows via `tbody tr:nth-child(even)`.
  - Citation chips: allow wrapping to a second row cleanly (`gap-y-1.5`), tighten chip radius to `rounded-md`, and align the `[n]` marker + label + pin on a single baseline (`items-baseline` instead of `items-center`) so numbers don't look like they float above the text.
  - Header row: replace the truncated `line-clamp-2` first line with a two-line summary and drop the `truncate` on the scope label so long scopes wrap instead of getting cut.
- Add a subtle 1px hairline between stacked cards (`.proposal-card + .proposal-card { border-top: 1px solid var(--border); }` in `styles.css`) rather than the current gap-only rhythm — reads more like a document.
- Sidecar header: keep 40-ish px height but move the Beta pill + Ground switch onto a single baseline with the title; today the switch pushes to the right edge and the title feels off-center at wider widths.

## 4. Template cards — better click feedback and hit target

The cards work, but the interaction feels dead because the whole panel keeps its idle state until the first stream delta arrives (2–4s on cold requests).

- On click, immediately swap the picked card into a compact "Preparing <template title>…" state with a spinner and disable the other cards, so the user sees the click registered.
- Increase card hit area padding (`py-3`) and give the icon a small circular badge (`h-6 w-6 rounded-full bg-accent/8`) for a firmer press target and clearer visual hierarchy.
- Category pill row: switch from horizontal scroll to a wrapping row (`flex-wrap gap-1.5`) so all six categories are visible without scrolling in the wider column.
- Keep the same prompts and template list unchanged.

## Out of scope

- No changes to `useAiAssist`, `ai-assist` edge function, matter/routing wiring, exports, autosave, or the document rail behavior.
- No change to how proposals are created in the sidecar chat — only visual polish inside `ProposalCard`.
