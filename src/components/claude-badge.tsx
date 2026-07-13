import { cn } from '@/lib/utils';
import poweredByClaude from '@/assets/powered-by-claude.png.asset.json';

// The "Powered by Claude" wordmark. The uploaded image already contains the
// starburst + label, so we render it directly instead of composing an icon +
// text (the composition never lines up perfectly across weights).

interface ClaudeBadgeProps {
  variant?: 'chip' | 'inline';
  className?: string;
  /** @deprecated the wordmark is now baked into the image */
  label?: string;
}

export function ClaudeBadge({ variant = 'inline', className }: ClaudeBadgeProps) {
  const title =
    'Powered by Claude — citations verified verbatim against the record. Draft for attorney review.';

  const img = (
    <img
      src={poweredByClaude.url}
      alt="Powered by Claude"
      title={title}
      className="h-3.5 w-auto select-none"
      draggable={false}
    />
  );

  if (variant === 'chip') {
    return (
      <span
        className={cn(
          'inline-flex items-center rounded-full border border-border bg-card px-2.5 py-1',
          className,
        )}
      >
        {img}
      </span>
    );
  }

  return <span className={cn('inline-flex items-center', className)}>{img}</span>;
}
