## Goal
Make the Depositions page an upload-first launcher. Remove the "Recent depositions" list entirely, kick off analysis automatically after upload without a button press, and use clean skeleton placeholders while things load.

## 1. `src/routes/_authenticated/depositions.index.tsx` — strip to a launcher

Remove from the page:
- The `Recent depositions` section header, filter bar, sort dropdown, and the divided list of previously uploaded transcripts.
- The metrics summary strip (transcripts / pp / analyzed / helpful-harmful / exhibits) — it depends on the roster.
- The `depositions` and `deposition_findings` queries plus all filter/sort state (`query`, `align`, `status`, `roleFilter`, `sort`, `findingsByDepo`, `metrics`, `filteredSorted`, `roleOptions`, related helpers, `AlignmentBadge`, `StatusBadge`).
- The Upload sheet's `autoAnalyze` Switch — analysis always runs.

Keep and promote:
- The upload flow (drag-drop card, witness name, witness role, submit). Render it directly on the page as the primary hero card, not behind a Sheet — no "Upload transcript" button needed to open a modal. (The `Sheet` component and `uploadOpen` state can be removed.)
- Header stays (matter name + page title), but drop the `Plus` button since upload is inline.
- Empty-state copy (`No depositions yet`) is deleted; the upload card replaces it.

Submission behavior:
- On successful `ingestDeposition`, always navigate to `/depositions/$id` with `search: { analyze: true }` (drop the toggle). No toast about "analyzing in the background" — the destination page will show live progress.
- Show skeleton state on the upload card while `busy` (file row shimmering, progress caption "Preparing transcript…").

## 2. `src/routes/_authenticated/depositions.$id.tsx` — auto-analyze on arrival

Current behavior already auto-starts analysis when `?analyze=true` is present (lines 562-572). Confirm it fires even before the deposition row has any pages loaded and:
- Set an initial UI state that assumes analysis is starting when `searchParams.analyze` is true, so users never see the "Not analyzed yet / Analyze now" empty card (line 1099) between navigation and the mutation firing.
- Replace the spinner-only pending block (~line 1073) and the transcript-loading blocks with the new `<DepoSkeleton />` component (below) so both the findings column and transcript column show aligned skeleton rows instead of a lone spinner.

## 3. Skeleton components

Add a small local `DepoSkeleton` (in `depositions.$id.tsx`, or a new `src/components/depo-skeletons.tsx` if cleaner) using the existing `Skeleton` shadcn primitive:
- `TranscriptSkeleton`: 12 rows of `page:line` gutter + text bar, matching the virtualized line layout.
- `FindingsSkeleton`: 4 stacked cards (title bar, 2 lines of text, small tag row).
- `HeaderSkeleton`: witness name + metadata line for the top of the workspace while `depoQ.isLoading`.

On the launcher page, add an inline `UploadingSkeleton` block that appears under the upload card once `busy` is true, mirroring the shape of the destination workspace so the transition feels continuous.

## 4. Cleanup

- Remove now-unused imports in `depositions.index.tsx` (`useQueryClient`, `Sheet*`, `Select*`, `Switch`, `Badge`, `SearchIcon`, `X`, `CheckCircle2`, `Sparkles`, `Plus`, `Loader2` where unused, `fmtDate`, `Deposition`, `DepositionFinding` types, `cn` if unused).
- No changes to `depo-api.ts`, edge functions, or DB.

## Out of scope
Any change to the transcript viewer internals, findings analytics, ask-the-witness pane, or export menus — only loading states and route wiring are touched there.
