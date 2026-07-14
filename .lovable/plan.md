## Fix 1 — Accept/Reject/Retry pill not appearing after regenerate

**Root cause.** The pill only renders when a track-change is created, and that only happens on the "suggestions ON" path in `runInlineTransform` (src/routes/_authenticated/draft.tsx:595). When we removed the "Suggest" header button in a prior pass, we left the underlying `suggestionsOn` state — which reads from `localStorage['draft.suggestions']`. Any user (like you) whose localStorage still has `'0'` from an earlier session now silently falls into the OFF path: the edit is applied in-place, no `changeId` is created, and `ChangePill` has nothing to anchor to.

**Fix.** Since there's no longer a UI to toggle suggestions, force the ON path always:
- Remove the `suggestionsOn` state, its localStorage read/write, and the `if (!suggestionsOn) { …direct replace… }` branch in `runInlineTransform`.
- Always create the deletion/insertion track-change pair and stream into it, so `ChangePill` renders with Accept / Reject / Retry every time.

No changes to `ChangePill` itself — it works, it just wasn't being given a `changeId`.

## Fix 2 — Slim, minimal Placeholder navigator

Rework `src/components/editor/placeholder-rail.tsx` into a compact vertical rail:
- Drop the header ("Placeholders" title + count) and the empty-state paragraph.
- Drop the token text (`[party name]`, `{{date}}`, index number).
- Render each placeholder as a small circular dot button (~10px), stacked vertically with tight spacing. Hover reveals the token as a tooltip (`title` attr) only.
- Container shrinks from a card to a bare ~20px-wide column of dots; no border, no background, no header chrome.
- When zero placeholders remain, render nothing (rail disappears).
- Click behaviour unchanged: focus + scroll + pulse.

Also narrow the reserved column in `draft.tsx` (`hidden xl:block shrink-0`) so the editor reclaims the width.

## Files touched
- `src/routes/_authenticated/draft.tsx` — remove `suggestionsOn` + OFF branch; tighten the placeholder rail slot.
- `src/components/editor/placeholder-rail.tsx` — minimal dot-only rail.
- `src/styles.css` — new minimal `.placeholder-rail` / `.placeholder-dot` styles (replace the card styles).

No edge-function or data changes.