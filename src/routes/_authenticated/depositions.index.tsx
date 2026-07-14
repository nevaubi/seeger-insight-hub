import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState, type DragEvent } from 'react';
import {
  Upload,
  Loader2,
  Mic,
  FileText,
  ChevronRight,
  Search as SearchIcon,
  X,
  ArrowUpDown,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
} from 'lucide-react';
import { toast } from 'sonner';
import { AppShell, PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import {
  supabase,
  type Deposition,
  type DepositionFinding,
} from '@/lib/supabase';
import { useMatter } from '@/lib/matter-context';
import { ingestDeposition } from '@/lib/depo-api';
import { fmtDate } from '@/components/case-ui';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/_authenticated/depositions/')({
  component: DepositionsPage,
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

const ROLES: { value: string; label: string; alignment: string | null }[] = [
  { value: 'plaintiff', label: 'Plaintiff', alignment: 'plaintiff' },
  { value: 'defendant', label: 'Defendant', alignment: 'defendant' },
  { value: 'fact witness', label: 'Fact witness', alignment: null },
  { value: 'expert', label: 'Expert', alignment: null },
  { value: 'corporate representative', label: 'Corporate representative', alignment: null },
];

type SortKey = 'added' | 'deposed' | 'findings' | 'pages';
type AlignFilter = 'any' | 'plaintiff' | 'defendant' | 'other';
type StatusFilter = 'any' | 'analyzed' | 'analyzing' | 'ingested' | 'error';

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

function StatusBadge({ status }: { status: Deposition['status'] }) {
  if (status === 'analyzed') {
    return (
      <Badge className="bg-emerald-600/10 text-emerald-700 border border-emerald-600/20 hover:bg-emerald-600/10">
        Analyzed
      </Badge>
    );
  }
  if (status === 'analyzing') {
    return (
      <Badge className="bg-amber-500/10 text-amber-700 border border-amber-500/25 hover:bg-amber-500/10">
        <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Analyzing
      </Badge>
    );
  }
  if (status === 'error') {
    return <Badge variant="destructive">Error</Badge>;
  }
  return (
    <Badge variant="outline" className="text-muted-foreground">
      Not analyzed
    </Badge>
  );
}

function Metric({ label, value, tone }: { label: string; value: number | string; tone?: 'default' | 'good' | 'bad' | 'muted' }) {
  const t =
    tone === 'good'
      ? 'text-emerald-700'
      : tone === 'bad'
        ? 'text-rose-700'
        : tone === 'muted'
          ? 'text-muted-foreground'
          : 'text-foreground';
  return (
    <div>
      <div className={cn('font-serif text-[22px] leading-none font-semibold tabular-nums', t)}>
        {value}
      </div>
      <div className="mt-1 text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </div>
    </div>
  );
}

function DepositionsPage() {
  const { currentMatter } = useMatter();
  const caseId = currentMatter.master_case_id;
  const navigate = useNavigate();
  const qc = useQueryClient();

  const {
    data: depos = [],
    isLoading,
    error,
  } = useQuery({
    queryKey: ['depositions', caseId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('depositions')
        .select('*')
        .eq('case_id', caseId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as Deposition[];
    },
  });

  const depoIds = useMemo(() => depos.map((d) => d.id), [depos]);
  const { data: allFindings = [] } = useQuery({
    queryKey: ['depositions-findings-summary', caseId, depoIds.join(',')],
    enabled: depoIds.length > 0,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('deposition_findings')
        .select('id,deposition_id,finding_type,stance,confidence,issue_tags')
        .in('deposition_id', depoIds);
      if (error) throw error;
      return (data ?? []) as Pick<
        DepositionFinding,
        'id' | 'deposition_id' | 'finding_type' | 'stance' | 'confidence' | 'issue_tags'
      >[];
    },
  });

  // Findings index by deposition_id
  const findingsByDepo = useMemo(() => {
    const m = new Map<string, typeof allFindings>();
    for (const f of allFindings) {
      const list = m.get(f.deposition_id) ?? [];
      list.push(f);
      m.set(f.deposition_id, list);
    }
    return m;
  }, [allFindings]);

  // Aggregate metrics
  const metrics = useMemo(() => {
    const totalPages = depos.reduce((n, d) => n + (d.page_count ?? 0), 0);
    const analyzed = depos.filter((d) => d.status === 'analyzed').length;
    let helpful = 0;
    let harmful = 0;
    let exhibits = 0;
    for (const f of allFindings) {
      if (f.finding_type === 'admission') {
        if (f.stance === 'helpful') helpful++;
        else if (f.stance === 'harmful') harmful++;
      } else if (f.finding_type === 'exhibit') exhibits++;
    }
    return { total: depos.length, totalPages, analyzed, helpful, harmful, exhibits };
  }, [depos, allFindings]);

  // ---- Filters + sort ----
  const [query, setQuery] = useState('');
  const [align, setAlign] = useState<AlignFilter>('any');
  const [status, setStatus] = useState<StatusFilter>('any');
  const [roleFilter, setRoleFilter] = useState<string>('any');
  const [sort, setSort] = useState<SortKey>('added');

  const filteredSorted = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = depos.filter((d) => {
      if (q) {
        const hay = `${d.witness_name ?? ''} ${d.filename ?? ''} ${d.witness_role ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      if (align !== 'any') {
        const a = (d.party_alignment || '').toLowerCase();
        if (align === 'other' ? (a === 'plaintiff' || a === 'defendant') : a !== align) return false;
      }
      if (status !== 'any' && d.status !== status) return false;
      if (roleFilter !== 'any' && (d.witness_role || '').toLowerCase() !== roleFilter) return false;
      return true;
    });
    const countFindings = (id: string) => (findingsByDepo.get(id)?.length ?? 0);
    list.sort((a, b) => {
      if (sort === 'deposed') {
        return (b.deposition_date || '').localeCompare(a.deposition_date || '');
      }
      if (sort === 'findings') return countFindings(b.id) - countFindings(a.id);
      if (sort === 'pages') return (b.page_count ?? 0) - (a.page_count ?? 0);
      return (b.created_at || '').localeCompare(a.created_at || '');
    });
    return list;
  }, [depos, query, align, status, roleFilter, sort, findingsByDepo]);

  const activeFilters =
    (query ? 1 : 0) + (align !== 'any' ? 1 : 0) + (status !== 'any' ? 1 : 0) + (roleFilter !== 'any' ? 1 : 0);
  const clearFilters = () => {
    setQuery('');
    setAlign('any');
    setStatus('any');
    setRoleFilter('any');
  };

  // ---- Upload ----
  const [file, setFile] = useState<File | null>(null);
  const [witnessName, setWitnessName] = useState('');
  const [witnessRole, setWitnessRole] = useState<string>('');
  const [autoAnalyze, setAutoAnalyze] = useState(true);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<'idle' | 'parsing'>('idle');
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setFile(null);
    setWitnessName('');
    setWitnessRole('');
    setAutoAnalyze(true);
    setStage('idle');
    if (inputRef.current) inputRef.current.value = '';
  };

  const acceptFile = (f: File | null) => {
    if (!f) return;
    if (f.type && f.type !== 'application/pdf' && !f.name.toLowerCase().endsWith('.pdf')) {
      toast.error('PDF only');
      return;
    }
    setFile(f);
  };

  const onDrop = (e: DragEvent<HTMLLabelElement>) => {
    e.preventDefault();
    setDragOver(false);
    if (busy) return;
    acceptFile(e.dataTransfer.files?.[0] ?? null);
  };

  const onSubmit = async () => {
    if (!file) return;
    setBusy(true);
    setStage('parsing');
    try {
      const roleMeta = ROLES.find((r) => r.value === witnessRole);
      const alignment = roleMeta?.alignment ?? null;
      const ingest = await ingestDeposition({
        caseId,
        file,
        witnessName: witnessName.trim() || undefined,
        witnessRole: witnessRole || undefined,
        partyAlignment: alignment,
      });
      if (!ingest.ok || !ingest.deposition_id) {
        throw new Error(ingest.error || 'Ingest failed');
      }
      const depositionId = ingest.deposition_id;
      toast.success(
        autoAnalyze
          ? 'Transcript ready — analyzing in the background'
          : 'Transcript ready',
      );
      await qc.invalidateQueries({ queryKey: ['depositions', caseId] });
      reset();
      navigate({
        to: '/depositions/$id',
        params: { id: depositionId },
        search: { analyze: autoAnalyze },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
    } finally {
      setBusy(false);
      setStage('idle');
    }
  };

  const roleOptions = useMemo(() => {
    const s = new Set<string>();
    for (const d of depos) if (d.witness_role) s.add(d.witness_role.toLowerCase());
    return Array.from(s).sort();
  }, [depos]);

  return (
    <AppShell>
      <PageHeader
        title="Depositions"
        description={`${currentMatter.short_name} — ${currentMatter.name}`}
      />

      <div className="px-8 py-8 space-y-8 max-w-6xl">
        {/* Docket-at-a-glance ledger */}
        <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-x-8 gap-y-4 border-y border-border py-5">
          <Metric label="Transcripts" value={metrics.total} />
          <Metric label="Pages" value={metrics.totalPages.toLocaleString()} />
          <Metric label="Analyzed" value={`${metrics.analyzed}/${metrics.total}`} tone="muted" />
          <Metric label="Helpful adm." value={metrics.helpful} tone="good" />
          <Metric label="Harmful adm." value={metrics.harmful} tone="bad" />
          <Metric label="Exhibits" value={metrics.exhibits} tone="muted" />
        </div>

        {/* Upload panel */}
        <Card className="p-6 shadow-sm">
          <div className="flex items-start gap-3 mb-5">
            <div className="mt-0.5 rounded-sm border border-border bg-secondary p-2">
              <Mic className="h-4 w-4 text-primary" strokeWidth={1.75} />
            </div>
            <div>
              <h2 className="font-serif text-lg leading-tight font-semibold tracking-tight">
                Upload transcript
              </h2>
              <p className="mt-1 font-sans text-[13px] text-muted-foreground">
                PDF deposition transcripts are parsed line-by-line and analyzed for admissions,
                exhibits, and impeachment material.
              </p>
            </div>
          </div>

          <label
            htmlFor="depo-file"
            onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={cn(
              'flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-6 py-8 text-center cursor-pointer transition-colors',
              file
                ? 'border-primary/40 bg-primary/5'
                : dragOver
                  ? 'border-primary bg-primary/10'
                  : 'border-border hover:border-primary/40 hover:bg-secondary/50',
            )}
          >
            <Upload className="h-5 w-5 text-muted-foreground" strokeWidth={1.75} />
            {file ? (
              <>
                <div className="font-sans text-sm font-medium">{file.name}</div>
                <div className="text-xs text-muted-foreground">
                  {(file.size / 1024 / 1024).toFixed(2)} MB · Click or drop to replace
                </div>
              </>
            ) : (
              <>
                <div className="font-sans text-sm font-medium">
                  {dragOver ? 'Drop to upload' : 'Drop or select a PDF'}
                </div>
                <div className="text-xs text-muted-foreground">
                  Transcripts up to a few hundred pages
                </div>
              </>
            )}
            <input
              id="depo-file"
              ref={inputRef}
              type="file"
              accept="application/pdf"
              className="hidden"
              onChange={(e) => acceptFile(e.target.files?.[0] ?? null)}
              disabled={busy}
            />
          </label>

          {file && (
            <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-1.5">
                <Label htmlFor="witness-name" className="text-xs">
                  Witness name (optional)
                </Label>
                <Input
                  id="witness-name"
                  value={witnessName}
                  onChange={(e) => setWitnessName(e.target.value)}
                  placeholder="e.g. Deborah Prescott"
                  disabled={busy}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Witness role (optional)</Label>
                <Select value={witnessRole} onValueChange={setWitnessRole} disabled={busy}>
                  <SelectTrigger>
                    <SelectValue placeholder="Select role" />
                  </SelectTrigger>
                  <SelectContent>
                    {ROLES.map((r) => (
                      <SelectItem key={r.value} value={r.value}>
                        {r.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="flex items-center justify-between md:col-span-2 rounded-sm border border-border bg-secondary/40 px-3 py-2">
                <div>
                  <div className="text-sm font-medium">Analyze after upload</div>
                  <div className="text-xs text-muted-foreground">
                    Runs LLM analysis to surface findings. Takes 1–2 minutes.
                  </div>
                </div>
                <Switch
                  checked={autoAnalyze}
                  onCheckedChange={setAutoAnalyze}
                  disabled={busy}
                />
              </div>
            </div>
          )}

          <div className="mt-5 flex items-center justify-between">
            <div className="text-xs text-muted-foreground font-sans min-h-[1.25rem]">
              {stage === 'parsing' && (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Parsing transcript…
                </span>
              )}
            </div>
            <Button onClick={onSubmit} disabled={!file || busy}>
              {busy ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Working…
                </>
              ) : (
                <>Upload &amp; analyze</>
              )}
            </Button>
          </div>
        </Card>

        {/* List */}
        <section>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h2 className="font-serif text-lg font-semibold tracking-tight">
              Recent depositions
            </h2>
            <div className="text-xs text-muted-foreground tabular-nums">
              {filteredSorted.length === depos.length
                ? `${depos.length} total`
                : `${filteredSorted.length} of ${depos.length}`}
            </div>
          </div>

          {/* Filter bar */}
          {depos.length > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-2">
              <div className="relative flex-1 min-w-[220px] max-w-md">
                <SearchIcon className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search witness, file, role…"
                  className="pl-8 h-8 text-sm"
                />
              </div>
              <Select value={align} onValueChange={(v) => setAlign(v as AlignFilter)}>
                <SelectTrigger className="h-8 w-[140px] text-xs">
                  <SelectValue placeholder="Alignment" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any alignment</SelectItem>
                  <SelectItem value="plaintiff">Plaintiff</SelectItem>
                  <SelectItem value="defendant">Defendant</SelectItem>
                  <SelectItem value="other">Other / Neutral</SelectItem>
                </SelectContent>
              </Select>
              {roleOptions.length > 0 && (
                <Select value={roleFilter} onValueChange={setRoleFilter}>
                  <SelectTrigger className="h-8 w-[150px] text-xs">
                    <SelectValue placeholder="Role" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="any">Any role</SelectItem>
                    {roleOptions.map((r) => (
                      <SelectItem key={r} value={r} className="capitalize">
                        {r}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <Select value={status} onValueChange={(v) => setStatus(v as StatusFilter)}>
                <SelectTrigger className="h-8 w-[130px] text-xs">
                  <SelectValue placeholder="Status" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="any">Any status</SelectItem>
                  <SelectItem value="analyzed">Analyzed</SelectItem>
                  <SelectItem value="analyzing">Analyzing</SelectItem>
                  <SelectItem value="ingested">Not analyzed</SelectItem>
                  <SelectItem value="error">Error</SelectItem>
                </SelectContent>
              </Select>
              <Select value={sort} onValueChange={(v) => setSort(v as SortKey)}>
                <SelectTrigger className="h-8 w-[140px] text-xs">
                  <ArrowUpDown className="mr-1 h-3 w-3" />
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="added">Sort: Newest added</SelectItem>
                  <SelectItem value="deposed">Sort: Date deposed</SelectItem>
                  <SelectItem value="findings"># Findings</SelectItem>
                  <SelectItem value="pages">Page count</SelectItem>
                </SelectContent>
              </Select>
              {activeFilters > 0 && (
                <Button variant="ghost" size="sm" className="h-8 px-2 text-xs" onClick={clearFilters}>
                  <X className="mr-1 h-3 w-3" /> Clear
                </Button>
              )}
            </div>
          )}

          {isLoading ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">
              <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />
              Loading depositions…
            </Card>
          ) : error ? (
            <Card className="p-6 text-sm text-destructive">
              Failed to load: {(error as Error).message}
            </Card>
          ) : depos.length === 0 ? (
            <Card className="p-10 text-center">
              <FileText className="mx-auto h-6 w-6 text-muted-foreground/70" strokeWidth={1.5} />
              <div className="mt-2 font-serif text-base font-semibold">No depositions yet</div>
              <div className="mt-1 text-sm text-muted-foreground">
                Upload a PDF transcript above to get started.
              </div>
            </Card>
          ) : filteredSorted.length === 0 ? (
            <Card className="p-8 text-center text-sm text-muted-foreground">
              No transcripts match those filters.
            </Card>
          ) : (
            <div className="space-y-2">
              {filteredSorted.map((d) => {
                const findings = findingsByDepo.get(d.id) ?? [];
                const admissions = findings.filter((f) => f.finding_type === 'admission');
                const helpful = admissions.filter((f) => f.stance === 'helpful').length;
                const harmful = admissions.filter((f) => f.stance === 'harmful').length;
                const exhibits = findings.filter((f) => f.finding_type === 'exhibit').length;
                const quality = findings.filter((f) => f.finding_type === 'quality_note').length;
                const topTags = Array.from(
                  new Set(findings.flatMap((f) => f.issue_tags || [])),
                ).slice(0, 3);
                const title = d.witness_name || d.filename || 'Untitled deposition';
                return (
                  <button
                    key={d.id}
                    onClick={() =>
                      navigate({ to: '/depositions/$id', params: { id: d.id } })
                    }
                    className="group w-full text-left"
                  >
                    <Card className="p-4 transition-colors hover:border-primary/40 hover:bg-secondary/30">
                      <div className="flex items-start gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 flex-wrap">
                            <span className="font-serif text-[15px] font-semibold text-foreground truncate">
                              {title}
                            </span>
                            <AlignmentBadge
                              alignment={d.party_alignment}
                              role={d.witness_role}
                            />
                            <StatusBadge status={d.status} />
                          </div>
                          <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground font-sans tabular-nums flex-wrap">
                            {d.deposition_date && (
                              <span>Depo {fmtDate(d.deposition_date)}</span>
                            )}
                            {d.page_count != null && <span>{d.page_count} pp</span>}
                            <span>Added {fmtDate(d.created_at)}</span>
                            {d.filename && d.witness_name && (
                              <span className="truncate max-w-[240px]">{d.filename}</span>
                            )}
                          </div>
                          {(admissions.length > 0 || exhibits > 0 || topTags.length > 0) && (
                            <div className="mt-2.5 flex items-center gap-3 flex-wrap text-[11px]">
                              {helpful > 0 && (
                                <span className="inline-flex items-center gap-1 text-emerald-700">
                                  <CheckCircle2 className="h-3 w-3" /> {helpful} helpful
                                </span>
                              )}
                              {harmful > 0 && (
                                <span className="inline-flex items-center gap-1 text-rose-700">
                                  <AlertTriangle className="h-3 w-3" /> {harmful} harmful
                                </span>
                              )}
                              {admissions.length > 0 && (
                                <span className="text-muted-foreground tabular-nums">
                                  {admissions.length} adm.
                                </span>
                              )}
                              {exhibits > 0 && (
                                <span className="text-muted-foreground tabular-nums">
                                  {exhibits} ex.
                                </span>
                              )}
                              {quality > 0 && (
                                <span className="text-muted-foreground tabular-nums">
                                  {quality} quality
                                </span>
                              )}
                              {topTags.map((t) => (
                                <span
                                  key={t}
                                  className="inline-flex items-center rounded-sm border border-border bg-secondary/50 px-1.5 py-[1px] text-[10px] font-medium text-muted-foreground"
                                >
                                  {t}
                                </span>
                              ))}
                            </div>
                          )}
                          {d.status === 'ingested' && admissions.length === 0 && (
                            <div className="mt-2 inline-flex items-center gap-1 text-[11px] text-muted-foreground">
                              <Sparkles className="h-3 w-3" /> Awaiting analysis
                            </div>
                          )}
                        </div>
                        <ChevronRight
                          className="h-4 w-4 text-muted-foreground/60 group-hover:text-foreground shrink-0 mt-1"
                          strokeWidth={1.75}
                        />
                      </div>
                    </Card>
                  </button>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </AppShell>
  );
}
