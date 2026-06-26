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
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setRailOpen((v) => !v)}
            className="gap-1.5 hidden lg:inline-flex"
            title={railOpen ? 'Hide document list' : 'Show document list'}
          >
            {railOpen ? <PanelLeftClose className="h-4 w-4" /> : <PanelLeftOpen className="h-4 w-4" />}
          </Button>
          <div className="lg:hidden">
            <DocumentMenu docs={docs} activeId={activeId} isLoading={isLoading} onPick={(d) => loadDoc(d)} onNew={newDocument} />
          </div>
          <SaveStatus
            dirty={dirty}
            saving={saveDoc.isPending}
            lastSavedAt={lastSavedAt}
            hasActive={!!activeId}
            onSave={() => saveDoc.mutate()}
          />

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
        {/* DOCUMENT RAIL */}
        {railOpen && (
          <DocumentRail
            docs={docs}
            activeId={activeId}
            isLoading={isLoading}
            query={railQuery}
            setQuery={setRailQuery}
            onPick={loadDoc}
            onNew={newDocument}
          />
        )}
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

type DraftTemplate = {
  category: 'Correspondence' | 'Motions & Briefs' | 'Discovery' | 'Case Management' | 'Hearing Prep' | 'Leadership / PSC';
  icon: typeof Mail;
  title: string;
  docType: string;
  summary: string;
  prompt: string;
};

const DRAFT_TEMPLATES: DraftTemplate[] = [
  // ---------- Correspondence ----------
  {
    category: 'Correspondence', icon: Mail, title: 'Meet-and-confer letter', docType: 'Letter',
    summary: 'Discovery deficiencies, numbered, tied to the controlling order.',
    prompt: 'Draft a meet-and-confer letter from Seeger Weiss LLP to defense liaison counsel addressing outstanding discovery deficiencies. Use full letter form: date line, addressee block, "Re: In re Depo-Provera Prods. Liab. Litig., MDL No. 3140 — Outstanding Discovery Deficiencies" line, salutation, body organized as numbered deficiency items each citing the controlling discovery order and the specific request at issue, a proposal of meet-and-confer times within the next seven days, and a closing signature block for [ATTORNEY NAME], Seeger Weiss LLP. Reserve all rights. Insert [BRACKETED ALL-CAPS] placeholders for any fact not in the record.',
  },
  {
    category: 'Correspondence', icon: Mail, title: 'Rule 26(f) follow-up letter', docType: 'Letter',
    summary: 'Memorialize 26(f) topics and open items for joint report.',
    prompt: 'Draft a Rule 26(f) follow-up letter from Seeger Weiss LLP to defense liaison counsel memorializing the parties\' discussion of the Fed. R. Civ. P. 26(f) topics. Letter form with caption "Re:" line referencing MDL No. 3140. Numbered sections: initial disclosures, ESI protocol status, protective order, discovery sequencing, anticipated motion practice, and proposed deadlines for the joint Rule 26(f) report. Flag points of disagreement neutrally. Signature block with [ATTORNEY NAME].',
  },
  {
    category: 'Correspondence', icon: Mail, title: 'Letter to Magistrate Cannon', docType: 'Letter',
    summary: 'Pre-motion discovery dispute letter per the operative procedure.',
    prompt: 'Draft a pre-motion discovery dispute letter to Magistrate Judge Hope T. Cannon following the procedure set out in the operative discovery management order. Brief letter form: date, "The Honorable Hope T. Cannon, United States Magistrate Judge, United States District Court, Northern District of Florida, Pensacola Division", "Re: In re Depo-Provera Prods. Liab. Litig., MDL No. 3140 — [SUBJECT]", salutation, three to four short numbered paragraphs stating (1) the dispute, (2) what plaintiffs sought and when, (3) defendants\' position and the parties\' meet-and-confer efforts, and (4) the limited relief requested. Cite the controlling order. Sign-off "Respectfully submitted," with [ATTORNEY NAME], Seeger Weiss LLP, on behalf of Plaintiffs\' co-lead counsel.',
  },
  {
    category: 'Correspondence', icon: Mail, title: 'Litigation-hold reminder', docType: 'Notice',
    summary: 'Refresher hold to client group, scoped to known custodians.',
    prompt: 'Draft a litigation-hold reminder memorandum from Seeger Weiss LLP to participating plaintiffs\' counsel and named-plaintiff clients. Memorandum form (TO / FROM / DATE / RE), referencing In re Depo-Provera Prods. Liab. Litig., MDL No. 3140. Sections: scope of duty to preserve, categories of materials to preserve (medical records, prescription history, communications with prescribers, social media, device data), preservation steps, prohibition on auto-deletion, and contact for questions. Place [BRACKETED ALL-CAPS] placeholders where facts vary by client.',
  },

  // ---------- Motions & Briefs ----------
  {
    category: 'Motions & Briefs', icon: Gavel, title: 'Motion to compel — outline', docType: 'Motion',
    summary: 'Argument headings, governing standard, and proposed relief.',
    prompt: 'Draft a detailed outline for Plaintiffs\' Motion to Compel Discovery. Begin with the full court caption (UNITED STATES DISTRICT COURT, NORTHERN DISTRICT OF FLORIDA, PENSACOLA DIVISION; In re Depo-Provera caption; MDL No. 3140; Judge Rodgers; Magistrate Judge Cannon). Title: "PLAINTIFFS\' MOTION TO COMPEL DISCOVERY". Sections: Introduction; Background (meet-and-confer history, pin-cited to letters); Legal Standard (Fed. R. Civ. P. 26(b)(1), 37(a), Eleventh Circuit authority); Argument with numbered headings (I., II., A., B.) addressing each disputed request; Conclusion / Proposed Relief; signature block for Plaintiffs\' Co-Lead Counsel; Certificate of Service. Use [BRACKETED ALL-CAPS] placeholders for case-specific facts.',
  },
  {
    category: 'Motions & Briefs', icon: Gavel, title: 'Daubert / Rule 702 response section', docType: 'Brief Section',
    summary: 'General-causation expert defense, ties to the gating hearing.',
    prompt: 'Draft a brief section responding to a Rule 702 / Daubert challenge to Plaintiffs\' general-causation expert(s) on the meningioma–medroxyprogesterone acetate association. No caption — produce the brief section only, suitable for insertion into a larger opposition. Numbered headings (I. Legal Standard; II. Dr. [EXPERT NAME]\'s Methodology Satisfies Rule 702; A. Reliability; B. Fit; III. Defendants\' Critiques Go to Weight, Not Admissibility). Cite Daubert, Kumho Tire, the 2023 amendments to Rule 702, and Eleventh Circuit authority (e.g., Chapman v. Procter & Gamble, McClain v. Metabolife). Use [BRACKETED ALL-CAPS] for expert names, study citations, and record pin cites.',
  },
  {
    category: 'Motions & Briefs', icon: Gavel, title: 'Opposition to motion to quash', docType: 'Brief',
    summary: 'Third-party subpoena defense; relevance and proportionality.',
    prompt: 'Draft an opposition brief responding to a non-party\'s motion to quash a Rule 45 subpoena duces tecum issued by Plaintiffs. Full caption (MDL No. 3140, Judge Rodgers, Magistrate Cannon). Title: "PLAINTIFFS\' OPPOSITION TO [NON-PARTY]\'S MOTION TO QUASH". Sections: Introduction; Factual Background (the subpoena and meet-and-confer); Legal Standard (Fed. R. Civ. P. 45(d), 26(b)(1)); Argument (relevance to general causation, proportionality, narrow tailoring, no undue burden, willingness to negotiate protective terms); Conclusion; signature block; Certificate of Service. Insert [BRACKETED ALL-CAPS] placeholders for the non-party identity and document categories.',
  },
  {
    category: 'Motions & Briefs', icon: Gavel, title: 'Motion to seal under PO', docType: 'Motion',
    summary: 'Narrow sealing request tied to the operative confidentiality order.',
    prompt: 'Draft an unopposed motion to file under seal pursuant to the operative Confidentiality / Protective Order in In re Depo-Provera Prods. Liab. Litig., MDL No. 3140. Full caption. Title: "UNOPPOSED MOTION TO FILE UNDER SEAL". Sections: Introduction (one paragraph identifying the document and the protective-order designation), Legal Standard (Eleventh Circuit common-law right of access; *Chicago Tribune Co. v. Bridgestone/Firestone, Inc.* test), Argument (narrow tailoring, redactions considered, defendants\' designation), Conclusion / Proposed Order. Signature block; proposed order paragraphs in a separate section labeled "[PROPOSED] ORDER". Insert [BRACKETED ALL-CAPS] placeholders.',
  },

  // ---------- Discovery ----------
  {
    category: 'Discovery', icon: FileSignature, title: "Plaintiffs' First RFPs", docType: 'Discovery Request',
    summary: 'Numbered RFPs with definitions and instructions block.',
    prompt: 'Draft Plaintiffs\' First Set of Requests for Production to Defendants in In re Depo-Provera Prods. Liab. Litig., MDL No. 3140. Full caption. Title: "PLAINTIFFS\' FIRST SET OF REQUESTS FOR PRODUCTION TO DEFENDANTS". Sections: I. Definitions (Plaintiffs, Defendants, Depo-Provera, Document, Communication, Concerning, Relevant Time Period, etc.); II. Instructions (incorporate Fed. R. Civ. P. 26 and 34 and the operative ESI protocol); III. Requests (numbered RFP No. 1–[N] on topics including general-causation research, pharmacovigilance signals on meningioma, label change history, FDA correspondence, internal risk assessments). Signature block. Each request on one substantive item.',
  },
  {
    category: 'Discovery', icon: FileSignature, title: 'Subpoena duces tecum (non-party)', docType: 'Subpoena',
    summary: 'Rule 45 schedule of documents to produce.',
    prompt: 'Draft Schedule A to a Fed. R. Civ. P. 45 subpoena duces tecum to a non-party in connection with In re Depo-Provera Prods. Liab. Litig., MDL No. 3140. Sections: I. Definitions; II. Instructions; III. Documents to be Produced (numbered categories, each scoped narrowly to a defined relevant time period and subject). Note that the subpoena form itself is the AO 88B and need not be reproduced; produce Schedule A only. Use [BRACKETED ALL-CAPS] placeholders for the non-party name and subject matter.',
  },
  {
    category: 'Discovery', icon: FileSignature, title: 'ESI protocol stipulation', docType: 'Stipulation',
    summary: 'Skeleton ESI protocol tracking the operative CMO.',
    prompt: 'Draft a stipulated ESI protocol for In re Depo-Provera Prods. Liab. Litig., MDL No. 3140, tracking the operative case management order. Full caption. Title: "STIPULATED ORDER GOVERNING THE PRODUCTION OF ELECTRONICALLY STORED INFORMATION". Numbered sections: 1. Cooperation; 2. Scope; 3. Custodians and Sources; 4. Search Methodology (TAR / search terms / negotiation); 5. Production Format (TIFF + load file, native for spreadsheets/presentations, color-as-kept); 6. Metadata Fields (table); 7. De-Duplication and Email Threading; 8. Privilege (logging, FRE 502(d)); 9. Hyperlinked / Modern Attachments; 10. Disputes (meet-and-confer, then to Magistrate Judge Cannon); 11. Modification. Signature lines for both sides and "SO ORDERED" line for Magistrate Judge Cannon.',
  },

  // ---------- Case Management ----------
  {
    category: 'Case Management', icon: ListChecks, title: 'Joint status report', docType: 'Status Report',
    summary: 'Pre-CMC report to Judge Rodgers on open items.',
    prompt: 'Draft a Joint Status Report to The Honorable M. Casey Rodgers in advance of the next status conference in In re Depo-Provera Prods. Liab. Litig., MDL No. 3140. Full caption. Title: "JOINT STATUS REPORT". Numbered sections: I. Case Inventory (transfers, direct filings, anticipated tag-alongs); II. Plaintiff Fact Sheets / Threshold Proof Compliance; III. Defendant Fact Sheets; IV. Document Discovery (status by custodian, hit-report progress); V. Deposition Schedule; VI. Expert Discovery / Daubert; VII. Bellwether Process; VIII. Pending Motions; IX. Proposed Agenda Items. Use a neutral joint voice; insert "Plaintiffs\' Position:" / "Defendants\' Position:" subheadings where the parties disagree. Dual signature block.',
  },
  {
    category: 'Case Management', icon: ListChecks, title: 'Proposed PTO/CMO', docType: 'Proposed Order',
    summary: 'Caption + IT IS ORDERED numbered paragraphs.',
    prompt: 'Draft a proposed Pretrial / Case Management Order for In re Depo-Provera Prods. Liab. Litig., MDL No. 3140. Full caption. Title: "PRETRIAL ORDER NO. [XX]: [SHORT SUBJECT]". One-paragraph recital noting the Court\'s consideration of the parties\' submissions and conference, then "Accordingly, IT IS ORDERED that:" followed by numbered operative paragraphs (1., 2., 3.) each stating a single obligation, deadline, or procedure. Close with "DONE AND ORDERED in Chambers in Pensacola, Florida, this [DATE]." and a signature line for "M. CASEY RODGERS, UNITED STATES DISTRICT JUDGE". Insert [BRACKETED ALL-CAPS] placeholders for fact-specific terms.',
  },
  {
    category: 'Case Management', icon: CalendarClock, title: 'Status-conference agenda', docType: 'Agenda',
    summary: 'PSC-facing internal agenda for the next status conference.',
    prompt: 'Draft an internal status-conference agenda for the Plaintiffs\' Steering Committee in advance of the next conference before Judge Rodgers in In re Depo-Provera Prods. Liab. Litig., MDL No. 3140. Memorandum-style header (TO: PSC; FROM: Co-Lead Counsel; DATE: [INSERT DATE]; RE: Status Conference Agenda). Numbered agenda items grouped under headings: I. Case Inventory; II. Discovery; III. Expert / Daubert; IV. Bellwether Process; V. Pending Motions; VI. Scheduling; VII. Common-Benefit Administration. Under each item, brief bullets for talking points and the proposed speaker. Insert [BRACKETED ALL-CAPS] placeholders.',
  },
  {
    category: 'Case Management', icon: CalendarClock, title: 'Deadline & obligations summary', docType: 'Memo',
    summary: 'Tabular summary of upcoming dates from the operative CMO.',
    prompt: 'Draft a memorandum summarizing upcoming deadlines and each party\'s obligations under the operative case management order in In re Depo-Provera Prods. Liab. Litig., MDL No. 3140. Memorandum header (TO / FROM / DATE / RE). Section 1: a Markdown table with columns "Date | Event | Source (PTO/CMO ¶) | Plaintiffs\' Obligation | Defendants\' Obligation". Section 2: narrative discussion of the three most operationally significant deadlines and any conflicts. Cite each row to the controlling order using short forms ("CMO-3 § II.B"). Use [BRACKETED ALL-CAPS] for any obligation not supported by the record.',
  },

  // ---------- Hearing Prep ----------
  {
    category: 'Hearing Prep', icon: FileSearch, title: 'Bench memo', docType: 'Bench Memo',
    summary: 'Internal bench memo for an upcoming hearing.',
    prompt: 'Draft an internal bench memo for Plaintiffs\' co-lead counsel preparing for an upcoming hearing in In re Depo-Provera Prods. Liab. Litig., MDL No. 3140. Header: "MEMORANDUM" with TO / FROM / DATE / RE block. Sections: I. Question Presented; II. Short Answer; III. Background; IV. Discussion (numbered argument with subheadings A., B.); V. Anticipated Questions from the Court; VI. Recommended Talking Points; VII. Open Issues / Follow-up. Bluebook citations throughout. Use [BRACKETED ALL-CAPS] placeholders for record pin cites and witness/expert names.',
  },
  {
    category: 'Hearing Prep', icon: FileSearch, title: 'Cross-examination outline', docType: 'Outline',
    summary: 'Topic-driven cross outline for an expert witness.',
    prompt: 'Draft a cross-examination outline for [EXPERT WITNESS NAME], a defense general-causation expert in In re Depo-Provera Prods. Liab. Litig., MDL No. 3140. Header with witness name, role, and date of testimony [INSERT DATE]. Sections by topic (I., II., III.), each topic broken into lettered subtopics (A., B.), each subtopic broken into numbered questions (1., 2.) with the anticipated answer in parentheses or italics, and an exhibit reference where applicable (e.g., "[Ex. 4 — 2019 deposition at 112:14–18]"). End with "Loose Ends" and "Impeachment Reserves" sections. Place [BRACKETED ALL-CAPS] for facts not in the record.',
  },

  // ---------- Leadership / PSC ----------
  {
    category: 'Leadership / PSC', icon: ClipboardList, title: 'Common-benefit time memo', docType: 'PSC Memo',
    summary: 'Submission instructions to participating firms.',
    prompt: 'Draft a memorandum from Plaintiffs\' Co-Lead Counsel to all participating plaintiffs\' firms in In re Depo-Provera Prods. Liab. Litig., MDL No. 3140, setting out the procedures for submitting common-benefit time and expenses under the operative Common Benefit Order. Memorandum header (TO / FROM / DATE / RE). Sections: I. Authority (cite the controlling CBO); II. What Qualifies as Common-Benefit Work; III. Time Submission Procedure (format, monthly deadline, contemporaneous-records requirement, billable categories); IV. Expense Submission Procedure; V. Audit and Approval; VI. Contact. Use [BRACKETED ALL-CAPS] for the time-keeper contact, monthly cut-off, and CBO paragraph numbers if not in the record.',
  },
  {
    category: 'Leadership / PSC', icon: ClipboardList, title: 'Lone Pine compliance analysis', docType: 'Analysis Memo',
    summary: 'Threshold-proof / Lone Pine compliance read.',
    prompt: 'Draft an internal analysis memorandum for the Plaintiffs\' Steering Committee evaluating Lone Pine / threshold-proof compliance issues in In re Depo-Provera Prods. Liab. Litig., MDL No. 3140. Memorandum header (TO: PSC; FROM: Co-Lead Counsel; DATE: [INSERT DATE]; RE: Threshold-Proof Compliance — Analysis and Recommendations). Sections: I. The Operative Order (summarize the threshold-proof requirements with pin cites); II. Categories of Non-Compliance Observed; III. Legal Standard for Dismissal / Show-Cause; IV. Recommended Compliance Push (deadlines, communications, escalation); V. Risk Assessment. Use [BRACKETED ALL-CAPS] for case-counts and dates not in the record.',
  },
];

const TEMPLATE_CATEGORIES: DraftTemplate['category'][] = [
  'Correspondence', 'Motions & Briefs', 'Discovery', 'Case Management', 'Hearing Prep', 'Leadership / PSC',
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

  const citeChips = dedupeCitations(msg.citations, msg.chunks);
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

        {citeChips.length > 0 && (
          <div className="mt-2.5 pt-2 border-t border-border/60">
            <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground font-sans mb-1.5">
              Citations <span className="text-muted-foreground/60">({citeChips.length})</span>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {citeChips.map((c, i) => {
                const insertText = ` (${[c.order_label, c.page].filter(Boolean).join(', ')})`;
                return (
                  <span
                    key={i}
                    className="group inline-flex items-center gap-1 text-[11px] rounded border border-border bg-card hover:border-accent/50 transition overflow-hidden"
                    title={c.cited_text ? `"${c.cited_text}"` : undefined}
                  >
                    {c.pdf_url ? (
                      <a href={c.pdf_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 pl-1.5 pr-1 py-0.5 text-foreground/80 hover:text-foreground">
                        <span className="font-sans font-medium tabular-nums text-accent">[{c.num}]</span>
                        <span>{c.order_label ?? c.title ?? 'Source'}</span>
                        {c.page && <span className="text-muted-foreground tabular-nums">· {c.page}</span>}
                        <ExternalLink className="h-2.5 w-2.5 opacity-60" />
                      </a>
                    ) : (
                      <span className="inline-flex items-center gap-1 pl-1.5 pr-1 py-0.5 text-foreground/80">
                        <span className="font-sans font-medium tabular-nums text-accent">[{c.num}]</span>
                        <span>{c.order_label ?? c.title ?? 'Source'}</span>
                        {c.page && <span className="text-muted-foreground tabular-nums">· {c.page}</span>}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => onInsert(insertText)}
                      title="Insert this citation at the cursor"
                      className="px-1 py-0.5 border-l border-border text-muted-foreground hover:text-accent hover:bg-accent/5"
                    >
                      <Plus className="h-2.5 w-2.5" />
                    </button>
                  </span>
                );
              })}
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

type CiteChip = {
  num: number;
  order_label: string | null;
  page: string | null;
  title?: string;
  cited_text?: string;
  pdf_url: string | null;
};

function dedupeCitations(citations?: AiAssistCitation[], chunks?: AiAssistChunk[]): CiteChip[] {
  if (!citations?.length) return [];
  const byRef = new Map((chunks ?? []).map((c) => [c.ref, c]));
  const seen = new Map<string, CiteChip>();
  for (const c of citations) {
    const key = `${c.order_label ?? c.title ?? ''}|${c.page ?? ''}`;
    if (seen.has(key)) continue;
    const chunk = c.ref ? byRef.get(c.ref) : undefined;
    seen.set(key, {
      num: c.num,
      order_label: c.order_label,
      page: c.page,
      title: c.title,
      cited_text: c.cited_text,
      pdf_url: chunk?.pdf_url ?? null,
    });
  }
  return Array.from(seen.values());
}

function SaveStatus({
  dirty, saving, lastSavedAt, hasActive, onSave,
}: {
  dirty: boolean;
  saving: boolean;
  lastSavedAt: number | null;
  hasActive: boolean;
  onSave: () => void;
}) {
  const ago = useRelativeTime(lastSavedAt);
  let status: { label: string; cls: string };
  if (saving) status = { label: 'Saving…', cls: 'text-muted-foreground' };
  else if (!hasActive) status = { label: 'Not saved', cls: 'text-muted-foreground' };
  else if (dirty) status = { label: 'Unsaved changes', cls: 'text-amber-600' };
  else if (lastSavedAt) status = { label: `Saved ${ago}`, cls: 'text-muted-foreground' };
  else status = { label: 'Saved', cls: 'text-muted-foreground' };

  return (
    <button
      type="button"
      onClick={onSave}
      disabled={saving || (!dirty && hasActive)}
      title={dirty ? 'Save now' : 'Up to date'}
      className={cn(
        'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-border bg-card text-[11.5px] font-sans tabular-nums transition',
        'hover:border-accent/40 disabled:opacity-70 disabled:cursor-default',
        status.cls,
      )}
    >
      {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
      {status.label}
    </button>
  );
}

function useRelativeTime(ts: number | null): string {
  const [, force] = useState(0);
  useEffect(() => {
    if (!ts) return;
    const id = setInterval(() => force((n) => n + 1), 15000);
    return () => clearInterval(id);
  }, [ts]);
  if (!ts) return '';
  const secs = Math.max(1, Math.floor((Date.now() - ts) / 1000));
  if (secs < 60) return `${secs}s ago`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function DocumentRail({
  docs, activeId, isLoading, query, setQuery, onPick, onNew,
}: {
  docs: WorkspaceDocument[];
  activeId: string | null;
  isLoading: boolean;
  query: string;
  setQuery: (s: string) => void;
  onPick: (d: WorkspaceDocument) => void;
  onNew: () => void;
}) {
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter((d) => d.title.toLowerCase().includes(q) || d.content.toLowerCase().includes(q));
  }, [docs, query]);

  const groups = useMemo(() => {
    const now = Date.now();
    const today: WorkspaceDocument[] = [];
    const week: WorkspaceDocument[] = [];
    const older: WorkspaceDocument[] = [];
    for (const d of filtered) {
      const age = now - new Date(d.updated_at).getTime();
      if (age < 86400000) today.push(d);
      else if (age < 7 * 86400000) week.push(d);
      else older.push(d);
    }
    return [
      { label: 'Today', items: today },
      { label: 'Past week', items: week },
      { label: 'Older', items: older },
    ].filter((g) => g.items.length);
  }, [filtered]);

  return (
    <aside className="hidden lg:flex lg:w-60 shrink-0 flex-col">
      <Card className="p-0 flex flex-col flex-1 overflow-hidden">
        <div className="px-3 py-2.5 border-b border-border bg-card/60 flex items-center gap-2">
          <span className="text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground font-sans">
            {isLoading ? 'Loading…' : `${docs.length} doc${docs.length === 1 ? '' : 's'}`}
          </span>
          <Button size="sm" variant="ghost" className="ml-auto h-7 gap-1 text-[11.5px]" onClick={onNew}>
            <Plus className="h-3.5 w-3.5" /> New
          </Button>
        </div>
        <div className="px-3 py-2 border-b border-border">
          <div className="relative">
            <Search className="h-3.5 w-3.5 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search documents…"
              className="h-8 pl-7 text-[12.5px]"
            />
          </div>
        </div>
        <div className="flex-1 overflow-y-auto">
          {groups.length === 0 && !isLoading && (
            <div className="p-4 text-[12px] text-muted-foreground">
              {docs.length === 0 ? 'No documents yet — create one.' : 'No matches.'}
            </div>
          )}
          {groups.map((g) => (
            <div key={g.label} className="py-1.5">
              <div className="px-3 pt-1 pb-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground/80 font-sans">
                {g.label}
              </div>
              {g.items.map((d) => {
                const active = d.id === activeId;
                return (
                  <button
                    key={d.id}
                    type="button"
                    onClick={() => onPick(d)}
                    className={cn(
                      'w-full text-left px-3 py-2 border-l-2 transition flex flex-col gap-0.5',
                      active
                        ? 'bg-secondary/70 border-accent'
                        : 'border-transparent hover:bg-secondary/40 hover:border-border',
                    )}
                  >
                    <span className={cn('truncate text-[12.5px]', active ? 'font-semibold text-foreground' : 'font-medium text-foreground/90')}>
                      {d.title || 'Untitled document'}
                    </span>
                    <span className="text-[10.5px] text-muted-foreground tabular-nums font-sans">
                      {new Date(d.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      </Card>
    </aside>
  );
}

