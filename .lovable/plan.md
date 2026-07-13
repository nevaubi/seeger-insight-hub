
# Drafting → Claude for Legal in Word (Phase 3)

Frontend only. Turn the current sidecar-and-editor into a Word-grade legal drafting surface with visible AI collaboration (track-changes, margin comments), keyboard-first authoring (slash menu, ghost completions), and live citation integrity.

## 1. Word-style Track Changes for inline transforms

Today Improve/Tighten/Bluebook silently replaces the selection. Word users expect to *see* the change and accept or reject it.

- Replace the direct `insertContentAt` in `runInlineTransform` with a two-tone diff overlay:
  - Wrap the original selection in a `<del class="tc-del">…</del>` mark; stream the new text into an `<ins class="tc-ins">…</ins>` mark immediately after it.
  - `.tc-del`: red strikethrough at 65% opacity. `.tc-ins`: green underline. Both inherit `.legal-prose`.
  - Anchor a floating "Change" pill above the range with **Accept**, **Reject**, **Regenerate**, and a diff-word count ("+18 / −12").
  - Accept collapses to `<ins>` text only; Reject restores the original; Regenerate re-streams into the same span.
- Add a document-level **Suggestions** toggle in `DocumentBar` (On/Off). When Off, transforms apply directly (current behavior). When On (default), every transform lands as a suggestion.
- New Tiptap marks (`Insertion`, `Deletion`) in `src/components/editor/track-changes.ts`; preserved through Turndown as HTML comments so markdown round-trip does not lose pending suggestions.

## 2. Margin comments pinned to the text

Replace the transient "Ask Claude on ¶" toast pattern with real margin threads, mirroring Word's review pane.

- New `CommentMark` Tiptap mark with a `commentId` attribute; renders a dotted underline in the prose.
- Right-margin rail inside the editor column stacks `CommentThread` cards vertically, aligned by CSS `top` computed from each mark's `getBoundingClientRect`.
- Each thread supports: quote of the anchored text, one AI reply (streamed via `ai-assist`, new `mode:'comment'`), and inline "Insert reply into document" or "Apply as edit" (routes back through §1).
- The BubbleMenu **Ask Claude** action now creates a comment thread on the selection instead of dispatching a window event. The sidecar chat stays for freeform drafting.
- Persistence: comments serialize as `<span data-comment="…">` and survive markdown round-trip via a Turndown rule.

## 3. Slash menu ("/") for legal inserts

Notion/Word-style command palette that opens on `/` at line start (or via `⌘/`).

- New `SlashCommandExtension` using Tiptap's Suggestion util. Commands:
  - Structure: H1/H2/H3, numbered section (I., A., 1., a.), block quote, hard rule, page break.
  - Legal blocks: **Case caption**, **Signature block** (from `matterScope`), **Certificate of service**, **Table of authorities placeholder**, **Footnote**, **Exhibit reference**.
  - Citations: **Insert citation…** opens the existing cite picker inline (reuses `formatShortCite` / `formatFullCite`).
  - AI: **Continue writing**, **Summarize above**, **Draft section from outline point** — each streams into a diff span (§1).
- Keyboard-navigated (↑/↓/Enter/Esc), styled to match the BubbleMenu.

## 4. Ghost-text autocomplete (Tab to accept)

- `GhostCompletionExtension`: on 800ms idle at end of paragraph, request a 1–2 sentence continuation from `ai-assist` (`mode:'continue'`, cheap model, capped ~60 tokens), context = last ~800 chars.
- Renders as a widget decoration in muted italic. `Tab` accepts (normal insertion, not tracked). `Esc` or continued typing dismisses.
- Feature-flagged via `DocumentBar` "…" menu (default **off** on first ship to watch cost).

## 5. Live cite-check with margin badges

Wire the existing `cite-check` edge function into the editor.

- Debounced (2s) pass: extract citation-like tokens (`PTO-\d+`, `CMO-\d+`, `Rule \d+`, `\d+ U\.S\.C\.`, etc.), send to `cite-check`.
- For each hit: subtle underline (blue = verified, amber = unresolved, red = conflicted) via a decoration set, plus a small dot in the right margin at the paragraph's y.
- Hover shows a card with the resolved order (title, date, page pin, source URL) and a one-click **Replace with Bluebook short form** action routed through §1.

## 6. Document outline (rail's second mode)

- Segmented control at the top of `DocumentRail`: **Documents** | **Outline**.
- Outline built from the editor's headings tree; click scrolls to that heading with a soft highlight flash.
- Drag-to-reorder headings via Tiptap `NodeRange` moves; also enables **Draft this section** per outline item (reuses §3 slash command).
- Collapsed rail gets a second icon strip button for Outline.

## 7. Editorial polish (small, high-signal)

- **Focus mode** (`⌘.`): dim all paragraphs except the one containing the caret to 40% opacity.
- **Page rulers**: faint hairlines every ~600px of scroll, toggled from "…" menu.
- **Live counts** in `DocumentBar` right cluster: word count, reading time, pending-suggestion count (§1), all `tabular-nums`.
- **Drop cap** option per document (stored in localStorage per doc id — no schema changes).

## 8. Sidecar refinements

- When a suggestion or comment exists at the caret, the sidecar shows a contextual header "Reviewing suggestion on ¶ 3" with the same Accept/Reject/Regenerate controls, so keyboard users never leave the sidecar.
- Proposal cards get an **Insert as tracked change** action alongside Apply — routes through §1.

## Technical details

New files:
- `src/components/editor/track-changes.ts` — Insertion/Deletion marks + accept/reject helpers
- `src/components/editor/comment-mark.ts` + `src/components/editor/comment-rail.tsx`
- `src/components/editor/slash-menu.tsx` + `src/components/editor/slash-commands.ts`
- `src/components/editor/ghost-completion.ts`
- `src/components/editor/cite-check-extension.ts`
- `src/components/editor/outline.tsx`

Extended:
- `legal-editor.tsx` — register new extensions, expose `applySuggestion`/`rejectSuggestion` via the `onReady` editor ref
- `draft.tsx` — Suggestions toggle in DocumentBar, comment rail slot, Outline mode in rail, live counts
- `tiptap-markdown.ts` — preserve tracked-change and comment spans through round-trip
- `styles.css` — diff colors, comment underline, margin rail, ghost text, focus mode, page rulers
- `useAiAssist.ts` — add `continue` and `comment` modes

No new dependencies (Tiptap's Suggestion util is already transitively present). No backend/schema changes; `ai-assist` already accepts arbitrary `mode`/`instruction`.

## Out of scope

Multi-user real-time cursors, redlines exchanged between users, DOCX-native track-changes export, voice dictation, retrieval changes.
