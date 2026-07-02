import { useCallback, useEffect, useRef, useState, type ReactNode, type KeyboardEvent, type PointerEvent } from 'react';

// Draggable left/right split with keyboard + localStorage persistence.
// Below `lg` the divider is hidden and children stack vertically to match the
// prior mobile layout. The container is expected to be `flex-col lg:flex-row`
// friendly — we render exactly that.

type Props = {
  left: ReactNode;
  right: ReactNode;
  /** left-pane percent, 20..80. Defaults to 62. */
  defaultPercent?: number;
  min?: number;
  max?: number;
  storageKey?: string;
  className?: string;
};

export function SplitPane({
  left,
  right,
  defaultPercent = 62,
  min = 35,
  max = 75,
  storageKey,
  className,
}: Props) {
  const [pct, setPct] = useState<number>(() => {
    if (typeof window === 'undefined' || !storageKey) return defaultPercent;
    const raw = window.localStorage.getItem(storageKey);
    const n = raw ? Number(raw) : NaN;
    return Number.isFinite(n) && n >= min && n <= max ? n : defaultPercent;
  });
  const containerRef = useRef<HTMLDivElement | null>(null);
  const draggingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const pendingPctRef = useRef<number | null>(null);

  const clamp = useCallback((v: number) => Math.min(max, Math.max(min, v)), [min, max]);

  const persist = useCallback((v: number) => {
    if (storageKey && typeof window !== 'undefined') {
      try { window.localStorage.setItem(storageKey, String(v)); } catch { /* ignore */ }
    }
  }, [storageKey]);

  const commit = useCallback(() => {
    if (pendingPctRef.current == null) return;
    setPct(pendingPctRef.current);
    pendingPctRef.current = null;
    rafRef.current = null;
  }, []);

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
    draggingRef.current = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const rel = ((e.clientX - rect.left) / rect.width) * 100;
    pendingPctRef.current = clamp(rel);
    if (rafRef.current == null) rafRef.current = requestAnimationFrame(commit);
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    persist(pct);
  };

  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 8 : 2;
    let next = pct;
    if (e.key === 'ArrowLeft') next = clamp(pct - step);
    else if (e.key === 'ArrowRight') next = clamp(pct + step);
    else if (e.key === 'Home') next = min;
    else if (e.key === 'End') next = max;
    else if (e.key === 'Enter' || e.key === ' ') next = pct <= min + 1 ? defaultPercent : min;
    else return;
    e.preventDefault();
    setPct(next);
    persist(next);
  };

  const onDoubleClick = () => {
    setPct(defaultPercent);
    persist(defaultPercent);
  };

  useEffect(() => () => {
    if (rafRef.current != null) cancelAnimationFrame(rafRef.current);
  }, []);

  // CSS var drives flex-basis only at lg+ via the Tailwind arbitrary utility
  // below. On mobile the children stack (flex-col) and the var is ignored.
  const styleVar = { ['--split-basis' as string]: `${pct}%` } as React.CSSProperties;

  return (
    <div
      ref={containerRef}
      className={`flex flex-col lg:flex-row ${className ?? ''}`}
      style={styleVar}
    >
      <div className="min-w-0 lg:h-full flex flex-col lg:[flex-basis:var(--split-basis)] lg:grow-0 lg:shrink-0">
        {left}
      </div>

      {/* Divider — hidden below lg */}
      <div
        className="hidden lg:flex items-stretch shrink-0 group"
        role="separator"
        aria-orientation="vertical"
        aria-valuenow={Math.round(pct)}
        aria-valuemin={min}
        aria-valuemax={max}
        aria-label="Resize evidence panel"
        tabIndex={0}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onKeyDown={onKey}
        onDoubleClick={onDoubleClick}
        style={{ width: '10px', cursor: 'col-resize', touchAction: 'none' }}
      >
        <div
          className="mx-auto my-0 w-px h-full bg-border transition-colors duration-150 group-hover:bg-accent/60 group-focus-visible:bg-accent group-active:bg-accent"
          aria-hidden
        />
      </div>

      <div className="min-w-0 lg:h-full lg:flex-1 flex flex-col">
        {right}
      </div>
    </div>
  );
}
