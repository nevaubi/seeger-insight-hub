# Drafting page: remove counter-draft, then improve

## Part 1 — Remove the counter-draft workflow

Delete and unwire everything from the aborted counter-draft feature so the page ships clean.

**Delete**
- `src/lib/counterdraft.ts`
- `src/components/editor/counterdraft-dialog.tsx`
- `src/components/editor/counterdraft-panel.tsx`
- `.lovable/plan.md` (stale counter-draft plan)

**Edit `src/routes/_authenticated/draft.tsx`**
- Remove all counterdraft imports, state, handlers (`createCounterdraft`, dialog open state, panel rendering).
- Remove the "Counter opposing draft" entry from the DocumentBar / DocumentMenu.
- Remove the `onNewCounterdraft` prop from `DocumentBar` type + call sites.

**Verify:** `tsgo` clean, /draft loads with no dead imports.

---

## Part 2 — Which improvements to build

I'd like you to pick before I plan the build. Here are the highest-leverage upgrades I see after re-reading the drafting page, editor, and `ai-assist`. Grouped by theme; pick any subset.

### A. Draft intelligence
1. **Matter-grounded "Ask Claude"** — the gutter/sidecar currently runs generic AI. Route selection prompts through `ai-assist` with `ground: true` + matter context so every rewrite pulls from PTO/CMO/deposition record and returns cite chips inline.
2. **Live cite-check panel** — reuse the existing `cite-check` edge function. On save (debounced), scan the doc for citations, flag unresolved / miscited pins in a right-rail panel with jump-to-position.
3. **One-click "improve" bar on selection** — replace the sidecar with a floating micro-toolbar (Tighten · Formalize · Shorten · Add citation · Rebut) that streams a redline directly at the selection. No panel round-trip.

### B. Structure & authoring
4. **Outline rail** — auto-extract H1/H2/H3 into a collapsible outline on the left; drag to reorder sections (updates doc). Doubles as jump nav for long motions.
5. **Section-scoped generation** — "Draft this section from the record" per outline node. Uses the section heading + matter context to stream a first draft into that node only.
6. **Template gallery upgrade** — the current 18 templates are flat. Group by phase (Pleadings / Discovery / Motions / Trial), add previews, and let a template preload matter facts (caption block, judge, MDL number) via the matter context.

### C. Review & compare
7. **Version history diff** — snapshot on each save; browse prior versions with inline diff and one-click restore. (Storage is local per doc via workspace_documents.)
8. **Two-doc compare** — pick any two workspace documents and see a side-by-side redline. Same infra as version diff.

### D. Export & polish
9. **Bluebook cite normalizer on export** — run cite-check + auto-format (short forms, id., supra) before DOCX/PDF export.
10. **Court-ready DOCX styling** — line numbering, pleading caption, footer with page X of Y, correct margins per N.D. Fla. local rules.

### E. Speed / UX polish
11. **Command palette (⌘K) scoped to draft** — jump to section, insert template block, run AI action, cite a specific order.
12. **Autosave indicator + offline queue** — visible saved/unsaved state, retry on network failure, never lose text.

---

## What I recommend

If you want the biggest visible jump: **A1 + A3 + B4 + C7**. That gives you a grounded, cite-aware editor with a real outline and version history — the four things that make it feel like a professional drafting tool instead of a rich-text box.

Reply with the numbers you want and I'll return a build-ready plan for just those.
