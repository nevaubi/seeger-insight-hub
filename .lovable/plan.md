## Fix: Drafting page freezes when clicking a Claude bubble-menu option

### Root cause
`src/components/editor/change-pill.tsx` runs a `useLayoutEffect(() => { ... })` with **no dependency array**. Inside, it calls `setPos({ top, left })` and `setDiff({ added, removed })` with brand-new object literals on every render. As soon as `activeChangeId` is assigned (which happens the moment a Claude voice action starts), React re-renders → the effect fires again → new object refs → another re-render → infinite loop → tab freezes.

The freeze is also amplified by the `editor.on('transaction', force)` listener bumping a counter on every ProseMirror transaction while streaming, but the primary bug is the unguarded effect.

### Change (single file)
`src/components/editor/change-pill.tsx`

1. Give the position/count effect a real dependency list: `[editor, changeId, tick]`, where `tick` is the existing `force` counter — so it re-measures on transactions and when the active change changes, not on every render.
2. Only call `setPos` / `setDiff` when the values actually change (shallow compare top/left and added/removed) so identical objects don't trigger another render.
3. Keep the `null` short-circuit path but guard it the same way (only `setPos(null)` if it isn't already `null`).

### Verification
- Reload `/draft`, highlight a paragraph, click "Persuasive" (or any bubble-menu Claude action).
- Expected: change pill appears above the pending diff, streams the suggestion, page stays responsive; no browser freeze / no "page unresponsive" dialog.
- Toggle Suggestions off, repeat with a direct in-place transform — no regression.
