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
  Play,
  RefreshCw,
  MoreVertical,
  Quote,
  XCircle,
  HelpCircle,
  Download,
  FileSpreadsheet,
  ClipboardCopy,
  Sparkles,
  LayoutTemplate,
  X,
} from 'lucide-react';
import { REVIEW_TEMPLATES, type ReviewTemplate, type TemplateColumn } from '@/lib/review-templates';
import { toast } from 'sonner';
import { SourcePreviewDrawer } from '@/components/review/source-preview-drawer';
import { AskReview } from '@/components/review/ask-review';
import { toCsvDownloads, toXlsxBlob, toMarkdownTable, downloadBlob } from '@/lib/review-export';
import { AppShell, PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
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
  TABULAR_EXTRACT_ENDPOINT,
  REVIEW_FILES_BUCKET,
  SUPABASE_ANON_KEY,
  MAX_REVIEW_FILES,
  type ReviewSet,
  type ReviewFile,
  type ReviewColumn,
  type ReviewColumnType,
  type ReviewCell,
  type ReviewCellCitation,
} from '@/lib/supabase';
import { useMatter } from '@/lib/matter-context';
import { cn } from '@/lib/utils';

const ACCEPT = '.pdf,.png,.jpg,.jpeg,.webp,.tiff,.tif,.gif,.txt,.md';
const MAX_BYTES = 25 * 1024 * 1024;

const TYPE_LABELS: Record<ReviewColumnType, string> = {
  text: 'Text',
  number: 'Number',
  date: 'Date',
  boolean: 'Yes / No',
  enum: 'Choice',
  list: 'List',
  currency: 'Currency',
};

const COLUMN_PRESETS: { name: string; data_type: ReviewColumnType; prompt: string; enum?: string[] }[] = [
  { name: 'Summary', data_type: 'text', prompt: 'A one-sentence summary of this document.' },
  { name: 'Parties', data_type: 'list', prompt: 'The named parties to this document.' },
  { name: 'Effective date', data_type: 'date', prompt: 'The effective date of the agreement or order.' },
  { name: 'Governing law', data_type: 'text', prompt: 'The governing law / choice-of-law jurisdiction.' },
  { name: 'Arbitration clause?', data_type: 'boolean', prompt: 'Does the document contain a binding arbitration clause?' },
];





type CellWithCites = ReviewCell & { review_cell_citations: ReviewCellCitation[] };

const setsQuery = (caseId: string) =>
  queryOptions({
    queryKey: ['review-sets', caseId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('review_sets').select('*').eq('case_id', caseId).order('created_at', { ascending: false });
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
        .from('review_files').select('*').eq('review_set_id', setId)
        .order('sort_order', { ascending: true }).order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as ReviewFile[];
    },
  });

const columnsQuery = (setId: string | null) =>
  queryOptions({
    queryKey: ['review-columns', setId],
    enabled: !!setId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('review_columns').select('*').eq('review_set_id', setId)
        .order('ordinal', { ascending: true }).order('created_at', { ascending: true });
      if (error) throw error;
      return (data ?? []) as ReviewColumn[];
    },
  });

const cellsQuery = (setId: string | null) =>
  queryOptions({
    queryKey: ['review-cells', setId],
    enabled: !!setId,
    refetchInterval: (q) => {
      const rows = (q.state.data ?? []) as CellWithCites[];
      return rows.some((c) => c.state === 'running') ? 2000 : false;
    },
    queryFn: async () => {
      const { data, error } = await supabase
        .from('review_cells').select('*, review_cell_citations(*)').eq('review_set_id', setId);
      if (error) throw error;
      return (data ?? []) as CellWithCites[];
    },
  });

export const Route = createFileRoute('/review')({
  component: ReviewPage,
  errorComponent: ({ error }) => (
    <AppShell><div className="p-8 text-sm text-destructive">Failed to load: {error.message}</div></AppShell>
  ),
  notFoundComponent: () => (<AppShell><div className="p-8">Not found.</div></AppShell>),
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
  const activeSet = useMemo(() => sets.find((s) => s.id === activeSetId) ?? sets[0] ?? null, [sets, activeSetId]);
  const setId = activeSet?.id ?? null;
  const { data: files = [] } = useQuery(filesQuery(setId));
  const { data: columns = [] } = useQuery(columnsQuery(setId));
  const { data: cells = [] } = useQuery(cellsQuery(setId));

  const readyFiles = useMemo(() => files.filter((f) => f.status === 'ready'), [files]);
  const cellMap = useMemo(() => {
    const m = new Map<string, CellWithCites>();
    for (const c of cells) m.set(`${c.review_file_id}:${c.review_column_id}`, c);
    return m;
  }, [cells]);
  const [runningCols, setRunningCols] = useState<Set<string>>(new Set());

  const createSet = useMutation({
    mutationFn: async () => {
      const { data, error } = await supabase
        .from('review_sets').insert({ case_id: caseId, name: `Review ${new Date().toLocaleDateString()}` }).select('*').single();
      if (error) throw error;
      return data as ReviewSet;
    },
    onSuccess: (s) => { setActiveSetId(s.id); qc.invalidateQueries({ queryKey: ['review-sets', caseId] }); },
    onError: (e: any) => toast.error(`Could not create review: ${e.message}`),
  });

  const ensureSet = useCallback(async (): Promise<string> => {
    if (setId) return setId;
    const s = await createSet.mutateAsync();
    return s.id;
  }, [setId, createSet]);

  const [uploading, setUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const ingest = async (file: Pick<ReviewFile, 'id' | 'storage_path' | 'mime_type' | 'filename'>) => {
    try {
      const res = await fetch(TABULAR_INGEST_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify({ review_file_id: file.id, storage_path: file.storage_path, mime_type: file.mime_type, filename: file.filename }),
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
    if (remaining <= 0) { toast.error(`A review holds up to ${MAX_REVIEW_FILES} files`); return; }
    const accepted = incoming.slice(0, remaining);
    if (incoming.length > remaining) toast.warning(`Only ${remaining} more allowed — added the first ${remaining}`);

    setUploading(true);
    try {
      const sid = await ensureSet();
      for (const file of accepted) {
        if (file.size > MAX_BYTES) { toast.error(`${file.name} exceeds 25MB`); continue; }
        const safe = file.name.replace(/[^\w.\-]+/g, '_');
        const path = `${sid}/${crypto.randomUUID()}-${safe}`;
        const { error: upErr } = await supabase.storage
          .from(REVIEW_FILES_BUCKET).upload(path, file, { contentType: file.type || 'application/octet-stream', upsert: false });
        if (upErr) { toast.error(`Upload failed for ${file.name}: ${upErr.message}`); continue; }
        const { data: row, error: insErr } = await supabase
          .from('review_files')
          .insert({ review_set_id: sid, filename: file.name, storage_path: path, mime_type: file.type || null, byte_size: file.size, status: 'uploaded' })
          .select('*').single();
        if (insErr || !row) { toast.error(`Could not register ${file.name}`); continue; }
        qc.invalidateQueries({ queryKey: ['review-files', sid] });
        void ingest(row as ReviewFile);
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
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['review-files', setId] }); qc.invalidateQueries({ queryKey: ['review-cells', setId] }); },
    onError: (e: any) => toast.error(`Delete failed: ${e.message}`),
  });

  const addColumn = useMutation({
    mutationFn: async (col: { name: string; data_type: ReviewColumnType; prompt: string; enum_options: string[] | null }) => {
      const sid = await ensureSet();
      const { data, error } = await supabase
        .from('review_columns')
        .insert({ review_set_id: sid, name: col.name, data_type: col.data_type, prompt: col.prompt || null, enum_options: col.enum_options, ordinal: columns.length })
        .select('*').single();
      if (error) throw error;
      return data as ReviewColumn;
    },
    onSuccess: (col) => {
      qc.invalidateQueries({ queryKey: ['review-columns', setId] });
      if (readyFiles.length) runColumn(col.id);
    },
    onError: (e: any) => toast.error(`Could not add column: ${e.message}`),
  });

  const deleteColumn = useMutation({
    mutationFn: async (id: string) => { const { error } = await supabase.from('review_columns').delete().eq('id', id); if (error) throw error; },
    onSuccess: () => { qc.invalidateQueries({ queryKey: ['review-columns', setId] }); qc.invalidateQueries({ queryKey: ['review-cells', setId] }); },
    onError: (e: any) => toast.error(`Delete failed: ${e.message}`),
  });

  const runColumn = useCallback(async (columnId: string) => {
    if (!setId || !readyFiles.length) return;
    setRunningCols((s) => new Set(s).add(columnId));
    try {
      const res = await fetch(TABULAR_EXTRACT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify({ review_set_id: setId, column_id: columnId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) throw new Error(body?.error || `Extraction failed (${res.status})`);
    } catch (e) {
      toast.error('Extraction failed', { description: (e as Error).message });
    } finally {
      setRunningCols((s) => { const n = new Set(s); n.delete(columnId); return n; });
      qc.invalidateQueries({ queryKey: ['review-cells', setId] });
    }
  }, [setId, readyFiles.length, qc]);

  const runColumns = useCallback(async (ids: string[]) => {
    if (!ids.length) return;
    const queue = [...ids];
    const worker = async () => {
      while (queue.length) {
        const next = queue.shift();
        if (next) await runColumn(next);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
  }, [runColumn]);

  const runAll = useCallback(() => {
    void runColumns(columns.map((c) => c.id));
  }, [columns, runColumns]);

  const addColumns = useMutation({
    mutationFn: async (cols: TemplateColumn[]) => {
      if (!cols.length) return [] as ReviewColumn[];
      const sid = await ensureSet();
      const rows = cols.map((c, i) => ({
        review_set_id: sid,
        name: c.name,
        data_type: c.data_type,
        prompt: c.prompt || null,
        enum_options: c.enum_options ?? null,
        ordinal: columns.length + i,
      }));
      const { data, error } = await supabase.from('review_columns').insert(rows).select('*');
      if (error) throw error;
      return (data ?? []) as ReviewColumn[];
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['review-columns', setId] });
      toast.success(`Added ${data.length} column${data.length === 1 ? '' : 's'}`);
    },
    onError: (e: any) => toast.error(`Could not add columns: ${e.message}`),
  });


  // Source preview drawer state
  const [drawer, setDrawer] = useState<{
    open: boolean;
    file: ReviewFile | null;
    cellId: string | null;
    citations: ReviewCellCitation[];
    page: number | null;
    quote: string | null;
  }>({ open: false, file: null, cellId: null, citations: [], page: null, quote: null });

  const openSource = useCallback((file: ReviewFile, cell: CellWithCites | undefined) => {
    const cites = cell?.review_cell_citations ?? [];
    const first = cites.slice().sort((a, b) => (a.page_number ?? 0) - (b.page_number ?? 0))[0];
    setDrawer({
      open: true,
      file,
      cellId: cell?.id ?? null,
      citations: cites,
      page: first?.page_number ?? 1,
      quote: first?.quote ?? null,
    });
  }, []);

  const setName = activeSet?.name ?? 'review';
  const doExport = useCallback(
    (kind: 'csv' | 'xlsx' | 'md') => {
      if (kind === 'csv') {
        for (const f of toCsvDownloads(setName, files, columns, cellMap)) downloadBlob(f.blob, f.name);
        toast.success('CSV downloaded');
      } else if (kind === 'xlsx') {
        downloadBlob(toXlsxBlob(setName, files, columns, cellMap), `${setName.replace(/[^\w]+/g, '_').toLowerCase()}.xlsx`);
        toast.success('Excel file downloaded');
      } else {
        navigator.clipboard.writeText(toMarkdownTable(files, columns, cellMap));
        toast.success('Markdown table copied to clipboard');
      }
    },
    [setName, files, columns, cellMap],
  );

  const anyRunning = runningCols.size > 0 || cells.some((c) => c.state === 'running');
  const atLimit = files.length >= MAX_REVIEW_FILES;
  const canRun = readyFiles.length > 0 && columns.length > 0;
  const hasExportable = files.length > 0 && columns.length > 0;



  return (
    <AppShell>
      <PageHeader
        title="Tabular Review"
        description="Upload up to 25 documents, define the fields you want, and extract a cited table — every value is pulled from the source text and verified against it."
      >
        <div className="flex items-center gap-2">
          {readyFiles.length > 0 && columns.length === 0 && (
            <Button size="sm" variant="outline" className="gap-2" onClick={addMetadataColumns} disabled={addColumn.isPending}>
              <Sparkles className="h-4 w-4" /> Auto-add metadata
            </Button>
          )}
          {columns.length > 0 && (
            <Button size="sm" className="gap-2" onClick={runAll} disabled={!canRun || anyRunning}>
              {anyRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Run all
            </Button>
          )}
          {hasExportable && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2">
                  <Download className="h-4 w-4" /> Export
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                <DropdownMenuItem onClick={() => doExport('xlsx')} className="gap-2">
                  <FileSpreadsheet className="h-3.5 w-3.5" /> Excel (.xlsx)
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => doExport('csv')} className="gap-2">
                  <FileText className="h-3.5 w-3.5" /> CSV + citations
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => doExport('md')} className="gap-2">
                  <ClipboardCopy className="h-3.5 w-3.5" /> Copy as Markdown table
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2 max-w-[16rem]">
                <Table2 className="h-4 w-4 shrink-0" />
                <span className="truncate">{activeSet ? activeSet.name : 'No review yet'}</span>
                <ChevronsUpDown className="h-3.5 w-3.5 opacity-60 shrink-0" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-64">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.14em] text-muted-foreground">Reviews</DropdownMenuLabel>
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

      <div className="px-6 lg:px-8 py-6">
        {/* Upload zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => { e.preventDefault(); setDragOver(false); if (!atLimit) handleFiles(e.dataTransfer.files); }}
          className={cn(
            'rounded-md border-2 border-dashed px-5 py-5 flex items-center gap-4 transition-colors',
            dragOver ? 'border-primary bg-primary/5' : 'border-border bg-card/40',
            atLimit && 'opacity-60',
          )}
        >
          <input ref={inputRef} type="file" multiple accept={ACCEPT} className="hidden" onChange={(e) => handleFiles(e.target.files)} />
          <Upload className="h-6 w-6 text-muted-foreground shrink-0" strokeWidth={1.5} />
          <div className="min-w-0 flex-1">
            <p className="font-sans text-sm text-foreground">
              {atLimit ? `Maximum ${MAX_REVIEW_FILES} files reached` : 'Drag documents here, or choose files'}
            </p>
            <p className="text-[11px] text-muted-foreground">PDF, images, or text · up to {MAX_REVIEW_FILES} · 25MB each · {files.length}/{MAX_REVIEW_FILES} used</p>
          </div>
          {!atLimit && (
            <Button variant="secondary" size="sm" className="gap-2 shrink-0" disabled={uploading} onClick={() => inputRef.current?.click()}>
              {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Upload className="h-4 w-4" />} Choose files
            </Button>
          )}
        </div>

        {/* Ask across documents */}
        {setId && readyFiles.length > 0 && (
          <div className="mt-6">
            <AskReview reviewSetId={setId} files={files} />
          </div>
        )}

        {/* Empty state */}
        {files.length === 0 ? (
          <div className="mt-10 text-center text-sm text-muted-foreground">
            Upload documents to begin, then add columns for the fields you want extracted.
          </div>
        ) : (
          <div className="mt-2 overflow-x-auto rounded-md border border-border">
            <table className="w-full border-collapse text-[13px]">
              <thead>
                <tr className="bg-secondary/50">
                  <th className="sticky left-0 z-10 bg-secondary/50 text-left font-sans font-medium text-[11px] uppercase tracking-wider text-muted-foreground px-3 py-2.5 border-b border-r border-border min-w-[15rem]">
                    Document
                  </th>
                  {columns.map((col) => (
                    <th key={col.id} className="text-left px-3 py-2 border-b border-r border-border align-top min-w-[14rem] max-w-[20rem]">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-sans font-semibold text-foreground truncate">{col.name}</div>
                          <Badge variant="secondary" className="mt-1 text-[9.5px] font-normal">{TYPE_LABELS[col.data_type]}</Badge>
                        </div>
                        <DropdownMenu>
                          <DropdownMenuTrigger asChild>
                            <button className="text-muted-foreground hover:text-foreground p-0.5 shrink-0"><MoreVertical className="h-3.5 w-3.5" /></button>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem onClick={() => runColumn(col.id)} disabled={!readyFiles.length} className="gap-2">
                              <RefreshCw className="h-3.5 w-3.5" /> Re-run column
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => deleteColumn.mutate(col.id)} className="gap-2 text-destructive">
                              <Trash2 className="h-3.5 w-3.5" /> Delete column
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                    </th>
                  ))}
                  <th className="px-3 py-2 border-b border-border align-middle w-[12rem]">
                    <AddColumnDialog onAdd={(c) => addColumn.mutate(c)} />
                  </th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.id} className="hover:bg-secondary/20">
                    <td className="sticky left-0 z-10 bg-card px-3 py-2.5 border-b border-r border-border align-top min-w-[15rem]">
                      <DocCell file={f} onRemove={() => removeFile.mutate(f)} onRetry={() => ingest(f)} />
                    </td>
                    {columns.map((col) => {
                      const cell = cellMap.get(`${f.id}:${col.id}`);
                      const hasSource = !!cell && (cell.review_cell_citations?.length ?? 0) > 0;
                      return (
                        <td
                          key={col.id}
                          className={cn(
                            'px-3 py-2.5 border-b border-r border-border align-top max-w-[20rem]',
                            hasSource && 'cursor-pointer hover:bg-accent/5',
                          )}
                          onClick={() => hasSource && openSource(f, cell)}
                        >
                          {f.status !== 'ready' ? (
                            <span className="text-muted-foreground/50">—</span>
                          ) : (
                            <CellView cell={cell} running={runningCols.has(col.id)} />
                          )}
                        </td>
                      );
                    })}
                    <td className="border-b border-border" />
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <SourcePreviewDrawer
        open={drawer.open}
        onOpenChange={(o) => setDrawer((d) => ({ ...d, open: o }))}
        file={drawer.file}
        cellId={drawer.cellId}
        citations={drawer.citations}
        initialPage={drawer.page}
        initialQuote={drawer.quote}
      />
    </AppShell>
  );

}

function DocCell({ file, onRemove, onRetry }: { file: ReviewFile; onRemove: () => void; onRetry: () => void }) {
  const isImage = (file.mime_type ?? '').startsWith('image/') || /\.(png|jpe?g|webp|gif|tiff?)$/i.test(file.filename);
  const Icon = isImage ? ImageIcon : FileText;
  return (
    <div className="flex items-start gap-2.5">
      <Icon className="h-4 w-4 text-muted-foreground shrink-0 mt-0.5" strokeWidth={1.5} />
      <div className="min-w-0 flex-1">
        <div className="font-sans font-medium text-foreground truncate" title={file.filename}>{file.filename}</div>
        <div className="text-[11px] text-muted-foreground tabular-nums flex items-center gap-1.5 mt-0.5">
          {file.status === 'uploaded' && <><Loader2 className="h-3 w-3 animate-spin" /> Queued</>}
          {file.status === 'transcribing' && <span className="inline-flex items-center gap-1 text-accent"><Loader2 className="h-3 w-3 animate-spin" /> Transcribing…</span>}
          {file.status === 'ready' && <span>{fmtBytes(file.byte_size)}{file.page_count != null ? ` · ${file.page_count}p` : ''}</span>}
          {file.status === 'error' && (
            <button onClick={onRetry} title={file.error ?? 'Retry'} className="inline-flex items-center gap-1 text-destructive hover:underline">
              <AlertTriangle className="h-3 w-3" /> Failed — retry
            </button>
          )}
        </div>
      </div>
      <button onClick={onRemove} aria-label="Remove" className="text-muted-foreground hover:text-destructive shrink-0 p-0.5"><Trash2 className="h-3.5 w-3.5" /></button>
    </div>
  );
}

function CellView({ cell, running }: { cell?: CellWithCites; running: boolean }) {
  if (running && (!cell || cell.state === 'pending' || cell.state === 'running')) {
    return <span className="inline-flex items-center gap-1.5 text-muted-foreground text-[12px]"><Loader2 className="h-3 w-3 animate-spin" /> Extracting…</span>;
  }
  if (!cell || cell.state === 'pending') return <span className="text-muted-foreground/40">·</span>;
  if (cell.state === 'running') return <span className="inline-flex items-center gap-1.5 text-muted-foreground text-[12px]"><Loader2 className="h-3 w-3 animate-spin" /> Extracting…</span>;
  if (cell.state === 'error') return <span className="inline-flex items-center gap-1 text-destructive text-[12px]" title={cell.error ?? ''}><XCircle className="h-3 w-3" /> Error</span>;
  if (cell.state === 'not_found') return <span className="text-muted-foreground/60 text-[12px] italic">Not found</span>;

  const cites = (cell.review_cell_citations ?? []).slice().sort((a, b) => (a.page_number ?? 0) - (b.page_number ?? 0));
  const needsReview = cell.state === 'needs_review';
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="text-left w-full group">
          <span className={cn('font-serif leading-snug', needsReview ? 'text-amber-700' : 'text-foreground')}>
            {cell.value_text || <span className="text-muted-foreground/60 italic">—</span>}
          </span>
          <span className="mt-1 flex items-center gap-1.5 flex-wrap">
            {needsReview && (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-600"><AlertTriangle className="h-2.5 w-2.5" /> review</span>
            )}
            {cites.length > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-accent group-hover:underline">
                <Quote className="h-2.5 w-2.5" /> {cites.length === 1 && cites[0].page_number ? `p.${cites[0].page_number}` : `${cites.length} cites`}
              </span>
            )}
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-80">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Extracted value</span>
            {cell.confidence != null && <span className="text-[10px] text-muted-foreground tabular-nums">conf {(cell.confidence * 100).toFixed(0)}%</span>}
          </div>
          <div className={cn('font-serif text-sm', needsReview ? 'text-amber-700' : 'text-foreground')}>
            {cell.value_text || <span className="italic text-muted-foreground">—</span>}
          </div>
          {cell.reasoning && (
            <div className="border-t border-border pt-2">
              <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1">Reasoning</div>
              <p className="text-[11px] text-muted-foreground">{cell.reasoning}</p>
            </div>
          )}
          {needsReview && (
            <div className="flex items-start gap-1.5 text-[11px] text-amber-700 bg-amber-50 rounded-sm px-2 py-1.5">
              <AlertTriangle className="h-3 w-3 mt-0.5 shrink-0" />
              <span>Flagged for review — unverified against the source or low-confidence. Confirm before relying on it.</span>
            </div>
          )}
          <div className="border-t border-border pt-2">
            <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-1.5">Citations</div>
            {cites.length === 0 ? (
              <p className="text-[11px] text-muted-foreground italic">No supporting quote returned.</p>
            ) : (
              <ul className="space-y-2">
                {cites.map((c) => (
                  <li key={c.id} className="text-[11px]">
                    <div className="flex items-center gap-1.5 text-muted-foreground">
                      {c.verified ? <CheckCircle2 className="h-3 w-3 text-emerald-600" /> : <HelpCircle className="h-3 w-3 text-amber-500" />}
                      <span className="tabular-nums">{c.page_number ? `Page ${c.page_number}` : 'Source'}</span>
                      {!c.verified && <span className="text-amber-600">unverified</span>}
                    </div>
                    <blockquote className="mt-0.5 pl-2 border-l-2 border-border font-serif italic text-foreground/80">“{c.quote}”</blockquote>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      </PopoverContent>
    </Popover>
  );
}

function AddColumnDialog({ onAdd }: { onAdd: (c: { name: string; data_type: ReviewColumnType; prompt: string; enum_options: string[] | null }) => void }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [type, setType] = useState<ReviewColumnType>('text');
  const [prompt, setPrompt] = useState('');
  const [enumRaw, setEnumRaw] = useState('');

  const reset = () => { setName(''); setType('text'); setPrompt(''); setEnumRaw(''); };
  const submit = () => {
    if (!name.trim()) return;
    onAdd({
      name: name.trim(),
      data_type: type,
      prompt: prompt.trim(),
      enum_options: type === 'enum' ? enumRaw.split(',').map((s) => s.trim()).filter(Boolean) : null,
    });
    reset();
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-1.5 w-full"><Plus className="h-3.5 w-3.5" /> Add column</Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add a column</DialogTitle>
          <DialogDescription>Name the field, pick its type, and optionally describe exactly what to extract.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="flex flex-wrap gap-1.5">
            {COLUMN_PRESETS.map((p) => (
              <button
                key={p.name}
                onClick={() => { setName(p.name); setType(p.data_type); setPrompt(p.prompt); setEnumRaw((p.enum ?? []).join(', ')); }}
                className="text-[11px] px-2 py-1 rounded-sm border border-border bg-secondary/50 hover:bg-secondary transition"
              >
                {p.name}
              </button>
            ))}
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="col-name">Field name</Label>
            <Input id="col-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Termination notice period" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label>Type</Label>
            <Select value={type} onValueChange={(v) => setType(v as ReviewColumnType)}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {(Object.keys(TYPE_LABELS) as ReviewColumnType[]).map((t) => (
                  <SelectItem key={t} value={t}>{TYPE_LABELS[t]}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {type === 'enum' && (
            <div className="space-y-1.5">
              <Label htmlFor="col-enum">Choices (comma-separated)</Label>
              <Input id="col-enum" value={enumRaw} onChange={(e) => setEnumRaw(e.target.value)} placeholder="e.g. Granted, Denied, Partial" />
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="col-prompt">Instruction <span className="text-muted-foreground font-normal">(optional)</span></Label>
            <Textarea id="col-prompt" value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder="What exactly should be extracted? Helps accuracy." className="min-h-[64px]" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!name.trim()} className="gap-2"><Plus className="h-4 w-4" /> Add &amp; extract</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
