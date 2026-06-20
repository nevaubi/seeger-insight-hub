import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { tagLabel } from '@/lib/supabase';

const TYPE_STYLES: Record<string, string> = {
  PTO: 'bg-[oklch(0.26_0.04_255)] text-white border-transparent',
  CMO: 'bg-[oklch(0.42_0.14_25)] text-white border-transparent',
  CBO: 'bg-[oklch(0.45_0.1_140)] text-white border-transparent',
  JPML: 'bg-[oklch(0.4_0.06_80)] text-white border-transparent',
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
        'inline-flex items-center rounded px-2 py-0.5 text-[11px] font-semibold tracking-wider uppercase',
        TYPE_STYLES[type] ?? 'bg-muted text-foreground',
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
          className="font-normal text-[10.5px] tracking-wide bg-secondary/60 border-border text-secondary-foreground/80 py-0 px-1.5"
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
    hearing: 'bg-[oklch(0.42_0.14_25)] text-white',
    cmc: 'bg-[oklch(0.26_0.04_255)] text-white',
    deadline: 'bg-[oklch(0.55_0.12_60)] text-white',
    milestone: 'bg-[oklch(0.4_0.06_140)] text-white',
  };
  return (
    <span
      className={cn(
        'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        styles[category] ?? 'bg-muted',
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
        'inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider',
        side === 'plaintiff'
          ? 'bg-[oklch(0.26_0.04_255)] text-white'
          : 'bg-[oklch(0.42_0.14_25)] text-white',
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
