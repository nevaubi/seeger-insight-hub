## Why every tab-switch flashes blank

Two things stack up on each navigation:

1. **`_authenticated/route.tsx` uses `ssr: false` + `supabase.auth.getUser()` in `beforeLoad`.** `getUser()` is a network round-trip to Supabase on *every* navigation, and `ssr: false` forces the whole authenticated subtree to suspend on the client while it resolves. With no pending UI, Suspense falls back to `null` → white page.
2. **The router has no `defaultPendingComponent` and no `defaultPreload`.** Route chunks are code-split, so the first time you hit `/orders`, `/deadliness`, etc., the browser downloads a JS chunk with nothing on screen.

Both are fixable without touching any feature code.

## Changes (2 files)

### `src/routes/_authenticated/route.tsx`
- Replace `supabase.auth.getUser()` with `supabase.auth.getSession()` — reads the session from local storage synchronously, no network hop. Only redirect when there is genuinely no session. (`onAuthStateChange` in `__root.tsx` already invalidates the router when auth state actually changes, so staleness isn't a concern.)
- Drop `ssr: false`. The guard runs in `beforeLoad` either way; removing it stops the subtree from suspending on every client transition.
- Add a `pendingComponent` that renders the existing `AppShell` chrome with a subtle skeleton in the content area, so sibling navigation keeps the sidebar/header on screen instead of unmounting to blank.

### `src/router.tsx`
- `defaultPreload: 'intent'` — prefetch the route chunk + loader data on link hover/focus, so the click itself is usually instant.
- `defaultPendingMs: 150`, `defaultPendingMinMs: 300` — don't show any pending UI for fast transitions, and if we do show it, don't flicker it away.
- `defaultPendingComponent` — a minimal shell-shaped placeholder used as a last-resort fallback (route-level `pendingComponent` above takes precedence for authenticated pages).

## What stays the same
- No changes to `/auth`, sign-out, or any feature route.
- No changes to queries, matter scoping, or `MatterProvider`.
- `onAuthStateChange` listener in `__root.tsx` is untouched — it still invalidates on real sign-in/out.

## Expected result
- Hover a sidebar link → chunk + data preload.
- Click → sidebar and header stay mounted; content area either swaps instantly or shows a brief skeleton (never a full white page).
- Auth check is now local storage, not a network call, so it doesn't gate paint.
