## Polish: Change-review pill — anchor closer to the edit, smoother visuals

### Problem
The Accept / Reject pill has no CSS at all (`.change-pill*` classes exist but no rules), so it renders as unstyled inline text. It also floats at `top: coords.top - 34` regardless of whether the diff sits near the top of the viewport, so on selections near the top it can drift off-screen and it feels disconnected from the highlighted text.

### Change 1 — Anchor logic (`src/components/editor/change-pill.tsx`)
- Measure both the start (`range.from`) and end (`range.to`) of the change to compute a natural anchor point.
- Prefer placing the pill **just above** the change; if there isn't ~40px of room above (near top of scroll area), flip it to sit **just below** the change instead. Track a `placement: 'top' | 'bottom'` in state so the caret arrow points the right way.
- Nudge the pill horizontally to align with the start of the diff (clamped inside the editor gutter), so it visibly "belongs" to the highlighted span.
- Add a tiny opening transition (opacity + 4px slide) using an `is-open` class toggled after mount via `requestAnimationFrame`, so the pill fades in instead of snapping.

### Change 2 — Visual design (`src/styles.css`, new block near the other editor styles)
Add a dedicated `.change-pill` design using existing tokens (parchment/navy/oxblood — no hardcoded colors):

- Compact rounded-lg card (`~9px` radius), soft shadow (`0 8px 24px -12px oklch(...)`, plus 1px hairline border in `--border`), `backdrop-filter: blur(8px)` over a translucent `--popover` background.
- 28px min height, `padding: 4px 4px 4px 8px`, `gap: 4px`, `font-family: var(--font-sans)`, `font-size: 11.5px`, `letter-spacing: 0.01em`.
- `+N / −N` diff counter: subtle emerald / oxblood dot indicators (tokenised as `--tc-add`, `--tc-rem` so we don't hardcode hex) with `font-variant-numeric: tabular-nums`.
- Vertical divider = 1px `--border`, 14px tall.
- Buttons: 24px tall, 6px horizontal padding, `border-radius: 6px`, icon + label. Hover = `bg-secondary/60`, focus-visible = 1px accent ring. Accept variant = accent text on hover with subtle `--tc-add` tint; Reject = subtle `--tc-rem` tint on hover; Retry = neutral muted.
- Caret arrow (6×6 rotated square) tokenised to the same popover bg + border, positioned bottom-center by default and top-center when placement flips.
- Streaming state: shows the spinner + "Streaming…" in muted text with a soft pulse; keeps the +/− counter visible so users see the diff grow.
- Motion: `transition: opacity 140ms ease, transform 160ms cubic-bezier(.2,.7,.2,1)`; opening from `translateY(4px)` (or `-4px` when flipped) to `0`. Respect `prefers-reduced-motion` (disable the transform, keep opacity fade).

### Change 3 — Tokens (`src/styles.css`, `:root` and `.dark` blocks)
Add two semantic tokens next to existing editor tokens:
```
--tc-add: oklch(...)   /* muted emerald derived from --accent-friendly, not hex */
--tc-rem: oklch(...)   /* muted oxblood derived from --destructive */
```
Reused for both the `<ins>` / `<del>` marks and the pill accents so the whole track-changes surface reads as one system.

### Verification
- `/draft`: highlight a paragraph mid-document → pill floats just above the diff, aligned to the left of the selection, arrow points down at the change.
- Highlight the first line at the top of the document → pill flips below, arrow points up, stays fully visible.
- Streaming → pill shows spinner + live +N/−N counter, no jumpiness.
- Accept / Reject / Retry hover states feel intentional; keyboard focus rings visible; reduced-motion users get the fade only.
