import { useEffect, useRef, useState } from 'react';
import { prefersReducedMotion } from './motion';

/**
 * Smoothly release an accumulating string to the DOM at a steady cadence
 * instead of in token bursts. Buffers the raw string (including any sentinels
 * like ⟦cite:..⟧ — they pass through untouched). When `running` becomes false
 * the full text is flushed instantly. Never drops or reorders characters.
 *
 * @param full   the latest cumulative string (must be append-only while running)
 * @param running whether the upstream stream is still active
 * @param cps    characters per second to reveal (default ~600)
 */
export function useSmoothText(full: string, running: boolean, cps = 900): string {
  const [shown, setShown] = useState('');
  const shownRef = useRef('');
  const fullRef = useRef('');
  const rafRef = useRef<number | null>(null);
  const lastTsRef = useRef<number | null>(null);

  // keep refs current
  fullRef.current = full;

  // If not running, snap to full immediately so nothing is ever lost.
  useEffect(() => {
    if (!running) {
      if (shownRef.current !== full) {
        shownRef.current = full;
        setShown(full);
      }
      if (rafRef.current != null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
        lastTsRef.current = null;
      }
    }
  }, [running, full]);

  // If user prefers reduced motion, mirror immediately.
  useEffect(() => {
    if (!running) return;
    if (prefersReducedMotion()) {
      if (shownRef.current !== full) {
        shownRef.current = full;
        setShown(full);
      }
    }
  }, [full, running]);

  // Reset when the buffer shrinks (new query starts).
  useEffect(() => {
    if (full.length < shownRef.current.length) {
      shownRef.current = '';
      setShown('');
    }
  }, [full]);

  // RAF loop while running
  useEffect(() => {
    if (!running) return;
    if (prefersReducedMotion()) return;

    const tick = (ts: number) => {
      rafRef.current = null;
      const last = lastTsRef.current ?? ts;
      const dt = Math.max(0, ts - last);
      lastTsRef.current = ts;

      const target = fullRef.current;
      const current = shownRef.current;
      if (current.length < target.length) {
        const behind = target.length - current.length;
        // Base rate, but catch up faster if we've fallen far behind.
        const rate = cps + Math.max(0, behind - 200) * 4;
        const advance = Math.max(1, Math.ceil((rate * dt) / 1000));
        const nextLen = Math.min(target.length, current.length + advance);
        const next = target.slice(0, nextLen);
        shownRef.current = next;
        setShown(next);
      }
      // Keep ticking while running; stop only when not running (handled above).
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
      lastTsRef.current = null;
    };
  }, [running, cps]);

  return shown;
}
