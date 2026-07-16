import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useRef, useState, type DragEvent } from 'react';
import { Upload, Loader2 } from 'lucide-react';
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

      <div className="px-8 py-8 max-w-3xl mx-auto">
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
      </div>
    </AppShell>
  );
}
