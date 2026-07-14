
## Goal

Trim visual bulk on the Depositions pages so the entire experience sits inside one viewport, matches the editorial tone of the rest of the app, and reads as a professional litigation tool. Frontend-only — no data, API, or feature changes.

## Depositions index (`src/routes/_authenticated/depositions.index.tsx`)

Current problem: three tall stacked blocks (metrics band, upload card, list) push the transcript list below the fold and duplicate every filter and label.

Changes:
- Replace `<PageHeader>` block with a slim editorial header row: title `Depositions` (serif, 22px), matter name in muted mono to the right, `Upload transcript` primary button on the right. Removes the ~140px bespoke hero.
- Kill the 6-metric ledger band. Fold the same numbers into a single-line summary strip under the header (`24 transcripts · 3,182 pp · 18 analyzed · 42 helpful / 19 harmful · 61 exhibits`) with muted labels and tabular-nums. Saves ~110px.
- Convert the always-visible upload Card into a collapsible drawer opened by the header's `Upload transcript` button (uses existing `Sheet` component). The drop zone, witness fields, and auto-analyze switch move into the sheet unchanged. When the sheet is closed the list starts near the top of the viewport.
- Compact the filter row: search input (h-8) + three small `Select`s become icon-prefixed dropdowns on a single 32px-tall bar aligned right of the "Recent depositions" heading, using the same bordered pill style as Orders. Drop redundant `ArrowUpDown` icon and the standalone `Clear` button (fold into an X inside the search input when any filter is set).
- List rows: reduce Card padding from `p-4` to `px-4 py-3`, remove the leading `ChevronRight`, use a 3-column grid `[minmax(0,1fr)_auto_auto]` (title/meta | count chips | status pill) so metadata stops wrapping. Move `filename` off the primary row into a `title` tooltip. Findings summary chips (`helpful/harmful/adm./ex.`) render as one right-aligned tabular strip instead of a wrapped chip cloud.
- Empty state: single centered line instead of a Card.

## Deposition workspace (`src/routes/_authenticated/depositions.$id.tsx`)

Current problem: the 140px header eats vertical space, the transcript pane's toolbar is two rows deep, and both panes scroll independently inside a page that already scrolls.

Changes:
- Slim header: shrink from `py-8` to `py-4`, drop the "Depositions" back-link into a tiny left-aligned breadcrumb chip, put title + alignment badge + subtitle bits on a single row, and move `Export` + `Re-run analysis` into a compact right-aligned toolbar with icon-only buttons and a shared `MoreHorizontal` overflow.
- Pane container: switch from the fixed `grid-cols-[58%_1fr]` layout to the existing `SplitPane` (`storageKey: 'depo-split'`, default 58%) so the divider is draggable and matches the search route. Set page container to `h-[calc(100vh-var(--depo-header,4rem))]` so only the panes scroll — the page itself no longer overflows.
- Transcript toolbar: collapse to a single 36px row — search input (flex-1) with inline regex toggle and match counter on the right edge; the speaker segmented control (`All / Q / A / Obj`) becomes a compact 24px pill row directly under the search only when filters are active. Removes the second toolbar row for most sessions.
- Sticky page headers: reduce from `py-1` band to a hairline `py-[2px]` label; use `Page 12` in mono-caps only.
- Findings pane: remove the outer `Card` chrome from every tab (`SummaryTab`, `AdmissionsTab`, `ChronologyTab`, `ExhibitsTab`, `QualityTab`, `AskTab`) — keep the tab strip flush with the pane, list rows separated by hairline `divide-y` instead of nested cards. Row padding drops from `p-4` → `px-3 py-2.5`, action buttons collapse into a hover-revealed row (`Send / Copy / Pin`) instead of always-visible.
- Mobile toggle pill: keep, but restyle to match the segmented controls used elsewhere (no drop-shadow, thinner border).

## Shared

- No new components required. Reuse `SplitPane`, `Sheet`, `DropdownMenu`, existing `Badge` variants, and `cn`.
- Preserve every existing prop, mutation, keyboard shortcut, and handler — this is a CSS/layout pass only. No changes to `depo-api`, `depo-export`, `useSynthesisStream`, or Supabase queries.

## Out of scope

- No changes to analysis logic, edge functions, or types.
- No color-token additions — reuses existing `--primary`, `--secondary`, `--border`, `--muted-foreground`.
- No touch to `AppShell`, `case-ui`, or other routes.

## Verification

After edits: read both files, then load `/depositions` and `/depositions/$id` via Playwright at the current 970×635 viewport and confirm the primary content (upload trigger, first list row, or transcript + findings top rows) is visible without scrolling.
