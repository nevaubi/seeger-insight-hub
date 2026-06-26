## 1. Bigger sidebar logo
- Expanded: bump from `h-5` to `h-8`, drop the width cap, let it fill the `px-3` brand block.
- Collapsed: bump from `h-5 / max-w-28px` to `h-6` centered in the icon rail.
- Slightly tighten the overline so the brand block stays compact.

## 2. Why nav clicks sometimes need a second tap

Root cause: the shell subscribes to `useRouterState({ select: s => s.location.pathname })` and then recomputes `active` for every `<Link>` on every render. Because that selector also fires for non-pathname router ticks (pending matches, loader state, history transitions), the entire sidebar re-renders mid-click. Combined with the `motion-safe:transition-[width]` on the `<aside>`, React occasionally commits a re-render between `pointerdown` and `click`, so the first click lands on an element instance that's been replaced and the synthetic click is dropped — you click again and it works.

Fix:
- Stop reading `pathname` in `AppShell`. Let each `<Link>` own its own active state via TanStack's built-in `activeProps` / `inactiveProps` and `activeOptions={{ exact }}`. Each Link re-renders independently, so the rest of the sidebar stays mounted and clicks are never replaced under the pointer.
- Make the active-state styling deterministic (no pseudo-element re-layout): use `data-[status=active]` Tailwind variants on the Link itself, with the left accent bar drawn via `border-l-2 border-transparent data-[status=active]:border-sidebar-primary`. Removes the `before:` pseudo-element that was added/removed on every active change.
- Add `preload="intent"` on each Link so hover warms the route — first click then resolves instantly.

## 3. Files
- `src/components/app-shell.tsx` — remove `useRouterState`, rewrite NAV `<Link>` to use `activeProps`/`inactiveProps`/`data-status`, drop the `before:` indicator, bump logo sizes.

## Out of scope
No router config changes, no route additions, no page-content changes.
