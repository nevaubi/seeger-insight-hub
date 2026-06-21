// Shared motion constants — keep all timings/easings consistent across the app.
export const EASE_OUT_SOFT = 'cubic-bezier(0.22, 1, 0.36, 1)';
export const DURATION = {
  fast: 200,
  base: 300,
  slow: 500,
} as const;

export function prefersReducedMotion(): boolean {
  if (typeof window === 'undefined' || !window.matchMedia) return false;
  return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}
