## Scope

Two surgical removals in `src/routes/draft.tsx` only. No backend changes — the `cite-check` edge function stays deployed but unused (safe; nothing else calls it).

## 1. Remove the Cite-Check button + panel

- Delete the toolbar button (line ~528) that calls `runCiteCheck`.
- Delete the `<CiteCheckPanel …>` render block (~line 590) and the `CiteCheckPanel` component definition (~line 621+).
- Delete the supporting state and handlers: `citeResult`, `citeChecking`, `runCiteCheck`, `jumpToCite`, and any highlight overlay driven by `citeResult`.
- Remove now-unused imports: `CiteCheckSummary`, `CiteCheckResult`, the cite-check invoke helper, and any icon used only by that button (e.g. `ShieldCheck` / `BadgeCheck`).

## 2. Remove the message-level "Insert" button (keep Append)

In `ChatBubble` (~line 1235), delete the `Insert` `<Button>`. Keep the `Append` button immediately below it unchanged.

Propagate the removal up:
- Drop the `onInsert` prop from `ChatBubble` and from `AssistantPane`'s prop list.
- Remove the `onInsert={insertAtCursor}` wire-up at the `<AssistantPane …>` call site (~line 604).
- Delete the now-unused `insertAtCursor` helper in the parent (the one that toasts "Inserted into document").

## What stays (intentionally)

- The **citation chip** dropdown ("Insert at cursor / Short / Full / Footnote") under each `[n]` chip — that's the Bluebook citation inserter, not the message-level Insert. It remains because the user asked to keep citation functionality and only remove the message Insert button.
- `appendToDoc`, the Append button on each assistant message, and autosave behavior — unchanged.
- The `cite-check` edge function source — left in place; safe to delete later if desired.

## Verification

- Typecheck: no dangling references to `citeResult`, `runCiteCheck`, `insertAtCursor`, `CiteCheckSummary`, `CiteCheckResult`.
- Manual: open `/draft`, confirm the Cite-Check toolbar button is gone, assistant messages show only "Append" (plus the existing Copy / Sources actions), and citation chips still insert correctly.

Does this match what you wanted? In particular: confirm I should **keep** the per-citation "Insert at cursor" dropdown on the `[n]` chips — only the big message-level Insert goes away.
