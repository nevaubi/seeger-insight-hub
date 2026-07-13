# Drafting page — vertical fit, collapsible rail, editorial paper polish

Four surgical fixes. Frontend only. Files touched: `src/routes/_authenticated/draft.tsx`, `src/components/editor/legal-editor.tsx`, `src/styles.css`.

## 1. Panels cleanly touch the bottom of the screen

Current: `<div className="lg:h-[calc(100vh-6.75rem)] lg:flex lg:overflow-hidden">` reserves 108px but the `DocumentBar` is only 54px, so the rail / editor / sidecar stop ~54px short of the viewport.

Change to `lg:h-[calc(100vh-54px)]` (matches the actual `h-[54px]` bar). Add `overflow-hidden` on the AppShell's `<main>` container path only where needed so the page itself does not scroll — inner panels own their scroll.

Also:
- Editor column: add `min-h-0` and make `<LegalEditor className="flex-1 min-h-0">` so its internal `overflow-y-auto` kicks in.
- `DocumentRail` and `ClaudeSidecar` are already `flex-col` with `flex-1 overflow-y-auto` inside — verify their outer `<aside>` also has `h-full min-h-0` so they visually reach the bottom edge (no dead band under the last item).
- `.legal-editor-shell` gets `display: flex; flex-direction: column; min-height: 0; height: 100%;` so `.legal-editor-content` (already `height: 100%; overflow-y: auto`) actually scrolls instead of expanding the page.

## 2. Left document rail — collapsible from its own edge

Today the rail only toggles via the `Layers` icon in the top bar. Add a slim edge affordance so it feels native:

- Add a 12px hover strip on the rail's right edge with a chevron button (`ChevronsLeft` when open, `ChevronsRight` when closed).
- When collapsed, render a 32px-wide vertical rail (not fully hidden) with just the chevron + a stacked "Docs" label rotated -90°, so the user can expand from the edge without hunting the top bar.
- Persist `railOpen` in `localStorage` under `draft.railOpen` so reloads remember it.
- Keep the top-bar `Layers` button as an alternate toggle for parity with the sidecar toggle.

## 3. Editorial paper polish (`.legal-prose` + editor frame)

Small changes tuned for a Claude-for-Legal feel:

- Widen measure to `72ch` and center; increase top/bottom padding to `3rem 4rem 8rem` so the first line breathes below the 54px bar.
- Body: `font-size: 16px; line-height: 1.75; letter-spacing: 0.005em;` (Source Serif 4). Enable `font-feature-settings: "onum" 1, "liga" 1, "kern" 1;` and `hanging-punctuation: first last;`.
- Headings: tighten leading, add subtle top-border on `h2` (`border-top: 1px solid color-mix(in oklab, var(--border) 70%, transparent); padding-top: 1rem;`) for section separators typical of briefs.
- First paragraph after each heading: `margin-top: 0.35rem;` and `text-indent: 0` (kill the default extra space). Optional small caps on the first 3 words of the first paragraph after `h1` via `.legal-prose h1 + p::first-line { font-variant: small-caps; letter-spacing: 0.04em; }`.
- Numbered lists: tabular-num markers already set — add `padding-left: 1.75rem` and `li { padding-left: 0.35rem; }` for a firmer indent hierarchy (I / A / i mirrors brief style).
- Blockquote: bump left border to 3px and add a faint left bg tint (`background: color-mix(in oklab, var(--accent) 4%, transparent);`), remove italic (real brief blockquotes are upright).
- `hr` becomes a centered fleuron `···` (via `::before` on a bordered `hr`) for section breaks.
- Add a subtle vertical rule between rail / editor / sidecar (already borders) and a `bg-[color-mix(in_oklab,var(--card)_35%,transparent)]` paper tint behind the editor column so the "page" reads as a document surface, not raw background.

## 4. Small correctness bits picked up along the way

- `.legal-editor-content .ProseMirror` currently uses `max-width: 78ch` — align to the new `72ch` and use `padding-inline: clamp(1.5rem, 6vw, 4rem)` so the paper doesn't hit the rail edge on narrower laptops.
- `.legal-gutter-mark` uses `left: max(1rem, calc((100% - 78ch) / 2 - 2.25rem))` — update the `78ch` here to match the new measure or the gutter marker drifts off the paragraph on wide screens.

## Out of scope

No changes to `ProposalCard`, `ai-assist` function, templates, save/export logic, or matter/routing wiring.
