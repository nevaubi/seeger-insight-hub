import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Loader2,
  Search as SearchIcon,
  RefreshCw,
  CheckCircle2,
  Check,
  X,
  Send,
  Sparkles,
  BadgeCheck,
  Calendar,
  FileText,
  AlertTriangle,
} from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  supabase,
  type Deposition,
  type DepositionLine,
  type DepositionSegment,
  type DepositionFinding,
  type FindingStance,
  type DepoAskResponse,
} from '@/lib/supabase';
import { analyzeDeposition, askDeposition } from '@/lib/depo-api';
import { fmtDate } from '@/components/case-ui';
import { cn } from '@/lib/utils';

type VerifyStatus = 'verified' | 'unverified' | 'failed' | null | undefined;

function VerifyMark({ status }: { status: VerifyStatus }) {
  if (status === 'verified') {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10.5px] text-emerald-700"
        title="Quote verified verbatim in the transcript"
      >
        <CheckCircle2 className="h-3.5 w-3.5" />
      </span>
    );
  }
  if (status === 'failed') {
    return (
      <span
        className="inline-flex items-center gap-1 text-[10.5px] text-amber-700"
        title="Quote could not be verified verbatim against the transcript"
      >
        <AlertTriangle className="h-3.5 w-3.5" />
        <span className="uppercase tracking-wide">unverified</span>
      </span>
    );
  }
  return null;
}

export const Route = createFileRoute('/depositions/$id')({
  validateSearch: (search: Record<string, unknown>): { analyze: boolean } => ({
    analyze: search.analyze === true || search.analyze === 'true',
  }),
  component: DepositionWorkspace,
  errorComponent: ({ error }) => (
    <AppShell>
      <div className="p-8 text-sm text-destructive">Failed to load: {error.message}</div>
    </AppShell>
  ),
  notFoundComponent: () => (
    <AppShell>
      <div className="p-8">Not found.</div>
    </AppShell>
  ),
});

interface CiteSpan {
  page_start: number | null;
  line_start: number | null;
  page_end: number | null;
  line_end: number | null;
}

function formatCite(c: CiteSpan): string | null {
  if (c.page_start == null || c.line_start == null) return null;
  const start = `${c.page_start}:${c.line_start}`;
  if (c.page_end == null || c.line_end == null) return start;
  if (c.page_end === c.page_start && c.line_end === c.line_start) return start;
  if (c.page_end === c.page_start) return `${start}–${c.line_end}`;
  return `${start}–${c.page_end}:${c.line_end}`;
}

function AlignmentBadge({ alignment, role }: { alignment: string | null; role: string | null }) {
  const a = (alignment || '').toLowerCase();
  const label = role || alignment || 'Witness';
  const tone =
    a === 'plaintiff'
      ? 'bg-primary/10 text-primary border-primary/20'
      : a === 'defendant'
        ? 'bg-accent/15 text-accent-foreground border-accent/30'
        : 'bg-secondary text-secondary-foreground border-border';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm border px-2 py-0.5 text-[10.5px] font-medium tracking-wide uppercase',
        tone,
      )}
    >
      {label}
    </span>
  );
}

function StanceBadge({ stance }: { stance: FindingStance | null }) {
  if (!stance) return null;
  const tone =
    stance === 'helpful'
      ? 'bg-emerald-600/10 text-emerald-700 border-emerald-600/20'
      : stance === 'harmful'
        ? 'bg-rose-600/10 text-rose-700 border-rose-600/20'
        : 'bg-slate-500/10 text-slate-700 border-slate-500/20';
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase',
        tone,
      )}
    >
      {stance}
    </span>
  );
}

function StanceDot({ stance }: { stance: FindingStance | null }) {
  const tone =
    stance === 'helpful'
      ? 'bg-emerald-500'
      : stance === 'harmful'
        ? 'bg-rose-500'
        : 'bg-slate-400';
  return <span className={cn('inline-block h-2 w-2 rounded-full', tone)} />;
}

function CiteButton({
  span,
  onCite,
  label,
}: {
  span: CiteSpan;
  onCite: (s: CiteSpan) => void;
  label?: string | null;
}) {
  const text = label ?? formatCite(span);
  if (!text) return null;
  return (
    <button
      type="button"
      onClick={() => onCite(span)}
      className="inline-flex items-center rounded-sm border border-border bg-secondary/40 px-1.5 py-0.5 font-mono text-[11px] tabular-nums text-foreground hover:bg-primary/10 hover:border-primary/30 hover:text-primary transition-colors"
    >
      {text}
    </button>
  );
}

function IssueTags({ tags }: { tags: string[] | null }) {
  if (!tags || tags.length === 0) return null;
  return (
    <div className="flex flex-wrap gap-1">
      {tags.map((t) => (
        <span
          key={t}
          className="inline-flex items-center rounded-sm border border-border bg-secondary/50 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
        >
          {t}
        </span>
      ))}
    </div>
  );
}

function DepositionWorkspace() {
  const { id } = Route.useParams();
  const searchParams = Route.useSearch();
  const navigate = useNavigate();
  const qc = useQueryClient();

  const depoQ = useQuery({
    queryKey: ['deposition', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('depositions')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw error;
      return data as Deposition | null;
    },
    refetchInterval: (q) =>
      (q.state.data as Deposition | null)?.status === 'analyzing' ? 2500 : false,
  });

  const linesQ = useQuery({
    queryKey: ['deposition-lines', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('deposition_lines')
        .select('*')
        .eq('deposition_id', id)
        .order('page', { ascending: true })
        .order('line', { ascending: true });
      if (error) throw error;
      return (data ?? []) as DepositionLine[];
    },
  });

  const currentStatus = depoQ.data?.status;
  const findingsQ = useQuery({
    queryKey: ['deposition-findings', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('deposition_findings')
        .select('*')
        .eq('deposition_id', id)
        .order('finding_type', { ascending: true })
        .order('ordinal', { ascending: true });
      if (error) throw error;
      return (data ?? []) as DepositionFinding[];
    },
    refetchInterval: currentStatus === 'analyzing' ? 2500 : false,
  });

  const segmentsQ = useQuery({
    queryKey: ['deposition-segments', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('deposition_segments')
        .select('*')
        .eq('deposition_id', id)
        .order('ordinal', { ascending: true });
      if (error) throw error;
      return (data ?? []) as DepositionSegment[];
    },
  });

  const runQ = useQuery({
    queryKey: ['deposition-latest-run', id],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('deposition_runs')
        .select('stats')
        .eq('deposition_id', id)
        .eq('kind', 'analyze')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (error) throw error;
      return data as { stats: Record<string, unknown> | null } | null;
    },
    refetchInterval: currentStatus === 'analyzing' ? 2500 : false,
  });

  // Transcript: refs + search + scroll-to-cite
  const [search, setSearch] = useState('');
  const [mobileView, setMobileView] = useState<'transcript' | 'findings'>('transcript');
  const [highlighted, setHighlighted] = useState<Set<string>>(new Set());
  const highlightTimer = useRef<number | null>(null);

  const scrollToCite = useCallback(
    (span: CiteSpan) => {
      if (span.page_start == null || span.line_start == null) return;
      setMobileView('transcript');
      const anchor = document.getElementById(`line-${span.page_start}-${span.line_start}`);
      anchor?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      const keys = new Set<string>();
      const ps = span.page_start;
      const ls = span.line_start;
      const pe = span.page_end ?? ps;
      const le = span.line_end ?? ls;
      const lines = linesQ.data ?? [];
      for (const l of lines) {
        const afterStart = l.page > ps || (l.page === ps && l.line >= ls);
        const beforeEnd = l.page < pe || (l.page === pe && l.line <= le);
        if (afterStart && beforeEnd) keys.add(`${l.page}-${l.line}`);
      }
      setHighlighted(keys);
      if (highlightTimer.current) window.clearTimeout(highlightTimer.current);
      highlightTimer.current = window.setTimeout(() => setHighlighted(new Set()), 2500);
    },
    [linesQ.data],
  );

  // Group lines by page
  const linesByPage = useMemo(() => {
    const groups = new Map<number, DepositionLine[]>();
    for (const l of linesQ.data ?? []) {
      const arr = groups.get(l.page) ?? [];
      arr.push(l);
      groups.set(l.page, arr);
    }
    return Array.from(groups.entries()).sort((a, b) => a[0] - b[0]);
  }, [linesQ.data]);

  // Line -> segment lookup via pointer walk (segments are ordered, non-overlapping)
  const segmentByLineKey = useMemo(() => {
    const map = new Map<string, DepositionSegment>();
    const segs = segmentsQ.data ?? [];
    const lines = linesQ.data ?? [];
    if (segs.length === 0 || lines.length === 0) return map;
    let si = 0;
    for (const l of lines) {
      // Advance segment pointer until this line is not past its end
      while (
        si < segs.length &&
        (l.page > segs[si].page_end ||
          (l.page === segs[si].page_end && l.line > segs[si].line_end))
      ) {
        si += 1;
      }
      if (si >= segs.length) break;
      const s = segs[si];
      const afterStart =
        l.page > s.page_start || (l.page === s.page_start && l.line >= s.line_start);
      if (afterStart) map.set(`${l.page}-${l.line}`, s);
    }
    return map;
  }, [segmentsQ.data, linesQ.data]);

  const searchLower = search.trim().toLowerCase();

  // Findings by type
  const findings = findingsQ.data ?? [];
  const byType = useMemo(() => {
    const m: Record<string, DepositionFinding[]> = {};
    for (const f of findings) {
      (m[f.finding_type] ??= []).push(f);
    }
    return m;
  }, [findings]);

  // Optimistically bump status → 'analyzing' so polling begins and a reload still shows the running state
  const setStatusAnalyzing = useCallback(async () => {
    await supabase.from('depositions').update({ status: 'analyzing' }).eq('id', id);
    qc.invalidateQueries({ queryKey: ['deposition', id] });
  }, [id, qc]);

  // Re-run analysis
  const analyzeM = useMutation({
    mutationFn: () => analyzeDeposition(id),
    onSuccess: async (res) => {
      if (!res.ok) {
        const msg = res.error || 'Analysis failed';
        await supabase
          .from('depositions')
          .update({ status: 'error', error: msg })
          .eq('id', id);
        qc.invalidateQueries({ queryKey: ['deposition', id] });
        toast.error(msg);
        return;
      }
      toast.success('Analysis complete');
      qc.invalidateQueries({ queryKey: ['deposition-findings', id] });
      qc.invalidateQueries({ queryKey: ['deposition', id] });
    },
    onError: async (e) => {
      const msg = e instanceof Error ? e.message : 'Analysis failed';
      await supabase
        .from('depositions')
        .update({ status: 'error', error: msg })
        .eq('id', id);
      qc.invalidateQueries({ queryKey: ['deposition', id] });
      toast.error(msg);
    },
  });

  const runAnalyze = useCallback(async () => {
    await setStatusAnalyzing();
    analyzeM.mutate();
  }, [analyzeM, setStatusAnalyzing]);

  // Auto-start analysis once when we arrive with ?analyze=true on an ingested deposition
  const autoStartedRef = useRef(false);
  useEffect(() => {
    if (autoStartedRef.current) return;
    if (!searchParams.analyze) return;
    if (!depoQ.data) return;
    if (depoQ.data.status !== 'ingested') return;
    if (analyzeM.isPending) return;
    autoStartedRef.current = true;
    void runAnalyze();
  }, [searchParams.analyze, depoQ.data, analyzeM.isPending, runAnalyze]);


  // Review controls
  const reviewM = useMutation({
    mutationFn: async (input: { findingId: string; status: 'approved' | 'rejected' }) => {
      const { error } = await supabase
        .from('deposition_findings')
        .update({ review_status: input.status })
        .eq('id', input.findingId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['deposition-findings', id] }),
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Update failed'),
  });

  // Ask
  const [question, setQuestion] = useState('');
  const [askResult, setAskResult] = useState<DepoAskResponse | null>(null);
  const [lastQuestion, setLastQuestion] = useState('');
  const askM = useMutation({
    mutationFn: (q: string) => askDeposition(id, q),
    onSuccess: (res, q) => {
      setAskResult(res);
      setLastQuestion(q);
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Ask failed'),
  });

  const depo = depoQ.data;
  const loading = depoQ.isLoading || linesQ.isLoading;

  if (loading) {
    return (
      <AppShell>
        <div className="p-8">
          <div className="animate-pulse space-y-3">
            <div className="h-6 w-64 rounded bg-secondary" />
            <div className="h-4 w-96 rounded bg-secondary" />
            <div className="mt-6 grid grid-cols-1 lg:grid-cols-[58%_1fr] gap-6">
              <div className="h-[70vh] rounded bg-secondary/60" />
              <div className="h-[70vh] rounded bg-secondary/60" />
            </div>
          </div>
        </div>
      </AppShell>
    );
  }

  if (!depo) {
    return (
      <AppShell>
        <div className="p-8">
          <Card className="p-8 text-center max-w-lg mx-auto">
            <AlertTriangle className="mx-auto h-6 w-6 text-muted-foreground" />
            <div className="mt-2 font-serif text-lg font-semibold">Deposition not found</div>
            <p className="mt-1 text-sm text-muted-foreground">
              It may have been removed or the link is incorrect.
            </p>
            <Button
              className="mt-4"
              variant="outline"
              onClick={() => navigate({ to: '/depositions' })}
            >
              <ArrowLeft className="mr-2 h-4 w-4" /> Back to Depositions
            </Button>
          </Card>
        </div>
      </AppShell>
    );
  }

  const title = depo.witness_name || depo.filename || 'Untitled deposition';
  const subtitleBits = [
    depo.individual_case_no,
    depo.mdl_number ? `MDL ${depo.mdl_number}` : null,
    depo.deposition_date ? `Deposed ${fmtDate(depo.deposition_date)}` : null,
    depo.page_count != null ? `${depo.page_count} pp` : null,
  ].filter(Boolean) as string[];

  const analyzed = depo.status === 'analyzed';
  const isAnalyzing = depo.status === 'analyzing' || analyzeM.isPending;
  const hasError = depo.status === 'error';
  const noFindings = findings.length === 0;

  const droppedCount = (() => {
    const stats = runQ.data?.stats as { dropped?: number } | null | undefined;
    const n = stats?.dropped;
    return typeof n === 'number' && n > 0 ? n : 0;
  })();

  return (
    <AppShell>
      <div className="border-b border-border bg-card px-8 py-8">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <Link
              to="/depositions"
              className="inline-flex items-center gap-1 text-xs font-sans text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-3 w-3" /> Depositions
            </Link>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <h1 className="font-serif text-[32px] leading-[1.15] font-semibold tracking-[-0.015em] text-foreground">
                {title}
              </h1>
              <AlignmentBadge alignment={depo.party_alignment} role={depo.witness_role} />
            </div>
            {subtitleBits.length > 0 && (
              <p className="mt-2 font-sans text-sm leading-relaxed text-muted-foreground tabular-nums">
                {subtitleBits.join(' · ')}
              </p>
            )}
          </div>
          <div className="shrink-0">
            <Button
              variant="outline"
              onClick={() => void runAnalyze()}
              disabled={isAnalyzing}
            >
              {isAnalyzing ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Analyzing…
                </>
              ) : (
                <>
                  <RefreshCw className="mr-2 h-4 w-4" /> Re-run analysis
                </>
              )}
            </Button>
          </div>
        </div>
      </div>

      <div className="px-8 py-6">
        {/* Mobile toggle (below lg) */}
        <div className="mb-4 lg:hidden">
          <div className="inline-flex rounded-md border border-border bg-card p-0.5">
            {(['transcript', 'findings'] as const).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => setMobileView(v)}
                className={cn(
                  'px-3 py-1.5 text-xs font-medium capitalize rounded-sm transition-colors',
                  mobileView === v
                    ? 'bg-primary text-primary-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                {v}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-[58%_1fr] gap-6">
          {/* LEFT: transcript */}
          <div className={cn('min-w-0', mobileView !== 'transcript' && 'hidden lg:block')}>
            <Card className="p-0 overflow-hidden flex flex-col h-[calc(100vh-11rem)] sticky top-4">
              <div className="border-b border-border bg-card px-4 py-3 shrink-0">
                <div className="relative">
                  <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Search transcript…"
                    className="pl-8 h-8 text-sm"
                  />
                </div>
              </div>
              <div className="flex-1 overflow-y-auto">
                {linesByPage.length === 0 ? (
                  <div className="p-8 text-center text-sm text-muted-foreground">
                    No transcript lines found.
                  </div>
                ) : (
                  <div className="py-2">
                    {linesByPage.map(([page, pageLines]) => {
                      // Determine "previous segment" carried over from the last line of the previous page
                      return (
                        <div key={page}>
                          <div className="sticky top-0 z-10 bg-secondary/70 backdrop-blur border-y border-border px-4 py-1 text-[10.5px] font-sans font-medium uppercase tracking-[0.14em] text-muted-foreground tabular-nums">
                            Page {page}
                          </div>
                          <div className="py-1">
                            {pageLines.map((l, idx) => {
                              const key = `${l.page}-${l.line}`;
                              const isMatch =
                                searchLower.length > 0 &&
                                l.text.toLowerCase().includes(searchLower);
                              const isHi = highlighted.has(key);
                              const seg = segmentByLineKey.get(key);
                              // Prev line across pages: prefer previous line on this page,
                              // else previous page's last line via lines array lookup
                              const prevLine =
                                idx > 0
                                  ? pageLines[idx - 1]
                                  : (() => {
                                      const all = linesQ.data ?? [];
                                      const i = all.findIndex(
                                        (x) => x.page === l.page && x.line === l.line,
                                      );
                                      return i > 0 ? all[i - 1] : undefined;
                                    })();
                              const prevSeg = prevLine
                                ? segmentByLineKey.get(`${prevLine.page}-${prevLine.line}`)
                                : undefined;
                              const isFirstOfSeg = !!seg && seg.id !== prevSeg?.id;

                              const kind = (seg?.kind || '').toLowerCase();
                              const speaker = (seg?.speaker || '').trim();
                              const isBareQA = speaker === 'Q' || speaker === 'A' || speaker === '';
                              let label = '';
                              if (kind === 'question') label = 'Q';
                              else if (kind === 'answer') label = 'A';
                              else if (kind === 'objection') label = 'OBJECTION';
                              else if (kind === 'event') label = '(RECORD)';
                              else label = (speaker || kind || '').toUpperCase();
                              if (
                                (kind === 'question' ||
                                  kind === 'answer' ||
                                  kind === 'objection' ||
                                  kind === 'event') &&
                                speaker &&
                                !isBareQA
                              ) {
                                label = `${label} · ${speaker}`;
                              }

                              // Turn styling by kind
                              const turnAccent =
                                kind === 'question'
                                  ? 'border-l-2 border-primary/40'
                                  : kind === 'answer'
                                    ? 'border-l-2 border-transparent bg-secondary/25'
                                    : kind === 'objection' || kind === 'event' || kind === 'colloquy'
                                      ? 'border-l-2 border-transparent'
                                      : 'border-l-2 border-transparent';
                              const textTone =
                                kind === 'question'
                                  ? 'text-foreground font-medium'
                                  : kind === 'answer'
                                    ? 'text-foreground'
                                    : kind === 'objection' ||
                                        kind === 'event' ||
                                        kind === 'colloquy'
                                      ? 'text-muted-foreground italic'
                                      : 'text-foreground/85';

                              return (
                                <div key={l.id}>
                                  {isFirstOfSeg && label && (
                                    <div className="mt-2 px-4 pl-6 text-[10px] font-sans font-semibold uppercase tracking-[0.14em] text-muted-foreground/80">
                                      {label}
                                    </div>
                                  )}
                                  <div
                                    id={`line-${l.page}-${l.line}`}
                                    className={cn(
                                      'flex gap-3 pl-3 pr-4 py-[2px] transition-colors',
                                      turnAccent,
                                      isHi && 'bg-primary/15',
                                      !isHi && isMatch && 'bg-amber-200/40',
                                    )}
                                  >
                                    <span className="shrink-0 w-11 font-mono text-[10.5px] leading-5 text-muted-foreground/70 tabular-nums select-none">
                                      {l.page}:{String(l.line).padStart(2, '0')}
                                    </span>
                                    <span
                                      className={cn(
                                        'font-mono text-[12.5px] leading-5 whitespace-pre-wrap',
                                        textTone,
                                      )}
                                    >
                                      {l.text}
                                    </span>
                                  </div>
                                </div>
                              );
                            })}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            </Card>
          </div>

          {/* RIGHT: findings tabs */}
          <div className={cn('min-w-0', mobileView !== 'findings' && 'hidden lg:block')}>
            {droppedCount > 0 && !isAnalyzing && !hasError && (
              <div className="mb-3 flex items-start gap-2 rounded-sm border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-[12px] text-amber-800">
                <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                <span>
                  {droppedCount} candidate finding{droppedCount === 1 ? '' : 's'} were dropped
                  because their quotes couldn't be verified verbatim against the transcript.
                </span>
              </div>
            )}
            {isAnalyzing ? (
              <Card className="p-8 text-center">
                <Loader2 className="mx-auto h-5 w-5 animate-spin text-primary" />
                <div className="mt-3 font-serif text-base font-semibold">
                  Analyzing testimony…
                </div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Findings will appear here as soon as the analysis completes.
                </p>
              </Card>
            ) : hasError ? (
              <Card className="p-8 text-center border-destructive/40">
                <AlertTriangle className="mx-auto h-5 w-5 text-destructive" />
                <div className="mt-2 font-serif text-base font-semibold">Analysis failed</div>
                <p className="mt-1 text-sm text-muted-foreground">
                  {depo.error || 'Something went wrong while analyzing this transcript.'}
                </p>
                <Button
                  className="mt-4"
                  onClick={() => void runAnalyze()}
                  disabled={analyzeM.isPending}
                >
                  <RefreshCw className="mr-2 h-4 w-4" /> Retry analysis
                </Button>
              </Card>
            ) : noFindings && !analyzed && !searchParams.analyze ? (
              <Card className="p-8 text-center">
                <Sparkles className="mx-auto h-5 w-5 text-muted-foreground" />
                <div className="mt-2 font-serif text-base font-semibold">Not analyzed yet</div>
                <p className="mt-1 text-sm text-muted-foreground">
                  Run analysis to surface admissions, chronology, and exhibits.
                </p>
                <Button className="mt-4" onClick={() => void runAnalyze()}>
                  <Sparkles className="mr-2 h-4 w-4" /> Run analysis
                </Button>
              </Card>
            ) : (
              <Tabs defaultValue="summary" className="w-full">
                <TabsList className="flex w-full justify-start gap-1 overflow-x-auto whitespace-nowrap h-auto p-1">
                  <TabsTrigger value="summary" className="shrink-0 px-3">Summary</TabsTrigger>
                  <TabsTrigger value="admissions" className="shrink-0 px-3">Admissions</TabsTrigger>
                  <TabsTrigger value="chronology" className="shrink-0 px-3">Chronology</TabsTrigger>
                  <TabsTrigger value="exhibits" className="shrink-0 px-3">Exhibits</TabsTrigger>
                  <TabsTrigger value="quality" className="shrink-0 px-3">Quality</TabsTrigger>
                  <TabsTrigger value="ask" className="shrink-0 px-3">Ask</TabsTrigger>
                </TabsList>

                <TabsContent value="summary" className="mt-4">
                  <SummaryTab
                    execs={byType['exec_summary'] ?? []}
                    profiles={byType['witness_profile'] ?? []}
                    onCite={scrollToCite}
                  />
                </TabsContent>

                <TabsContent value="admissions" className="mt-4">
                  <AdmissionsTab
                    items={byType['admission'] ?? []}
                    onCite={scrollToCite}
                    onReview={(fid, status) =>
                      reviewM.mutate({ findingId: fid, status })
                    }
                    pendingId={reviewM.isPending ? reviewM.variables?.findingId : undefined}
                  />
                </TabsContent>

                <TabsContent value="chronology" className="mt-4">
                  <ChronologyTab items={byType['chronology'] ?? []} onCite={scrollToCite} />
                </TabsContent>

                <TabsContent value="exhibits" className="mt-4">
                  <ExhibitsTab items={byType['exhibit'] ?? []} onCite={scrollToCite} />
                </TabsContent>

                <TabsContent value="quality" className="mt-4">
                  <QualityTab items={byType['quality_note'] ?? []} onCite={scrollToCite} />
                </TabsContent>

                <TabsContent value="ask" className="mt-4">
                  <AskTab
                    question={question}
                    setQuestion={setQuestion}
                    lastQuestion={lastQuestion}
                    result={askResult}
                    onAsk={(q) => askM.mutate(q)}
                    pending={askM.isPending}
                    onCite={scrollToCite}
                  />
                </TabsContent>
              </Tabs>
            )}
          </div>
        </div>
      </div>
    </AppShell>
  );
}

// ---------- Tab components ----------

function EmptyTab({ label }: { label: string }) {
  return (
    <Card className="p-6 text-center text-sm text-muted-foreground">No {label} yet.</Card>
  );
}

function SummaryTab({
  execs,
  profiles,
  onCite,
}: {
  execs: DepositionFinding[];
  profiles: DepositionFinding[];
  onCite: (s: CiteSpan) => void;
}) {
  const exec = execs[0];
  const profile = profiles[0];
  if (!exec && !profile) return <EmptyTab label="summary" />;
  const data = (profile?.data ?? {}) as {
    role?: string;
    key_points?: {
      text: string;
      quote?: string;
      cite?: string;
      verified?: boolean;
      page_start?: number | null;
      line_start?: number | null;
      page_end?: number | null;
      line_end?: number | null;
    }[];
  };
  return (
    <div className="space-y-4">
      {exec?.detail && (
        <Card className="p-5">
          <div className="text-[10.5px] uppercase tracking-[0.14em] font-medium text-muted-foreground mb-2">
            Executive summary
          </div>
          <p className="font-serif text-[15px] leading-relaxed text-foreground">
            {exec.detail}
          </p>
        </Card>
      )}
      {profile && (
        <Card className="p-5">
          <div className="flex items-baseline justify-between gap-2 mb-2">
            <div className="text-[10.5px] uppercase tracking-[0.14em] font-medium text-muted-foreground">
              Witness profile
            </div>
            {data.role && (
              <div className="text-xs text-muted-foreground">{data.role}</div>
            )}
          </div>
          {profile.detail && (
            <p className="text-sm text-foreground/90 leading-relaxed">{profile.detail}</p>
          )}
          {Array.isArray(data.key_points) && data.key_points.length > 0 && (
            <ul className="mt-4 space-y-2.5">
              {data.key_points.map((kp, i) => (
                <li key={i} className="text-sm">
                  <div className="flex items-start gap-2">
                    <span className="mt-1.5 inline-block h-1 w-1 rounded-full bg-primary/70 shrink-0" />
                    <div className="min-w-0 flex-1">
                      <div className="text-foreground/90">{kp.text}</div>
                      {kp.quote && (
                        <div className="mt-1 text-xs text-muted-foreground italic">
                          “{kp.quote}”
                        </div>
                      )}
                      <div className="mt-1 flex items-center gap-1.5">
                        <CiteButton
                          span={{
                            page_start: kp.page_start ?? null,
                            line_start: kp.line_start ?? null,
                            page_end: kp.page_end ?? null,
                            line_end: kp.line_end ?? null,
                          }}
                          onCite={onCite}
                          label={kp.cite}
                        />
                        {kp.verified && (
                          <BadgeCheck className="h-3.5 w-3.5 text-emerald-600" />
                        )}
                      </div>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  );
}

function AdmissionsTab({
  items,
  onCite,
  onReview,
  pendingId,
}: {
  items: DepositionFinding[];
  onCite: (s: CiteSpan) => void;
  onReview: (findingId: string, status: 'approved' | 'rejected') => void;
  pendingId?: string;
}) {
  if (items.length === 0) return <EmptyTab label="admissions" />;
  return (
    <div className="space-y-3">
      {items.map((f) => {
        const approved = f.review_status === 'approved';
        const rejected = f.review_status === 'rejected';
        return (
          <Card
            key={f.id}
            className={cn(
              'p-4 transition-all',
              approved && 'border-emerald-600/40 ring-1 ring-emerald-600/20',
              rejected && 'border-rose-600/30 opacity-70',
            )}
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <StanceBadge stance={f.stance} />
                  <h3 className="font-serif text-[15px] font-semibold leading-snug text-foreground">
                    {f.title || 'Admission'}
                  </h3>
                  {f.verify_status === 'verified' && (
                    <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
                  )}
                </div>
                {f.issue_tags && f.issue_tags.length > 0 && (
                  <div className="mt-2">
                    <IssueTags tags={f.issue_tags} />
                  </div>
                )}
              </div>
              <div className="flex items-center gap-1 shrink-0">
                <Button
                  size="sm"
                  variant={approved ? 'default' : 'outline'}
                  className="h-7 px-2"
                  onClick={() => onReview(f.id, 'approved')}
                  disabled={pendingId === f.id}
                >
                  <Check className="h-3.5 w-3.5" />
                </Button>
                <Button
                  size="sm"
                  variant={rejected ? 'destructive' : 'outline'}
                  className="h-7 px-2"
                  onClick={() => onReview(f.id, 'rejected')}
                  disabled={pendingId === f.id}
                >
                  <X className="h-3.5 w-3.5" />
                </Button>
              </div>
            </div>
            {f.detail && (
              <p className="mt-3 text-sm text-foreground/90 leading-relaxed">{f.detail}</p>
            )}
            {f.quote && (
              <blockquote className="mt-3 border-l-2 border-primary/40 bg-secondary/40 px-3 py-2 text-[13px] italic text-foreground/85 leading-relaxed">
                “{f.quote}”
              </blockquote>
            )}
            <div className="mt-3">
              <CiteButton span={f} onCite={onCite} label={f.cite} />
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function ChronologyTab({
  items,
  onCite,
}: {
  items: DepositionFinding[];
  onCite: (s: CiteSpan) => void;
}) {
  if (items.length === 0) return <EmptyTab label="chronology" />;
  return (
    <Card className="p-5">
      <ol className="relative border-l border-border ml-3 space-y-5">
        {items.map((f) => {
          const data = (f.data ?? {}) as { date?: string };
          return (
            <li key={f.id} className="pl-5 relative">
              <span className="absolute -left-[5px] top-1.5">
                <StanceDot stance={f.stance} />
              </span>
              <div className="flex items-baseline gap-2 flex-wrap">
                {data.date && (
                  <span className="inline-flex items-center gap-1 text-[11px] font-mono tabular-nums text-muted-foreground">
                    <Calendar className="h-3 w-3" /> {data.date}
                  </span>
                )}
                <h4 className="font-serif text-sm font-semibold text-foreground">
                  {f.title || 'Event'}
                </h4>
              </div>
              {f.detail && (
                <p className="mt-1 text-sm text-foreground/85 leading-relaxed">{f.detail}</p>
              )}
              {f.quote && (
                <div className="mt-1.5 text-xs text-muted-foreground italic">“{f.quote}”</div>
              )}
              <div className="mt-2">
                <CiteButton span={f} onCite={onCite} label={f.cite} />
              </div>
            </li>
          );
        })}
      </ol>
    </Card>
  );
}

function ExhibitsTab({
  items,
  onCite,
}: {
  items: DepositionFinding[];
  onCite: (s: CiteSpan) => void;
}) {
  if (items.length === 0) return <EmptyTab label="exhibits" />;
  return (
    <div className="space-y-3">
      {items.map((f) => {
        const data = (f.data ?? {}) as { description?: string; number?: number };
        const num = data.number ?? f.title?.match(/\d+/)?.[0];
        return (
          <Card key={f.id} className="p-4">
            <div className="flex items-start gap-3">
              <div className="rounded-sm border border-border bg-secondary/60 p-2 shrink-0">
                <FileText className="h-4 w-4 text-primary" />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2 flex-wrap">
                  <h4 className="font-serif text-[15px] font-semibold text-foreground">
                    {f.title || (num ? `Exhibit ${num}` : 'Exhibit')}
                  </h4>
                  <CiteButton span={f} onCite={onCite} label={f.cite} />
                </div>
                {data.description && (
                  <p className="mt-1 text-sm text-foreground/85">{data.description}</p>
                )}
                {f.detail && (
                  <p className="mt-1 text-xs text-muted-foreground leading-relaxed">
                    {f.detail}
                  </p>
                )}
              </div>
            </div>
          </Card>
        );
      })}
    </div>
  );
}

function QualityTab({
  items,
  onCite,
}: {
  items: DepositionFinding[];
  onCite: (s: CiteSpan) => void;
}) {
  if (items.length === 0) return <EmptyTab label="quality notes" />;
  return (
    <div className="space-y-3">
      {items.map((f) => {
        const data = (f.data ?? {}) as { category?: string };
        return (
          <Card key={f.id} className="p-4">
            <div className="flex items-center gap-2 flex-wrap">
              <h4 className="font-serif text-sm font-semibold text-foreground">
                {f.title || 'Note'}
              </h4>
              {data.category && (
                <Badge variant="outline" className="text-[10px] uppercase tracking-wider">
                  {data.category}
                </Badge>
              )}
            </div>
            {f.detail && (
              <p className="mt-1.5 text-sm text-foreground/85 leading-relaxed">{f.detail}</p>
            )}
            {f.quote && (
              <blockquote className="mt-2 border-l-2 border-border bg-secondary/40 px-3 py-2 text-[13px] italic text-muted-foreground">
                “{f.quote}”
              </blockquote>
            )}
            {(f.page_start != null || f.cite) && (
              <div className="mt-2">
                <CiteButton span={f} onCite={onCite} label={f.cite} />
              </div>
            )}
          </Card>
        );
      })}
    </div>
  );
}

function AskTab({
  question,
  setQuestion,
  lastQuestion,
  result,
  onAsk,
  pending,
  onCite,
}: {
  question: string;
  setQuestion: (s: string) => void;
  lastQuestion: string;
  result: DepoAskResponse | null;
  onAsk: (q: string) => void;
  pending: boolean;
  onCite: (s: CiteSpan) => void;
}) {
  const submit = () => {
    const q = question.trim();
    if (!q || pending) return;
    onAsk(q);
  };
  return (
    <div className="space-y-4">
      <Card className="p-4">
        <Textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a question about this deposition…"
          className="min-h-[80px] text-sm resize-none"
          disabled={pending}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <div className="mt-3 flex items-center justify-between">
          <div className="text-[11px] text-muted-foreground">
            Answers cite the transcript. ⌘⏎ to send.
          </div>
          <Button onClick={submit} disabled={pending || !question.trim()}>
            {pending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Reading transcript…
              </>
            ) : (
              <>
                <Send className="mr-2 h-4 w-4" /> Ask
              </>
            )}
          </Button>
        </div>
      </Card>

      {result && (
        <Card className="p-5">
          {lastQuestion && (
            <div className="text-[10.5px] uppercase tracking-[0.14em] font-medium text-muted-foreground mb-1">
              Question
            </div>
          )}
          {lastQuestion && (
            <p className="text-sm text-foreground/90 mb-4">{lastQuestion}</p>
          )}
          <div className="text-[10.5px] uppercase tracking-[0.14em] font-medium text-muted-foreground mb-2">
            Answer
          </div>
          {result.answered ? (
            <p className="font-serif text-[15px] leading-relaxed text-foreground whitespace-pre-wrap">
              {result.answer}
            </p>
          ) : (
            <p className="text-sm italic text-muted-foreground">
              {result.answer || 'Not addressed in the record.'}
            </p>
          )}
          {result.citations && result.citations.length > 0 && (
            <div className="mt-5 space-y-2">
              <div className="text-[10.5px] uppercase tracking-[0.14em] font-medium text-muted-foreground">
                Citations
              </div>
              {result.citations.map((c, i) => (
                <div
                  key={i}
                  className="rounded-sm border border-border bg-secondary/30 px-3 py-2.5"
                >
                  {c.note && (
                    <div className="text-xs text-foreground/85 mb-1">{c.note}</div>
                  )}
                  {c.quote && (
                    <blockquote className="border-l-2 border-primary/40 pl-2 text-[12.5px] italic text-foreground/80 leading-relaxed">
                      “{c.quote}”
                    </blockquote>
                  )}
                  <div className="mt-2 flex items-center gap-2">
                    <CiteButton span={c} onCite={onCite} label={c.cite} />
                    {c.verified && (
                      <span className="inline-flex items-center gap-1 text-[10.5px] text-emerald-700">
                        <BadgeCheck className="h-3 w-3" /> verified
                      </span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
