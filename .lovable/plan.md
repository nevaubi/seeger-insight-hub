# Dashboard Refinement

Scope: `src/routes/_authenticated/index.tsx` only (plus a tiny helper if needed). No data/query changes. No sidebar/shell changes.

## Problems with current UI
- Five uniform stat tiles read as a generic SaaS metrics grid.
- Icons in every card + colored highlight strip on Rule-702 row feel decorative rather than editorial.
- "Next critical dates" and "Recent orders" are both plain divided lists with near-identical headers — no hierarchy between them.
- "Strategic posture" card is thin (single paragraph + meta line) and floats awkwardly next to the taller calendar card.
- Header is a plain title/description; no sense of matter identity, docket status, or "as of" recency.

## Redesign moves

### 1. Masthead (replaces `PageHeader` on this route only)
Editorial two-column banner styled like a case caption:
- Left: small oxblood rule + "MDL 3140 · N.D. Fla. (Pensacola)" overline; serif matter name; italic serif subtitle; judge line with tabular figures.
- Right: compact "As of {date}" stamp + a single primary CTA ("Ask the Record →").
- Bottom hairline divider only — no card background.

### 2. Stat strip → "Docket at a glance" ledger
Replace 5 identical cards with a single bordered ledger row (like a case-caption table):
- Horizontal row of 5 cells separated by hairline dividers (no per-cell borders, no icons).
- Each cell: tiny uppercase label, large serif tabular number, small delta/context line under it (e.g. "5 in last 30d" for orders when we have data; static caption otherwise).
- Sits inside one bordered container with `bg-card`, feels like a printed masthead ledger.

### 3. Two-column body with clearer hierarchy
- **Left (2/3): Next critical dates** — keep list but restyle:
  - Remove the tinted background block on Rule-702 rows; instead use a slim oxblood left rule + a small serif "Gating event" pill in oxblood outline.
  - Date column becomes a two-line editorial stamp: day-of-week (uppercase micro) + serif date, then category badge.
  - Row hover: subtle bg-muted/30, no strong color.
- **Right (1/3): Strategic posture** — rebuild as a "Case brief" card:
  - Serif drop-cap-style opening paragraph (first letter enlarged serif, no gimmicky styling).
  - Definition-list of matter facts (MDL №, Court, Judge, Magistrate, Posture) with tabular alignment.
  - Small footer link "Practice profile →".
  - Give it matching height via `lg:sticky lg:top-4` so it anchors alongside the taller list.

### 4. Recent orders → "Docket activity" table
- Convert list to a proper 3-column table layout using CSS grid rows (date · order · tags), with a subtle header row.
- Remove the colored `OrderTypeBadge` visual weight — use a mono/tabular order-number style (e.g. "PTO 42") in oxblood-tinted small caps, no pill.
- Tags render as low-contrast text chips (bordered, no fill) capped at 3 with "+N more".
- Row: date on the left in tabular figures, title bold serif, tags on right; hairline dividers.

### 5. Motion & polish
- Replace the blanket `motion-fade-rise` on every section with one subtle staggered reveal on initial mount (via a small local component using CSS custom-property delays), respecting `prefers-reduced-motion`.
- Consistent vertical rhythm: sections separated by `space-y-8` (was `space-y-10`), header/body gutters aligned to `px-10`.

### 6. Loading state
- Replace centered spinner with proper skeleton (masthead + ledger + two placeholder cards) so first paint doesn't look empty.

## Technical notes
- All changes live in `src/routes/_authenticated/index.tsx`. No new files unless a small `<Masthead>` sub-component helps readability (kept in the same file).
- Continue using existing tokens (`--accent` oxblood, serif family, `t-eyebrow`, `t-meta`). No new colors.
- No changes to `dashboardQuery`, `PageHeader` (still used elsewhere), or shared components.
- Verify visually with a Playwright screenshot at 1280×1800 after changes.
