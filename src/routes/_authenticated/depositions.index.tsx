import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo, useRef, useState, type DragEvent } from 'react';
import {
  Upload,
  Loader2,
  FileText,
  Search as SearchIcon,
  X,
  CheckCircle2,
  AlertTriangle,
  Sparkles,
  Plus,
} from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Switch } from '@/components/ui/switch';
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetDescription,
} from '@/components/ui/sheet';
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
        'inline-flex items-center rounded-sm border px-1.5 py-0.5 text-[10px] font-medium tracking-wide uppercase',
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
      <Badge className="bg-emerald-600/10 text-emerald-700 border border-emerald-600/20 hover:bg-emerald-600/10 rounded-sm px-1.5 py-0 text-[10px]">
        Analyzed
      </Badge>
    );
  }
  if (status === 'analyzing') {
    return (
      <Badge className="bg-amber-500/10 text-amber-700 border border-amber-500/25 hover:bg-amber-500/10 rounded-sm px-1.5 py-0 text-[10px]">
        <Loader2 className="mr-1 h-3 w-3 animate-spin" /> Analyzing
      </Badge>
    );
  }
  if (status === 'error') {
    return <Badge variant="destructive" className="rounded-sm px-1.5 py-0 text-[10px]">Error</Badge>;
  }
  return (
    <Badge variant="outline" className="text-muted-foreground rounded-sm px-1.5 py-0 text-[10px]">
      Not analyzed
    </Badge>
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

  const findingsByDepo = useMemo(() => {
    const m = new Map<string, typeof allFindings>();
    for (const f of allFindings) {
      const list = m.get(f.deposition_id) ?? [];
      list.push(f);
      m.set(f.deposition_id, list);
    }
    return m;
  }, [allFindings]);

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
  const [uploadOpen, setUploadOpen] = useState(false);
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
        autoAnalyze ? 'Transcript ready — analyzing in the background' : 'Transcript ready',
      );
      await qc.invalidateQueries({ queryKey: ['depositions', caseId] });
      reset();
      setUploadOpen(false);
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
      {/* Slim editorial header */}
      <div className="border-b border-border bg-card px-8 py-4">
        <div className="flex items-center justify-between gap-4">
          <div className="min-w-0 flex items-baseline gap-3">
            <h1 className="font-serif text-[22px] font-semibold tracking-[-0.01em] text-foreground">
              Depositions
            </h1>
            <span className="hidden sm:inline text-[11px] font-mono uppercase tracking-[0.14em] text-muted-foreground truncate">
              {currentMatter.short_name}
            </span>
          </div>
          <Button size="sm" onClick={() => setUploadOpen(true)} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" /> Upload transcript
          </Button>
        </div>
        {/* Single-line summary strip */}
        {depos.length > 0 && (
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11.5px] text-muted-foreground tabular-nums">
            <span><span className="font-medium text-foreground">{metrics.total}</span> transcripts</span>
            <span className="text-border">·</span>
            <span><span className="font-medium text-foreground">{metrics.totalPages.toLocaleString()}</span> pp</span>
            <span className="text-border">·</span>
            <span><span className="font-medium text-foreground">{metrics.analyzed}</span> analyzed</span>
            <span className="text-border">·</span>
            <span>
              <span className="text-emerald-700 font-medium">{metrics.helpful} helpful</span>
              {' / '}
              <span className="text-rose-700 font-medium">{metrics.harmful} harmful</span>
            </span>
            <span className="text-border">·</span>
            <span><span className="font-medium text-foreground">{metrics.exhibits}</span> exhibits</span>
          </div>
        )}
      </div>

      <div className="px-8 py-5 max-w-6xl">
        {/* Section header + compact filter bar */}
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-baseline gap-2">
            <h2 className="font-serif text-[15px] font-semibold tracking-tight">
              Recent depositions
            </h2>
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {filteredSorted.length === depos.length
                ? `${depos.length}`
                : `${filteredSorted.length} of ${depos.length}`}
            </span>
          </div>
          {depos.length > 0 && (
            <div className="flex items-center gap-1.5">
              <div className="relative">
                <SearchIcon className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search…"
                  className="pl-7 pr-7 h-8 w-[180px] text-xs"
                />
                {(query || activeFilters > 0) && (
                  <button
                    type="button"
                    onClick={clearFilters}
                    aria-label="Clear filters"
                    className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
              </div>
              <Select value={align} onValueChange={(v) => setAlign(v as AlignFilter)}>
                <SelectTrigger className="h-8 w-[118px] text-[11px]">
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
                  <SelectTrigger className="h-8 w-[110px] text-[11px]">
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
                <SelectTrigger className="h-8 w-[110px] text-[11px]">
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
                <SelectTrigger className="h-8 w-[130px] text-[11px]">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="added">Newest added</SelectItem>
                  <SelectItem value="deposed">Date deposed</SelectItem>
                  <SelectItem value="findings"># Findings</SelectItem>
                  <SelectItem value="pages">Page count</SelectItem>
                </SelectContent>
              </Select>
            </div>
          )}
        </div>

        {isLoading ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            <Loader2 className="mx-auto mb-2 h-4 w-4 animate-spin" />
            Loading depositions…
          </div>
        ) : error ? (
          <div className="py-6 text-sm text-destructive">
            Failed to load: {(error as Error).message}
          </div>
        ) : depos.length === 0 ? (
          <div className="py-16 text-center">
            <FileText className="mx-auto h-6 w-6 text-muted-foreground/70" strokeWidth={1.5} />
            <div className="mt-2 font-serif text-[15px] font-semibold">No depositions yet</div>
            <div className="mt-1 text-xs text-muted-foreground">
              Upload a PDF transcript to get started.
            </div>
            <Button size="sm" className="mt-4 gap-1.5" onClick={() => setUploadOpen(true)}>
              <Plus className="h-3.5 w-3.5" /> Upload transcript
            </Button>
          </div>
        ) : filteredSorted.length === 0 ? (
          <div className="py-8 text-center text-sm text-muted-foreground">
            No transcripts match those filters.
          </div>
        ) : (
          <div className="rounded-sm border border-border bg-card divide-y divide-border">
            {filteredSorted.map((d) => {
              const findings = findingsByDepo.get(d.id) ?? [];
              const admissions = findings.filter((f) => f.finding_type === 'admission');
              const helpful = admissions.filter((f) => f.stance === 'helpful').length;
              const harmful = admissions.filter((f) => f.stance === 'harmful').length;
              const exhibits = findings.filter((f) => f.finding_type === 'exhibit').length;
              const title = d.witness_name || d.filename || 'Untitled deposition';
              return (
                <button
                  key={d.id}
                  onClick={() => navigate({ to: '/depositions/$id', params: { id: d.id } })}
                  title={d.filename ?? undefined}
                  className="group w-full text-left px-4 py-2.5 grid grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-4 hover:bg-secondary/40 transition-colors"
                >
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 min-w-0">
                      <span className="font-serif text-[14px] font-semibold text-foreground truncate">
                        {title}
                      </span>
                      <AlignmentBadge alignment={d.party_alignment} role={d.witness_role} />
                    </div>
                    <div className="mt-0.5 flex items-center gap-2.5 text-[11px] text-muted-foreground font-sans tabular-nums truncate">
                      {d.deposition_date && <span>Depo {fmtDate(d.deposition_date)}</span>}
                      {d.page_count != null && <span>· {d.page_count} pp</span>}
                      <span>· Added {fmtDate(d.created_at)}</span>
                      {d.status === 'ingested' && admissions.length === 0 && (
                        <span className="inline-flex items-center gap-1 text-muted-foreground/80">
                          · <Sparkles className="h-3 w-3" /> awaiting analysis
                        </span>
                      )}
                    </div>
                  </div>
                  <div className="hidden sm:flex items-center gap-3 text-[11px] tabular-nums shrink-0">
                    {helpful > 0 && (
                      <span className="inline-flex items-center gap-1 text-emerald-700">
                        <CheckCircle2 className="h-3 w-3" /> {helpful}
                      </span>
                    )}
                    {harmful > 0 && (
                      <span className="inline-flex items-center gap-1 text-rose-700">
                        <AlertTriangle className="h-3 w-3" /> {harmful}
                      </span>
                    )}
                    {admissions.length > 0 && (
                      <span className="text-muted-foreground">{admissions.length} adm.</span>
                    )}
                    {exhibits > 0 && (
                      <span className="text-muted-foreground">{exhibits} ex.</span>
                    )}
                  </div>
                  <div className="shrink-0">
                    <StatusBadge status={d.status} />
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Upload drawer */}
      <Sheet open={uploadOpen} onOpenChange={(o) => { setUploadOpen(o); if (!o) reset(); }}>
        <SheetContent side="right" className="w-full sm:max-w-md overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="font-serif text-lg">Upload transcript</SheetTitle>
            <SheetDescription>
              PDF deposition transcripts are parsed line-by-line and analyzed for admissions,
              exhibits, and impeachment material.
            </SheetDescription>
          </SheetHeader>

          <div className="mt-5 space-y-4">
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
              <div className="space-y-3">
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
                <div className="flex items-center justify-between rounded-sm border border-border bg-secondary/40 px-3 py-2">
                  <div>
                    <div className="text-sm font-medium">Analyze after upload</div>
                    <div className="text-xs text-muted-foreground">
                      Runs LLM analysis. Takes 1–2 minutes.
                    </div>
                  </div>
                  <Switch checked={autoAnalyze} onCheckedChange={setAutoAnalyze} disabled={busy} />
                </div>
              </div>
            )}

            <div className="flex items-center justify-between pt-2 border-t border-border">
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
          </div>
        </SheetContent>
      </Sheet>
    </AppShell>
  );
}
