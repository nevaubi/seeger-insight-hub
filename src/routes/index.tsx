import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useSuspenseQuery, queryOptions } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight, FileText, Users, Building2, Gavel, CheckCircle2 } from 'lucide-react';
import { AppShell, PageHeader } from '@/components/app-shell';
import { OrderTypeBadge, TagChips, CategoryBadge, fmtDate, fmtDateRange, isRule702 } from '@/components/case-ui';
import { Card } from '@/components/ui/card';
import { supabase, type Order, type KeyDate } from '@/lib/supabase';

const today = () => new Date().toISOString().slice(0, 10);

const dashboardQuery = queryOptions({
  queryKey: ['dashboard'],
  queryFn: async () => {
    const todayStr = today();
    const [orders, ordersCount, casesCount, jpmlCount, counselAll, upcoming, recent] = await Promise.all([
      supabase.from('v_orders').select('id', { count: 'exact', head: true }),
      supabase.from('v_orders').select('id', { count: 'exact', head: true }),
      supabase.from('v_case_roster').select('id', { count: 'exact', head: true }),
      supabase.from('v_case_roster').select('id', { count: 'exact', head: true }).eq('on_jpml_schedule_a', true),
      supabase.from('v_counsel').select('firm_name'),
      supabase.from('v_key_dates').select('*').gte('event_date', todayStr).order('event_date', { ascending: true }).limit(6),
      supabase.from('v_orders').select('*').not('order_date', 'is', null).order('order_date', { ascending: false }).limit(6),
    ]);

    const firms = new Set((counselAll.data ?? []).map((r: any) => r.firm_name).filter(Boolean));
    void orders;
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

export const Route = createFileRoute('/')({
  loader: ({ context }) => context.queryClient.ensureQueryData(dashboardQuery),
  component: Dashboard,
  errorComponent: ({ error }) => (
    <AppShell>
      <div className="p-8 text-sm text-destructive">Failed to load: {error.message}</div>
    </AppShell>
  ),
  notFoundComponent: () => <AppShell><div className="p-8">Not found.</div></AppShell>,
});

function Dashboard() {
  const { data } = useSuspenseQuery(dashboardQuery);
  const navigate = useNavigate();

  return (
    <AppShell>
      <PageHeader
        title="In re: Depo-Provera Products Liability Litigation"
        description="MDL No. 3140 · U.S. District Court, Northern District of Florida, Pensacola Division · Hon. M. Casey Rodgers · Mag. Judge Hope T. Cannon"
      />

      <div className="px-8 py-6 space-y-8">
        {/* Stat cards */}
        <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
          <StatCard icon={Gavel} label="Controlling orders" value={data.counts.orders} />
          <StatCard icon={FileText} label="Cases in roster" value={data.counts.cases} />
          <StatCard icon={CheckCircle2} label="Certified JPML transfers" value={data.counts.jpml} />
          <StatCard icon={Users} label="Counsel of record" value={data.counts.counsel} />
          <StatCard icon={Building2} label="Distinct firms" value={data.counts.firms} />
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Upcoming */}
          <Card className="lg:col-span-2 p-0 overflow-hidden">
            <div className="px-5 py-3.5 border-b border-border flex items-baseline justify-between">
              <h2 className="font-serif text-lg font-semibold">Next critical dates</h2>
              <span className="text-xs text-muted-foreground">From the record</span>
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
                      className={`px-5 py-3.5 flex gap-4 items-start ${
                        headline ? 'bg-[hsl(38_42%_45%/0.08)] border-l-2 border-l-[hsl(38_42%_45%)]' : ''
                      }`}
                    >
                      <div className="w-28 shrink-0">
                        <div className="text-xs uppercase tracking-wider text-muted-foreground">
                          {fmtDateRange(d.event_date, d.end_date)}
                        </div>
                        <div className="mt-1"><CategoryBadge category={d.category} /></div>
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className={`text-sm font-medium ${headline ? 'font-serif text-base' : ''}`}>
                            {d.title}
                          </span>
                          {headline && (
                            <span className="text-[10px] uppercase tracking-wider bg-accent text-accent-foreground px-1.5 py-0.5 rounded font-semibold">
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
                          <div className="text-xs text-muted-foreground mt-0.5">Affects: {d.affects}</div>
                        )}
                        {d.citation && (
                          <div className="text-[11px] text-muted-foreground mt-1 italic font-serif">
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
          <Card className="p-5">
            <h2 className="font-serif text-lg font-semibold">Strategic posture</h2>
            <div className="mt-3 text-sm leading-relaxed text-foreground/85 space-y-3 font-serif">
              <p>
                The MDL is in <strong>pretrial</strong>, with general-causation discovery
                ongoing. Plaintiffs allege long-term use of Depo-Provera (depot
                medroxyprogesterone acetate) causes intracranial meningioma and that
                defendants failed to warn.
              </p>
              <p>
                The <strong>Rule 702 (Daubert) hearing on general causation</strong> is
                the gating event — its outcome will materially determine the trajectory
                of the entire MDL.
              </p>
              <p className="text-xs text-muted-foreground font-sans not-italic">
                Defendants: Pfizer, Pharmacia &amp; Upjohn, Pharmacia LLC, Greenstone
                LLC, Viatris Inc., Prasco LLC.
              </p>
            </div>
          </Card>
        </div>

        {/* Recent orders */}
        <Card className="p-0 overflow-hidden">
          <div className="px-5 py-3.5 border-b border-border flex items-baseline justify-between">
            <h2 className="font-serif text-lg font-semibold">Recent orders</h2>
            <button
              onClick={() => navigate({ to: '/orders' })}
              className="text-xs text-accent hover:underline inline-flex items-center gap-1"
            >
              All orders <ArrowRight className="h-3 w-3" />
            </button>
          </div>
          <ul className="divide-y divide-border">
            {data.recent.map((o) => (
              <li
                key={o.id}
                onClick={() => navigate({ to: '/orders', search: { id: o.id } as any })}
                className="px-5 py-3 flex items-start gap-4 hover:bg-muted/50 cursor-pointer transition-colors"
              >
                <div className="shrink-0 pt-0.5">
                  <OrderTypeBadge type={o.order_type} number={o.order_number} />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm font-medium text-foreground truncate">{o.canonical_title}</div>
                  <div className="mt-1"><TagChips tags={o.tags} max={5} /></div>
                </div>
                <div className="text-xs text-muted-foreground shrink-0 tabular-nums">
                  {fmtDate(o.order_date)}
                </div>
              </li>
            ))}
          </ul>
        </Card>
      </div>
    </AppShell>
  );
}

function StatCard({ icon: Icon, label, value }: { icon: any; label: string; value: number }) {
  return (
    <Card className="p-4">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground">{label}</div>
        <Icon className="h-4 w-4 text-muted-foreground/60" strokeWidth={1.5} />
      </div>
      <div className="mt-2 font-serif text-3xl font-semibold tabular-nums">{value.toLocaleString()}</div>
    </Card>
  );
}
