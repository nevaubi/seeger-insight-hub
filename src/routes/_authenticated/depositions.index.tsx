import { createFileRoute, useNavigate, Link } from '@tanstack/react-router';
import { useMemo, useRef, useState, type DragEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Upload, Loader2, Search as SearchIcon, FileText } from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useMatter } from '@/lib/matter-context';
import { ingestDeposition } from '@/lib/depo-api';
import { supabase, type Deposition } from '@/lib/supabase';
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

function UploadingSkeleton() {
  return (
    <div className="mt-6 rounded-sm border border-border bg-card p-5 animate-in fade-in duration-300">
      <div className="flex items-center gap-3">
        <Skeleton className="h-8 w-8 rounded-sm" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-3.5 w-1/3" />
          <Skeleton className="h-2.5 w-1/2" />
        </div>
      </div>
      <div className="mt-5 grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="space-y-2">
          <Skeleton className="h-3 w-24" />
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-3 w-full" style={{ opacity: 1 - i * 0.15 }} />
          ))}
        </div>
        <div className="space-y-2">
          <Skeleton className="h-3 w-20" />
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-3 w-full" style={{ opacity: 1 - i * 0.15 }} />
          ))}
        </div>
      </div>
    </div>
  );
}

function DepositionsPage() {
  const { currentMatter } = useMatter();
  const caseId = currentMatter.master_case_id;
  const navigate = useNavigate();

  const [file, setFile] = useState<File | null>(null);
  const [witnessName, setWitnessName] = useState('');
  const [witnessRole, setWitnessRole] = useState<string>('');
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState<'idle' | 'parsing'>('idle');
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

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
      navigate({
        to: '/depositions/$id',
        params: { id: ingest.deposition_id },
        search: { analyze: true },
      });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Upload failed');
      setBusy(false);
      setStage('idle');
    }
  };

  return (
    <AppShell>
      <div className="border-b border-border bg-card px-8 py-4">
        <div className="flex items-baseline gap-3">
          <h1 className="font-serif text-[22px] font-semibold tracking-[-0.01em] text-foreground">
            Depositions
          </h1>
          <span className="hidden sm:inline text-[11px] font-mono uppercase tracking-[0.14em] text-muted-foreground truncate">
            {currentMatter.short_name}
          </span>
        </div>
      </div>

      <div className="px-8 py-8 max-w-4xl mx-auto">
        <div className="mb-4">
          <h2 className="font-serif text-[17px] font-semibold tracking-tight">
            Upload a transcript
          </h2>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            PDF transcripts are parsed line-by-line and analyzed for admissions, exhibits, and
            impeachment material. Analysis begins automatically.
          </p>
        </div>

        <div className="rounded-sm border border-border bg-card p-5 space-y-4">
          <label
            htmlFor="depo-file"
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={onDrop}
            className={cn(
              'flex flex-col items-center justify-center gap-2 rounded-md border-2 border-dashed px-6 py-10 text-center cursor-pointer transition-colors',
              file
                ? 'border-primary/40 bg-primary/5'
                : dragOver
                  ? 'border-primary bg-primary/10'
                  : 'border-border hover:border-primary/40 hover:bg-secondary/50',
              busy && 'pointer-events-none opacity-70',
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
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
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
            </div>
          )}

          <div className="flex items-center justify-between pt-3 border-t border-border">
            <div className="text-xs text-muted-foreground font-sans min-h-[1.25rem]">
              {stage === 'parsing' && (
                <span className="inline-flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Preparing transcript…
                </span>
              )}
            </div>
            <Button onClick={onSubmit} disabled={!file || busy}>
              {busy ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Uploading…
                </>
              ) : (
                <>Upload &amp; analyze</>
              )}
            </Button>
          </div>
        </div>

        {busy && <UploadingSkeleton />}

        <TranscriptLibrary caseId={caseId} />

      </div>
    </AppShell>
  );
}

const STATUS_TONE: Record<string, string> = {
  analyzed: 'text-[hsl(150_45%_28%)]',
  analyzing: 'text-primary',
  ingested: 'text-muted-foreground',
  error: 'text-destructive',
};

function TranscriptLibrary({ caseId }: { caseId: string }) {
  const [q, setQ] = useState('');
  const [alignment, setAlignment] = useState<'all' | 'plaintiff' | 'defendant' | 'other'>('all');

  const depoQ = useQuery({
    queryKey: ['depositions-library', caseId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('depositions')
        .select('*')
        .eq('case_id', caseId)
        .order('created_at', { ascending: false })
        .limit(200);
      if (error) throw error;
      return (data ?? []) as Deposition[];
    },
    refetchInterval: (query) =>
      ((query.state.data as Deposition[] | undefined) ?? []).some((d) => d.status === 'analyzing')
        ? 4000
        : false,
  });

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    return (depoQ.data ?? []).filter((d) => {
      if (alignment !== 'all') {
        const a = (d.party_alignment || '').toLowerCase();
        if (alignment === 'other' ? a === 'plaintiff' || a === 'defendant' : a !== alignment)
          return false;
      }
      if (!term) return true;
      return [d.witness_name, d.witness_role, d.filename, d.individual_case_no]
        .filter(Boolean)
        .some((v) => String(v).toLowerCase().includes(term));
    });
  }, [depoQ.data, q, alignment]);

  return (
    <section className="mt-10">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h2 className="font-serif text-[17px] font-semibold tracking-tight">
            Transcript library
          </h2>
          <p className="mt-1 text-[12.5px] text-muted-foreground">
            Every deposition ingested for this matter.
          </p>
        </div>
        <div className="flex items-center gap-2">
          <div className="relative">
            <SearchIcon className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter by witness…"
              aria-label="Filter transcripts"
              className="h-8 w-52 pl-8 text-[12.5px]"
            />
          </div>
          <div className="inline-flex overflow-hidden rounded-sm border border-border">
            {(
              [
                { v: 'all', label: 'All' },
                { v: 'plaintiff', label: 'Plaintiff' },
                { v: 'defendant', label: 'Defendant' },
                { v: 'other', label: 'Other' },
              ] as const
            ).map((o) => (
              <button
                key={o.v}
                type="button"
                onClick={() => setAlignment(o.v)}
                aria-pressed={alignment === o.v}
                className={cn(
                  'h-8 px-2.5 text-[11px] font-medium transition-colors',
                  alignment === o.v
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-card text-muted-foreground hover:text-foreground',
                )}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      <div className="mt-3 overflow-hidden rounded-sm border border-border bg-card">
        {depoQ.isLoading ? (
          <div className="space-y-2 p-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-6 w-full" style={{ opacity: 1 - i * 0.15 }} />
            ))}
          </div>
        ) : rows.length === 0 ? (
          <div className="px-4 py-10 text-center">
            <FileText className="mx-auto h-4 w-4 text-muted-foreground" />
            <p className="mt-2 text-[12.5px] text-muted-foreground">
              {depoQ.data?.length ? 'No transcripts match that filter.' : 'No transcripts yet — upload one above.'}
            </p>
          </div>
        ) : (
          <table className="w-full text-left">
            <thead>
              <tr className="border-b border-border bg-secondary/40 text-[10px] font-sans uppercase tracking-[0.12em] text-muted-foreground">
                <th className="px-3 py-2 font-medium">Witness</th>
                <th className="px-3 py-2 font-medium">Role</th>
                <th className="px-3 py-2 font-medium">Deposed</th>
                <th className="px-3 py-2 font-medium text-right">Pages</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((d) => (
                <tr key={d.id} className="border-b border-border/60 last:border-0 hover:bg-secondary/40">
                  <td className="px-3 py-2">
                    <Link
                      to="/depositions/$id"
                      params={{ id: d.id }}
                      search={{ analyze: false }}
                      className="font-sans text-[13px] font-medium text-foreground hover:text-primary"
                    >
                      {d.witness_name || d.filename || 'Untitled transcript'}
                    </Link>
                  </td>
                  <td className="px-3 py-2 text-[12px] text-muted-foreground capitalize">
                    {d.witness_role || d.party_alignment || '—'}
                  </td>
                  <td className="px-3 py-2 text-[12px] text-muted-foreground tabular-nums">
                    {d.deposition_date ? fmtDate(d.deposition_date) : '—'}
                  </td>
                  <td className="px-3 py-2 text-right text-[12px] text-muted-foreground tabular-nums">
                    {d.page_count ?? '—'}
                  </td>
                  <td
                    className={cn(
                      'px-3 py-2 text-[11px] font-sans capitalize',
                      STATUS_TONE[d.status] ?? 'text-muted-foreground',
                    )}
                  >
                    {d.status}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}
