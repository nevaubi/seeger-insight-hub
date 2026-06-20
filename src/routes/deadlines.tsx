import { createFileRoute } from '@tanstack/react-router';
import { useSuspenseQuery, queryOptions } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { AlertTriangle, ExternalLink } from 'lucide-react';
import { AppShell, PageHeader } from '@/components/app-shell';
import { CategoryBadge, fmtDateRange, isRule702 } from '@/components/case-ui';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { supabase, type KeyDate } from '@/lib/supabase';

const datesQuery = queryOptions({
  queryKey: ['key-dates'],
  queryFn: async () => {
    const { data, error } = await supabase
      .from('v_key_dates')
      .select('*')
      .order('event_date', { ascending: true });
    if (error) throw error;
    return (data ?? []) as KeyDate[];
  },
});

export const Route = createFileRoute('/deadlines')({
  loader: ({ context }) => context.queryClient.ensureQueryData(datesQuery),
  component: DeadlinesPage,
  errorComponent: ({ error }) => (
    <AppShell><div className="p-8 text-sm text-destructive">Failed to load: {error.message}</div></AppShell>
  ),
  notFoundComponent: () => <AppShell><div className="p-8">Not found.</div></AppShell>,
});

function DeadlinesPage() {
  const { data: all } = useSuspenseQuery(datesQuery);
  const [upcomingOnly, setUpcomingOnly] = useState(true);

  const today = new Date().toISOString().slice(0, 10);
  const rows = useMemo(
    () => (upcomingOnly ? all.filter((d) => d.event_date >= today) : all),
    [all, upcomingOnly, today],
  );

  return (
    <AppShell>
      <PageHeader
        title="Deadlines & Calendar"
        description="Every hearing, CMC, deadline, and milestone on the docket, with the source order it derives from."
      >
        <div className="flex items-center gap-2.5 text-sm">
          <span className="text-muted-foreground">Upcoming only</span>
          <Switch checked={upcomingOnly} onCheckedChange={setUpcomingOnly} />
        </div>
      </PageHeader>

      <div className="px-8 py-6">
        <Card className="p-0 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-secondary/60 text-[11px] uppercase tracking-wider text-muted-foreground">
              <tr>
                <th className="text-left px-4 py-2.5 font-medium w-44">Date</th>
                <th className="text-left px-4 py-2.5 font-medium w-24">Category</th>
                <th className="text-left px-4 py-2.5 font-medium">Title & affects</th>
                <th className="text-left px-4 py-2.5 font-medium w-[30%]">Citation</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => {
                const headline = isRule702(d.title) || isRule702(d.description);
                return (
                  <tr
                    key={d.id}
                    className={`border-t border-border align-top ${
                      headline ? 'bg-[hsl(38_42%_45%/0.07)]' : ''
                    }`}
                  >
                    <td className="px-4 py-3 tabular-nums">
                      <div className="font-medium text-foreground">{fmtDateRange(d.event_date, d.end_date)}</div>
                      {d.event_time && (
                        <div className="text-xs text-muted-foreground">{d.event_time}</div>
                      )}
                    </td>
                    <td className="px-4 py-3"><CategoryBadge category={d.category} /></td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className={`font-medium ${headline ? 'font-serif text-base' : ''}`}>{d.title}</span>
                        {headline && (
                          <span className="text-[10px] uppercase tracking-wider bg-[hsl(38_42%_45%)] text-white px-1.5 py-0.5 rounded-sm font-semibold">
                            Gating event
                          </span>
                        )}
                        {d.is_conflicted && (
                          <span className="inline-flex items-center gap-1 text-[10px] uppercase tracking-wider bg-amber-500/15 text-amber-800 px-1.5 py-0.5 rounded font-semibold border border-amber-500/30">
                            <AlertTriangle className="h-3 w-3" /> Date conflict
                          </span>
                        )}
                      </div>
                      {d.description && (
                        <div className="text-xs text-muted-foreground mt-1">{d.description}</div>
                      )}
                      {d.affects && (
                        <div className="text-xs text-muted-foreground mt-1">
                          <span className="uppercase tracking-wider text-[10px]">Affects: </span>{d.affects}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 text-xs">
                      {d.source_order_title && (
                        <div className="font-medium text-foreground/80 font-serif italic">
                          {d.source_order_type && <span className="not-italic font-sans text-[10px] uppercase tracking-wider mr-1.5 text-muted-foreground">{d.source_order_type}</span>}
                          {d.source_order_title}
                        </div>
                      )}
                      {d.citation && <div className="text-muted-foreground mt-0.5">{d.citation}</div>}
                      {d.source_url && (
                        <a
                          href={d.source_url}
                          target="_blank"
                          rel="noreferrer"
                          className="mt-1 inline-flex items-center gap-1 text-accent hover:underline"
                        >
                          <ExternalLink className="h-3 w-3" /> Source
                        </a>
                      )}
                    </td>
                  </tr>
                );
              })}
              {rows.length === 0 && (
                <tr><td colSpan={4} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No dates to show.
                </td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>
    </AppShell>
  );
}
