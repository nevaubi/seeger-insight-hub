import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { useQuery, queryOptions } from '@tanstack/react-query';
import { AlertTriangle, ArrowRight } from 'lucide-react';
import { AppShell } from '@/components/app-shell';
import { fmtDate, fmtDateRange, isRule702, tagLabel } from '@/components/case-ui';
import { supabase, type Order, type KeyDate } from '@/lib/supabase';
import { useMatter } from '@/lib/matter-context';
import { cn } from '@/lib/utils';

const today = () => new Date().toISOString().slice(0, 10);

const dashboardQuery = (caseId: string) =>
  queryOptions({
    queryKey: ['dashboard', caseId],
    queryFn: async () => {
      const todayStr = today();
      const rosterBase = () =>
        supabase
          .from('v_case_roster')
          .select('id', { count: 'exact', head: true })
          .or(`id.eq.${caseId},parent_case_id.eq.${caseId}`);
      const [ordersCount, casesCount, jpmlCount, counselAll, upcoming, recent] = await Promise.all([
        supabase.from('v_orders').select('id', { count: 'exact', head: true }).eq('case_id', caseId),
        rosterBase(),
        rosterBase().eq('on_jpml_schedule_a', true),
        supabase.from('v_counsel').select('firm_name').eq('case_id', caseId),
        supabase
          .from('v_key_dates')
          .select('*')
          .eq('case_id', caseId)
          .gte('event_date', todayStr)
          .order('event_date', { ascending: true })
          .limit(6),
        supabase
          .from('v_orders')
          .select('*')
          .eq('case_id', caseId)
          .not('order_date', 'is', null)
          .order('order_date', { ascending: false })
          .limit(6),
      ]);

      const firms = new Set(
        (counselAll.data ?? [])
          .map((r: { firm_name: string | null }) => r.firm_name)
          .filter(Boolean),
      );
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
      <div className="p-10 text-sm text-destructive">Failed to load: {error.message}</div>
    </AppShell>
  ),
  notFoundComponent: () => (
    <AppShell>
      <div className="p-10">Not found.</div>
    </AppShell>
  ),
});

// ── Small helpers ─────────────────────────────────────────────────────────────

const WEEKDAY = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function parseISO(d: string) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return null;
  // Construct in UTC so weekday is stable across environments.
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return { y: +m[1], mo: +m[2], da: +m[3], dt };
}

function weekdayOf(d: string): string {
  const p = parseISO(d);
  if (!p) return '';
  return WEEKDAY[p.dt.getUTCDay()];
}

function asOfLabel(): string {
  const now = new Date();
  return `${MONTH_SHORT[now.getMonth()]} ${now.getDate()}, ${now.getFullYear()}`;
}

function Stagger({ children }: { children: React.ReactNode }) {
  return (
    <div className="motion-safe:[&>*]:opacity-0 motion-safe:[&>*]:animate-[fadeRise_.5s_ease-out_forwards]">
      {children}
      <style>{`
        @keyframes fadeRise {
          from { opacity: 0; transform: translateY(6px); }
          to   { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

// ── Component ─────────────────────────────────────────────────────────────────

function Dashboard() {
  const { currentMatter } = useMatter();
  const { data, isLoading } = useQuery(dashboardQuery(currentMatter.master_case_id));
  const navigate = useNavigate();

  const cfg = currentMatter.config ?? {};
  const subtitle = cfg.subtitle ?? currentMatter.name;

  return (
    <AppShell>
      <Masthead
        matterName={currentMatter.name}
        subtitle={subtitle}
        mdl={currentMatter.mdl_number}
        court={currentMatter.court}
        judge={currentMatter.judge}
      />

      <div className="px-10 py-8 space-y-8">
        {isLoading || !data ? (
          <DashboardSkeleton />
        ) : (
          <Stagger>
            <section style={{ animationDelay: '0ms' }}>
              <Ledger
                items={[
                  { label: 'Controlling orders', value: data.counts.orders, hint: 'PTO · CMO · CBO' },
                  { label: 'Cases in roster', value: data.counts.cases, hint: 'Master + members' },
                  { label: 'JPML transfers', value: data.counts.jpml, hint: 'Schedule A certified' },
                  { label: 'Counsel of record', value: data.counts.counsel, hint: 'Across both sides' },
                  { label: 'Distinct firms', value: data.counts.firms, hint: 'Filed appearances' },
                ]}
              />
            </section>

            <section
              style={{ animationDelay: '80ms' }}
              className="grid grid-cols-1 lg:grid-cols-3 gap-6 items-start"
            >
              <CriticalDates dates={data.upcoming} />
              <CaseBrief
                subtitle={subtitle}
                mdl={currentMatter.mdl_number}
                court={currentMatter.court}
                judge={currentMatter.judge}
                magistrate={cfg.magistrate as string | undefined}
                posture={cfg.posture as string | undefined}
              />
            </section>

            <section style={{ animationDelay: '160ms' }}>
              <DocketActivity
                orders={data.recent}
                onOpen={(id) => navigate({ to: '/orders', search: { id } as any })}
                onAll={() => navigate({ to: '/orders' })}
              />
            </section>
          </Stagger>
        )}
      </div>
    </AppShell>
  );
}

// ── Masthead ──────────────────────────────────────────────────────────────────

function Masthead({
  matterName,
  subtitle,
  mdl,
  court,
  judge,
}: {
  matterName: string;
  subtitle: string;
  mdl: string;
  court: string;
  judge: string;
}) {
  const navigate = useNavigate();
  return (
    <header className="border-b border-border bg-background">
      <div className="px-10 pt-10 pb-8">
        <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_auto] items-end gap-6">
          <div className="min-w-0">
            <div className="flex items-center gap-2.5">
              <span
                aria-hidden
                className="inline-block h-[2px] w-8"
                style={{ background: 'var(--gold)' }}
              />
              <span className="text-[10.5px] uppercase tracking-[0.22em] text-muted-foreground font-sans font-medium">
                MDL {mdl} · {court}
              </span>
            </div>
            <h1 className="mt-3 font-serif text-[38px] leading-[1.08] font-semibold tracking-[-0.02em] text-foreground">
              {matterName}
            </h1>
            <p className="mt-3 font-serif italic text-[15px] leading-relaxed text-foreground/70 max-w-3xl">
              {subtitle}
            </p>
            <p className="mt-4 text-[11.5px] font-sans text-muted-foreground tabular-nums tracking-[0.02em]">
              Presiding: Hon. {judge}
            </p>
          </div>

          <div className="flex flex-col items-start lg:items-end gap-3 shrink-0">
            <div className="text-[10.5px] uppercase tracking-[0.2em] text-muted-foreground font-sans">
              As of <span className="tabular-nums text-foreground/80 ml-1">{asOfLabel()}</span>
            </div>
            <button
              type="button"
              onClick={() => navigate({ to: '/search' })}
              className="inline-flex items-center gap-2 rounded-sm border border-foreground/15 bg-card px-4 py-2 text-[12px] font-sans font-medium text-foreground hover:border-foreground/40 hover:bg-muted/50 transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/40"
            >
              Ask the Record
              <ArrowRight className="h-3.5 w-3.5" strokeWidth={1.75} />
            </button>
          </div>
        </div>
      </div>
    </header>
  );
}

// ── Ledger (stat strip) ───────────────────────────────────────────────────────

function Ledger({
  items,
}: {
  items: { label: string; value: number; hint: string }[];
}) {
  return (
    <div className="border border-border bg-card rounded-sm overflow-hidden">
      <div className="px-5 pt-3 pb-2 border-b border-border/70 flex items-baseline justify-between">
        <div className="t-eyebrow">Docket at a glance</div>
        <div className="text-[10.5px] uppercase tracking-[0.18em] text-muted-foreground font-sans">
          Live from record
        </div>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-5 divide-y md:divide-y-0 md:divide-x divide-border/70">
        {items.map((it) => (
          <div key={it.label} className="px-5 py-4">
            <div className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground font-sans font-medium">
              {it.label}
            </div>
            <div className="mt-2 font-serif text-[34px] leading-none font-semibold tabular-nums tracking-[-0.02em] text-foreground">
              {it.value.toLocaleString()}
            </div>
            <div className="mt-2 text-[11px] font-sans text-muted-foreground/85 italic">
              {it.hint}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

// ── Critical dates ────────────────────────────────────────────────────────────

function CriticalDates({ dates }: { dates: KeyDate[] }) {
  return (
    <div className="lg:col-span-2 border border-border bg-card rounded-sm overflow-hidden">
      <div className="px-6 pt-4 pb-3 border-b border-border/70 flex items-baseline justify-between">
        <div>
          <div className="t-eyebrow">Calendar</div>
          <h2 className="mt-1 font-serif text-[19px] font-semibold tracking-[-0.01em]">
            Next critical dates
          </h2>
        </div>
        <Link
          to="/deadlines"
          className="text-[11.5px] font-sans font-medium text-foreground/70 hover:text-foreground inline-flex items-center gap-1"
        >
          Full calendar <ArrowRight className="h-3 w-3" />
        </Link>
      </div>

      {dates.length === 0 ? (
        <div className="p-8 text-sm text-muted-foreground font-serif italic">
          No upcoming events on record.
        </div>
      ) : (
        <ul className="divide-y divide-border/70">
          {dates.slice(0, 5).map((d) => {
            const headline = isRule702(d.title) || isRule702(d.description);
            const wd = weekdayOf(d.event_date);
            return (
              <li
                key={d.id}
                className={cn(
                  'relative pl-6 pr-6 py-4 flex gap-6 items-start hover:bg-muted/30 transition-colors',
                  headline && 'pl-[22px]',
                )}
              >
                {headline && (
                  <span
                    aria-hidden
                    className="absolute left-0 top-0 bottom-0 w-[3px]"
                    style={{ background: 'var(--gold)' }}
                  />
                )}
                {/* Date stamp */}
                <div className="w-[92px] shrink-0">
                  <div className="text-[9.5px] uppercase tracking-[0.16em] text-muted-foreground font-sans font-medium">
                    {wd}
                  </div>
                  <div className="mt-0.5 font-serif text-[15px] font-semibold tabular-nums tracking-[-0.01em] text-foreground">
                    {fmtDateRange(d.event_date, d.end_date)}
                  </div>
                  <div className="mt-1.5 text-[10px] uppercase tracking-[0.12em] font-sans font-medium text-muted-foreground">
                    {d.category}
                  </div>
                </div>

                {/* Title + meta */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span
                      className={cn(
                        'text-[14px] leading-snug text-foreground',
                        headline
                          ? 'font-serif text-[16.5px] font-semibold tracking-[-0.005em]'
                          : 'font-sans font-medium',
                      )}
                    >
                      {d.title}
                    </span>
                    {headline && (
                      <span
                        className="text-[9.5px] uppercase tracking-[0.16em] font-sans font-semibold px-1.5 py-[2px] rounded-sm border"
                        style={{
                          color: 'var(--gold)',
                          borderColor: 'color-mix(in oklab, var(--gold) 55%, transparent)',
                        }}
                      >
                        Gating event
                      </span>
                    )}
                    {d.is_conflicted && (
                      <span className="inline-flex items-center gap-1 text-[9.5px] uppercase tracking-[0.14em] text-amber-800 px-1.5 py-[2px] rounded-sm font-sans font-semibold border border-amber-500/40 bg-amber-500/5">
                        <AlertTriangle className="h-3 w-3" /> Conflict
                      </span>
                    )}
                  </div>
                  {d.affects && (
                    <div className="text-[11.5px] text-muted-foreground mt-1.5 font-sans">
                      Affects: {d.affects}
                    </div>
                  )}
                  {d.citation && (
                    <div className="text-[11px] text-muted-foreground/90 mt-1.5 font-serif italic">
                      {d.is_conflicted ? (
                        <span className="not-italic font-sans text-amber-800 mr-1">
                          Conflict cite:
                        </span>
                      ) : (
                        <span className="not-italic font-sans text-muted-foreground/70 mr-1">
                          Source:
                        </span>
                      )}
                      {d.citation}
                    </div>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

// ── Case brief ────────────────────────────────────────────────────────────────

function CaseBrief({
  subtitle,
  mdl,
  court,
  judge,
  magistrate,
  posture,
}: {
  subtitle: string;
  mdl: string;
  court: string;
  judge: string;
  magistrate?: string;
  posture?: string;
}) {
  const rows: [string, string][] = [
    ['MDL №', mdl],
    ['Court', court],
    ['Presiding', `Hon. ${judge}`],
    ...(magistrate ? ([['Magistrate', `Hon. ${magistrate}`]] as [string, string][]) : []),
    ['Posture', posture ?? 'Pretrial · Rule 702 gating'],
  ];

  return (
    <aside className="border border-border bg-card rounded-sm lg:sticky lg:top-4">
      <div className="px-6 pt-4 pb-3 border-b border-border/70">
        <div className="t-eyebrow">Case brief</div>
        <h2 className="mt-1 font-serif text-[19px] font-semibold tracking-[-0.01em]">Posture</h2>
      </div>

      <div className="px-6 py-5">
        <p
          className="font-serif text-[14.5px] leading-[1.65] text-foreground/85
                     first-letter:font-serif first-letter:text-[38px] first-letter:leading-[0.9]
                     first-letter:float-left first-letter:mr-2 first-letter:mt-1
                     first-letter:font-semibold first-letter:text-foreground"
        >
          {subtitle}
        </p>

        <dl className="mt-5 pt-4 border-t border-border/70 grid grid-cols-[auto_1fr] gap-x-5 gap-y-2">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground font-sans font-medium self-baseline">
                {k}
              </dt>
              <dd className="text-[12.5px] font-sans text-foreground tabular-nums leading-snug">
                {v}
              </dd>
            </div>
          ))}
        </dl>

        <div className="mt-5 pt-4 border-t border-border/70">
          <Link
            to="/practice-profile"
            className="inline-flex items-center gap-1 text-[11.5px] font-sans font-medium text-foreground/70 hover:text-foreground"
          >
            Practice profile <ArrowRight className="h-3 w-3" />
          </Link>
        </div>
      </div>
    </aside>
  );
}

// ── Docket activity table ─────────────────────────────────────────────────────

function DocketActivity({
  orders,
  onOpen,
  onAll,
}: {
  orders: Order[];
  onOpen: (id: string) => void;
  onAll: () => void;
}) {
  return (
    <div className="border border-border bg-card rounded-sm overflow-hidden">
      <div className="px-6 pt-4 pb-3 border-b border-border/70 flex items-baseline justify-between">
        <div>
          <div className="t-eyebrow">Docket activity</div>
          <h2 className="mt-1 font-serif text-[19px] font-semibold tracking-[-0.01em]">
            Recent orders
          </h2>
        </div>
        <button
          onClick={onAll}
          className="text-[11.5px] font-sans font-medium text-foreground/70 hover:text-foreground inline-flex items-center gap-1"
        >
          All orders <ArrowRight className="h-3 w-3" />
        </button>
      </div>

      <div
        role="row"
        className="hidden md:grid grid-cols-[110px_1fr_auto] gap-6 px-6 py-2.5 border-b border-border/70 bg-muted/30"
      >
        <div className="text-[10px] uppercase tracking-[0.16em] font-sans font-semibold text-muted-foreground">
          Filed
        </div>
        <div className="text-[10px] uppercase tracking-[0.16em] font-sans font-semibold text-muted-foreground">
          Order
        </div>
        <div className="text-[10px] uppercase tracking-[0.16em] font-sans font-semibold text-muted-foreground">
          Tags
        </div>
      </div>

      <ul className="divide-y divide-border/70">
        {orders.map((o) => {
          const tags = (o.tags ?? []).slice(0, 3);
          const extra = (o.tags ?? []).length - tags.length;
          return (
            <li
              key={o.id}
              onClick={() => onOpen(o.id)}
              className="grid grid-cols-1 md:grid-cols-[110px_1fr_auto] gap-x-6 gap-y-1 px-6 py-3.5 hover:bg-muted/30 cursor-pointer transition-colors"
            >
              <div className="text-[12px] font-sans text-muted-foreground tabular-nums pt-[3px]">
                {fmtDate(o.order_date)}
              </div>
              <div className="min-w-0">
                <div className="flex items-baseline gap-2.5">
                  <span
                    className="text-[10.5px] uppercase tracking-[0.14em] font-sans font-semibold tabular-nums shrink-0"
                    style={{ color: 'var(--gold)' }}
                  >
                    {o.order_type}
                    {o.order_number ? ` ${o.order_number}` : ''}
                  </span>
                  <span className="font-serif text-[14.5px] leading-snug font-medium text-foreground truncate">
                    {o.canonical_title}
                  </span>
                </div>
              </div>
              <div className="flex flex-wrap gap-1.5 md:justify-end pt-1 md:pt-[3px] max-w-[280px]">
                {tags.map((t) => (
                  <span
                    key={t}
                    className="text-[10px] font-sans tracking-[0.04em] text-muted-foreground border border-border/80 px-1.5 py-[1px] rounded-sm"
                  >
                    {tagLabel(t)}
                  </span>
                ))}
                {extra > 0 && (
                  <span className="text-[10px] font-sans text-muted-foreground/70 self-center">
                    +{extra}
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── Skeleton ──────────────────────────────────────────────────────────────────

function DashboardSkeleton() {
  return (
    <div className="space-y-8 animate-pulse">
      <div className="h-[112px] border border-border rounded-sm bg-card" />
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <div className="lg:col-span-2 h-[360px] border border-border rounded-sm bg-card" />
        <div className="h-[360px] border border-border rounded-sm bg-card" />
      </div>
      <div className="h-[320px] border border-border rounded-sm bg-card" />
    </div>
  );
}
