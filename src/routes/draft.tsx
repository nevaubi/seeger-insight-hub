import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PenLine,
  Plus,
  Save,
  Trash2,
  FileText as FileTextIcon,
  Eye,
  Pencil,
  Sparkles,
  Wand2,
  Loader2,
  ChevronDown,
  CornerDownLeft,
  BookOpen,
  ExternalLink,
  ArrowDownToLine,
  Copy,
  Check,
  ShieldCheck,
  CheckCircle2,
  AlertTriangle,
  XCircle,
  X,
  Mail,
  ListChecks,
  CalendarClock,
  Gavel,
  Search,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { toast } from 'sonner';
import { AppShell, PageHeader } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Card } from '@/components/ui/card';
import { Switch } from '@/components/ui/switch';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog';
import {
  supabase,
  CITE_CHECK_ENDPOINT,
  SUPABASE_ANON_KEY,
  type WorkspaceDocument,
  type CiteCheckSummary,
  type CiteCheckResult,
  type CiteState,
} from '@/lib/supabase';
import { useMatter } from '@/lib/matter-context';
import { useAiAssist, type AiAssistCitation, type AiAssistChunk } from '@/lib/useAiAssist';
import { downloadDocx, printDocument, blocksToHtml, markdownToBlocks, downloadBlob, exportFilename } from '@/lib/file-export';
import { cn } from '@/lib/utils';

const docsQuery = (caseId: string) =>
  queryOptions({
    queryKey: ['workspace-docs', caseId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('workspace_documents')
        .select('*')
        .eq('case_id', caseId)
        .order('updated_at', { ascending: false });
      if (error) throw error;
      return (data ?? []) as WorkspaceDocument[];
    },
  });

export const Route = createFileRoute('/draft')({
  component: DraftPage,
  errorComponent: ({ error }) => (
    <AppShell><div className="p-8 text-sm text-destructive">Failed to load: {error.message}</div></AppShell>
  ),
  notFoundComponent: () => <AppShell><div className="p-8">Not found.</div></AppShell>,
});

// Quick inline-transform commands for a text selection.
const TRANSFORMS: { key: string; label: string; instruction: string }[] = [
  { key: 'improve', label: 'Improve', instruction: 'Improve the clarity, precision, and flow of this passage without changing its meaning.' },
  { key: 'formal', label: 'Formalize', instruction: 'Rewrite this passage in a more formal, polished litigation register.' },
  { key: 'concise', label: 'Shorten', instruction: 'Make this passage more concise while preserving every substantive point.' },
  { key: 'expand', label: 'Expand', instruction: 'Expand this passage with appropriate detail and supporting reasoning, matching the surrounding style.' },
];

type ChatMsg = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: AiAssistCitation[];
  chunks?: AiAssistChunk[];
  streaming?: boolean;
};

function DraftPage() {
  const { currentMatter } = useMatter();
  const caseId = currentMatter.master_case_id;
  const qc = useQueryClient();
  const { data: docs = [], isLoading } = useQuery(docsQuery(caseId));

  // ---- editor state ----
  const [activeId, setActiveId] = useState<string | null>(null);
  const [title, setTitle] = useState('Untitled document');
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [preview, setPreview] = useState(false);
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [transforming, setTransforming] = useState(false);
  const [citeResult, setCiteResult] = useState<CiteCheckSummary | null>(null);
  const [citeRunning, setCiteRunning] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [savedTick, setSavedTick] = useState(0);
  const [railOpen, setRailOpen] = useState(true);
  const [railQuery, setRailQuery] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const cursorRef = useRef<number>(0);

  const matterScope = useMemo(
    () => ({
      name: currentMatter.name,
      short_name: currentMatter.short_name,
      mdl_number: currentMatter.mdl_number,
      court: currentMatter.court,
      judge: currentMatter.judge,
    }),
    [currentMatter],
  );

  // Load the first document once available (or when the active one disappears).
  useEffect(() => {
    if (activeId && docs.some((d) => d.id === activeId)) return;
    if (docs.length) loadDoc(docs[0]);
    else { setActiveId(null); setTitle('Untitled document'); setContent(''); setDirty(false); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs]);

  const loadDoc = (d: WorkspaceDocument) => {
    setActiveId(d.id);
    setTitle(d.title);
    setContent(d.content);
    setDirty(false);
    setSelection(null);
  };

  // ---- mutations ----
  const createDoc = useMutation({
    mutationFn: async (doc: { title: string; content: string }) => {
      const { data, error } = await supabase
        .from('workspace_documents')
        .insert({ case_id: caseId, title: doc.title, content: doc.content })
        .select('*')
        .single();
      if (error) throw error;
      return data as WorkspaceDocument;
    },
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['workspace-docs', caseId] });
      loadDoc(d);
    },
    onError: (e: any) => toast.error(`Could not create document: ${e.message}`),
  });

  const saveDoc = useMutation({
    mutationFn: async () => {
      if (activeId) {
        const { data, error } = await supabase
          .from('workspace_documents')
          .update({ title, content })
          .eq('id', activeId)
          .select('*')
          .single();
        if (error) throw error;
        return data as WorkspaceDocument;
      }
      const { data, error } = await supabase
        .from('workspace_documents')
        .insert({ case_id: caseId, title, content })
        .select('*')
        .single();
      if (error) throw error;
      return data as WorkspaceDocument;
    },
    onSuccess: (d) => {
      setActiveId(d.id);
      setDirty(false);
      setLastSavedAt(Date.now());
      qc.invalidateQueries({ queryKey: ['workspace-docs', caseId] });
    },
    onError: (e: any) => toast.error(`Save failed: ${e.message}`),
  });

  const deleteDoc = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.from('workspace_documents').delete().eq('id', id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['workspace-docs', caseId] });
      toast.success('Document deleted');
    },
    onError: (e: any) => toast.error(`Delete failed: ${e.message}`),
  });

  const newDocument = () => {
    createDoc.mutate({ title: 'Untitled document', content: '' });
  };

  // ---- editor change tracking ----
  const onContentChange = (v: string) => { setContent(v); setDirty(true); };

  // ---- autosave (debounced) ----
  useEffect(() => {
    if (!dirty || !activeId || saveDoc.isPending) return;
    const t = setTimeout(() => { saveDoc.mutate(); }, 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, activeId, title, content]);

  // re-render every 15s so "Saved Xs ago" updates
  useEffect(() => {
    const id = setInterval(() => setSavedTick((n) => n + 1), 15000);
    return () => clearInterval(id);
  }, []);
  void savedTick;

  const syncSelection = () => {
    const el = textareaRef.current;
    if (!el) return;
    cursorRef.current = el.selectionStart;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (end > start) setSelection({ start, end });
    else setSelection(null);
  };

  // ---- inline transform of the current selection (streams into the editor) ----
  const { run: runAssist, running: assistRunning } = useAiAssist();

  const runTransform = async (instruction: string) => {
    const el = textareaRef.current;
    if (!el || !selection) return;
    const { start, end } = selection;
    const selected = content.slice(start, end);
    if (!selected.trim()) return;
    const before = content.slice(0, start);
    const after = content.slice(end);
    setTransforming(true);
    let acc = '';
    const result = await runAssist({
      mode: 'transform',
      instruction,
      selection: selected,
      document: content,
      caseId,
      matter: matterScope,
      onText: (delta) => {
        acc += delta;
        setContent(before + acc + after);
      },
    });
    setTransforming(false);
    setDirty(true);
    const finalText = (result?.text ?? acc).trim() || selected;
    setContent(before + finalText + after);
    // re-select the replaced range
    const newEnd = before.length + finalText.length;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(before.length, newEnd);
      setSelection({ start: before.length, end: newEnd });
    });
    if (result) toast.success('Selection updated');
  };

  // ---- cite-check (verify citations against CourtListener) ----
  const runCiteCheck = async () => {
    if (!content.trim() || citeRunning) return;
    setCiteRunning(true);
    try {
      const res = await fetch(CITE_CHECK_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ text: content }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) throw new Error(body?.error || `Cite-check failed (${res.status})`);
      const s = body as CiteCheckSummary;
      setCiteResult(s);
      const flagged = s.not_found + s.invalid;
      if (s.count === 0) toast.info('No case citations found in this draft');
      else if (flagged === 0 && s.ambiguous === 0) toast.success(`All ${s.count} citation${s.count === 1 ? '' : 's'} verified against CourtListener`);
      else toast.warning(`${flagged + s.ambiguous} of ${s.count} citation${s.count === 1 ? '' : 's'} need review`);
    } catch (e) {
      toast.error('Cite-check failed', { description: (e as Error).message });
    } finally {
      setCiteRunning(false);
    }
  };

  // ---- export ----
  const exportDocx = () => {
    downloadDocx(`${currentMatter.short_name}-${title}`.slice(0, 80), markdownToBlocks(content || `# ${title}`));
    toast.success('Exported to Word (.docx)');
  };
  const exportPdf = () => {
    const ok = printDocument({
      title: title || 'Document',
      metaLine: `<span class="matter">${currentMatter.short_name}</span> · MDL ${currentMatter.mdl_number}`,
      bodyHtml: blocksToHtml(markdownToBlocks(content || `# ${title}`)),
    });
    if (!ok) toast.error('Allow pop-ups to print / save as PDF');
  };
  const exportMarkdown = () => {
    downloadBlob(exportFilename(`${currentMatter.short_name}-${title}`, 'md'), new Blob([content], { type: 'text/markdown;charset=utf-8' }));
    toast.success('Exported Markdown (.md)');
  };

  // ---- insertion from chat ----
  const insertAtCursor = (text: string) => {
    const pos = Math.min(cursorRef.current, content.length);
    const next = content.slice(0, pos) + text + content.slice(pos);
    setContent(next);
    setDirty(true);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) { el.focus(); el.setSelectionRange(pos + text.length, pos + text.length); cursorRef.current = pos + text.length; }
    });
    toast.success('Inserted into document');
  };
  const appendToDoc = (text: string) => {
    const next = content ? `${content}\n\n${text}` : text;
    setContent(next);
    setDirty(true);
    toast.success('Appended to document');
  };

  const jumpToCite = (r: CiteCheckResult) => {
    if (preview) setPreview(false);
    const el = textareaRef.current;
    if (!el || r.start == null || r.end == null) return;
    requestAnimationFrame(() => {
      el.focus();
      el.setSelectionRange(r.start as number, r.end as number);
      setSelection({ start: r.start as number, end: r.end as number });
    });
  };

  const wordCount = useMemo(() => (content.trim() ? content.trim().split(/\s+/).length : 0), [content]);

  return (
    <AppShell>
      <PageHeader
        title="Drafting Workspace"
        description="Draft litigation documents with an AI assistant grounded in the matter's record — highlight any passage to refine it, or generate new sections by chat."
      >
        <div className="flex items-center gap-2">
          <DocumentMenu docs={docs} activeId={activeId} isLoading={isLoading} onPick={(d) => loadDoc(d)} onNew={newDocument} />
          <Button variant="default" size="sm" onClick={() => saveDoc.mutate()} disabled={saveDoc.isPending || (!dirty && !!activeId)} className="gap-2">
            {saveDoc.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Save className="h-4 w-4" />}
            Save{dirty ? ' •' : ''}
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2" disabled={!content.trim()}>
                <ArrowDownToLine className="h-4 w-4" /> Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={exportDocx} className="gap-2 cursor-pointer"><FileTextIcon className="h-4 w-4 text-[hsl(215_60%_40%)]" /> Word document (.docx)</DropdownMenuItem>
              <DropdownMenuItem onClick={exportPdf} className="gap-2 cursor-pointer"><FileTextIcon className="h-4 w-4 text-muted-foreground" /> Print / Save as PDF</DropdownMenuItem>
              <DropdownMenuItem onClick={exportMarkdown} className="gap-2 cursor-pointer"><FileTextIcon className="h-4 w-4 text-muted-foreground" /> Markdown (.md)</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          {activeId && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline" size="sm" className="gap-2 text-destructive hover:text-destructive"><Trash2 className="h-4 w-4" /></Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Delete this document?</AlertDialogTitle>
                  <AlertDialogDescription>“{title}” will be permanently removed. This cannot be undone.</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={() => activeId && deleteDoc.mutate(activeId)} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">Delete</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </PageHeader>

      <div className="px-6 lg:px-8 py-5 lg:h-[calc(100vh-9.5rem)] lg:flex lg:gap-5 lg:overflow-hidden">
        {/* EDITOR */}
        <div className="lg:flex-[3] min-w-0 flex flex-col mb-5 lg:mb-0">
          <Card className="p-0 flex flex-col flex-1 overflow-hidden">
            {/* editor toolbar */}
            <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border bg-card/60">
              <Input
                value={title}
                onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
                placeholder="Document title…"
                className="h-8 border-0 shadow-none px-0 font-serif text-base font-semibold focus-visible:ring-0 bg-transparent"
              />
              <div className="ml-auto flex items-center gap-1.5 shrink-0">
                <span className="text-[11px] text-muted-foreground tabular-nums font-sans mr-1">{wordCount} words</span>
                <Button
                  variant="outline"
                  size="sm"
                  className="h-7 gap-1.5 text-xs"
                  disabled={!content.trim() || citeRunning}
                  onClick={runCiteCheck}
                  title="Verify the case citations in this draft against CourtListener"
                >
                  {citeRunning ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldCheck className="h-3.5 w-3.5" />}
                  Cite-check
                </Button>
                <div className="w-px h-5 bg-border mx-0.5" />
                <Button variant={preview ? 'ghost' : 'secondary'} size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setPreview(false)}>
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </Button>
                <Button variant={preview ? 'secondary' : 'ghost'} size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setPreview(true)}>
                  <Eye className="h-3.5 w-3.5" /> Preview
                </Button>
              </div>
            </div>

            {/* selection transform bar */}
            {!preview && (
              <div className={cn(
                'flex items-center gap-1.5 px-4 py-2 border-b border-border bg-secondary/40 transition-opacity',
                selection ? 'opacity-100' : 'opacity-50',
              )}>
                <Wand2 className="h-3.5 w-3.5 text-accent shrink-0" />
                <span className="text-[11px] text-muted-foreground font-sans mr-1 shrink-0">
                  {selection ? `${selection.end - selection.start} chars selected` : 'Select text to refine'}
                </span>
                {TRANSFORMS.map((t) => (
                  <Button key={t.key} variant="outline" size="sm" className="h-6 px-2 text-[11px]" disabled={!selection || transforming} onClick={() => runTransform(t.instruction)}>
                    {t.label}
                  </Button>
                ))}
                <CustomTransform disabled={!selection || transforming} onRun={(instr) => runTransform(instr)} />
                {transforming && <Loader2 className="h-3.5 w-3.5 animate-spin text-accent ml-1" />}
              </div>
            )}

            {/* editor body */}
            <div className="flex-1 overflow-y-auto">
              {preview ? (
                <div className="answer-prose max-w-[72ch] mx-auto px-6 py-6 font-serif">
                  {content.trim() ? (
                    <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
                  ) : (
                    <p className="text-sm text-muted-foreground italic">Nothing to preview yet.</p>
                  )}
                </div>
              ) : (
                <Textarea
                  ref={textareaRef}
                  value={content}
                  onChange={(e) => onContentChange(e.target.value)}
                  onSelect={syncSelection}
                  onKeyUp={syncSelection}
                  onClick={syncSelection}
                  placeholder="Start writing, or ask the assistant to draft a section for you…"
                  className="w-full h-full min-h-[50vh] resize-none border-0 shadow-none focus-visible:ring-0 rounded-none font-serif text-[15px] leading-[1.7] px-6 py-5 bg-transparent"
                  spellCheck
                />
              )}
            </div>

            {citeResult && (
              <CiteCheckPanel
                summary={citeResult}
                onClose={() => setCiteResult(null)}
                onJump={jumpToCite}
              />
            )}
          </Card>
        </div>

        {/* ASSISTANT */}
        <AssistantPane
          caseId={caseId}
          matter={matterScope}
          documentText={content}
          onInsert={insertAtCursor}
          onAppend={appendToDoc}
        />
      </div>
    </AppShell>
  );
}

const CITE_STATE_META: Record<CiteState, { label: string; cls: string; Icon: typeof CheckCircle2 }> = {
  valid: { label: 'Verified', cls: 'text-emerald-600', Icon: CheckCircle2 },
  not_found: { label: 'Not found', cls: 'text-destructive', Icon: XCircle },
  invalid: { label: 'Invalid', cls: 'text-destructive', Icon: XCircle },
  ambiguous: { label: 'Ambiguous', cls: 'text-amber-600', Icon: AlertTriangle },
  error: { label: 'Unverified', cls: 'text-muted-foreground', Icon: AlertTriangle },
};

function CiteCheckPanel({
  summary,
  onClose,
  onJump,
}: {
  summary: CiteCheckSummary;
  onClose: () => void;
  onJump: (r: CiteCheckResult) => void;
}) {
  const flagged = summary.not_found + summary.invalid;
  return (
    <div className="border-t border-border bg-card/70 max-h-[38vh] flex flex-col">
      <div className="flex items-center gap-3 px-4 py-2 border-b border-border/70 shrink-0">
        <ShieldCheck className="h-4 w-4 text-accent shrink-0" />
        <span className="text-[12px] font-sans font-medium text-foreground">Citation check</span>
        <div className="flex items-center gap-2.5 text-[11px] font-sans tabular-nums">
          {summary.count === 0 ? (
            <span className="text-muted-foreground">No case citations detected</span>
          ) : (
            <>
              <span className="inline-flex items-center gap-1 text-emerald-600">
                <CheckCircle2 className="h-3 w-3" /> {summary.valid} verified
              </span>
              {flagged > 0 && (
                <span className="inline-flex items-center gap-1 text-destructive">
                  <XCircle className="h-3 w-3" /> {flagged} not found
                </span>
              )}
              {summary.ambiguous > 0 && (
                <span className="inline-flex items-center gap-1 text-amber-600">
                  <AlertTriangle className="h-3 w-3" /> {summary.ambiguous} ambiguous
                </span>
              )}
            </>
          )}
        </div>
        <span className="ml-auto text-[10px] text-muted-foreground hidden sm:inline">
          via CourtListener{summary.truncated ? ' · checked first part of a long draft' : ''}
        </span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close citation check"
          className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-secondary transition"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {summary.count > 0 && (
        <div className="overflow-y-auto px-2 py-2 space-y-1">
          {summary.results.map((r, i) => {
            const meta = CITE_STATE_META[r.state] ?? CITE_STATE_META.error;
            const Icon = meta.Icon;
            const jumpable = r.start != null && r.end != null;
            return (
              <div
                key={i}
                className={cn(
                  'flex items-start gap-2.5 rounded-sm px-2.5 py-2 text-[12px]',
                  jumpable && 'cursor-pointer hover:bg-secondary/60',
                )}
                onClick={() => jumpable && onJump(r)}
                title={jumpable ? 'Jump to this citation in the draft' : undefined}
              >
                <Icon className={cn('h-3.5 w-3.5 mt-0.5 shrink-0', meta.cls)} />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-sans font-medium text-foreground tabular-nums">{r.citation ?? '—'}</span>
                    <span className={cn('text-[10px] uppercase tracking-wide font-medium', meta.cls)}>{meta.label}</span>
                  </div>
                  {r.state === 'valid' && r.case_name && (
                    <div className="mt-0.5 text-muted-foreground font-serif">
                      {r.case_name}
                      {r.year ? ` (${r.year})` : ''}
                      {r.citation_count != null ? ` · cited ${r.citation_count}×` : ''}
                    </div>
                  )}
                  {r.state === 'ambiguous' && (
                    <div className="mt-0.5 text-muted-foreground">
                      Matches {r.match_count} cases — disambiguate before relying on it.
                    </div>
                  )}
                  {(r.state === 'not_found' || r.state === 'invalid') && (
                    <div className="mt-0.5 text-muted-foreground">
                      {r.message || 'No matching opinion on CourtListener — verify this citation is real and correctly formatted.'}
                    </div>
                  )}
                  {r.url && (
                    <a
                      href={r.url}
                      target="_blank"
                      rel="noreferrer"
                      onClick={(e) => e.stopPropagation()}
                      className="mt-1 inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" /> View on CourtListener
                    </a>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function DocumentMenu({
  docs, activeId, isLoading, onPick, onNew,
}: {
  docs: WorkspaceDocument[];
  activeId: string | null;
  isLoading: boolean;
  onPick: (d: WorkspaceDocument) => void;
  onNew: () => void;
}) {
  const active = docs.find((d) => d.id === activeId);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2 max-w-[260px]">
          <FileTextIcon className="h-4 w-4 shrink-0" />
          <span className="truncate">{active?.title ?? 'Documents'}</span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 opacity-60" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72">
        <DropdownMenuItem onClick={onNew} className="gap-2 cursor-pointer font-medium">
          <Plus className="h-4 w-4" /> New document
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuLabel className="text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground font-sans">
          {isLoading ? 'Loading…' : `${docs.length} document${docs.length === 1 ? '' : 's'}`}
        </DropdownMenuLabel>
        <div className="max-h-72 overflow-y-auto">
          {docs.map((d) => (
            <DropdownMenuItem key={d.id} onClick={() => onPick(d)} className={cn('flex flex-col items-start gap-0.5 cursor-pointer', d.id === activeId && 'bg-secondary')}>
              <span className="truncate w-full font-medium">{d.title || 'Untitled document'}</span>
              <span className="text-[10.5px] text-muted-foreground tabular-nums font-sans">
                {new Date(d.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
              </span>
            </DropdownMenuItem>
          ))}
          {!isLoading && docs.length === 0 && (
            <div className="px-2 py-3 text-xs text-muted-foreground">No documents yet — create one.</div>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function CustomTransform({ disabled, onRun }: { disabled: boolean; onRun: (instruction: string) => void }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="h-6 px-2 text-[11px] gap-1" disabled={disabled}>
          <Sparkles className="h-3 w-3" /> Custom
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 p-2">
        <div className="text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground font-sans mb-1.5 px-1">Custom instruction</div>
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. Rewrite this in the third person and cite the controlling order"
          className="text-[13px] min-h-[72px] resize-none"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && text.trim()) {
              e.preventDefault();
              onRun(text.trim());
              setText('');
              setOpen(false);
            }
          }}
        />
        <div className="flex justify-end mt-2">
          <Button size="sm" className="h-7 gap-1.5 text-xs" disabled={!text.trim()} onClick={() => { onRun(text.trim()); setText(''); setOpen(false); }}>
            Apply <CornerDownLeft className="h-3 w-3" />
          </Button>
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

const DRAFT_TEMPLATES: { icon: typeof Mail; title: string; prompt: string }[] = [
  {
    icon: Mail,
    title: 'Meet-and-confer letter',
    prompt: 'Draft a meet-and-confer letter to opposing counsel addressing outstanding discovery deficiencies, citing the controlling discovery order.',
  },
  {
    icon: ListChecks,
    title: 'Status-conference agenda',
    prompt: 'Outline an agenda for the next status conference, organized by open issues, pending motions, and upcoming deadlines.',
  },
  {
    icon: CalendarClock,
    title: 'Deadline & obligations summary',
    prompt: "Summarize the upcoming deadlines and each party's obligations under the operative case management order.",
  },
  {
    icon: Gavel,
    title: 'Motion-to-compel outline',
    prompt: 'Draft an outline for a motion to compel discovery, with argument headings and the governing legal standard.',
  },
];

function AssistantPane({
  caseId, matter, documentText, onInsert, onAppend,
}: {
  caseId: string;
  matter: { name: string; short_name: string; mdl_number: string; court: string; judge: string };
  documentText: string;
  onInsert: (text: string) => void;
  onAppend: (text: string) => void;
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [ground, setGround] = useState(true);
  const { run, running } = useAiAssist();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const idRef = useRef(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = async (override?: string) => {
    const text = (override ?? input).trim();
    if (!text || running) return;
    if (!override) setInput('');
    const userMsg: ChatMsg = { id: `u${idRef.current++}`, role: 'user', content: text };
    const asstId = `a${idRef.current++}`;
    const history = messages.map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, userMsg, { id: asstId, role: 'assistant', content: '', streaming: true }]);

    const result = await run({
      mode: 'draft',
      instruction: text,
      document: documentText,
      messages: history,
      ground,
      caseId,
      matter,
      onText: (delta) => {
        setMessages((m) => m.map((msg) => (msg.id === asstId ? { ...msg, content: msg.content + delta } : msg)));
      },
    });

    setMessages((m) => m.map((msg) => (msg.id === asstId
      ? { ...msg, streaming: false, content: result?.text ?? msg.content, citations: result?.citations, chunks: result?.chunks }
      : msg)));
  };

  return (
    <div className="lg:flex-[2] min-w-0 lg:max-w-[440px] flex flex-col">
      <Card className="p-0 flex flex-col flex-1 overflow-hidden">
        <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-card/60">
          <PenLine className="h-4 w-4 text-accent" />
          <span className="text-sm font-medium">Drafting assistant</span>
          <label className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground font-sans cursor-pointer">
            <BookOpen className="h-3.5 w-3.5" /> Ground in record
            <Switch checked={ground} onCheckedChange={setGround} />
          </label>
        </div>

        <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4 min-h-[40vh]">
          {messages.length === 0 && (
            <div className="py-8 px-2">
              <div className="text-center text-sm text-muted-foreground mb-5">
                <Sparkles className="h-5 w-5 mx-auto mb-3 text-accent/70" />
                <p className="font-serif text-[15px] text-foreground/80 mb-2">Ask the assistant to draft for you.</p>
                <p className="text-xs leading-relaxed">
                  Start from a template below, or describe what you need. With grounding on, factual
                  claims are cited to the controlling orders.
                </p>
              </div>
              <div className="grid grid-cols-2 gap-2">
                {DRAFT_TEMPLATES.map((t) => {
                  const Icon = t.icon;
                  return (
                    <button
                      key={t.title}
                      type="button"
                      onClick={() => send(t.prompt)}
                      disabled={running}
                      title={t.prompt}
                      className="group flex items-start gap-2 rounded-md border border-border bg-card px-3 py-2.5 text-left transition hover:border-accent/50 hover:bg-accent/5 disabled:opacity-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/40"
                    >
                      <Icon className="h-4 w-4 text-accent shrink-0 mt-0.5" strokeWidth={1.75} />
                      <span className="text-[12px] font-sans font-medium text-foreground/90 leading-snug">{t.title}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          )}
          {messages.map((m) => (
            <ChatBubble key={m.id} msg={m} onInsert={onInsert} onAppend={onAppend} />
          ))}
        </div>

        <div className="border-t border-border p-3">
          <div className="relative">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
              }}
              placeholder="Ask the assistant to draft or revise…"
              className="resize-none min-h-[72px] pr-12 text-[14px]"
              disabled={running}
            />
            <Button size="sm" className="absolute bottom-2 right-2 h-8 w-8 p-0" disabled={!input.trim() || running} onClick={() => send()}>
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <CornerDownLeft className="h-4 w-4" />}
            </Button>
          </div>
          <div className="text-[10.5px] text-muted-foreground mt-1.5 px-1 font-sans">
            Enter to send · Shift+Enter for a new line{ground ? ' · grounded in the record' : ''}
          </div>
        </div>
      </Card>
    </div>
  );
}

function ChatBubble({ msg, onInsert, onAppend }: { msg: ChatMsg; onInsert: (t: string) => void; onAppend: (t: string) => void }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    navigator.clipboard?.writeText(msg.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  if (msg.role === 'user') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[88%] rounded-2xl rounded-br-sm bg-primary text-primary-foreground px-3.5 py-2 text-[14px] leading-relaxed">
          {msg.content}
        </div>
      </div>
    );
  }

  const sources = dedupeSources(msg.chunks, msg.citations);
  return (
    <div className="space-y-2">
      <div className="rounded-2xl rounded-bl-sm bg-secondary/50 border border-border px-3.5 py-2.5">
        <div className="answer-prose text-[14px] leading-[1.65] font-serif">
          {msg.content ? (
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
          ) : msg.streaming ? (
            <span className="text-muted-foreground inline-flex items-center gap-2"><Loader2 className="h-3.5 w-3.5 animate-spin" /> Drafting…</span>
          ) : null}
          {msg.streaming && msg.content && <span className="motion-stream-caret" aria-hidden />}
        </div>

        {sources.length > 0 && (
          <div className="mt-2.5 pt-2 border-t border-border/60">
            <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground font-sans mb-1">Sources</div>
            <div className="flex flex-wrap gap-1.5">
              {sources.map((s, i) => (
                s.pdf_url ? (
                  <a key={i} href={s.pdf_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[11px] px-1.5 py-0.5 rounded border border-border bg-card hover:border-accent/50 text-foreground/80">
                    {s.label}<ExternalLink className="h-2.5 w-2.5" />
                  </a>
                ) : (
                  <span key={i} className="text-[11px] px-1.5 py-0.5 rounded border border-border bg-card text-foreground/80">{s.label}</span>
                )
              ))}
            </div>
          </div>
        )}
      </div>

      {!msg.streaming && msg.content && (
        <div className="flex items-center gap-1.5 px-1">
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px] gap-1" onClick={() => onInsert(msg.content)}>
            <ArrowDownToLine className="h-3 w-3" /> Insert
          </Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px] gap-1" onClick={() => onAppend(msg.content)}>
            <Plus className="h-3 w-3" /> Append
          </Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px] gap-1" onClick={copy}>
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      )}
    </div>
  );
}

function dedupeSources(chunks?: AiAssistChunk[], citations?: AiAssistCitation[]): { label: string; pdf_url: string | null }[] {
  const out: { label: string; pdf_url: string | null }[] = [];
  const seen = new Set<string>();
  // Prefer the actually-cited passages; fall back to grounding chunks.
  const fromCites = (citations ?? []).map((c) => ({ label: [c.order_label, c.page].filter(Boolean).join(' · ') || c.title || 'Source', pdf_url: null as string | null, ref: c.ref }));
  const byRef = new Map((chunks ?? []).map((c) => [c.ref, c]));
  for (const c of fromCites) {
    const chunk = c.ref ? byRef.get(c.ref) : undefined;
    const label = c.label;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ label, pdf_url: chunk?.pdf_url ?? null });
  }
  return out.slice(0, 8);
}
