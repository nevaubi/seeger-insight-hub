
# Drafting: "Claude-for-Legal" upgrade

## Research anchor (what we're modeling after)

**Claude for Word** (Anthropic, Nov 2025) and **Thomson Reuters CoCounsel Drafting** are the two current benchmarks. Common pattern across both:

- **Inline sidecar assistant** anchored to the document, not a separate chat page. Selecting text triggers a small floating action ("Ask Claude" / "Ask CoCounsel"). Hovering a paragraph reveals a subtle mark icon in the left gutter that opens the same prompt.
- **Structured proposal cards** in the sidecar (not free-form chat): each suggestion is a discrete card with a one-line label ("Limit indemnification…", "Insert notice clause"), a preview of the change, and Apply / Reject / Snooze. Applied edits go in as **tracked changes** so authorship is auditable.
- **Track-changes redlines by default** for anything that touches the body. The model proposes edits as verbatim-anchored ops (we already do this in `ai-assist/anchor.ts` — the redline protocol is built).
- **Section-aware navigation**: right side shows a "Summary of Counterparty Edits" / section outline (§1 Definitions, §2 Obligations…) — the doc *has* structure and the UI shows it.
- **Legal-aware formatting**: numbered sections auto-render (I., A., 1., (a)), block quotes, defined terms bolded, `Id.` and short-form cites styled distinctly, footnotes inline with hover-preview, small-caps for parties, tabular alignment for signature blocks.
- **One-click voice/tone actions**: Formalize, Plain-English, Tighten, Persuasive, Neutral — all operating on selection with a live diff preview before commit.
- **Minimal chrome**: no giant page header, no big padding at the top; document sits close to the top edge, toolbars are single-row, and the sidebar is a thin utility rail. The document is the hero.

Sources: Anthropic Claude for Word announcement + product page; Thomson Reuters CoCounsel Drafting/Word add-in docs; images the user uploaded (`user-uploads://image-9..13.png`) — the pattern is consistent across all three.

## Current problems (from `src/routes/_authenticated/draft.tsx`)

- **Plain `<textarea>`** with monospace-ish editing — no per-sentence targets, no rich formatting, markdown is only visible in Preview.
- **Top of screen is padded twice**: `PageHeader` (title + description block) + a second toolbar strip. Uses ~180px before any document surface.
- **Assistant is a chat panel**, not a sidecar. Proposals are prose blobs, not applyable cards.
- **Transform bar** is stuck to the top of the editor and shows even when nothing is selected (opacity-50 clutter).
- **Citations render as chips inside chat**, not as first-class inline elements in the document.
- **No sentence-hover affordance, no floating selection menu, no diff/redline preview.**

## Direction

Build a Tiptap-based editor with a sidecar redesign, matching the Claude/CoCounsel pattern. Keep the existing edge functions (`ai-assist`, redline protocol) unchanged — they already return the right shape. All the work is in the frontend.

## Plan

### 1. Editor: replace textarea with Tiptap

Add `@tiptap/react`, `@tiptap/starter-kit`, `@tiptap/extension-placeholder`, `@tiptap/extension-typography`, `@tiptap/extension-link`, `@tiptap/extension-underline`, `@tiptap/extension-highlight`, `@tiptap/extension-table` + row/cell/header. Serialize to Markdown both ways using a small adapter (reuse `markdownToBlocks` for export; add `markdownToTipTap` + `tiptapToMarkdown` via `turndown` or a hand-rolled serializer sitting on ProseMirror JSON — we already carry Markdown, so we can go MD ⇄ HTML through `marked` + a Tiptap HTML paste).

Editor surface:
- Serif body (`Source Serif 4`, 15.5px / 1.72), 72ch column, centered, ivory paper background with a hairline shadow. Numbered lists auto-style to `1.` / `(a)` / `(i)` at nesting levels. Blockquote gets an accent left rule. Defined terms (`**Recipient**` in MD) render bold small-caps in the doc.
- Citation nodes: extend Tiptap with a `citation` inline node so `[[cite:ref]]` in Markdown renders as a superscript numbered pill with hover card (label + page + Open PDF). Round-trips cleanly to MD for export.
- Placeholder is a serif italic prompt, not the empty grey block.

### 2. Hover-per-sentence "Ask Claude"

Two affordances, both wired to the same panel handler:

- **Left-gutter mark**: an invisible ProseMirror decoration on the current hovered paragraph shows a small Claude mark (reuse `ClaudeBadge`'s `img` — the orange sunburst) in the left gutter with a subtle "Ask Claude" tooltip. Click opens the sidecar composer, pre-scoped to that paragraph.
- **Selection bubble**: on non-empty selection, a floating menu appears above the selection (Tiptap `BubbleMenu`) with: Improve · Tighten · Formalize · Plain English · Ask Claude… (custom). Each button runs the existing `runTransform` and streams the replacement in-place with a diff highlight (green add / strikethrough delete) that resolves to plain text on accept.

### 3. Voice/prose one-click improvers

Extend the existing `TRANSFORMS` catalog with a small, curated **Voice palette** presented as icon buttons in the BubbleMenu and as a dedicated "Voice" pill in the sidecar:

- Improve · Tighten · Formalize · Plain English · Persuasive · Neutral · Fix cites (runs `cite-check`) · Bluebook-ify

All hit `ai-assist` in transform mode; result streams as a diff overlay the user accepts or rejects. The Voice palette is one shortcut menu, not a strip that eats vertical space.

### 4. Sidecar (replaces the chat pane)

Right rail becomes a **Claude sidecar**, not a chat:

- **Header**: matter chip · "Claude" wordmark · Ground toggle · overflow.
- **Composer** at the bottom (single line growing to 4), placeholder rotates through prompts pulled from the same `question_suggestions` pool ("Draft a §3 confidentiality clause…", "Explain §7 in plain English…").
- **Body** shows an ordered stream of **proposal cards**, one per model response. Each card:
  - Title (one-line label the model returns as its first line; we already do this loosely)
  - Preview of the change (first ~2 sentences)
  - Chips: Apply · Preview diff · Copy · Dismiss
  - Redline mode: when the model returns NDJSON anchor-ops (existing protocol), each op is its own sub-card with Apply/Reject; parent card shows "3 of 5 applied".
- **Citations** attached to a card are shown as compact numbered chips, same Bluebook menu as today, but the primary insertion path now is "Apply" which drops a real citation node at the anchor.

Removes the free-form chat bubbles and their large parchment blocks.

### 5. Section outline (right-of-sidecar mini-rail, collapsible)

Auto-derived from heading nodes. Click a heading to scroll. Shows counts of open redlines per section (like CoCounsel's "Summary of Counterparty Edits" screenshot).

### 6. Header collapse + spacing overhaul

- Drop the `PageHeader` block on this route only; replace with a **single 44px document bar**: `[matter chip] · [document title inline-edit] · [save status] · [export] · [voice ▾] · [•••]`. Removes ~110px of vertical chrome.
- Editor page-container padding tightens: `px-8 pt-3 pb-4` (was `px-8 py-5` + PageHeader).
- Document rail: collapse to 40px icon rail by default on this page; expands on hover or when clicked. Recovers ~220px of horizontal space, giving the document more breathing room.
- Assistant rail widens slightly to 460px and pins bottom-composer.
- Overall: document surface starts ~55px from the top of the viewport instead of ~180px.

### 7. Markdown & legal formatting polish

- Wire `.answer-prose` (existing) plus a new `.legal-prose` layer in `styles.css`:
  - Numbered list counters styled `1.` `A.` `(1)` `(a)` by depth
  - Block quotes: `border-l-2 border-accent/50 pl-4 italic text-foreground/85`
  - `<sup class="cite">` gets `.t-num` + underline-on-hover
  - Signature block utility (`.sig-block` — 2-col tabular)
  - Section headings: serif, small-caps for §, tight tracking
- The `preview` mode is retired; the Tiptap editor IS the preview (WYSIWYG), toggling only shows a "Read mode" that hides the gutter marks and BubbleMenu.

### 8. Retained (don't break)

- All edge functions and `useAiAssist` API stay identical.
- Bluebook cite helpers (`formatShortCite`, `expandLabel`, footnote emitter) reused.
- Export (docx / pdf / md) reuses `markdownToBlocks` — Tiptap → MD serializer feeds it.
- Templates (`DRAFT_TEMPLATES`) surface as a "Start from template" menu in the empty state and in the sidecar overflow.

## Files touched

- `src/routes/_authenticated/draft.tsx` — largely rewritten around Tiptap and the new sidecar.
- `src/components/editor/legal-editor.tsx` (new) — Tiptap wrapper, BubbleMenu, gutter decoration, citation node, diff overlay.
- `src/components/editor/ask-claude-menu.tsx` (new) — floating menu + voice palette.
- `src/components/editor/proposal-card.tsx` (new) — sidecar cards + redline sub-cards.
- `src/lib/tiptap-markdown.ts` (new) — MD ⇄ ProseMirror.
- `src/styles.css` — `.legal-prose`, gutter styles, diff highlight tokens, sidecar chrome.
- `src/components/app-shell.tsx` — allow a route to opt out of `PageHeader` (a `bare` prop) so drafting can use the tight top bar.

## Out of scope

- Backend / edge function changes (protocol already supports what we need).
- Real-time multi-user or comments (we keep single-author for now).
- Word `.docx` **import** with tracked-changes preservation (we already export; import is a separate effort).
- Auth or role scoping.

## Verification

Playwright pass on `/draft`:
- Load with existing doc — top of document sits ≤60px from viewport top.
- Hover a paragraph — Claude mark appears in the gutter within 150ms.
- Select a sentence — BubbleMenu appears; click Formalize; stream in; accept diff.
- Ask sidecar for a "meet-and-confer letter" — receives proposal card with Apply; Apply drops formatted content into the document with citations as inline superscripts.
- Export DOCX — round-trips content, headings, lists, and citations.
