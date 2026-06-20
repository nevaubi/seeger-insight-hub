## Problem

The Dashboard SSR throws a hydration mismatch (`Jun 23, 2026 — Jun 25, 2026` vs `Jun 24, 2026 — Jun 26, 2026`), which aborts the Suspense boundary and leaves the preview blank ("agent failing to output").

Cause: `fmtDate` in `src/components/case-ui.tsx` does `new Date('2026-06-24').toLocaleDateString('en-US', ...)`. ISO date-only strings parse as UTC midnight, then format in the renderer's local timezone — server (UTC) and browser (local) disagree by one day for every date the app displays.

## Fix

Make `fmtDate` timezone-independent by parsing the `YYYY-MM-DD` parts directly and formatting from a static month table — no `Date` object, no locale, no timezone. Same output on server and client.

```ts
const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return d;
  const [, y, mo, day] = m;
  return `${MONTHS[+mo - 1]} ${+day}, ${y}`;
}
```

`fmtDateRange` is unchanged (already delegates to `fmtDate`).

## Scope

- Edit only `src/components/case-ui.tsx` (`fmtDate` body).
- No changes to data, routes, synthesis stream, or styling.

## Verification

- Reload `/` — Dashboard renders without the Suspense/hydration error in console.
- Spot-check Orders, Deadlines: dates render identically (same `Jun 24, 2026` formatting).
- Confirm Ask the Record still streams a synthesis answer.