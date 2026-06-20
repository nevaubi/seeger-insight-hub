import { createFileRoute } from '@tanstack/react-router';
import { useSuspenseQuery, queryOptions } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import { CheckCircle2, Search as SearchIcon, Star } from 'lucide-react';
import { AppShell, PageHeader } from '@/components/app-shell';
import { SideBadge, fmtDate } from '@/components/case-ui';
import { Card } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { supabase, type CaseRow, type CounselRow } from '@/lib/supabase';
import { cn } from '@/lib/utils';

const casesQuery = queryOptions({
  queryKey: ['roster-cases'],
  queryFn: async () => {
    const { data, error } = await supabase
      .from('v_case_roster')
      .select('*')
      .order('date_filed', { ascending: false, nullsFirst: false });
    if (error) throw error;
    return (data ?? []) as CaseRow[];
  },
});

const counselQuery = queryOptions({
  queryKey: ['roster-counsel'],
  queryFn: async () => {
    const { data, error } = await supabase.from('v_counsel').select('*');
    if (error) throw error;
    return (data ?? []) as CounselRow[];
  },
});

export const Route = createFileRoute('/roster')({
  loader: async ({ context }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(casesQuery),
      context.queryClient.ensureQueryData(counselQuery),
    ]);
  },
  component: RosterPage,
  errorComponent: ({ error }) => (
    <AppShell><div className="p-8 text-sm text-destructive">Failed to load: {error.message}</div></AppShell>
  ),
  notFoundComponent: () => <AppShell><div className="p-8">Not found.</div></AppShell>,
});

function RosterPage() {
  return (
    <AppShell>
      <PageHeader
        title="Roster & Key Players"
        description="The MDL master case and member roster, plus counsel of record across both sides."
      />
      <div className="px-8 py-6">
        <Tabs defaultValue="cases">
          <TabsList>
            <TabsTrigger value="cases">Cases</TabsTrigger>
            <TabsTrigger value="counsel">Counsel & Firms</TabsTrigger>
          </TabsList>
          <TabsContent value="cases" className="mt-4"><CasesTab /></TabsContent>
          <TabsContent value="counsel" className="mt-4"><CounselTab /></TabsContent>
        </Tabs>
      </div>
    </AppShell>
  );
}

function CasesTab() {
  const { data: cases } = useSuspenseQuery(casesQuery);
  const [courtFilter, setCourtFilter] = useState<string>('all');
  const [certifiedOnly, setCertifiedOnly] = useState(false);

  const courts = useMemo(() => {
    const s = new Set<string>();
    cases.forEach((c) => c.court_name && s.add(c.court_name));
    return Array.from(s).sort();
  }, [cases]);

  const master = cases.filter((c) => c.case_role === 'mdl_master');
  const rest = cases.filter((c) => c.case_role !== 'mdl_master');

  const filteredRest = rest.filter((c) => {
    if (certifiedOnly && !c.on_jpml_schedule_a) return false;
    if (courtFilter !== 'all' && c.court_name !== courtFilter) return false;
    return true;
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-4">
        <div className="flex items-center gap-2">
          <label className="text-xs uppercase tracking-wider text-muted-foreground">Court</label>
          <select
            value={courtFilter}
            onChange={(e) => setCourtFilter(e.target.value)}
            className="h-9 rounded-md border border-border bg-card px-2 text-sm"
          >
            <option value="all">All courts</option>
            {courts.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-2.5 text-sm">
          <Switch checked={certifiedOnly} onCheckedChange={setCertifiedOnly} id="cert" />
          <label htmlFor="cert" className="text-muted-foreground cursor-pointer">Certified JPML transfers only</label>
        </div>
        <div className="ml-auto text-xs text-muted-foreground">
          {master.length + filteredRest.length} cases
        </div>
      </div>

      <Card className="p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-secondary/60 text-[11px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="text-left px-4 py-2.5 font-medium">Case name</th>
              <th className="text-left px-4 py-2.5 font-medium w-36">Docket</th>
              <th className="text-left px-4 py-2.5 font-medium">Court</th>
              <th className="text-left px-4 py-2.5 font-medium w-44">Judge</th>
              <th className="text-left px-4 py-2.5 font-medium w-28">Filed</th>
              <th className="text-left px-4 py-2.5 font-medium w-32">Status</th>
            </tr>
          </thead>
          <tbody>
            {master.map((c) => <CaseRowEl key={c.id} c={c} pinned />)}
            {filteredRest.map((c) => <CaseRowEl key={c.id} c={c} />)}
            {master.length + filteredRest.length === 0 && (
              <tr><td colSpan={6} className="px-4 py-10 text-center text-sm text-muted-foreground">No cases match.</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function CaseRowEl({ c, pinned }: { c: CaseRow; pinned?: boolean }) {
  return (
    <tr className={cn(
      'border-t border-border align-top',
      pinned && 'bg-[oklch(0.26_0.04_255_/_0.06)] border-l-2 border-l-primary',
    )}>
      <td className="px-4 py-3">
        <div className="flex items-start gap-2">
          {pinned && <Star className="h-3.5 w-3.5 text-primary mt-0.5 shrink-0" fill="currentColor" />}
          <div>
            <div className="font-medium text-foreground font-serif">{c.case_name}</div>
            {pinned && (
              <div className="text-[10px] uppercase tracking-wider text-primary font-semibold mt-0.5">MDL Master Case</div>
            )}
            {c.on_jpml_schedule_a && !pinned && (
              <span className="inline-flex items-center gap-1 mt-1 text-[10px] uppercase tracking-wider bg-[oklch(0.4_0.06_140)] text-white px-1.5 py-0.5 rounded font-semibold">
                <CheckCircle2 className="h-3 w-3" /> Certified transfer
              </span>
            )}
          </div>
        </div>
      </td>
      <td className="px-4 py-3 text-muted-foreground tabular-nums text-xs">{c.docket_number ?? '—'}</td>
      <td className="px-4 py-3 text-foreground/80 text-xs">{c.court_name ?? '—'}</td>
      <td className="px-4 py-3 text-foreground/80 text-xs">{c.assigned_judge ?? c.assigned_judge_str ?? '—'}</td>
      <td className="px-4 py-3 text-muted-foreground tabular-nums text-xs">{fmtDate(c.date_filed)}</td>
      <td className="px-4 py-3 text-xs">
        <span className="text-foreground/80">{c.case_status ?? '—'}</span>
      </td>
    </tr>
  );
}

function CounselTab() {
  const { data: counsel } = useSuspenseQuery(counselQuery);
  const [sideFilter, setSideFilter] = useState<'all' | 'plaintiff' | 'defendant'>('all');
  const [q, setQ] = useState('');

  const filtered = useMemo(() => {
    const v = q.trim().toLowerCase();
    return counsel.filter((c) => {
      if (sideFilter !== 'all' && c.side !== sideFilter) return false;
      if (v) {
        const hay = `${c.firm_name ?? ''} ${c.attorney_name ?? ''}`.toLowerCase();
        if (!hay.includes(v)) return false;
      }
      return true;
    });
  }, [counsel, sideFilter, q]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[240px] max-w-sm">
          <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search firm or attorney…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-9 bg-card"
          />
        </div>
        <div className="flex items-center gap-1.5">
          {(['all', 'plaintiff', 'defendant'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSideFilter(s)}
              className={cn(
                'text-xs px-2.5 py-1 rounded border capitalize',
                sideFilter === s ? 'bg-primary text-primary-foreground border-primary' : 'bg-card border-border text-foreground/70 hover:bg-muted',
              )}
            >
              {s}
            </button>
          ))}
        </div>
        <div className="ml-auto text-xs text-muted-foreground">
          {filtered.length} of {counsel.length}
        </div>
      </div>

      <Card className="p-0 overflow-hidden">
        <table className="w-full text-sm">
          <thead className="bg-secondary/60 text-[11px] uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="text-left px-4 py-2.5 font-medium w-20">Side</th>
              <th className="text-left px-4 py-2.5 font-medium">Attorney</th>
              <th className="text-left px-4 py-2.5 font-medium">Firm</th>
              <th className="text-left px-4 py-2.5 font-medium">Represents</th>
              <th className="text-left px-4 py-2.5 font-medium w-56">Contact</th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((c) => {
              const isSeeger = (c.firm_name ?? '').toUpperCase().includes('SEEGER');
              return (
                <tr key={c.id} className={cn(
                  'border-t border-border align-top',
                  isSeeger && 'bg-[oklch(0.42_0.14_25_/_0.05)] border-l-2 border-l-accent',
                )}>
                  <td className="px-4 py-3"><SideBadge side={c.side} /></td>
                  <td className="px-4 py-3 font-medium text-foreground">{c.attorney_name ?? '—'}</td>
                  <td className="px-4 py-3 text-foreground/80 font-serif">
                    {c.firm_name ?? '—'}
                    {isSeeger && (
                      <span className="ml-2 text-[10px] uppercase tracking-wider text-accent font-semibold not-italic font-sans">Our firm</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-xs text-foreground/75">{c.represents ?? '—'}</td>
                  <td className="px-4 py-3 text-xs">
                    {c.email && <div><a className="text-accent hover:underline" href={`mailto:${c.email}`}>{c.email}</a></div>}
                    {c.phone && <div className="text-muted-foreground tabular-nums">{c.phone}</div>}
                  </td>
                </tr>
              );
            })}
            {filtered.length === 0 && (
              <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-muted-foreground">No counsel match.</td></tr>
            )}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
