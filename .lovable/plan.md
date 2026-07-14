
## What the errors actually are

**Ignore (not your app):**
- `Code WebSocket closed prematurely` — Lovable preview HMR/Sentry socket reconnect. Only appears in the Lovable editor iframe; never on the published site.
- `[Violation] Permissions policy 'unload' is not allowed` — Lovable preview iframe policy warning. Same story — preview-only, harmless.
- `Checking for app updates` / `Lovable Script — v1.6.0` — Lovable's update-check chatter, not our code.

**Real, worth fixing:**

1. **`TypeError: Cannot read properties of null (reading 'sequence')` (0.8.67:1)**
   This is Tiptap's ProseMirror plugin state reading a null node. Two likely triggers in `src/components/editor/legal-editor.tsx`:
   - `HoverParagraphExtension` calls `state.doc.resolve(...)` and `$pos.before(1)` without guarding for an empty doc / depth 0 → when the editor is empty or first paints, `nodeAt(start)` can be null and downstream code inside Tiptap chokes.
   - `useEditor` may fire `onUpdate` after the component is unmounting (e.g. when you click through the document rail and the editor destroys mid-transaction).

2. **`GET …/v_question_suggestions … 404 (Not Found)`**
   We flipped `SUGGESTIONS_VIEW_ENABLED = true` in `src/lib/supabase.ts`, but the external Supabase project doesn't have `v_question_suggestions` (hint says the closest table is `document_suggestions`). Every matter switch fires this query and 404s.

## Fixes

**File 1 — `src/components/editor/legal-editor.tsx`**
Harden `HoverParagraphExtension`:
- Guard `apply` against invalid positions (clamp to `doc.content.size`, ignore when doc is empty).
- In `decorations`, bail if `state.doc.content.size === 0`, if resolved `$pos.depth < 1`, or if the top-level node isn't a block (defensive `try/catch` returning `null` on any throw so a stale hover pos from a prior doc can never crash the plugin).
- In `handleDOMEvents.mousemove`, only dispatch when `pos.pos` actually changed (prevents a transaction storm during streaming edits).

Also destroy-safety on the editor:
- In `onUpdate`, early-return if `ed.isDestroyed`.
- In the external-value reconciliation `useEffect`, check `instance.isDestroyed` before `setContent`.

**File 2 — `src/lib/supabase.ts`**
Flip `SUGGESTIONS_VIEW_ENABLED` back to `false` until the `v_question_suggestions` view actually exists in the external DB. The suggestions UI already handles the disabled path gracefully (returns the built-in matter starters). No 404s, no console noise.

Optionally, add a one-line comment noting the view name the backend needs to expose so we can re-enable it later.

## Out of scope

- The WebSocket/Permissions-Policy/update-check logs come from Lovable's preview shell; we can't and shouldn't try to silence those from app code.
- No backend/SQL changes — I can't create the missing view in the external Supabase project. If you want the suggestions carousel back, that view has to be added on the backend side and I'll flip the flag on again.

## Verification

- Reload `/draft` and click through paragraphs — no more `sequence` TypeError.
- Switch matters on any page — no more `v_question_suggestions` 404.
- The remaining `WebSocket closed` / `unload` / `app updates` lines will still appear in the Lovable preview and that is expected.
