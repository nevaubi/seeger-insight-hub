## Add basic email/password auth (gate the whole app)

Add Lovable Cloud email/password authentication with a minimal `/auth` login page. Every existing route becomes protected; unauthed visitors are redirected to `/auth`. No signup UI, no roles, no email confirmation. Accounts are created manually by you in the backend Users panel.

This is additive — no existing route files, queries, or data flow change. The external Supabase project holding the litigation data (`blhcucozljrojnvqosyi`) is untouched; auth uses the separate Lovable Cloud Supabase project (`gpbaczvqtpsenghicfpm`) already wired into `@/integrations/supabase/client`.

### What changes

1. **Configure auth** (Lovable Cloud)
   - Enable email provider, auto-confirm on, signup disabled, HIBP on.

2. **New file: `src/routes/auth.tsx`** (public)
   - Minimal email + password form styled to match the parchment/navy editorial theme (Source Serif heading, Inter inputs, oxblood submit).
   - Calls `supabase.auth.signInWithPassword`, on success navigates to `search.redirect ?? "/"`.
   - Shows a generic error on failure. No "Sign up" link, no "Forgot password" link (internal tool, manual account creation).
   - Redirects to `/` if already signed in.

3. **New file: `src/routes/_authenticated/route.tsx`** (integration-managed pattern)
   - Pathless layout with `ssr: false`, `beforeLoad` calls `supabase.auth.getUser()`, redirects to `/auth` when no user.
   - Renders `<Outlet />`.

4. **Move every existing route under `_authenticated/`** (file renames only, no code edits)
   - `src/routes/index.tsx` → `src/routes/_authenticated/index.tsx`
   - `deadlines.tsx`, `orders.tsx`, `roster.tsx`, `search.tsx`, `review.tsx`, `draft.tsx`, `docket.tsx`, `depositions.tsx`, `depositions.index.tsx`, `depositions.$id.tsx` → same names under `_authenticated/`
   - TanStack Router regenerates `routeTree.gen.ts` automatically. URLs stay identical (`/`, `/orders`, `/depositions/$id`, etc.) because `_authenticated` is pathless.

5. **Root subscribes to auth changes** (`src/routes/__root.tsx`)
   - Add one `supabase.auth.onAuthStateChange` listener that calls `router.invalidate()` on `SIGNED_IN` / `SIGNED_OUT` / `USER_UPDATED` so the gate re-evaluates.

6. **Sign-out control** in `src/components/app-shell.tsx`
   - Small "Sign out" button in the sidebar footer: cancels queries, clears the query cache, `supabase.auth.signOut()`, then `navigate({ to: "/auth", replace: true })`.

### Safety notes

- No database migrations, no schema changes, no RLS work (nothing user-scoped exists).
- The external litigation Supabase client in `src/lib/supabase.ts` is untouched; it stays anon read-only.
- Route moves are pure file renames — component code, queries, and the `matter` search param all keep working.
- `MatterProvider`, `QueryClientProvider`, and `Toaster` in `__root.tsx` stay wrapping `<Outlet />`, so both `/auth` and protected routes get them.
- Accounts: after this ships, you create the first user from the backend Users panel (I'll surface a "View Backend" button).

### Technical details

- Uses `@/integrations/supabase/client` (Lovable Cloud); bearer middleware in `src/start.ts` stays as-is.
- Managed `_authenticated` layout uses `ssr: false` because Supabase stores the session in `localStorage`; server-side gating would loop on refresh.
- No new packages.
