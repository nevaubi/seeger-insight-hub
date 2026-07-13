import { cn } from '@/lib/utils';

// The Claude starburst mark, inlined as SVG (no CDN dependency). Twelve tapered rays
// radiating from center — drawn to read cleanly from 12px up. Coral #C96442 by default.

export function ClaudeMark({
  className,
  color = '#C96442',
  title,
}: {
  className?: string;
  color?: string;
  title?: string;
}) {
  // one tapered ray pointing up from center; rotated 12× (every 30°)
  const ray = 'M50 50 L45.5 13 Q50 8 54.5 13 Z';
  return (
    <svg
      viewBox="0 0 100 100"
      className={cn('h-3.5 w-3.5', className)}
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <g fill={color}>
        {Array.from({ length: 12 }, (_, i) => (
          <path key={i} d={ray} transform={`rotate(${i * 30} 50 50)`} />
        ))}
        <circle cx="50" cy="50" r="7.5" />
      </g>
    </svg>
  );
}
