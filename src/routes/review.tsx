import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, queryOptions, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Table2,
  Upload,
  FileText,
  Image as ImageIcon,
  Loader2,
  CheckCircle2,
  AlertTriangle,
  Trash2,
  Plus,
  ChevronsUpDown,
  Check,
} from 'lucide-react';
import { toast } from 'sonner';
import { AppShell, PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  supabase,
  TABULAR_INGEST_ENDPOINT,
  REVIEW_FILES_BUCKET,
  SUPABASE_ANON_KEY,
  MAX_REVIEW_FILES,
  type ReviewSet,
  type ReviewFile,
} from '@/lib/supabase';
import { useMatter } from '@/lib/matter-context';
import { cn } from '@/lib/utils';

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.tiff,.tif,.gif,.txt,.md';
const MAX_BYTES = 20 * 1024 * 1024;

const setsQuery = (caseId: string) =>
  queryOptions({
    queryKey: ['review-sets', caseId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('review_sets')
        .select('*')
        .eq('case_id', caseId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as ReviewSet[];
    },
  });

const filesQuery = (setId: string | null) =>
  queryOptions({
    queryKey: ['review-files', setId],
    enabled: !!setId,
    refetchInterval: (q) => {
      const rows = (q.state.data ?? []) as ReviewFile[];
      return rows.some((f) => f.status === 'uploaded' || f.status === 'transcribing') ? 2500 : false;
    },
    queryFn: async () => {
      const { data, error } = await supabase
        .from('review_files')
        .select('*')
        .eq('review_set_id', setId)
        .order('sort_order', { ascending: true })
        .order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as ReviewFile[];
    },
  });

export const Route = createFileRoute('/review')({
  component: ReviewPage,
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

function fmtBytes(n: number | null): string {
  if (!n) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function ReviewPage() {
  const { currentMatter } = useMatter();
  const caseId = currentMatter.master_case_id;
  const qc = useQueryClient();
  const [activeSetId, setActiveSetId] = useState<string | null>(null);

  const { data: sets = [] } = useQuery(setsQuery(caseId));
  const activeSet = useMemo(
    () => sets.find((s) => s.id === activeSetId) ?? sets[0] ?? null,
    [sets, activeSetId],
  );
  const setId = activeSet?.id ?? null;
  const { data: files = [] } = useQuery(filesQuery(setId));

  const createSet = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase
        .from('review_sets')
        .insert({ case_id: caseId, name: `Review ${new Date().toLocaleDateString()}` })
        .select('*')
        .single();
      if (error) throw error;
      return data as ReviewSet;
    },
    onSuccess: (s) => {
      setActiveSetId(s.id);
      qc.invalidateQueries({ queryKey: ['review-sets', caseId] });
    },
    onError: (e: any) => toast.error(`Could not create review: ${e.message}`),
  });

  // Ensure a review set exists, returning its id.
  const ensureSet = useCallback(async (): Promise<string> => {
    if (setId) return setId;
    const s = await createSet.mutateAsync();
    return s.id;
  }, [setId, createSet]);

  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const ingest = async (reviewFileId: string) => {
    try {
      const res = await fetch(TABULAR_INGEST_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ review_file_id: reviewFileId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) throw new Error(body?.error || `Transcription failed (${res.status})`);
    } catch (e) {
      toast.error('Transcription failed', { description: (e as Error).message });
    } finally {
      qc.invalidateQueries({ queryKey: ['review-files', setId] });
    }
  };

  const handleFiles = async (fileList: FileList | null) => {
    if (!fileList || fileList.length === 0) return;
    const incoming = Array.from(fileList);
    const remaining = MAX_REVIEW_FILES - files.length;
    if (remaining <= 0) {
      toast.error(`A review holds up to ${MAX_REVIEW_FILES} files`);
      return;
    }
    const accepted = incoming.slice(0, remaining);
    if (incoming.length > remaining) {
      toast.warning(`Only ${remaining} more file${remaining === 1 ? '' : 's'} allowed — added the first ${remaining}`);
    }

    setUploading(true);
    try {
      const sid = await ensureSet();
      for (const file of accepted) {
        if (file.size > MAX_BYTES) {
          toast.error(`${file.name} exceeds 20MB`);
          continue;
        }
        const safe = file.name.replace(/[^\w.\-]+/g, '_');
        const path = `${sid}/${crypto.randomUUID()}-${safe}`;
        const { error: upErr } = await supabase.storage
          .from(REVIEW_FILES_BUCKET)
          .upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
        if (upErr) {
          toast.error(`Upload failed for ${file.name}: ${upErr.message}`);
          continue;
        }
        const { data: row, error: insErr } = await supabase
          .from('review_files')
          .insert({
            review_set_id: sid,
            filename: file.name,
            storage_path: path,
            mime_type: file.type || null,
            byte_size: file.size,
            status: 'uploaded',
          })
          .select('*')
          .single();
        if (insErr || !row) {
          toast.error(`Could not register ${file.name}`);
          continue;
        }
        qc.invalidateQueries({ queryKey: ['review-files', sid] });
        void ingest((row as ReviewFile).id); // transcribe in the background
      }
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const removeFile = useMutation({
    mutationFn: async (f: ReviewFile) => {
      await supabase.storage.from(REVIEW_FILES_BUCKET).remove([f.storage_path]);
      const { error } = await supabase.from('review_files').delete().eq('id', f.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ['review-files', setId] }),
    onError: (e: any) => toast.error(`Delete failed: ${e.message}`),
  });

  const atLimit = files.length >= MAX_REVIEW_FILES;
  const readyCount = files.filter((f) => f.status === 'ready').length;

  return (
    <AppShell>
      <PageHeader
        title="Tabular Review"
        description="Upload up to 5 documents, then define the fields you want extracted. Every value is pulled from the source text and cited back to its page."
      >
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2 max-w-[16rem]">
                <Table2 className="h-4 w-4 shrink-0" />
                <span className="truncate">{activeSet ? activeSet.name : 'No review yet'}</span>
                <ChevronsUpDown className="h-3.5 w-3.5 opacity-60 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">
                Reviews
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              {sets.map((s) => (
                <DropdownMenuItem key={s.id} onClick={() => setActiveSetId(s.id)} className="flex items-center gap-2">
                  <Check className={cn('h-3.5 w-3.5 shrink-0', s.id === setId ? 'opacity-100' : 'opacity-0')} />
                  <span className="truncate">{s.name}</span>
                </DropdownMenuItem>
              ))}
              {sets.length > 0 && <DropdownMenuSeparator />}
              <DropdownMenuItem onClick={() => createSet.mutate()} className="gap-2 cursor-pointer font-medium">
                <Plus className="h-3.5 w-3.5" /> New review
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </PageHeader>

      <div className="px-8 py-6 max-w-4xl">
        {/* Upload zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); if (!atLimit) handleFiles(e.dataTransfer.files); }}
          className={cn(
            'rounded-md border-2 border-dashed px-6 py-10 text-center transition-colors',
            dragOver ? 'border-primary bg-primary/5' : 'border-border bg-card/40',
            atLimit && 'opacity-60',
          )}
        >
          <input
            ref={inputRef}
            type="file"
            multiple
            accept={ACCEPT}
            className="hidden"
            onChange={(e) => handleFiles(e.target.files)}
          />
          <Upload className="h-8 w-8 mx-auto text-muted-foreground" strokeWidth={1.5} />
          <p className="mt-3 font-sans text-sm text-foreground">
            {atLimit ? `Maximum ${MAX_REVIEW_FILES} files reached` : 'Drag documents here, or'}
          </p>
          {!atLimit && (
            <Button
              variant="secondary"
              size="sm"
              className="mt-3 gap-2"
              disabled={uploading}
              onClick={() => inputRef.current?.click()}
            >
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />}
              Choose files
            </Button>
          )}
          <p className="mt-3 text-[11px] text-muted-foreground">
            PDF, images, or text · up to {MAX_REVIEW_FILES} files · 20MB each · {files.length}/{MAX_REVIEW_FILES} used
          </p>
        </div>

        {/* File list */}
        {files.length > 0 && (
          <div className="mt-6 space-y-2">
            {files.map((f) => (
              <FileRow key={f.id} file={f} onRemove={() => removeFile.mutate(f)} onRetry={() => ingest(f.id)} />
            ))}
          </div>
        )}

        {/* Next step hint */}
        {readyCount > 0 && (
          <div className="mt-6 flex items-center gap-2 rounded-sm border border-border bg-secondary/40 px-4 py-3 text-[13px] text-muted-foreground">
            <CheckCircle2 className="h-4 w-4 text-emerald-600 shrink-0" />
            <span>
              {readyCount} document{readyCount === 1 ? '' : 's'} transcribed and ready. Next: define the columns to extract —
              the extraction grid is coming online.
            </span>
          </div>
        )}
      </div>
    </AppShell>
  );
}

function FileRow({ file, onRemove, onRetry }: { file: ReviewFile; onRemove: () => void; onRetry: () => void }) {
  const isImage = (file.mime_type ?? '').startsWith('image/') || /\.(png|jpe?g|webp|gif|tiff?)$/i.test(file.filename);
  const Icon = isImage ? ImageIcon : FileText;
  return (
    <Card className="p-3 flex items-center gap-3">
      <Icon className="h-5 w-5 text-muted-foreground shrink-0" strokeWidth={1.5} />
      <div className="min-w-0 flex-1">
        <div className="font-sans text-[13px] font-medium text-foreground truncate">{file.filename}</div>
        <div className="text-[11px] text-muted-foreground tabular-nums">
          {fmtBytes(file.byte_size)}
          {file.status === 'ready' && file.page_count != null ? ` · ${file.page_count} page${file.page_count === 1 ? '' : 's'}` : ''}
        </div>
      </div>
      <div className="shrink-0 flex items-center gap-2">
        {file.status === 'uploaded' && (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" /> Queued</span>
        )}
        {file.status === 'transcribing' && (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-accent"><Loader2 className="h-3 w-3 animate-spin" /> Transcribing…</span>
        )}
        {file.status === 'ready' && (
          <span className="inline-flex items-center gap-1.5 text-[11px] text-emerald-600"><CheckCircle2 className="h-3 w-3" /> Ready</span>
        )}
        {file.status === 'error' && (
          <button onClick={onRetry} title={file.error ?? 'Retry'} className="inline-flex items-center gap-1.5 text-[11px] text-destructive hover:underline">
            <AlertTriangle className="h-3 w-3" /> Failed — retry
          </button>
        )}
        <button
          onClick={onRemove}
          aria-label="Remove file"
          className="inline-flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground hover:text-destructive hover:bg-secondary transition"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
      </div>
    </Card>
  );
}
