Problem: the main document body in the drafting page is constrained to `max-width: 72ch` with generous lateral padding, so the text column looks narrow and wastes available viewport — especially when the document rail and Claude sidecar are both open.

Changes:
1. **Editor body width** — in `src/styles.css`, change `.legal-editor-content .ProseMirror`:
   - `max-width: 72ch` → `max-width: min(96ch, 100% - 2.5rem)`
   - horizontal padding `clamp(1.5rem, 6vw, 4rem)` → `clamp(1rem, 3.5vw, 2.5rem)`
   - top/bottom padding tightened slightly (`3rem ... 8rem` → `2.5rem ... 6rem`)
2. **Sidecar breathing room** — in `src/routes/_authenticated/draft.tsx`, narrow the Claude sidecar at the `lg` breakpoint:
   - `lg:w-[520px] xl:w-[560px]` → `lg:w-[460px] xl:w-[560px]`
   - This keeps the wide desktop experience but gives the editor more space on medium/large laptops where the rail is open.
3. **Verify** — reload the Draft page at the current viewport and confirm the text block fills more of the panel without touching the sidecar.

No functional changes to editor behavior, presets, or export formatting.