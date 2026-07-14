## Drafting page polish — 3 surgical additions

### 1. Compact the body type
Current editor body sits around 17–18px with generous leading, which reads oversized on a 1214px viewport.

- Drop base body from ~17px → **15px** (headings scale down proportionally: H1 26→22, H2 20→18, H3 17→16).
- Tighten line-height 1.7 → **1.55** for body, 1.35 for headings.
- Ligatures + tabular-nums stay on. Print/DOCX export sizing untouched — this is screen-only via the `.legal-editor-content` scope in `src/styles.css`.

### 2. Visible page/document boundaries
Give the editor real paper chrome so it reads as a document, not a text box.

- Wrap the ProseMirror surface in a `.page-sheet` element: white (`--card`) rectangle, `box-shadow: 0 1px 2px, 0 8px 24px -12px`, thin `1px` hairline border in `--border`, `8.5in` max-width capped by container.
- Parchment/navy app background shows around it → the sheet floats.
- Optional faint 1in margin guides (dashed `--border/40`) toggled by a small "Show margins" switch in the DocumentBar, off by default.
- Simulated page-break rules: every ~11in of content height, render a horizontal seam (`::before` pseudo on paragraphs crossing the boundary is fragile; instead a fixed decorative `background-image: repeating-linear-gradient` in the sheet gutter, purely visual). Cheapest, no layout math.

### 3. Placeholder navigator rail
Detect bracketed placeholders anywhere in the doc and expose a smooth vertical timeline.

- Parse the editor JSON on every debounced change for text matching `\[[^\]]+\]` and `\{\{[^}]+\}\}`. Store `{ id, label, pos, resolved }` where `resolved = false` when brackets remain.
- New right-edge rail component `PlaceholderRail` inside the editor column (thin 32px gutter or an overlay pill stack anchored top-right of the sheet). Each entry: small dot + truncated label. Sticky, scrolls with sheet.
- Click → `editor.commands.setTextSelection(pos)` + smooth `scrollIntoView({ block: 'center' })` + a 1.2s pulse ring on the token (temporary decoration mark).
- Counter chip at top: "3 placeholders remaining". Turns green + collapses when zero.
- Keyboard: `⌘J` / `Ctrl+J` cycles to the next placeholder.
- Lives alongside the existing Claude sidecar — it's a 220px collapsible strip between editor and sidecar, or floats over the sheet's right margin on narrow viewports.

### Files touched
- `src/styles.css` — new `.legal-editor-content` sizing, `.page-sheet`, optional margin-guide utility.
- `src/components/editor/legal-editor.tsx` — wrap content in `.page-sheet`, emit placeholder positions upward via a callback prop.
- `src/components/editor/placeholder-rail.tsx` *(new)* — the timeline + click-to-scroll + pulse decoration.
- `src/routes/_authenticated/draft.tsx` — mount `PlaceholderRail`, wire count chip into DocumentBar, add margin-toggle state (localStorage-persisted).

### Out of scope
- No true multi-page pagination (would require ProseMirror page-break plugin; expensive, brittle).
- No changes to DOCX/PDF export sizing.
- No changes to Claude sidecar behavior.

Est. work: ~1 focused pass, ~250 lines net.
