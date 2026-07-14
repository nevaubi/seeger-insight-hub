## Goal

Expand the drafting template library and redesign the launcher, with each template carrying formatting metadata that automatically applies matching styles to both the editor and the exported DOCX.

## Part 1 — Expanded template library

New file: `src/lib/draft-templates.ts` (moves `DRAFT_TEMPLATES` out of `draft.tsx` and grows it).

Template shape (extended):
```ts
type PresetId = 'federal-motion' | 'federal-brief' | 'letter' | 'internal-memo' | 'discovery' | 'stipulation' | 'outline' | 'bench-memo';
type TemplateVar = { key: string; label: string; default?: string; source?: 'matter.judge'|'matter.court'|'matter.mdl_number'|'matter.short_name'|'today'|'user' };
type DraftTemplate = {
  id: string;                          // stable slug for favorites/recents
  category: Category;
  icon: LucideIcon;
  title: string;
  docType: string;
  summary: string;
  preset: PresetId;                    // drives editor + export styling
  vars: TemplateVar[];                 // prefilled from matter context / user
  prompt: string;                      // may reference {{var}} tokens
};
```

Categories (unchanged 6) and ~28 templates total. Adds:
- **Correspondence**: Rule 37 pre-motion letter; Extension request; Deposition scheduling; Preservation letter.
- **Motions & Briefs**: Motion to Compel (full brief, not outline); Reply in support; Opposition to MTD; Motion in Limine; Motion for Protective Order; Rule 502(d) motion; Sanctions motion; Response to Lone Pine motion.
- **Discovery**: Interrogatories (First Set); Requests for Admission; 30(b)(6) notice; Subpoena duces tecum; Privilege log skeleton; Plaintiff Fact Sheet cover.
- **Case Management**: Rule 26(f) report; Proposed CMO section; Bellwether selection proposal.
- **Hearing Prep**: Direct-exam outline; Oral-argument outline; Daubert hearing prep memo.
- **Leadership / PSC**: PSC meeting agenda; Common-benefit assessment notice; TPLF disclosure memo.

Existing templates get an `id`, `preset`, and `vars` field.

## Part 2 — Formatting presets (editor + export)

New file: `src/lib/format-presets.ts` — the source of truth for per-preset styling.

```ts
type FormatPreset = {
  id: PresetId;
  label: string;
  editor: { fontFamily: string; fontSize: string; lineHeight: string; firstLineIndent?: string; headingScale: 'legal'|'memo'|'letter' };
  docx: {
    font: 'Times New Roman'|'Century Schoolbook'|'Arial';
    sizeHalfPts: number;               // 24 = 12pt
    lineRule: 'auto'|'exact';
    lineTwips: number;                 // 480 = double
    firstLineIndentDxa: number;
    marginsDxa: { top:number; right:number; bottom:number; left:number };
    headingNumbering: 'roman'|'decimal'|'none';    // I./A./1./a. vs 1./1.1 vs plain
    caption: boolean;                  // render court caption block
    pageNumbers: 'footer-center'|'footer-right'|'none';
    signatureBlock: boolean;
    certificateOfService: boolean;
  };
};
```

Six presets ship: `federal-motion`, `federal-brief`, `letter`, `internal-memo`, `discovery`, `stipulation`, plus `outline` and `bench-memo`.

**Editor side** (`legal-editor.tsx`): accept an optional `preset` prop; apply matching CSS custom properties (`--legal-font`, `--legal-size`, `--legal-line`, `--legal-indent`) on the `.legal-prose` root. Heading numbering rendered via CSS counters (`.preset-federal-motion h2::before { content: counter(h2, upper-roman) '. '; }`). No content change.

**Export side** (`file-export.ts`): existing `downloadDocx` gains an optional `preset: FormatPreset['docx']` parameter that swaps the `DOCX_STYLES` defaults (font, size, line spacing, first-line indent), sets `<w:sectPr>` margins, and conditionally emits the caption/footer/signature/COS parts already scoped by the earlier court-ready plan. Presets without caption keep the current clean output.

## Part 3 — Launcher UX

Rewrite `TemplateLauncher` (still in `draft.tsx`, ~200 lines) into three panes:

```
┌ Search ─────────────────────┐  ┌ Preview ─────────────────┐
│ [🔎 search templates…]      │  │ Motion to Compel         │
│                             │  │ Preset: Federal Motion   │
│ ★ Favorites                 │  │ ─────────────────────── │
│   • Motion to compel        │  │ Fields                   │
│   • Meet-and-confer letter  │  │ Opposing party: [    ]  │
│                             │  │ Deadline:       [    ]  │
│ Recents (5)                 │  │ Attorney:       Firas … │
│                             │  │                          │
│ Correspondence   >          │  │ [ Use template ]         │
│ Motions & Briefs >          │  │                          │
│ Discovery        >          │  └──────────────────────────┘
│ Case Management  >          │
│ Hearing Prep     >          │
│ Leadership/PSC   >          │
└─────────────────────────────┘
```

- **Search** — fuzzy match on title, docType, summary (client-side).
- **Favorites & Recents** — persisted in `localStorage` under `draft.templates.{favorites,recents}`; recents capped at 5.
- **Variables** — auto-filled from `useMatter()` (`matter.judge`, `matter.court`, `matter.mdl_number`, `matter.short_name`) and today's date; user-editable fields for opposing party, attorney name, deadline, subject. `{{tokens}}` in the prompt are substituted before sending.
- **Preview pane** — shows the resolved prompt's first ~15 lines and the preset badge (`Federal Motion · Times 12 · Double-spaced`).
- **Preset badge** on every category chip so users see the format at a glance.

## Part 4 — Wiring

- `draft.tsx`: import from `draft-templates.ts`, store `activePresetId` alongside the current document, pass it to `<LegalEditor preset={preset} />` and to `downloadDocx({ preset })`.
- Persist `preset_id` on `WorkspaceDocument` locally (session state only — no schema change; we cache it in a `Map<docId, presetId>` in memory + `localStorage`).
- Template pick sets the preset AND streams the resolved prompt into the assist queue exactly as today.

## Technical notes

- No backend, no migrations, no new edge functions.
- New files: `src/lib/draft-templates.ts`, `src/lib/format-presets.ts`.
- Touched: `src/routes/_authenticated/draft.tsx` (launcher rewrite + preset plumbing), `src/components/editor/legal-editor.tsx` (preset prop + CSS scope class), `src/lib/file-export.ts` (preset param on `downloadDocx`), `src/styles.css` (preset CSS rules).
- Bluebook polish and court-ready caption from the prior pass remain intact — presets simply toggle those existing capabilities.

## Out of scope

- Server-side template storage or sharing across users.
- Per-firm branding kits (logo insertion, watermarks).
- Real-time collaborative editing of templates.