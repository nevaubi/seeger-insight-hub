# Fix: crash when collapsing the left doc panel on `/draft`

## Root cause
`DocumentRail` in `src/routes/_authenticated/draft.tsx` violates the Rules of Hooks:

```
line 1551  useMemo(filtered)   ← always runs
line 1559  useMemo(groups)     ← always runs
line 1577  if (!open) return … ← EARLY RETURN
line 1599  useMemo(outline)    ← only runs when open === true
```

When the user clicks the collapse button, `open` flips to `false`, the component renders with one fewer hook than the previous render, and React throws **Minified error #300** ("Rendered fewer hooks than the previous render"), which unmounts the whole draft page.

The tiptap `[link, underline]` duplicate-extension warning is unrelated noise — StarterKit v3 now bundles those.

## Fix (surgical, ~10 lines)

1. **`src/routes/_authenticated/draft.tsx`** — in `DocumentRail`, hoist the `outline` `useMemo` above the `if (!open) return …` block so all three hooks run on every render regardless of `open`.
2. **`src/components/editor/legal-editor.tsx`** — drop the standalone `Underline` and `Link` extensions (kept from StarterKit) to silence the tiptap warning; reconfigure Link via `StarterKit.configure({ link: { openOnClick: true, HTMLAttributes: { rel: 'noreferrer', target: '_blank' } } })`. Remove the now-unused imports.

## Non-goals
No visual changes, no rail behavior changes, nothing else touched.

## Verification
- Typecheck clean.
- Open `/draft`, click the collapse chevron → panel collapses to the 32px rail without crashing; expand again works.
- Console no longer shows the tiptap duplicate-extension warning.
