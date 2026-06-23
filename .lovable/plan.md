# Fix "Rendered fewer hooks than expected" in the agent timeline

## Root cause

In `src/routes/search.tsx`, `RunCard` has an early `return` for the collapsed-and-done summary state (lines ~937–956). After that early return, there's still a `useMemo` for the unified `timeline` (line ~967). Hook count therefore changes when `timelineOpen` flips, which React forbids — hence the crash and the SSR-Suspense fallback warning.

## Fix (single file: `src/routes/search.tsx`)

1. **Delete the early-return collapsed-summary block** (the `if (done && !timelineOpen) { return <button>…</button>; }` at ~937–956). The smooth grid-rows collapse you already approved is the only collapse UI — no separate summary card, matching your "no other background container or added text" instruction.

2. **Remove dead code** left over from the previous Tabs design so the file stops carrying confusing scaffolding:
   - `const [tab, setTab] = useState…` (unused)
   - `steps` `useMemo` (unused; replaced by the new `timeline` `useMemo`)
   - the `void reasoningOpen; void setReasoningOpen;` no-op lines (the props are still passed through but unused — keep the props in the signature to avoid touching the call site)

3. **Keep everything else as-is**: the auto-collapse-when-writer-starts effect, the grid-rows smooth transition, the bare timeline (dots + spine + steps), the merged thoughts/tool/search items, the `ThoughtStepRow` expand-on-click.

## Verification

- `bunx tsgo --noEmit` should pass.
- Drive the running app with Playwright: ask a question, watch the timeline render → searches appear → the moment the writer round begins, the timeline smoothly collapses to height 0 with no console error. Confirm "Rendered fewer hooks than expected" is gone.

## Out of scope

- The `postMessage` warnings from `lovable.js` (cross-origin iframe noise, harmless).
- Any other route, any styling change, any data/SSE logic.
