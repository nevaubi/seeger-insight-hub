import { createFileRoute } from '@tanstack/react-router';
import { useQuery, queryOptions } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { AlertTriangle, ExternalLink, Loader2 } from 'lucide-react';
import { AppShell, PageHeader } from '@/components/app-shell';
import { ExportMenu } from '@/components/export-menu';
import { CategoryBadge, fmtDateRange, isRule702 } from '@/components/case-ui';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import { supabase, type KeyDate } from '@/lib/supabase';
import { useMatter } from '@/lib/matter-context';

const datesQuery = (caseId: string) =>
  queryOptions({
    queryKey: ['key-dates', caseId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_key_dates')
        .select('*')
        .eq('case_id', caseId)
        .order('event_date', { ascending: true });
      if (error) throw error;
      return (data ?? []) as KeyDate[];
    },
  });

export const Route = createFileRoute('/deadlines')({
  component: DeadlinesPage,
  errorComponent: ({ error }) => (
    <AppShell><div className="p-8 text-sm text-destructive">Failed to load: {error.message}</div></AppShell>
  ),
  notFoundComponent: () => <AppShell><div className="p-8">Not found.</div></AppShell>,
});

function DeadlinesPage() {
  const { currentMatter } = useMatter();
  const { data: all = [], isLoading } = useQuery(datesQuery(currentMatter.master_case_id));
  const [upcomingOnly, setUpcomingOnly] = useState(true);

  const today = new Date().toISOString().slice(0, 10);
  const rows = useMemo(
    () => (upcomingOnly ? all.filter((d) => d.event_date >= today) : all),
    [all, upcomingOnly, today],
  );

  const grouped = useMemo(() => {
    const map = new Map<string, KeyDate[]>();
    for (const d of rows) {
      const key = (d.event_date ?? '').slice(0, 7);
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(d);
    }
    return Array.from(map.entries());
  }, [rows]);

  const fmtMonthKey = (k: string) => {
    const m = /^(\d{4})-(\d{2})/.exec(k);
    if (!m) return k;
    const months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
    return `${months[+m[2] - 1]} ${m[1]}`;
  };

  const exportColumns = [
    { header: 'Date', width: 14 },
    { header: 'End date', width: 14 },
    { header: 'Time', width: 14 },
    { header: 'Category', width: 12 },
    { header: 'Title', width: 48 },
    { header: 'Description', width: 60 },
    { header: 'Affects', width: 30 },
    { header: 'Conflict', width: 10 },
    { header: 'Source order', width: 40 },
    { header: 'Citation', width: 28 },
    { header: 'Source URL', width: 40 },
  ];
  const exportRows = rows.map((d) => [
    d.event_date,
    d.end_date ?? '',
    d.event_time ?? '',
    d.category,
    d.title,
    d.description ?? '',
    d.affects ?? '',
    d.is_conflicted ? 'Yes' : '',
    [d.source_order_type, d.source_order_title].filter(Boolean).join(' '),
    d.citation ?? '',
    d.source_url ?? '',
  ]);

  return (
    <AppShell>
      <PageHeader
        title="Deadlines & Calendar"
        description="Every hearing, CMC, deadline, and milestone on the docket, with the source order it derives from."
      >
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2.5 text-sm font-sans">
            <span className="text-muted-foreground">Upcoming only</span>
            <Switch checked={upcomingOnly} onCheckedChange={setUpcomingOnly} />
          </div>
          <ExportMenu
            baseName={`${currentMatter.short_name}-deadlines`}
            sheetName="Deadlines"
            columns={exportColumns}
            rows={exportRows}
          />
        </div>
      </PageHeader>

      <div className="px-8 py-6 space-y-8">
        {isLoading && (
          <Card className="p-10 text-center text-sm text-muted-foreground inline-flex items-center justify-center gap-2 w-full">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </Card>
        )}
        {!isLoading && rows.length === 0 && (
          <Card className="p-10 text-center text-sm text-muted-foreground">No dates to show.</Card>
        )}
        {grouped.map(([monthKey, items]) => (
          <section key={monthKey} className="motion-safe:motion-fade-rise">
            <div className="flex items-baseline justify-between mb-3 px-1">
              <h2 className="font-serif text-lg font-semibold tracking-[-0.01em]">{fmtMonthKey(monthKey)}</h2>
              <span className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground font-sans tabular-nums">
                {items.length} {items.length === 1 ? 'event' : 'events'}
              </span>
            </div>
            <Card className="p-0 overflow-hidden">
              <table className="w-full text-sm">
                <thead className="bg-secondary/60 text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground font-sans">
                  <tr>
                    <th className="text-left px-4 py-3 font-semibold w-44">Date</th>
                    <th className="text-left px-4 py-3 font-semibold w-24">Category</th>
                    <th className="text-left px-4 py-3 font-semibold">Title & affects</th>
                    <th className="text-left px-4 py-3 font-semibold w-[30%]">Citation</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((d) => {
                    const headline = isRule702(d.title) || isRule702(d.description);
                    return (
                      <tr
                        key={d.id}
                        className={`border-t border-border align-top ${
                          headline ? 'bg-[hsl(38_42%_45%/0.07)] border-l-2 border-l-[hsl(38_42%_45%)]' : ''
                        }`}
                      >
                        <td className="px-4 py-4 tabular-nums font-sans">
                          <div className="font-semibold text-foreground">{fmtDateRange(d.event_date, d.end_date)}</div>
                          {d.event_time && (
                            <div className="text-xs text-muted-foreground mt-0.5">{d.event_time}</div>
                          )}
                        </td>
                        <td className="px-4 py-4"><CategoryBadge category={d.category} /></td>
                        <td className="px-4 py-4">
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
                            <div className="text-xs text-muted-foreground mt-1.5 leading-relaxed">{d.description}</div>
                          )}
                          {d.affects && (
                            <div className="text-xs text-muted-foreground mt-1.5">
                              <span className="uppercase tracking-[0.12em] text-[10px] font-sans">Affects: </span>{d.affects}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-4 text-xs">
                          {d.source_order_title && (
                            <div className="font-medium text-foreground/80 font-serif italic leading-snug">
                              {d.source_order_type && <span className="not-italic font-sans text-[10px] uppercase tracking-[0.12em] mr-1.5 text-muted-foreground">{d.source_order_type}</span>}
                              {d.source_order_title}
                            </div>
                          )}
                          {d.citation && <div className="text-muted-foreground mt-1 font-sans">{d.citation}</div>}
                          {d.source_url && (
                            <a
                              href={d.source_url}
                              target="_blank"
                              rel="noreferrer"
                              className="mt-1.5 inline-flex items-center gap-1 text-accent hover:underline font-sans"
                            >
                              <ExternalLink className="h-3 w-3" /> Source
                            </a>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </Card>
          </section>
        ))}
      </div>
    </AppShell>
  );
}
