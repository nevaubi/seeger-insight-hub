## Goal
Replace the "MDL 3140 Command Center" wordmark with the Seeger Weiss LLP logo, and tighten the sidebar so it feels lean and well-organized instead of bulky.

## 1. Brand the sidebar with the Seeger Weiss logo
- Upload `ChatGPT_Image_Jun_25_2026_08_31_37_PM.png` via `lovable-assets` and import it as `src/assets/seeger-weiss-logo.png.asset.json` (CDN pointer, no binary in repo).
- Logo is navy-on-white. Sidebar is dark navy, so render it white using Tailwind `brightness-0 invert` on the `<img>`. Sized ~`h-7` expanded, `h-6` collapsed (icon rail).
- Replace the entire brand block:
  - Expanded: white Seeger Weiss logo, then a small `MDL {number} · Command Center` overline beneath it, then the MatterSwitcher. Drop the large serif title, the Scale icon, and the italic subtitle paragraph.
  - Collapsed: just the centered logo mark (no Scale icon).

## 2. Compact + organize the nav
- Reduce row height from `h-10` to `h-8`, icon `14px`, tracking `0.06em`, font-size `[10.5px]`. Group spacing `space-y-px`.
- Group items under tiny section overlines (hidden when collapsed):
  ```text
  WORKSPACE        Dashboard
  INTELLIGENCE     Orders Intelligence · Ask the Record
  CASE             Deadlines & Calendar · Roster & Key Players
  WORK PRODUCT     Drafting Workspace · Tabular Review
  ```
- Section label style: `px-4 pt-4 pb-1 text-[9.5px] uppercase tracking-[0.16em] text-sidebar-foreground/40`.
- Tighten brand block padding (`py-7` → `py-5`) and footer (`pt-5 pb-3` → `pt-3 pb-2`).
- Court-info footer block: collapse to a single muted line (`N.D. Fla. · Pensacola · Judge Rodgers`) to reduce visual weight.

## 3. Files touched
- `src/components/app-shell.tsx` — brand block + grouped/compact nav.
- `src/assets/seeger-weiss-logo.png.asset.json` — new CDN pointer (no binary added).

## Out of scope
No route changes, no theme/color token edits, no page-content changes.
