## Fixes

### 1. Sidebar — fixed viewport height
Today the sidebar stretches with page content because it lives inside a `min-h-screen flex` row. Change the `<aside>` to `h-screen sticky top-0` with `overflow-hidden`, and make the `<nav>` `flex-1 overflow-y-auto` so long nav lists scroll internally instead of stretching the page. Brand block and footer toggle stay pinned top/bottom.

### 2. Logo — currently renders as a white box
Root cause: the uploaded PNG has a solid white background. `brightness-0 invert` turns every opaque pixel white, so the whole rectangle becomes white.

Fix: generate a transparent-background variant of the logo via `imagegen--edit_image` (`transparent_background: true`), save as `src/assets/seeger-weiss-logo-white.png`, and use it in the sidebar with `brightness-0 invert` so only the navy wordmark pixels become white on the navy sidebar. Drop the old asset reference. (Keep the old `.asset.json` in case it's wanted elsewhere later; if not we can delete it, but it's harmless.)

### 3. Sidebar width — reduce 22%
- Expanded: `w-56` (224px) → `w-44` (176px) — exactly 21.4% narrower.
- Collapsed: `w-14` (56px) → `w-11` (44px).
- Tighten brand padding to fit (`px-4` → `px-3`) and nav padding (`px-2` → `px-1.5`).

## Files
- `src/components/app-shell.tsx` — height/sticky behavior, width tokens, swap logo import.
- `src/assets/seeger-weiss-logo-white.png` (new, transparent) — generated from the existing logo.

## Out of scope
No nav grouping changes, no color tokens, no page content edits.
