import { cn } from '@/lib/utils';

// The Anthropic / Claude starburst mark — inlined SVG, no CDN dependency.
// Eight tapered rays radiating from a small core, drawn with a slight concave
// curve so each ray reads as a proper spindle. Coral #C96442 by default.

export function ClaudeMark({
  className,
  color = '#C96442',
  title,
}: {
  className?: string;
  color?: string;
  title?: string;
}) {
  // one spindle-shaped ray pointing up, with concave sides for the classic Anthropic look
  const ray =
    'M50 50 C 48.6 34 47.9 20 50 4 C 52.1 20 51.4 34 50 50 Z';
  return (
    <svg
      viewBox="0 0 100 100"
      className={cn('h-3.5 w-3.5', className)}
      role={title ? 'img' : 'presentation'}
      aria-hidden={title ? undefined : true}
    >
      {title && <title>{title}</title>}
      <g fill={color}>
        {Array.from({ length: 8 }, (_, i) => (
          <path key={i} d={ray} transform={`rotate(${i * 45} 50 50)`} />
        ))}
      </g>
    </svg>
  );
}
