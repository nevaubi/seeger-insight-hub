import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery, queryOptions } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, FileText, Users, Building2, Gavel, CheckCircle2, Loader2 } from 'lucide-react';
import { AppShell, PageHeader } from '@/components/app-shell';
import { OrderTypeBadge, TagChips, CategoryBadge, fmtDate, fmtDateRange, isRule702 } from '@/components/case-ui';
import { Card } from '@/components/ui/card';
import { supabase, type Order, type KeyDate } from '@/lib/supabase';
import { useMatter } from '@/lib/matter-context';

const today = () => new Date().toISOString().slice(0, 10);

const dashboardQuery = (caseId: string) =>
  queryOptions({
    queryKey: ['dashboard', caseId],
    queryFn: async () => {
      const todayStr = today();
      const rosterBase = () => supabase.from('v_case_roster').select('id', { count: 'exact', head: true })
        .or(`id.eq.${caseId},parent_case_id.eq.${caseId}`);
      const [ordersCount, casesCount, jpmlCount, counselAll, upcoming, recent] = await Promise.all([
        supabase.from('v_orders').select('id', { count: 'exact', head: true }).eq('case_id', caseId),
        rosterBase(),
        rosterBase().eq('on_jpml_schedule_a', true),
        supabase.from('v_counsel').select('firm_name').eq('case_id', caseId),
        supabase.from('v_key_dates').select('*').eq('case_id', caseId).gte('event_date', todayStr).order('event_date', { ascending: true }).limit(6),
        supabase.from('v_orders').select('*').eq('case_id', caseId).not('order_date', 'is', null).order('order_date', { ascending: false }).limit(6),
      ]);


      const firms = new Set((counselAll.data ?? []).map((r: { firm_name: string | null }) => r.firm_name).filter(Boolean));
      return {
        counts: {
          orders: ordersCount.count ?? 0,
          cases: casesCount.count ?? 0,
          jpml: jpmlCount.count ?? 0,
          counsel: counselAll.data?.length ?? 0,
          firms: firms.size,
        },
        upcoming: (upcoming.data ?? []) as KeyDate[],
        recent: (recent.data ?? []) as Order[],
      };
    },
  });

export const Route = createFileRoute('/_authenticated/')({
  component: Dashboard,
  errorComponent: ({ error }) => (
    <AppShell>
      <div className="p-8 text-sm text-destructive">Failed to load: {error.message}</div>
    </AppShell>
  ),
  notFoundComponent: () => <AppShell><div className="p-8">Not found.</div></AppShell>,
});

function Dashboard() {
  const { currentMatter } = useMatter();
  const { data, isLoading } = useQuery(dashboardQuery(currentMatter.master_case_id));
  const navigate = useNavigate();

  const cfg = currentMatter.config ?? {};
  const headerTitle = currentMatter.name;
  const headerDesc = `MDL No. ${currentMatter.mdl_number} · ${currentMatter.court} · Hon. ${currentMatter.judge}`;

  if (isLoading || !data) {
    return (
      <AppShell>
        <PageHeader title={headerTitle} description={headerDesc} />
        <div className="px-8 py-10 text-sm text-muted-foreground inline-flex items-center gap-2">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading…
        </div>
      </AppShell>
    );
  }

  return (
    <AppShell>
      <PageHeader
        title={headerTitle}
        description={headerDesc}
      />


      <div className="px-8 py-6 space-y-10">
        {/* Stat cards */}
        <section className="motion-safe:motion-fade-rise">
          <div className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground mb-2.5 font-sans">At a glance</div>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatCard icon={Gavel} label="Controlling orders" value={data.counts.orders} />
            <StatCard icon={FileText} label="Cases in roster" value={data.counts.cases} />
            <StatCard icon={CheckCircle2} label="Certified JPML transfers" value={data.counts.jpml} />
            <StatCard icon={Users} label="Counsel of record" value={data.counts.counsel} />
            <StatCard icon={Building2} label="Distinct firms" value={data.counts.firms} />
          </div>
        </section>

        <section className="grid grid-cols-1 lg:grid-cols-3 gap-6 motion-safe:motion-fade-rise">
          {/* Upcoming */}
          <Card className="lg:col-span-2 p-0 overflow-hidden">
            <div className="px-5 py-4 border-b border-border flex items-baseline justify-between bg-card">
              <div>
                <div className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground font-sans">Calendar</div>
                <h2 className="font-serif text-lg font-semibold mt-0.5 tracking-[-0.01em]">Next critical dates</h2>
              </div>
              <span className="text-[11px] text-muted-foreground font-sans">From the record</span>
            </div>
            {data.upcoming.length === 0 ? (
              <div className="p-6 text-sm text-muted-foreground">No upcoming events on record.</div>
            ) : (
              <ul className="divide-y divide-border">
                {data.upcoming.slice(0, 5).map((d) => {
                  const headline = isRule702(d.title) || isRule702(d.description);
                  return (
                    <li
                      key={d.id}
                      className={`px-5 py-4 flex gap-5 items-start ${
                        headline ? 'bg-[hsl(38_42%_45%/0.08)] border-l-2 border-l-[hsl(38_42%_45%)]' : ''
                      }`}
                    >
                      <div className="w-32 shrink-0">
                        <div className="text-xs font-sans text-foreground/80 font-medium tabular-nums">
                          {fmtDateRange(d.event_date, d.end_date)}
                        </div>
                        <div className="mt-1.5"><CategoryBadge category={d.category} /></div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-sm font-medium ${headline ? 'font-serif text-base' : ''}`}>
                            {d.title}
                          </span>
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
                        {d.affects && (
                          <div className="text-xs text-muted-foreground mt-1">Affects: {d.affects}</div>
                        )}
                        {d.citation && (
                          <div className="text-[11px] text-muted-foreground mt-1.5 italic font-serif">
                            {d.is_conflicted ? <span className="not-italic font-sans text-amber-800">Conflict cite: </span> : 'Source: '}
                            {d.citation}
                          </div>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </Card>

          {/* Strategic posture */}
          <Card className="p-5 bg-secondary/40">
            <div className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground font-sans">Context</div>
            <h2 className="font-serif text-lg font-semibold mt-0.5 tracking-[-0.01em]">{currentMatter.short_name}</h2>
            <div className="mt-4 text-sm leading-relaxed text-foreground/85 space-y-3 font-serif">
              <p>{cfg.subtitle ?? currentMatter.name}</p>
              <p className="text-xs text-muted-foreground font-sans not-italic pt-1 border-t border-border">
                MDL {currentMatter.mdl_number} · {currentMatter.court} · Hon. {currentMatter.judge}
              </p>
            </div>
          </Card>
        </section>


        {/* Recent orders */}
        <section className="motion-safe:motion-fade-rise">
          <Card className="p-0 overflow-hidden">
            <div className="px-5 py-4 border-b border-border flex items-baseline justify-between bg-card">
              <div>
                <div className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground font-sans">Docket activity</div>
                <h2 className="font-serif text-lg font-semibold mt-0.5 tracking-[-0.01em]">Recent orders</h2>
              </div>
              <button
                onClick={() => navigate({ to: '/orders' })}
                className="text-xs text-accent hover:underline inline-flex items-center gap-1 font-sans"
              >
                All orders <ArrowRight className="h-3 w-3" />
              </button>
            </div>
            <ul className="divide-y divide-border">
              {data.recent.map((o) => (
                <li
                  key={o.id}
                  onClick={() => navigate({ to: '/orders', search: { id: o.id } as any })}
                  className="px-5 py-3.5 flex items-start gap-4 hover:bg-muted/50 cursor-pointer transition-colors"
                >
                  <div className="shrink-0 pt-0.5 w-24">
                    <OrderTypeBadge type={o.order_type} number={o.order_number} />
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-foreground truncate">{o.canonical_title}</div>
                    <div className="mt-1.5"><TagChips tags={o.tags} max={5} /></div>
                  </div>
                  <div className="text-xs text-muted-foreground shrink-0 tabular-nums font-sans pt-0.5">
                    {fmtDate(o.order_date)}
                  </div>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      </div>
    </AppShell>
  );
}

function StatCard({ icon: Icon, label, value }: { icon: any; label: string; value: number }) {
  return (
    <Card className="p-4 hover:border-foreground/15 transition-colors">
      <div className="flex items-start justify-between gap-2">
        <div className="text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground font-sans leading-snug">{label}</div>
        <Icon className="h-4 w-4 text-muted-foreground/60 shrink-0" strokeWidth={1.5} />
      </div>
      <div className="mt-3 font-serif text-3xl font-semibold tabular-nums tracking-[-0.02em]">{value.toLocaleString()}</div>
    </Card>
  );
}
