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
  Wand2,
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
  TABULAR_STANDARDIZE_ENDPOINT,
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
const DOC_COL_KEY = '__doc__';
type ExtractResult = { file_id: string; state: string; value: string | null; confidence: number | null };
const CONFIDENCE_LOW = 0.7;



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
  { name: 'Document type', data_type: 'enum', prompt: 'Classify this document into exactly one category based on its caption and content.', enum: ['Order', 'Motion', 'Brief', 'Stipulation', 'Notice', 'Letter', 'Expert Report', 'Deposition', 'Pleading', 'Other'] },
  { name: 'Filing / entry date', data_type: 'date', prompt: 'The date the document was filed, signed, or entered.' },
  { name: 'Filing party', data_type: 'text', prompt: 'The party who filed or submitted this document.' },
  { name: 'Judge', data_type: 'text', prompt: 'The judge or judicial officer named in the document.' },
  { name: 'Court', data_type: 'text', prompt: 'The court or forum named in the document.' },
  { name: 'Docket / case no.', data_type: 'text', prompt: 'The docket number, case number, or MDL number.' },
  { name: 'Parties', data_type: 'list', prompt: 'The named parties (plaintiffs, defendants, signatories).' },
  { name: 'Relief sought', data_type: 'text', prompt: 'The relief, ruling, or outcome requested or ordered.' },
  { name: 'Disposition', data_type: 'enum', prompt: 'How the matter was resolved, if stated.', enum: ['Granted', 'Denied', 'Granted in part', 'Pending', 'Withdrawn', 'Deferred'] },
  { name: 'Deadlines set', data_type: 'list', prompt: 'Any deadlines or dated obligations imposed, each as "date/trigger — what is due".' },
  { name: 'Causes of action', data_type: 'list', prompt: 'The legal claims or causes of action asserted.' },
  { name: 'Summary', data_type: 'text', prompt: 'A one-sentence summary of the document.' },
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
  const [colWidths, setColWidths] = useState<Record<string, number>>({});
  

  const startResize = (key: string, defaultW: number) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const startX = e.clientX;
    const startW = colWidths[key] ?? defaultW;
    const onMove = (ev: PointerEvent) =>
      setColWidths((w) => ({ ...w, [key]: Math.max(120, Math.min(640, startW + ev.clientX - startX)) }));
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  };


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

  const runColumn = useCallback(async (columnId: string, fileIds?: string[]): Promise<ExtractResult[] | null> => {
    if (!setId || !readyFiles.length) return null;
    setRunningCols((s) => new Set(s).add(columnId));
    try {
      const body: Record<string, unknown> = { review_set_id: setId, column_id: columnId };
      if (fileIds && fileIds.length) body.file_ids = fileIds;
      const res = await fetch(TABULAR_EXTRACT_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify(body),
      });
      const respBody = await res.json().catch(() => ({}));
      if (!res.ok || respBody?.ok === false) throw new Error(respBody?.error || `Extraction failed (${res.status})`);
      return Array.isArray(respBody?.results) ? (respBody.results as ExtractResult[]) : [];
    } catch (e) {
      toast.error('Extraction failed', { description: (e as Error).message });
      return null;
    } finally {
      setRunningCols((s) => { const n = new Set(s); n.delete(columnId); return n; });
      qc.invalidateQueries({ queryKey: ['review-cells', setId] });
    }
  }, [setId, readyFiles.length, qc]);

  const runTasks = useCallback(async (tasks: { columnId: string; fileIds?: string[] }[], concurrency = 6) => {
    const queue = [...tasks];
    if (!queue.length) return;
    const worker = async () => { while (queue.length) { const t = queue.shift(); if (t) await runColumn(t.columnId, t.fileIds); } };
    await Promise.all(Array.from({ length: Math.min(concurrency, queue.length) }, worker));
  }, [runColumn]);

  const retryFailed = useCallback(async () => {
    const byCol = new Map<string, string[]>();
    for (const c of cells) {
      if (c.state !== 'error') continue;
      const arr = byCol.get(c.review_column_id) ?? [];
      arr.push(c.review_file_id);
      byCol.set(c.review_column_id, arr);
    }
    const tasks = Array.from(byCol.entries()).map(([columnId, fileIds]) => ({ columnId, fileIds }));
    if (!tasks.length) return;
    await runTasks(tasks, 6);
  }, [cells, runTasks]);

  const runIncomplete = useCallback(async () => {
    const tasks: { columnId: string; fileIds: string[] }[] = [];
    for (const col of columns) {
      const fids: string[] = [];
      for (const f of readyFiles) {
        const st = cellMap.get(`${f.id}:${col.id}`)?.state;
        if (!st || st === 'pending' || st === 'error' || st === 'not_found') fids.push(f.id);
      }
      if (fids.length) tasks.push({ columnId: col.id, fileIds: fids });
    }
    if (!tasks.length) { toast.info('Nothing incomplete to extract'); return; }
    await runTasks(tasks, 6);
  }, [columns, readyFiles, cellMap, runTasks]);

  const runAll = useCallback(async () => {
    const stateMap = new Map<string, Map<string, string>>();
    const record = (colId: string, results: ExtractResult[] | null, scope?: string[]) => {
      let m = stateMap.get(colId); if (!m) { m = new Map(); stateMap.set(colId, m); }
      if (results) { for (const r of results) m.set(r.file_id, r.state); }
      else if (scope) { for (const fid of scope) m.set(fid, 'error'); }
    };
    {
      const queue = columns.map((c) => c.id);
      const worker = async () => { while (queue.length) { const id = queue.shift(); if (!id) continue; const res = await runColumn(id); record(id, res); } };
      await Promise.all(Array.from({ length: Math.min(6, queue.length || 1) }, worker));
    }
    const MAX_SWEEPS = 2;
    const countEmpty = () => { let n = 0; for (const m of stateMap.values()) for (const s of m.values()) if (s === 'error' || s === 'not_found') n++; return n; };
    let prev = countEmpty();
    for (let sweep = 0; sweep < MAX_SWEEPS && prev > 0; sweep++) {
      const tasks: { columnId: string; fileIds: string[] }[] = [];
      for (const [colId, m] of stateMap.entries()) {
        const fids = Array.from(m.entries()).filter(([, s]) => s === 'error' || s === 'not_found').map(([f]) => f);
        if (fids.length) tasks.push({ columnId: colId, fileIds: fids });
      }
      if (!tasks.length) break;
      const queue = [...tasks];
      const worker = async () => { while (queue.length) { const t = queue.shift(); if (!t) continue; const res = await runColumn(t.columnId, t.fileIds); record(t.columnId, res, t.fileIds); } };
      await Promise.all(Array.from({ length: Math.min(6, tasks.length) }, worker));
      const now = countEmpty();
      if (now >= prev) break;
      prev = now;
    }
  }, [columns, runColumn]);

  const [standardizing, setStandardizing] = useState<Set<string>>(new Set());
  const anyStandardizing = standardizing.size > 0;

  const standardizeColumn = useCallback(async (columnId: string) => {
    if (!setId) return;
    setStandardizing((s) => new Set(s).add(columnId));
    try {
      const res = await fetch(TABULAR_STANDARDIZE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        body: JSON.stringify({ review_set_id: setId, column_id: columnId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) throw new Error(body?.error || `Standardize failed (${res.status})`);
      const changed = body?.changed ?? 0;
      toast.success(changed > 0 ? `Standardized ${changed} cell${changed === 1 ? '' : 's'}` : 'Values already consistent');
    } catch (e) {
      toast.error('Standardize failed', { description: (e as Error).message });
    } finally {
      setStandardizing((s) => { const n = new Set(s); n.delete(columnId); return n; });
      qc.invalidateQueries({ queryKey: ['review-cells', setId] });
    }
  }, [setId, qc]);

  const standardizeAll = useCallback(async () => {
    const eligible = columns.filter((c) => c.data_type === 'text' || c.data_type === 'list' || c.data_type === 'enum');
    if (!eligible.length) { toast.info('No text-like columns to standardize'); return; }
    const queue = [...eligible];
    const worker = async () => { while (queue.length) { const c = queue.shift(); if (c) await standardizeColumn(c.id); } };
    await Promise.all(Array.from({ length: Math.min(3, eligible.length) }, worker));
  }, [columns, standardizeColumn]);




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
  const errorCount = useMemo(() => cells.filter((c) => c.state === 'error').length, [cells]);
  const incompleteCount = useMemo(() => {
    let n = 0;
    for (const col of columns) for (const f of readyFiles) {
      const st = cellMap.get(`${f.id}:${col.id}`)?.state;
      if (!st || st === 'pending' || st === 'error' || st === 'not_found') n++;
    }
    return n;
  }, [columns, readyFiles, cellMap]);
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
          {files.length > 0 && (
            <>
              <TemplatesDialog onApply={(cols) => addColumns.mutate(cols)} />
              <AddColumnsDialog onAdd={(cols) => addColumns.mutate(cols)} />
            </>
          )}
          {columns.length > 0 && (
            <Button size="sm" className="gap-2" onClick={() => void runAll()} disabled={!canRun || anyRunning}>
              {anyRunning ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              Extract all
            </Button>
          )}
          {columns.length > 0 && incompleteCount > 0 && (
            <Button size="sm" variant="outline" className="gap-2" onClick={() => void runIncomplete()} disabled={!canRun || anyRunning}>
              <Play className="h-4 w-4" /> Extract incomplete ({incompleteCount})
            </Button>
          )}
          {errorCount > 0 && (
            <Button size="sm" variant="outline" className="gap-2" onClick={() => void retryFailed()} disabled={anyRunning}>
              <RefreshCw className="h-4 w-4" /> Retry failed ({errorCount})
            </Button>
          )}
          {columns.length > 0 && files.length > 0 && (
            <Button size="sm" variant="outline" className="gap-2" onClick={() => void standardizeAll()} disabled={anyRunning || anyStandardizing}>
              {anyStandardizing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Wand2 className="h-4 w-4" />} Standardize all
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
            <table className="w-full border-collapse text-[13px] table-fixed">
              <colgroup>
                <col style={{ width: colWidths[DOC_COL_KEY] ?? 260 }} />
                {columns.map((col) => (
                  <col key={col.id} style={{ width: colWidths[col.id] ?? 240 }} />
                ))}
                <col style={{ width: 190 }} />
              </colgroup>
              <thead>
                <tr className="bg-secondary/50">
                  <th className="relative sticky left-0 z-10 bg-secondary/50 text-left font-sans font-medium text-[11px] uppercase tracking-wider text-muted-foreground px-2.5 py-2 border-b border-r border-border">
                    Document
                    <div
                      onPointerDown={startResize(DOC_COL_KEY, 260)}
                      className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize select-none hover:bg-primary/40"
                    />
                  </th>
                  {columns.map((col) => (
                    <th key={col.id} className="relative text-left px-2.5 py-2 border-b border-r border-border align-top">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="font-sans font-semibold text-foreground break-words">{col.name}</div>
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
                            <DropdownMenuItem onClick={() => standardizeColumn(col.id)} disabled={anyRunning || standardizing.has(col.id)} className="gap-2">
                              <Wand2 className="h-3.5 w-3.5" /> Standardize values
                            </DropdownMenuItem>
                            <DropdownMenuItem onClick={() => deleteColumn.mutate(col.id)} className="gap-2 text-destructive">
                              <Trash2 className="h-3.5 w-3.5" /> Delete column
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </div>
                      <div
                        onPointerDown={startResize(col.id, 240)}
                        className="absolute top-0 right-0 h-full w-1.5 cursor-col-resize select-none hover:bg-primary/40"
                      />
                    </th>
                  ))}
                  <th className="px-2.5 py-2 border-b border-border align-middle">
                    <AddColumnDialog onAdd={(c) => addColumn.mutate(c)} />
                  </th>
                </tr>
              </thead>
              <tbody>
                {files.map((f) => (
                  <tr key={f.id} className="hover:bg-secondary/20">
                    <td className="sticky left-0 z-10 bg-card px-2.5 py-2 border-b border-r border-border align-top">
                      <DocCell file={f} onRemove={() => removeFile.mutate(f)} onRetry={() => ingest(f)} />
                    </td>
                    {columns.map((col) => {
                      const cell = cellMap.get(`${f.id}:${col.id}`);
                      const hasSource = !!cell && (cell.review_cell_citations?.length ?? 0) > 0;
                      return (
                        <td
                          key={col.id}
                          className={cn(
                            'px-2.5 py-2 border-b border-r border-border align-top',
                            hasSource && 'cursor-pointer hover:bg-accent/5',
                          )}
                          onClick={() => hasSource && openSource(f, cell)}
                        >
                          <div className="whitespace-normal break-words">
                            {f.status !== 'ready' ? (
                              <span className="text-muted-foreground/50">—</span>
                            ) : (
                              <CellView cell={cell} running={runningCols.has(col.id)} />
                            )}
                          </div>
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
  const skeleton = (
    <div className="space-y-1.5 py-0.5" aria-label="Extracting">
      <div className="h-2.5 rounded bg-muted animate-pulse" style={{ width: '85%' }} />
      <div className="h-2.5 rounded bg-muted animate-pulse" style={{ width: '55%' }} />
    </div>
  );
  if (running && (!cell || cell.state === 'pending' || cell.state === 'running')) return skeleton;
  if (!cell || cell.state === 'pending') return <span className="text-muted-foreground/40">·</span>;
  if (cell.state === 'running') return skeleton;
  if (cell.state === 'error') return <span className="inline-flex items-center gap-1 text-destructive text-[12px]" title={cell.error ?? ''}><XCircle className="h-3 w-3" /> Error</span>;
  if (cell.state === 'not_found') return <span className="text-muted-foreground/60 text-[12px] italic">Not found</span>;


  const cites = (cell.review_cell_citations ?? []).slice().sort((a, b) => (a.page_number ?? 0) - (b.page_number ?? 0));
  const needsReview = cell.state === 'needs_review';
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="text-left w-full group">
          <span className={cn('block font-serif leading-snug break-words line-clamp-4', needsReview ? 'text-amber-700' : 'text-foreground')}>
            {cell.value_text || <span className="text-muted-foreground/60 italic">—</span>}
          </span>

          <span className="mt-1 flex items-center gap-1.5 flex-wrap">
            {cell.confidence != null && cell.confidence < CONFIDENCE_LOW && (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-600" title={`Low confidence (${(cell.confidence * 100).toFixed(0)}%)`}>
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500 inline-block" />{(cell.confidence * 100).toFixed(0)}%
              </span>
            )}
            {needsReview && (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-600"><AlertTriangle className="h-2.5 w-2.5" /> review</span>
            )}
            {cites.length > 0 && (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-accent group-hover:underline">
                <Quote className="h-2.5 w-2.5" /> {cites.length === 1 && cites[0].page_number ? `p.${cites[0].page_number}` : `${cites.length} cites`}
              </span>
            )}
            {cell.value_original && cell.value_original !== cell.value_text && (
              <span className="inline-flex items-center gap-0.5 text-[10px] text-muted-foreground" title={`Normalized from: ${cell.value_original}`}>
                <Wand2 className="h-2.5 w-2.5" /> normalized
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

function TemplatesDialog({ onApply }: { onApply: (cols: TemplateColumn[]) => void }) {
  const [open, setOpen] = useState(false);
  const apply = (tpl: ReviewTemplate) => {
    onApply(tpl.columns);
    setOpen(false);
  };
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <LayoutTemplate className="h-4 w-4" /> Templates
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Column templates</DialogTitle>
          <DialogDescription>
            Preview a litigation column-pack and apply it in one click. Columns are added as pending — run Extract all when you are ready.
          </DialogDescription>
        </DialogHeader>
        <div className="overflow-y-auto -mx-6 px-6 space-y-3" style={{ maxHeight: '70vh' }}>
          {REVIEW_TEMPLATES.map((tpl) => (
            <div key={tpl.id} className="rounded-md border border-border p-4 bg-card/40">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <div className="font-serif text-base text-foreground">{tpl.name}</div>
                  <p className="text-[12px] text-muted-foreground mt-0.5">{tpl.description}</p>
                </div>
                <Button size="sm" onClick={() => apply(tpl)} className="gap-1.5 shrink-0">
                  <Sparkles className="h-3.5 w-3.5" /> Apply
                </Button>
              </div>
              <div className="mt-3 flex flex-wrap gap-1.5">
                {tpl.columns.map((c) => (
                  <span key={c.name} className="inline-flex items-center gap-1.5 rounded-sm border border-border bg-secondary/40 px-2 py-1 text-[11px]">
                    <span className="text-foreground">{c.name}</span>
                    <Badge variant="secondary" className="text-[9px] font-normal">{TYPE_LABELS[c.data_type]}</Badge>
                  </span>
                ))}
              </div>
            </div>
          ))}
        </div>
      </DialogContent>
    </Dialog>
  );
}

interface DraftRow {
  name: string;
  data_type: ReviewColumnType;
  prompt: string;
  enum_options_raw: string;
}

const emptyDraft = (): DraftRow => ({ name: '', data_type: 'text', prompt: '', enum_options_raw: '' });

function AddColumnsDialog({ onAdd }: { onAdd: (cols: TemplateColumn[]) => void }) {
  const [open, setOpen] = useState(false);
  const [rows, setRows] = useState<DraftRow[]>([emptyDraft()]);

  const reset = () => setRows([emptyDraft()]);
  const update = (i: number, patch: Partial<DraftRow>) =>
    setRows((r) => r.map((row, idx) => (idx === i ? { ...row, ...patch } : row)));
  const remove = (i: number) => setRows((r) => (r.length === 1 ? [emptyDraft()] : r.filter((_, idx) => idx !== i)));
  const addRow = () => setRows((r) => (r.length >= 30 ? r : [...r, emptyDraft()]));
  const appendPreset = (p: typeof COLUMN_PRESETS[number]) => {
    if (rows.length >= 30) return;
    const draft: DraftRow = {
      name: p.name,
      data_type: p.data_type,
      prompt: p.prompt,
      enum_options_raw: (p.enum ?? []).join(', '),
    };
    setRows((r) => {
      // Replace the first fully-empty row with the preset; otherwise append.
      const idx = r.findIndex((x) => !x.name.trim() && !x.prompt.trim());
      if (idx >= 0) return r.map((x, i) => (i === idx ? draft : x));
      return [...r, draft];
    });
  };

  const named = rows.filter((r) => r.name.trim());
  const canSubmit = named.length > 0;

  const submit = () => {
    const cols: TemplateColumn[] = named.map((r) => ({
      name: r.name.trim(),
      data_type: r.data_type,
      prompt: r.prompt.trim(),
      enum_options:
        r.data_type === 'enum'
          ? r.enum_options_raw.split(',').map((s) => s.trim()).filter(Boolean)
          : undefined,
    }));
    onAdd(cols);
    reset();
    setOpen(false);
  };

  return (
    <Dialog open={open} onOpenChange={(o) => { setOpen(o); if (!o) reset(); }}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Plus className="h-4 w-4" /> Add columns
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-3xl max-h-[85vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Add columns</DialogTitle>
          <DialogDescription>
            Define up to 30 columns at once. Columns are added as pending — run Extract all when you are ready.
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-wrap gap-1.5">
          {COLUMN_PRESETS.map((p) => (
            <button
              key={p.name}
              onClick={() => appendPreset(p)}
              disabled={rows.length >= 30}
              className="text-[11px] px-2 py-1 rounded-sm border border-border bg-secondary/50 hover:bg-secondary transition disabled:opacity-50"
            >
              + {p.name}
            </button>
          ))}
        </div>

        <div className="overflow-y-auto -mx-6 px-6 space-y-3" style={{ maxHeight: '55vh' }}>
          {rows.map((row, i) => (
            <div key={i} className="rounded-md border border-border p-3 bg-card/40 space-y-2">
              <div className="flex items-start gap-2">
                <div className="flex-1 grid grid-cols-1 sm:grid-cols-[1fr_10rem] gap-2">
                  <Input
                    value={row.name}
                    onChange={(e) => update(i, { name: e.target.value })}
                    placeholder={`Field name #${i + 1}`}
                  />
                  <Select value={row.data_type} onValueChange={(v) => update(i, { data_type: v as ReviewColumnType })}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>
                      {(Object.keys(TYPE_LABELS) as ReviewColumnType[]).map((t) => (
                        <SelectItem key={t} value={t}>{TYPE_LABELS[t]}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <button
                  onClick={() => remove(i)}
                  aria-label="Remove row"
                  className="p-1.5 text-muted-foreground hover:text-destructive shrink-0"
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </div>
              {row.data_type === 'enum' && (
                <Input
                  value={row.enum_options_raw}
                  onChange={(e) => update(i, { enum_options_raw: e.target.value })}
                  placeholder="Choices (comma-separated)"
                />
              )}
              <Textarea
                value={row.prompt}
                onChange={(e) => update(i, { prompt: e.target.value })}
                placeholder="Instruction (optional) — what exactly should be extracted?"
                className="min-h-[52px] text-[12px]"
              />
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between pt-2 border-t border-border">
          <div className="text-[11px] text-muted-foreground tabular-nums">{rows.length} / 30</div>
          <Button variant="outline" size="sm" onClick={addRow} disabled={rows.length >= 30} className="gap-1.5">
            <Plus className="h-3.5 w-3.5" /> Add row
          </Button>
        </div>

        <DialogFooter>
          <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!canSubmit} className="gap-2">
            <Plus className="h-4 w-4" /> Add {named.length || ''} column{named.length === 1 ? '' : 's'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

