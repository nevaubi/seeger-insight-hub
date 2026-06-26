## What's there today

A two-pane workspace: a Markdown editor (title + plain `<textarea>` + preview toggle) on the left, and a "Drafting assistant" chat (with a "Ground in record" toggle and 4 starter templates) on the right. Bonus features: a selection-transform toolbar (Improve / Formalize / Shorten / Expand / Custom) that streams a rewrite back into the editor, a cite-check panel that verifies citations against CourtListener, and Word/PDF/Markdown export. Documents are listed in a dropdown.

The bones are solid. The polish gaps are mostly: a flat `<textarea>` editor, a hidden document list, weak grounding affordances in chat, and citations that don't visibly tie back to the prose.

## Improvements, tiered

### Tier 1 — high impact, contained scope

1. **Real document list as a left rail** (collapsible, like the sidebar). Replace the "Documents ▾" dropdown with a slim third column showing all drafts grouped by recency, with search, pin, rename-in-place, and a per-row updated-at. Keeps the dropdown as a fallback on narrow screens. Wins discoverability dramatically.

2. **Cited drafts that actually show citations.** When `ground` is on, render `[1]`, `[2]` superscripts inline in assistant replies that hover/click to a footnote panel listing the order, page, and a "Insert citation" button. Today `citations` and `chunks` come back but aren't surfaced beyond the chat bubble.

3. **"Insert as section" / "Replace selection" actions on every assistant reply.** Right now we only have copy / insert-at-cursor / append. Add: replace-current-selection, insert-as-new-section (`## Heading`), and a diff preview before applying.

4. **Floating selection menu.** The transform bar is at the top of the editor — easy to miss. Add a small popover that appears next to a selection (like Notion / Linear) with the same 4 actions + Custom + "Ask about this." This is also where `ai-assist`'s `insight` mode (already built into the edge function but unused on this page) plugs in.

5. **Autosave + version history.** A 1.5s-debounced save kills the "Save •" cognitive load. Persist a lightweight `workspace_document_versions` row on each save (or every N edits) so attorneys can roll back. Show "Saved 12s ago" in the toolbar.

### Tier 2 — meaningful UX upgrades

6. **Outline / mini-map.** Auto-extract `#`/`##` headings into a right-side outline (or a slide-out) for jump-to-section in long memos. Show word count per section.

7. **Slash-command menu in the editor** (`/`): insert heading, bulleted list, blockquote, citation placeholder `[CITE ORDER]`, hr, today's date, matter short-name, judge name. Faster than reaching for Markdown.

8. **Grounding chips in chat.** Above the composer, show small chips for the passages the assistant actually used in its last answer (order + page), with click-to-open the PDF. Makes record-grounding visible instead of implicit.

9. **Templates expansion + custom user templates.** The 4 starters are good; add ~6 more (Daubert section outline, deposition prep, exhibit list, privilege log cover, response to RFP, joint status report) and let users save their own prompts as templates per matter.

10. **Cite-check inline highlighting.** Today flagged citations live in a bottom panel. Also underline them in the preview (red for not-found, amber for ambiguous, green for verified) and put a status dot in the editor gutter so authors see issues where they wrote them.

### Tier 3 — bigger lifts, optional

11. **Switch from `<textarea>` to a true rich-text editor (Tiptap/ProseMirror).** Unlocks proper headings, bold/italic toolbar, footnote/citation nodes, comments, and inline diffing for AI edits. This is the only structural change in the list; everything else builds on the current textarea.

12. **Suggest-mode AI edits.** Instead of streaming directly into the document, stream into a tracked-changes overlay the attorney accepts or rejects per paragraph. Requires #11.

13. **"Compare against the record" pass.** A one-click run that takes the current draft, extracts factual assertions, and flags any sentence that the matter's record doesn't support — using the same retrieval the assistant uses. Like cite-check but for record facts, not citations.

14. **Per-document chat thread persistence.** Right now assistant chat history dies on reload. Persist it next to the document so attorneys can pick up where they left off.

## My recommendation for a first build

Tier 1 items 1, 2, 4, and 5 — left rail, visible citations, floating selection menu, autosave + "Saved Xs ago." That set lands the biggest perceived-quality jump without rewriting the editor.

Tell me which subset you want and I'll implement.
