# Surgical Frontend Polish

No structural rewrites, no new features — just tightening what already exists so the app reads as one coherent editorial law-firm surface. Scope is limited to `src/styles.css`, `src/components/app-shell.tsx`, `src/routes/_authenticated/index.tsx`, `src/routes/_authenticated/search.tsx`, and small touch-ups in `src/components/case-ui.tsx`.

## 1. Global tokens & typography

Goal: one visual voice, no drift between pages.

- **Type scale**: define a small utility set (`.t-eyebrow`, `.t-h1`, `.t-h2`, `.t-body`, `.t-meta`, `.t-num`) in `styles.css` so every page pulls from the same ramp instead of ad-hoc `text-[13px]`. Serif reserved for h1/h2 + numeric hero figures; Inter everywhere else.
- **Eyebrow labels**: standardize the tracked uppercase eyebrow (`text-[10.5px] tracking-[0.14em] uppercase text-muted-foreground`) — currently spelled 5 different ways.
- **Border/divider tone**: audit `border-border` vs raw hairlines; introduce `--border-strong` for section separators and `--border-soft` (currently borders read a hair too heavy on parchment).
- **Radius**: unify to `rounded-sm` for chips/badges, `rounded-md` for controls, `rounded-lg` for cards. Remove stray `rounded-xl` on the sidebar and evidence rail.
- **Focus ring**: single token (`ring-1 ring-ring/60 ring-offset-2 ring-offset-background`) applied via a `.focus-ring` utility; today several components override with mismatched colors.
- **Motion**: consolidate remaining `transition-all` into `transition-colors` / `transition-[background,border]` with `--dur-fast` so hovers feel uniform.
- **Numerals**: ensure `tabular-nums` on every date/number cell (a few slipped through in Dashboard KPIs and timeline elapsed times).

## 2. Shell + Dashboard

Goal: quieter chrome, sharper hierarchy, better rhythm.

Sidebar (`app-shell.tsx`):
- Tighten vertical rhythm: nav rows to `h-8`, group labels to the standard eyebrow, 12px gap between groups.
- Logo lockup: align optical size, add 1px hairline under lockup only when expanded, remove the current soft divider.
- Matter switcher: reduce visual weight (borderless, hover-only chevron), align baseline with nav.
- Active state: swap current filled pill for a 2px accent bar on the left + `bg-sidebar-accent/40`, keeps the navy chrome calmer.
- Collapsed rail: center icons on a 44px grid, tooltip on hover with the same eyebrow style.
- Footer: single-line user block, remove duplicated separators.

Dashboard (`_authenticated/index.tsx`):
- KPI cards: unify to same height, serif number + eyebrow label + delta meta; drop mixed `Card` paddings.
- Section headers: eyebrow + serif h2 + right-aligned action link (currently inconsistent per section).
- "Next up" and "Recent orders" lists: shared row component look — same left rule, same spacing, same date column width.
- Remove the double-bordered container around the docket watcher card; sit it on the parchment with only an internal hairline.

## 3. Ask the Record (`_authenticated/search.tsx`)

Goal: calmer canvas, more editorial timeline, tighter composer. No behavior change.

Launcher (resting state):
- Center column max-width 640px; serif prompt (`t-h1`), muted subhead.
- Suggestion deck: 2×2 grid of quiet cards (hairline border, no shadow), category eyebrow on top, question in serif. Shuffle as a ghost icon-button aligned right of the eyebrow row.

Composer:
- Single hairline border, subtle inner shadow removed; focus adds accent hairline (not glow).
- Submit button: square 36px, `bg-primary` only when input has content, otherwise ghost.
- Halo animation: dial opacity to 0.25 max and only render on focus (currently always on).

Timeline (active state):
- Rail: 1px `border-l` in `--border-soft`, nodes are 8px circles flush to the rail (currently mixed 6/10px).
- Node color = tool accent (retrieval=primary, web=gold, verify=accent, plan=muted). Consolidate into one `stepAccent()` helper instead of per-branch classnames.
- Row layout: `grid-cols-[16px_1fr_auto]` — dot / content / elapsed. Elapsed time uses `.t-num text-muted-foreground` and animates in with `motion-stream-in`.
- Reasoning text: reduce to `text-[13.5px] leading-[1.55]`, ivory background swapped for transparent so it sits on the canvas.
- Shimmer: only on the currently-running node's label, not on completed ones (a couple stay shimmering today).
- Collapse animation into the answer: keep, but ease with `--ease-out-soft` at `--dur-slow` and fade the rail out at 60%.

Answer (resting/final):
- Serif h2 header "Answer", ivory removed, hairline above sources block.
- Citations: inline superscripts styled with `.t-num` + underline on hover, matching evidence rail numbering.
- Follow-up chips: same chip style as suggestion deck for continuity (currently a different pill).

Evidence rail:
- Sticky header becomes a two-line block (eyebrow + count), hairline bottom only.
- Cards: remove inner shadow, use hairline + `hover:bg-muted/40`. Passage number in serif, matter/doc meta in `.t-meta`.

## Technical notes

- All work in the listed files plus small additions to `styles.css` (new utilities, no token color changes beyond adding `--border-soft`).
- No changes to routing, data hooks, edge functions, or the streaming state machine.
- No new dependencies.
- Verify with a quick Playwright screenshot pass on `/`, `/search`, sidebar collapsed + expanded, and the active-run state, in both empty and populated forms.

## Out of scope

Data pages (Orders/Deadlines/Roster/Docket), Depositions, Review, Drafting, auth pages, and any backend/edge changes.
