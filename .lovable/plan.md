
## Why nothing works today (root causes)

1. **Selection popover never appears.** `word-editor.tsx` renders `ClaudePopover` inside the same `shell` as SuperDoc, which has `overflow-hidden`, and does math against `shell.scrollTop` — but SuperDoc scrolls in its own inner container, so the badge either lands off-screen or is clipped. There's also no right-click affordance at all.
2. **"Copy for document" doesn't insert.** `appendToDoc` and `insertCitation` in `draft.tsx` only call `navigator.clipboard.writeText()`. That's why a click never moves text into the canvas.
3. **Letterhead / Caption / Signature / Certificate silently fail.** `insertMarkdownBlock` calls SuperDoc's `doc.markdownToFragment` / `doc.insert` with a shape that current SuperDoc (v1.44) doesn't accept for markdown fragments; the throw is swallowed by the toast. HTML-through-ProseMirror is the supported path.
4. **Layout wastes vertical space above the canvas.** Page header + `py-5` + the doc title strip stack ≈ 10rem before the page starts. Editor sits low, feels cramped.
5. **Claude branding is inconsistent.** A hand-drawn 12-ray SVG stands in everywhere, and the user's uploaded "Powered by Claude" wordmark isn't used yet.

## The fix — frontend-only, scoped

### 1. Make the Claude selection popover actually work
File: `src/components/draft/word-editor.tsx` (and small tweak to `claude-popover.tsx`).

- Portal both the floating pill and the expanded card to `document.body` via `createPortal`, positioned in **viewport coords** from `range.getBoundingClientRect()`. No more shell/scroll math, no clipping from `overflow-hidden`.
- Replace the 7×7 dot with a readable pill: `✦ Ask Claude   ⌘K` — appears just above the selection.
- Add a real **right-click context menu** on the SuperDoc shell (`contextmenu` handler, custom fixed-positioned menu since shadcn's DropdownMenu fights the native event):
  - Ask Claude about this…
  - Suggest edits (redline)
  - Add as comment
  - ─────
  - Copy
- Debounce → 60 ms; also listen to `mouseup` / `keyup` inside the shell so we don't miss selections. Capture the SuperDoc `selection.current().target` the moment the pill appears (not only on expand), so "Add as comment" always has a valid target.
- `⌘K` / `Ctrl-K` while a non-empty selection is inside the editor opens the popover directly.
- Tag the pill/popover DOM with `data-claude-ui` so the selectionchange handler doesn't treat clicks inside them as "selection lost".

### 2. Real one-click insert (append + citation) into the Word canvas
Files: `src/routes/_authenticated/draft.tsx`, `src/components/draft/word-editor.tsx`.

- Extend `WordEditorApi` with `insertMarkdown(md: string, where: 'cursor' | 'end')` and `insertPlain(text: string, where)`. Implement both by calling `editor.commands.insertContent(html)` on the underlying ProseMirror `Editor` — this is the supported path in SuperDoc and works even when `doc.markdownToFragment` is unavailable. Fall back to `doc.insert({ content: htmlFragment })` when `insertContent` isn't present.
- Rewire `appendToDoc(text)`: if `wordApi` is present, call `wordApi.insertMarkdown(text, 'cursor')`, save + rescroll to the insertion, toast "Inserted at cursor". Fall back to clipboard only if the API isn't ready (no active doc).
- Rewire `insertCitation(c, variant)`: build the short/full string, then `wordApi.insertPlain(text, 'cursor')`.
- Rename the button in `ChatBubble` from "Copy for document" → **"Insert into document"** with a `PenLine` icon, keep a secondary "Copy" for clipboard.

### 3. Fix letterhead / caption / signature / certificate
File: `src/components/draft/word-editor.tsx`.

- Rewrite `insertBlock` to build **HTML directly** (not markdown) for each block kind — SuperDoc's ProseMirror schema accepts HTML through `editor.commands.insertContent`. Letterhead/caption go at the top via `editor.commands.setTextSelection(0)` then `insertContent`; signature/certificate go at cursor.
- The header letterhead uses the Seeger Weiss logo already at `src/assets/seeger-weiss-logo.png.asset.json` — embed as an `<img>` in the HTML so it renders as an inline image inside the docx, and export round-trips it (SuperDoc handles inline images).
- Surface real failures (not just toast success) — if `insertContent` returns `false`, toast the reason.

### 4. Move the Word canvas UP, tighten the premium chrome
File: `src/routes/_authenticated/draft.tsx`, small CSS in `src/styles.css`.

- Collapse `PageHeader` on this route into a slim 40-px utility bar (title + save state + export + Claude wordmark on the right). Reclaim ~48 px above the canvas.
- Drop `py-5` → `py-2` on the page container; make the workspace `h-[calc(100vh-4.5rem)]`.
- Merge the blue "document title strip" with the SuperDoc toolbar area — one continuous chrome band, editor page starts immediately below it. Use a subtle `bg-gradient-to-b` (Word-blue 40% → 32%) so it reads as a single premium band.
- Give the canvas Card a soft `shadow-[0_1px_0_0_hsl(var(--border)),0_20px_40px_-24px_hsl(215_60%_20%/0.25)]` and 1-px oxblood top hairline so it reads as an elevated "page".
- Assistant pane: same top alignment; increase width to `max-w-[500px]` on ≥xl for chat comfort.

### 5. Claude branding: uploaded wordmark + real starburst logo
Files: new asset for the uploaded PNG, `src/components/claude-badge.tsx`, `src/components/claude-mark.tsx`, callsites.

- Upload `user-uploads://image-8.png` to Lovable Assets → `src/assets/powered-by-claude.png.asset.json`.
- `ClaudeBadge`: render the CDN image directly (`<img>` with `alt="Powered by Claude"`, height ~14 px, brightness/contrast tuned for light+dark). Remove the "Powered by Claude" text — the image IS the label. Keep it as a link-free identity mark.
- `ClaudeMark` (icon-only, used in the toolbar Claude pill, tab labels, source-preview headers): redraw as the **authentic Anthropic starburst** — eight tapered rays with the correct 45° spacing and slight curvature, coral `#C96442`. Keep it as inline SVG (no CDN dep, tree-shakable).
- Callsite audit: replace `ClaudeMark` with the wordmark where a "Powered by Claude" attribution is intended (page header chip, canvas top-right chip, chat empty state), and keep `ClaudeMark` where it's a compact icon (context-menu items, right-click header, in-canvas pill, tabs).

## Files touched

- `src/components/draft/word-editor.tsx` — popover portal, right-click menu, real insert API, HTML block inserts, tightened toolbar height.
- `src/components/draft/claude-popover.tsx` — portal, pill visual, keyboard hooks, `data-claude-ui` tags.
- `src/routes/_authenticated/draft.tsx` — real `appendToDoc` / `insertCitation`, "Insert into document" button, slim header, tightened heights.
- `src/components/claude-badge.tsx` — swap to uploaded wordmark image.
- `src/components/claude-mark.tsx` — corrected 8-ray Anthropic starburst.
- `src/assets/powered-by-claude.png.asset.json` — new CDN asset pointer.
- `src/styles.css` — soft page shadow token, focus ring on the canvas card, small `.claude-pill` styles.

No backend, no edge-function, no redline-pipeline, no auth changes.

## Technical notes

- **Why HTML through `editor.commands.insertContent`** and not `doc.markdownToFragment`: SuperDoc's public/stable insertion path is ProseMirror's `insertContent`. `markdownToFragment` exists but its shape has churned across SuperDoc versions; HTML round-trips through the OOXML converter without special-casing.
- **`createPortal` for the popover**: eliminates the `overflow-hidden` clipping issue, keeps positioning `position: fixed` at viewport coords, and lets the pill sit above the toolbar and side panels.
- **Right-click** must call `preventDefault` on `contextmenu` and be dismissed on outside click, ESC, and scroll. The menu is a lightweight local component (fixed positioning at `event.clientX/Y`), not shadcn's `DropdownMenu`, because DropdownMenu wants to own its own trigger event.
- **`getBoundingClientRect` for the selection** is viewport-relative, so the browser keeps it correct while SuperDoc scrolls internally — no need to re-listen to scroll events.
- The Claude wordmark image is served through Lovable Assets and referenced by its CDN URL — no binary lives in the repo.
