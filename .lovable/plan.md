## Fix Ask-the-Record timeline: smoother streaming + graceful collapse

Frontend-only polish in `src/routes/_authenticated/search.tsx`, `src/lib/useSmoothText.ts`, and `src/styles.css`. No changes to the edge function, stream protocol, or reducers.

### 1. Faster, more "alive" reasoning stream

`useSmoothText` currently paces at 140 cps (reasoning) / 180 cps (interim text) / 1100 cps (writer). The RAF loop only advances by whole characters, so short bursts feel choppy.

- Raise defaults: reasoning 140 → **220 cps**, interim text 180 → **260 cps**, writer 1100 → **1600 cps**.
- Rework the RAF loop to a **fractional accumulator** (keep `progress` as a float, reveal `floor(progress)` chars) so slow rates still animate smoothly frame-to-frame instead of stalling then leaping.
- Softer catch-up curve: `rate + max(0, behind-40) * 12` so a big buffer doesn't dump instantly (feels like thinking, not paste).

### 2. Per-word "shimmer as it types" reveal

Right now only the active retrieval label uses `shimmer-text` (a full-width gradient sweep). Streamed reasoning text is plain foreground.

- Add a new `motion-word-reveal` utility: each newly appended word wrapped in a `<span>` with a short `word-shimmer` keyframe (opacity 0.35 → 1 + subtle 90deg gradient sweep across the word, 420ms, once). Words that finished animating stay solid foreground — no perpetual shimmer noise.
- Small helper in the file: `useRevealedWords(shownText)` that diffs the last render and marks only *new* words as animating. Applied to `RoundHeader` reasoning and `InterimNoteRow`.
- Tighten the global `shimmer-text` sweep to **1.4s** (from 1.9s) so the active retrieval label reads as clearly "in progress".

### 3. Graceful collapse into the writer

Today `setTimelineOpen(false)` fires the instant `writerActive` flips true, so `RunCard` unmounts hard and the `WritingIndicator` pops in.

- Convert the timeline container to an animated collapse:
  - Wrap `RunCard` in a `<div class="timeline-collapse" data-open={timelineOpen}>` that transitions `grid-template-rows: 1fr → 0fr` + opacity + slight translateY, 520ms `--ease-out-soft`. (grid-rows trick keeps content measurable without JS height calc.)
  - Keep `RunCard` mounted through the transition; only unmount ~600ms after `writerActive` (local `showTimeline` state driven by a timeout).
- Delay collapse trigger by **~350ms** after `writerActive` so the last retrieval check-mark visibly settles before the fold.
- `WritingIndicator` cross-fades in with `motion-fade-rise` staggered 250ms after collapse begins (add `animation-delay`), so the two motions overlap instead of snapping.
- Cross-fade to answer body: when the first writer token arrives, fade `WritingIndicator` out (150ms) as the answer prose fades in.

### 4. Small polish touches

- Round header caret: switch `motion-stream-caret` to a softer 1.2s cadence so it doesn't compete with the word reveal.
- Step check-in animation: when a `StatusNode` flips `done`, add a one-shot `motion-ring-pulse` on the node (already exists) so completion is felt, not just seen.

### Files touched

- `src/lib/useSmoothText.ts` — fractional accumulator, softer catch-up, higher default.
- `src/styles.css` — add `@keyframes word-shimmer`, `.motion-word-reveal`, `.timeline-collapse` grid-row transition; tune `shimmer-text` duration.
- `src/routes/_authenticated/search.tsx` — new `useRevealedWords` helper, apply to `RoundHeader` / `InterimNoteRow` / `WriterReasoning`; wrap `RunCard` in collapse container with delayed unmount; stagger `WritingIndicator` entrance and answer cross-fade; bump `useSmoothText` cps args.

### Out of scope

Reducer/state shape, SSE events, edge function pacing, evidence column, composer.