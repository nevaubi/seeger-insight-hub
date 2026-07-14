Plan: Drafting page polish + AI edit pill reliability

1. Make the placeholder navigator dots slightly larger and better spaced
- Increase dot size from 8px to about 10px.
- Increase vertical spacing from 6px to about 9px.
- Slightly widen the rail so hover/focus states do not feel cramped.
- Keep the minimal dot-only design.

2. Fix Accept / Reject / Retry disappearing after the first successful AI edit
- The current inline AI edit flow stores the Tiptap editor only in a ref, so React does not reliably re-render `ChangePill` when the editor becomes ready or when subsequent edits create a new change.
- Add a small reactive `editorInstance` state alongside the existing ref and pass that state into `ChangePill` and `PlaceholderRail`.
- When a new inline AI transform starts, force the new change id through React state before streaming begins so the pill remounts/repositions for every run.
- After streaming finishes, verify the insertion/deletion marks still exist; if they do, keep `activeChangeId` set so the pill remains visible.

3. Harden the pill positioning
- Make `ChangePill` reposition on scroll/resize in addition to editor transactions.
- If coordinates briefly fail during rapid selection/streaming updates, keep the last good position instead of immediately unmounting the pill.

Files to touch
- `src/routes/_authenticated/draft.tsx`
- `src/components/editor/change-pill.tsx`
- `src/styles.css`

Expected result
- The dot rail is still minimal, but more legible and better spaced.
- Every time highlighted text is refined/regenerated, the Accept / Reject / Retry pill appears near the edited text and stays visible until accepted or rejected.