## Hide the "Live Docket" tab from the sidebar

Remove the Live Docket entry from the sidebar navigation across all matters so users can't reach it from the UI, while leaving the underlying route, data, and sync function intact (safe, fully reversible).

### Change

**File:** `src/components/app-shell.tsx`
- Delete the `{ to: '/docket', label: 'Live Docket', icon: ScrollText }` entry from the `NAV` array.
- Remove the now-unused `ScrollText` import from `lucide-react`.

### Intentionally NOT changed

- `src/routes/docket.tsx` — left in place. The route still exists at `/docket` (reachable only by typing the URL), so nothing breaks and we can restore the tab in one line if you change your mind.
- `supabase/functions/recap-sync/index.ts` and `recap_sync_state` / `v_recap_docket` queries — untouched.
- No other page references `/docket` via `<Link>`, so removing the nav item leaves no dangling links.

### Why this is safe

- The nav is the only entry point in the app — no other component links to `/docket`.
- Routing, data, and the sync edge function continue to work, so if any background process or future page needs the docket data it's still there.
- Reversal = re-add one array entry and one icon import.

If you'd rather also delete the route file entirely (harder to reverse, removes the URL too), say the word and I'll fold that in.