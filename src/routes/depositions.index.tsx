import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Upload, Loader2, Mic, FileText, ChevronRight } from 'lucide-react';
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
import { supabase, type Deposition } from '@/lib/supabase';
import { useMatter } from '@/lib/matter-context';
import { ingestDeposition, analyzeDeposition } from '@/lib/depo-api';
import { fmtDate } from '@/components/case-ui';
import { cn } from '@/lib/utils';

export const Route = createFileRoute('/depositions/')({
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

  const [file, setFile] = useState<File | null>(null);
  const [witnessName, setWitnessName] = useState('');
  const [witnessRole, setWitnessRole] = useState<string>('');
  const [autoAnalyze, setAutoAnalyze] = useState(true);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<'idle' | 'parsing'>('idle');
  const inputRef = useRef<HTMLInputElement>(null);

  const reset = () => {
    setFile(null);
    setWitnessName('');
    setWitnessRole('');
    setAutoAnalyze(true);
    setStage('idle');
    if (inputRef.current) inputRef.current.value = '';
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

  return (
    <AppShell>
      <PageHeader
        title="Depositions"
        description={`${currentMatter.short_name} — ${currentMatter.name}`}
      />

      <div className="px-8 py-8 space-y-8 max-w-5xl">
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
            className={cn(
              'flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-6 py-8 text-center cursor-pointer transition-colors',
              file
                ? 'border-primary/40 bg-primary/5'
                : 'border-border hover:border-primary/40 hover:bg-secondary/50',
            )}
          >
            <Upload className="h-5 w-5 text-muted-foreground" strokeWidth={1.75} />
            {file ? (
              <>
                <div className="font-sans text-sm font-medium">{file.name}</div>
                <div className="text-xs text-muted-foreground">
                  {(file.size / 1024 / 1024).toFixed(2)} MB · Click to replace
                </div>
              </>
            ) : (
              <>
                <div className="font-sans text-sm font-medium">Drop or select a PDF</div>
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
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
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
              {stage === 'analyzing' && (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Analyzing testimony…
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
          <div className="mb-3 flex items-baseline justify-between">
            <h2 className="font-serif text-lg font-semibold tracking-tight">
              Recent depositions
            </h2>
            <div className="text-xs text-muted-foreground tabular-nums">
              {depos.length} total
            </div>
          </div>

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
          ) : (
            <div className="space-y-2">
              {depos.map((d) => {
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
                      <div className="flex items-center gap-4">
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
                          <div className="mt-1 flex items-center gap-3 text-xs text-muted-foreground font-sans tabular-nums">
                            {d.deposition_date && (
                              <span>Depo {fmtDate(d.deposition_date)}</span>
                            )}
                            {d.page_count != null && <span>{d.page_count} pp</span>}
                            <span>Added {fmtDate(d.created_at)}</span>
                            {d.filename && d.witness_name && (
                              <span className="truncate max-w-[240px]">{d.filename}</span>
                            )}
                          </div>
                        </div>
                        <ChevronRight
                          className="h-4 w-4 text-muted-foreground/60 group-hover:text-foreground shrink-0"
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
