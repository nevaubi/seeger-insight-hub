import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { tagLabel } from '@/lib/supabase';

const TYPE_STYLES: Record<string, string> = {
  PTO: 'bg-secondary text-primary border border-border',
  CMO: 'bg-primary text-primary-foreground border border-transparent',
  CBO: 'bg-accent text-accent-foreground border border-transparent',
  JPML: 'bg-secondary text-secondary-foreground border border-border',
};

export function OrderTypeBadge({
  type,
  number,
  className,
}: {
  type: string | null;
  number?: string | null;
  className?: string;
}) {
  if (!type) return null;
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm px-2 py-0.5 text-[10.5px] font-semibold tracking-[0.09em] uppercase tabular-nums',
        TYPE_STYLES[type] ?? 'bg-secondary text-secondary-foreground border border-border',
        className,
      )}
    >
      {type}
      {number ? <span className="ml-1 opacity-90 font-medium">#{number}</span> : null}
    </span>
  );
}

export function TagChips({ tags, max }: { tags: string[] | null; max?: number }) {
  if (!tags || tags.length === 0) return null;
  const list = max ? tags.slice(0, max) : tags;
  const rest = max && tags.length > max ? tags.length - max : 0;
  return (
    <div className="flex flex-wrap gap-1">
      {list.map((t) => (
        <Badge
          key={t}
          variant="outline"
          className="font-medium text-[10px] tracking-[0.04em] bg-secondary border-border text-secondary-foreground py-0 px-1.5 rounded-sm"
        >
          {tagLabel(t)}
        </Badge>
      ))}
      {rest > 0 && (
        <span className="text-[10.5px] text-muted-foreground self-center">+{rest}</span>
      )}
    </div>
  );
}

export function CategoryBadge({ category }: { category: string }) {
  const styles: Record<string, string> = {
    hearing: 'bg-primary text-primary-foreground',
    cmc: 'bg-accent text-accent-foreground',
    deadline: 'bg-secondary text-secondary-foreground border border-border',
    milestone: 'bg-secondary text-secondary-foreground border border-border',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.09em]',
        styles[category] ?? 'bg-muted text-muted-foreground',
      )}
    >
      {category}
    </span>
  );
}

export function SideBadge({ side }: { side: 'plaintiff' | 'defendant' }) {
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.09em]',
        side === 'plaintiff'
          ? 'bg-primary text-primary-foreground'
          : 'bg-secondary text-secondary-foreground border border-border',
      )}
    >
      {side}
    </span>
  );
}

export function fmtDate(d: string | null | undefined): string {
  if (!d) return '—';
  const dt = new Date(d);
  if (isNaN(dt.getTime())) return d;
  return dt.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function fmtDateRange(start: string | null, end: string | null): string {
  if (!start) return '—';
  if (!end || end === start) return fmtDate(start);
  return `${fmtDate(start)} — ${fmtDate(end)}`;
}

export function isRule702(title: string | null | undefined): boolean {
  if (!title) return false;
  const t = title.toLowerCase();
  return t.includes('daubert') || t.includes('rule 702') || t.includes('702');
}
