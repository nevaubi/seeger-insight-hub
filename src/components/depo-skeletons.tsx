import { Skeleton } from '@/components/ui/skeleton';
import { ClaudeBadge } from '@/components/claude-badge';

export function TranscriptSkeleton() {
  return (
    <div className="space-y-2.5 p-4 animate-in fade-in duration-300">
      {Array.from({ length: 22 }).map((_, i) => (
        <div key={i} className="flex gap-3 items-start">
          <Skeleton className="h-3 w-10 shrink-0" />
          <Skeleton
            className="h-3 flex-1"
            style={{ width: `${60 + ((i * 37) % 40)}%` }}
          />
        </div>
      ))}
    </div>
  );
}

export function FindingsSkeleton() {
  return (
    <div className="space-y-4 py-2 animate-in fade-in duration-300">
      <div className="flex items-center justify-between">
        <Skeleton className="h-4 w-40" />
        <ClaudeBadge variant="chip" label="Analyzing…" />
      </div>
      <div className="space-y-3">
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            className="rounded-sm border border-border bg-card p-4 space-y-2"
            style={{ opacity: 1 - i * 0.12 }}
          >
            <div className="flex items-center gap-2">
              <Skeleton className="h-3 w-16" />
              <Skeleton className="h-3 w-24" />
            </div>
            <Skeleton className="h-4 w-2/3" />
            <Skeleton className="h-3 w-full" />
            <Skeleton className="h-3 w-11/12" />
            <Skeleton className="h-3 w-3/4" />
          </div>
        ))}
      </div>
    </div>
  );
}
