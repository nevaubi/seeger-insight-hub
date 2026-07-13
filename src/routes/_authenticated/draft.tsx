import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  PenLine,
  Plus,
  Save,
  Trash2,
  FileText as FileTextIcon,
  Loader2,
  ChevronDown,
  CornerDownLeft,
  BookOpen,
  ExternalLink,
  ArrowDownToLine,
  Copy,
  Check,
  ListChecks,
  Search,
  PanelLeftClose,
  PanelLeftOpen,
  FileUp,
  FileDiff,
  AlertTriangle,
  Command as CommandIcon,
  Quote,
  Sparkles,
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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
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
import { supabase, WORKSPACE_DOCX_BUCKET, type WorkspaceDocument } from '@/lib/supabase';
import { useMatter } from '@/lib/matter-context';
import {
  useAiAssist,
  type AiAssistCitation,
  type AiAssistChunk,
  type AiAssistMatter,
  type AiAssistMeta,
} from '@/lib/useAiAssist';
import { useRedline } from '@/lib/useRedline';
import { locateAnchor, scanPlaceholdersLocal, type PlaceholderHit } from '@/lib/redline';
import {
  buildDocx,
  printDocument,
  blocksToHtml,
  markdownToBlocks,
} from '@/lib/file-export';
import {
  dedupeCitations,
  expandLabel,
  formatFullCite,
  formatPagePin,
  formatShortCite,
  type CiteChip,
} from '@/lib/bluebook';
import { cn } from '@/lib/utils';
import { ChangesPanel } from '@/components/draft/changes-panel';
import { ChecksPanel } from '@/components/draft/checks-panel';
import { CommandPalette, type PaletteTemplate } from '@/components/draft/command-palette';
import { VersionHistory, snapshotVersion } from '@/components/draft/version-history';
import { ClaudeBadge } from '@/components/claude-badge';
import {
  DRAFT_TEMPLATES,
  MARKUP_PRESETS,
  TemplateLauncher,
  type DraftTemplate,
} from '@/components/draft/templates';
import type { WordEditorApi } from '@/components/draft/word-editor';

// SuperDoc is a heavy editor runtime — loaded lazily; it is the workspace's only editor.
const WordEditor = lazy(() => import('@/components/draft/word-editor'));

const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

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

export const Route = createFileRoute('/_authenticated/draft')({
  component: DraftPage,
  errorComponent: ({ error }) => (
    <AppShell><div className="p-8 text-sm text-destructive">Failed to load: {error.message}</div></AppShell>
  ),
  notFoundComponent: () => <AppShell><div className="p-8">Not found.</div></AppShell>,
});

type ChatMsg = {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  citations?: AiAssistCitation[];
  chunks?: AiAssistChunk[];
  streaming?: boolean;
  grounded?: boolean;
};

type AssistantTab = 'chat' | 'changes' | 'checks';

function DraftPage() {
  const { currentMatter } = useMatter();
  const caseId = currentMatter.master_case_id;
  const qc = useQueryClient();
  const { data: docs = [], isLoading } = useQuery(docsQuery(caseId));

  // ---- document state (the canvas owns content; we track metadata + extracted text) ----
  const [activeId, setActiveId] = useState<string | null>(null);
  const [title, setTitle] = useState('Untitled document');
  const [titleDirty, setTitleDirty] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  const [railQuery, setRailQuery] = useState('');
  const [ground, setGround] = useState(true);
  const [activeTab, setActiveTab] = useState<AssistantTab>('chat');
  const [focusedSuggestionId, setFocusedSuggestionId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [placeholderGate, setPlaceholderGate] = useState<{ hits: PlaceholderHit[] } | null>(null);
  const [importing, setImporting] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [mounted, setMounted] = useState(false);
  const [wordApi, setWordApi] = useState<WordEditorApi | null>(null);
  const [wordSave, setWordSave] = useState<{ saving: boolean; lastSavedAt: number | null; dirty: boolean }>({ saving: false, lastSavedAt: null, dirty: false });
  const [wordText, setWordText] = useState('');
  useEffect(() => setMounted(true), []);

  const importInputRef = useRef<HTMLInputElement | null>(null);
  const assistantApiRef = useRef<{ send: (text: string) => void } | null>(null);
  // canvas application bookkeeping: suggestion id → native tracked-change/comment ids
  const appliedRef = useRef(new Map<string, { changeIds: string[]; commentId?: string | null }>());
  const applyAttemptedRef = useRef(new Set<string>());

  const redline = useRedline();
  const pendingSuggestions = useMemo(
    () => redline.suggestions.filter((s) => s.status === 'pending'),
    [redline.suggestions],
  );

  const matterScope: AiAssistMatter = useMemo(
    () => ({
      name: currentMatter.name,
      short_name: currentMatter.short_name,
      mdl_number: currentMatter.mdl_number,
      court: currentMatter.court,
      judge: currentMatter.judge,
    }),
    [currentMatter],
  );

  const activeDoc = useMemo(() => docs.find((d) => d.id === activeId) ?? null, [docs, activeId]);

  // ---- Word-only: legacy markdown documents are upgraded to .docx on open ----
  const upgradeToDocx = useCallback(
    async (d: WorkspaceDocument): Promise<WorkspaceDocument | null> => {
      setUpgrading(true);
      try {
        const blob = buildDocx(markdownToBlocks(d.content?.trim() ? d.content : `# ${d.title || 'Untitled document'}\n\n `));
        const path = `${caseId}/${crypto.randomUUID()}.docx`;
        const { error: upErr } = await supabase.storage
          .from(WORKSPACE_DOCX_BUCKET)
          .upload(path, blob, { contentType: DOCX_MIME });
        if (upErr) throw new Error(upErr.message);
        const { data, error } = await supabase
          .from('workspace_documents')
          .update({ format: 'docx', storage_path: path })
          .eq('id', d.id)
          .select('*')
          .single();
        if (error) throw error;
        qc.invalidateQueries({ queryKey: ['workspace-docs', caseId] });
        toast.success(`“${d.title}” upgraded to a Word document`);
        return data as WorkspaceDocument;
      } catch (e) {
        toast.error(`Could not upgrade document: ${(e as Error).message}`);
        return null;
      } finally {
        setUpgrading(false);
      }
    },
    [caseId, qc],
  );

  const loadDoc = useCallback(
    async (d: WorkspaceDocument) => {
      redline.clear();
      appliedRef.current.clear();
      applyAttemptedRef.current.clear();
      setFocusedSuggestionId(null);
      setWordApi(null);
      setWordText('');
      setWordSave({ saving: false, lastSavedAt: null, dirty: false });
      if (d.format === 'docx' && d.storage_path) {
        setActiveId(d.id);
        setTitle(d.title);
        setTitleDirty(false);
        return;
      }
      const upgraded = await upgradeToDocx(d);
      if (upgraded) {
        setActiveId(upgraded.id);
        setTitle(upgraded.title);
        setTitleDirty(false);
      }
    },
    [redline, upgradeToDocx],
  );

  // load first document when available
  useEffect(() => {
    if (activeId && docs.some((d) => d.id === activeId)) return;
    if (docs.length) void loadDoc(docs[0]);
    else {
      setActiveId(null);
      setTitle('Untitled document');
      setTitleDirty(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs]);

  // ---- mutations ----
  const createDoc = useMutation({
    mutationFn: async (doc: { title: string; content: string; format?: string; storage_path?: string }) => {
      const { data, error } = await supabase
        .from('workspace_documents')
        .insert({
          case_id: caseId,
          title: doc.title,
          content: doc.content,
          ...(doc.format ? { format: doc.format } : {}),
          ...(doc.storage_path ? { storage_path: doc.storage_path } : {}),
        })
        .select('*')
        .single();
      if (error) throw error;
      return data as WorkspaceDocument;
    },
    onSuccess: (d) => {
      qc.invalidateQueries({ queryKey: ['workspace-docs', caseId] });
      void loadDoc(d);
    },
    onError: (e: Error) => toast.error(`Could not create document: ${e.message}`),
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
    onError: (e: Error) => toast.error(`Delete failed: ${e.message}`),
  });

  const newDocument = useCallback(async () => {
    try {
      const blob = buildDocx(markdownToBlocks(' '));
      const path = `${caseId}/${crypto.randomUUID()}.docx`;
      const { error } = await supabase.storage.from(WORKSPACE_DOCX_BUCKET).upload(path, blob, { contentType: DOCX_MIME });
      if (error) throw new Error(error.message);
      createDoc.mutate({ title: 'Untitled document', content: '', format: 'docx', storage_path: path });
    } catch (e) {
      toast.error(`Could not create document: ${(e as Error).message}`);
    }
  }, [caseId, createDoc]);

  // title autosave (canvas content autosaves inside the Word editor)
  useEffect(() => {
    if (!titleDirty || !activeId) return;
    const t = setTimeout(async () => {
      const { error } = await supabase.from('workspace_documents').update({ title }).eq('id', activeId);
      if (!error) {
        setTitleDirty(false);
        qc.invalidateQueries({ queryKey: ['workspace-docs', caseId] });
      }
    }, 1200);
    return () => clearTimeout(t);
  }, [title, titleDirty, activeId, caseId, qc]);

  // keep last-extracted text mirrored to the row (search/versions) — throttled
  const lastMirrored = useRef('');
  useEffect(() => {
    if (!activeId || !wordText || wordText === lastMirrored.current) return;
    const t = setTimeout(() => {
      lastMirrored.current = wordText;
      void supabase.from('workspace_documents').update({ content: wordText }).eq('id', activeId);
    }, 4000);
    return () => clearTimeout(t);
  }, [wordText, activeId]);

  // ---- .docx import (always Word mode) ----
  const importDocxFile = async (file: File) => {
    setImporting(true);
    try {
      const path = `${caseId}/${crypto.randomUUID()}.docx`;
      const { error } = await supabase.storage.from(WORKSPACE_DOCX_BUCKET).upload(path, file, { contentType: DOCX_MIME });
      if (error) throw new Error(error.message);
      createDoc.mutate({
        title: file.name.replace(/\.docx$/i, ''),
        content: '',
        format: 'docx',
        storage_path: path,
      });
      toast.success(`Opened “${file.name}”`);
    } catch (e) {
      toast.error(`Could not open: ${(e as Error).message}`);
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = '';
    }
  };

  // ---- verified redline → native tracked changes in the canvas ----
  useEffect(() => {
    if (!wordApi) return;
    for (const s of redline.suggestions) {
      if (s.status !== 'pending' || applyAttemptedRef.current.has(s.id)) continue;
      applyAttemptedRef.current.add(s.id);
      const result = wordApi.applyRedlineEdit(s);
      if (result.ok) {
        appliedRef.current.set(s.id, { changeIds: result.changeIds, commentId: result.commentId ?? null });
      } else {
        redline.failLocal(s.id, `canvas: ${result.reason ?? 'could not anchor'}`);
      }
    }
  }, [redline.suggestions, wordApi, redline]);

  // suggestions arriving → surface the review rail
  const hadSuggestions = useRef(0);
  useEffect(() => {
    if (redline.suggestions.length > 0 && hadSuggestions.current === 0) setActiveTab('changes');
    hadSuggestions.current = redline.suggestions.length;
  }, [redline.suggestions.length]);

  const runMarkup = useCallback(
    async (instruction: string, selectionText?: string | null) => {
      const docText = wordApi?.extractText() || wordText;
      if (!docText.trim()) {
        toast.error('Nothing to review yet — the document is empty.');
        return;
      }
      if (activeId) {
        snapshotVersion({ documentId: activeId, caseId, content: docText, label: 'Before markup pass' }).catch(() => {});
        qc.invalidateQueries({ queryKey: ['document-versions', activeId] });
      }
      let selection: { start: number; end: number } | null = null;
      if (selectionText?.trim()) {
        const loc = locateAnchor(docText, selectionText.trim().slice(0, 400));
        if (loc) selection = loc;
      }
      setActiveTab('changes');
      const ok = await redline.run({
        instruction,
        document: docText,
        selection,
        ground,
        caseId,
        matter: matterScope,
        documentId: activeId,
      });
      if (!ok && !redline.error) {
        toast.message('No suggestions', { description: 'The reviewer found nothing to change for that instruction.' });
      }
    },
    [wordApi, wordText, activeId, caseId, ground, matterScope, redline, qc],
  );

  // ---- suggestion resolution → native accept/reject ----
  const acceptSuggestion = (id: string) => {
    const m = appliedRef.current.get(id);
    if (m && m.changeIds.length > 0) wordApi?.decideTracked(m.changeIds, 'accept');
    // comments: accepting keeps the margin note in the document
    redline.resolveExternal(id, 'accepted');
    setFocusedSuggestionId(null);
  };

  const rejectSuggestion = (id: string) => {
    const m = appliedRef.current.get(id);
    if (m?.commentId) wordApi?.removeComment(m.commentId);
    if (m && m.changeIds.length > 0) wordApi?.decideTracked(m.changeIds, 'reject');
    redline.resolveExternal(id, 'rejected');
    setFocusedSuggestionId(null);
  };

  const acceptAllSuggestions = () => {
    let n = 0;
    for (const s of pendingSuggestions) {
      acceptSuggestion(s.id);
      n++;
    }
    if (n) toast.success(`Accepted ${n} suggestion${n === 1 ? '' : 's'}`);
  };

  const rejectAllSuggestions = () => {
    for (const s of pendingSuggestions) rejectSuggestion(s.id);
    toast.message('Suggestions dismissed');
  };

  // ---- export (placeholder gate first) ----
  const exportDocx = () => {
    const text = wordApi?.extractText() ?? wordText;
    const hits = scanPlaceholdersLocal(text);
    if (hits.length > 0) setPlaceholderGate({ hits });
    else void wordApi?.exportDocx(`${currentMatter.short_name}-${title}`.slice(0, 80));
  };

  const exportPdf = () => {
    const text = wordApi?.extractText() ?? wordText;
    const ok = printDocument({
      title: title || 'Document',
      metaLine: `<span class="matter">${currentMatter.short_name}</span> · MDL ${currentMatter.mdl_number}`,
      bodyHtml: blocksToHtml(markdownToBlocks(text || `# ${title}`)),
    });
    if (!ok) toast.error('Allow pop-ups to print / save as PDF');
  };

  // ---- chat helpers ----
  const appendToDoc = (text: string) => {
    navigator.clipboard?.writeText(text).then(() => {
      toast.message('Copied to clipboard', { description: 'Paste into the document where you need it.' });
    });
  };

  const insertCitation = (c: CiteChip, variant: 'short' | 'full' | 'footnote') => {
    const text = variant === 'full' ? formatFullCite(c) : formatShortCite(c);
    navigator.clipboard?.writeText(text.trim()).then(() => {
      toast.success('Citation copied — paste at the cursor');
    });
  };

  const paletteTemplates: PaletteTemplate[] = useMemo(
    () => [
      ...MARKUP_PRESETS.map((m) => ({ title: m.title, category: 'Markup', prompt: m.instruction })),
      ...DRAFT_TEMPLATES.map((t) => ({ title: t.title, category: t.category, prompt: t.prompt })),
    ],
    [],
  );

  const wordCount = useMemo(() => {
    const t = wordText.trim();
    return t ? t.split(/\s+/).length : 0;
  }, [wordText]);

  const canvasReady = !!activeDoc?.storage_path && activeDoc.format === 'docx';

  return (
    <AppShell>
      <PageHeader
        title="Drafting Workspace"
        description="A Word-grade canvas with Claude inside — select any passage to ask the record, and AI edits arrive as tracked changes, every one anchored to text verified to exist."
      >
        <div className="flex items-center gap-2">
          <ClaudeBadge variant="chip" className="hidden xl:inline-flex" />
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
            <DocumentMenu docs={docs} activeId={activeId} isLoading={isLoading} onPick={(d) => void loadDoc(d)} onNew={() => void newDocument()} />
          </div>
          <Button
            variant="ghost"
            size="sm"
            className="hidden lg:inline-flex gap-1.5 text-muted-foreground"
            onClick={() => setPaletteOpen(true)}
            title="Command palette (⌘K)"
          >
            <CommandIcon className="h-3.5 w-3.5" />
            <span className="text-[11px] font-sans">⌘K</span>
          </Button>
          <SaveStatus
            dirty={wordSave.dirty || titleDirty}
            saving={wordSave.saving}
            lastSavedAt={wordSave.lastSavedAt}
            hasActive={!!activeId}
          />
          <VersionHistory
            documentId={activeId}
            caseId={caseId}
            currentContent={wordText}
            allowRestore={false}
            onRestore={() => {}}
          />
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2" disabled={!canvasReady}>
                <ArrowDownToLine className="h-4 w-4" /> Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuItem onClick={exportDocx} className="gap-2 cursor-pointer">
                <FileTextIcon className="h-4 w-4 text-[hsl(215_60%_40%)]" /> Word document (.docx)
              </DropdownMenuItem>
              <DropdownMenuItem onClick={exportPdf} className="gap-2 cursor-pointer">
                <FileTextIcon className="h-4 w-4 text-muted-foreground" /> Print / Save as PDF
              </DropdownMenuItem>
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
            onPick={(d) => void loadDoc(d)}
            onNew={() => void newDocument()}
            onImport={() => importInputRef.current?.click()}
            importing={importing}
          />
        )}

        {/* THE WORD CANVAS */}
        <div className="lg:flex-[3] min-w-0 flex flex-col mb-5 lg:mb-0">
          <Card className="p-0 flex flex-col flex-1 overflow-hidden">
            {/* document title strip — Word-blue */}
            <div className="flex items-center gap-3 border-b border-[hsl(215_45%_86%)] bg-[hsl(215_62%_40%)] px-4 py-2">
              <FileTextIcon className="h-4 w-4 shrink-0 text-white/85" />
              <Input
                value={title}
                onChange={(e) => { setTitle(e.target.value); setTitleDirty(true); }}
                placeholder="Document title…"
                className="h-7 border-0 shadow-none px-0 font-sans text-[13.5px] font-medium focus-visible:ring-0 bg-transparent text-white placeholder:text-white/50"
              />
              <div className="ml-auto flex items-center gap-2 shrink-0">
                <span className="text-[11px] text-white/75 tabular-nums font-sans">{wordCount.toLocaleString()} words</span>
                {pendingSuggestions.length > 0 && (
                  <button
                    type="button"
                    onClick={() => setActiveTab('changes')}
                    className="inline-flex items-center gap-1 rounded-full bg-white/15 px-2 py-0.5 text-[10.5px] font-sans text-white hover:bg-white/25 transition"
                  >
                    <FileDiff className="h-3 w-3" /> {pendingSuggestions.length} suggested change{pendingSuggestions.length === 1 ? '' : 's'}
                  </button>
                )}
                <ClaudeBadge variant="chip" className="border-white/25 bg-white/10 text-white/90" />
              </div>
            </div>

            {(upgrading || (!canvasReady && docs.length > 0 && isLoading === false && activeId)) && (
              <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
                <Loader2 className="h-4 w-4 animate-spin mr-2" /> Preparing Word document…
              </div>
            )}

            {!activeId && !upgrading && (
              <div className="flex flex-1 items-center justify-center p-10">
                <div className="text-center max-w-sm">
                  <FileUp className="h-6 w-6 mx-auto mb-3 text-accent/60" strokeWidth={1.5} />
                  <p className="font-serif text-[16px] text-foreground/85 mb-1.5">Open the record, or start clean.</p>
                  <p className="text-[12px] leading-relaxed text-muted-foreground mb-4">
                    Open a .docx exactly as filed — pagination, styles, tables intact — or start a new
                    document from a litigation skill. Claude works inside the page.
                  </p>
                  <div className="flex items-center justify-center gap-2">
                    <Button size="sm" className="gap-1.5" onClick={() => importInputRef.current?.click()}>
                      <FileUp className="h-3.5 w-3.5" /> Open .docx
                    </Button>
                    <Button size="sm" variant="outline" className="gap-1.5" onClick={() => void newDocument()}>
                      <Plus className="h-3.5 w-3.5" /> New document
                    </Button>
                  </div>
                </div>
              </div>
            )}

            {canvasReady && mounted && (
              <Suspense
                fallback={
                  <div className="flex flex-1 items-center justify-center text-muted-foreground text-sm">
                    <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading Word editor…
                  </div>
                }
              >
                <WordEditor
                  key={activeDoc!.storage_path!}
                  storagePath={activeDoc!.storage_path!}
                  caseId={caseId}
                  matter={matterScope}
                  onSaveStateChange={setWordSave}
                  onTextChange={setWordText}
                  onApi={setWordApi}
                  onSuggestEdits={(selText, instruction) => void runMarkup(instruction, selText)}
                />
              </Suspense>
            )}
          </Card>
        </div>

        {/* ASSISTANT */}
        <AssistantPane
          caseId={caseId}
          matter={matterScope}
          documentText={wordText}
          ground={ground}
          setGround={setGround}
          activeTab={activeTab}
          setActiveTab={setActiveTab}
          pendingCount={pendingSuggestions.length}
          redline={redline}
          focusedSuggestionId={focusedSuggestionId}
          setFocusedSuggestionId={setFocusedSuggestionId}
          onAccept={acceptSuggestion}
          onReject={rejectSuggestion}
          onAcceptAll={acceptAllSuggestions}
          onRejectAll={rejectAllSuggestions}
          onRunMarkup={(instr) => void runMarkup(instr, null)}
          onAppend={appendToDoc}
          onInsertCite={insertCitation}
          apiRef={assistantApiRef}
        />
      </div>

      {/* ⌘K */}
      <CommandPalette
        open={paletteOpen}
        onOpenChange={setPaletteOpen}
        docs={docs}
        activeId={activeId}
        templates={paletteTemplates}
        ground={ground}
        onPickDoc={(d) => void loadDoc(d)}
        onNew={() => void newDocument()}
        onImport={() => importInputRef.current?.click()}
        onRunTemplate={(t) => {
          if (t.category === 'Markup') void runMarkup(t.prompt, null);
          else {
            setActiveTab('chat');
            assistantApiRef.current?.send(t.prompt);
          }
        }}
        onToggleGround={() => setGround((g) => !g)}
        onExportDocx={exportDocx}
        onExportPdf={exportPdf}
        onExportMd={exportPdf}
        onOpenChecks={() => setActiveTab('checks')}
      />

      {/* placeholder export gate */}
      <Dialog open={!!placeholderGate} onOpenChange={(v) => !v && setPlaceholderGate(null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2 font-serif">
              <AlertTriangle className="h-4 w-4 text-amber-600" />
              {placeholderGate?.hits.length} unresolved placeholder{placeholderGate?.hits.length === 1 ? '' : 's'}
            </DialogTitle>
            <DialogDescription>
              These blanks are still in the document — filings shouldn't leave the building with
              placeholders. Find them with the canvas search, or export anyway.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-56 overflow-y-auto rounded-md border border-border">
            {placeholderGate?.hits.map((h, i) => (
              <div key={i} className="border-b border-border/50 px-3 py-1.5 last:border-b-0">
                <span className="font-mono text-[12px] text-amber-800">{h.quote}</span>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPlaceholderGate(null)}>Keep editing</Button>
            <Button
              variant="outline"
              onClick={() => {
                setPlaceholderGate(null);
                void wordApi?.exportDocx(`${currentMatter.short_name}-${title}`.slice(0, 80));
              }}
            >
              Export anyway
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* hidden .docx input */}
      <input
        ref={importInputRef}
        type="file"
        accept={`.docx,${DOCX_MIME}`}
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void importDocxFile(f);
        }}
      />
    </AppShell>
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

// ---------------- assistant pane ----------------

function AssistantPane({
  caseId,
  matter,
  documentText,
  ground,
  setGround,
  activeTab,
  setActiveTab,
  pendingCount,
  redline,
  focusedSuggestionId,
  setFocusedSuggestionId,
  onAccept,
  onReject,
  onAcceptAll,
  onRejectAll,
  onRunMarkup,
  onAppend,
  onInsertCite,
  apiRef,
}: {
  caseId: string;
  matter: AiAssistMatter;
  documentText: string;
  ground: boolean;
  setGround: (v: boolean) => void;
  activeTab: AssistantTab;
  setActiveTab: (t: AssistantTab) => void;
  pendingCount: number;
  redline: ReturnType<typeof useRedline>;
  focusedSuggestionId: string | null;
  setFocusedSuggestionId: (id: string | null) => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onRunMarkup: (instruction: string) => void;
  onAppend: (text: string) => void;
  onInsertCite: (c: CiteChip, variant: 'short' | 'full' | 'footnote') => void;
  apiRef: React.MutableRefObject<{ send: (text: string) => void } | null>;
}) {
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [input, setInput] = useState('');
  const [chatProfile, setChatProfile] = useState<AiAssistMeta['profile']>(null);
  const { run, running } = useAiAssist();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const idRef = useRef(0);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = useCallback(
    async (override?: string) => {
      const text = (override ?? input).trim();
      if (!text || running) return;
      if (!override) setInput('');
      const userMsg: ChatMsg = { id: `u${idRef.current++}`, role: 'user', content: text };
      const asstId = `a${idRef.current++}`;
      const history = messages.map((m) => ({ role: m.role, content: m.content }));
      setMessages((m) => [...m, userMsg, { id: asstId, role: 'assistant', content: '', streaming: true, grounded: ground }]);

      const result = await run({
        mode: 'draft',
        instruction: text,
        document: documentText,
        messages: history,
        ground,
        caseId,
        matter,
        onMeta: (meta) => {
          setChatProfile(meta.profile ?? null);
          setMessages((m) => m.map((msg) => (msg.id === asstId ? { ...msg, grounded: meta.grounded } : msg)));
        },
        onText: (delta) => {
          setMessages((m) => m.map((msg) => (msg.id === asstId ? { ...msg, content: msg.content + delta } : msg)));
        },
      });

      setMessages((m) => m.map((msg) => (msg.id === asstId
        ? { ...msg, streaming: false, content: result?.text ?? msg.content, citations: result?.citations, chunks: result?.chunks }
        : msg)));
    },
    [input, running, messages, ground, caseId, matter, documentText, run],
  );

  useEffect(() => {
    apiRef.current = { send: (text: string) => void send(text) };
    return () => { apiRef.current = null; };
  }, [apiRef, send]);

  const profile = redline.meta?.profile ?? chatProfile;

  return (
    <div className="lg:flex-[2] min-w-0 lg:max-w-[460px] flex flex-col">
      <Card className="p-0 flex flex-col flex-1 overflow-hidden">
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card/60">
          <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as AssistantTab)}>
            <TabsList className="h-8 bg-secondary/60">
              <TabsTrigger value="chat" className="h-6.5 px-2.5 text-[12px] gap-1.5">
                <PenLine className="h-3.5 w-3.5" /> Chat
              </TabsTrigger>
              <TabsTrigger value="changes" className="h-6.5 px-2.5 text-[12px] gap-1.5">
                <FileDiff className="h-3.5 w-3.5" /> Changes
                {pendingCount > 0 && (
                  <span className="rounded-full bg-accent text-accent-foreground px-1.5 text-[10px] font-sans tabular-nums leading-[1.5]">
                    {pendingCount}
                  </span>
                )}
              </TabsTrigger>
              <TabsTrigger value="checks" className="h-6.5 px-2.5 text-[12px] gap-1.5">
                <ListChecks className="h-3.5 w-3.5" /> Checks
              </TabsTrigger>
            </TabsList>
          </Tabs>
          <label className="ml-auto flex items-center gap-1.5 text-[11px] text-muted-foreground font-sans cursor-pointer shrink-0" title="Retrieve and cite the matter's controlling orders">
            <BookOpen className="h-3.5 w-3.5" /> Ground
            <Switch checked={ground} onCheckedChange={setGround} />
          </label>
        </div>

        {profile && (
          <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border/60 bg-secondary/30">
            <BookOpen className="h-3 w-3 text-accent" />
            <span className="truncate text-[10.5px] font-sans text-muted-foreground">
              Playbook: <span className="text-foreground/75">{profile.name ?? 'Practice profile'}</span>
              {profile.updated_at && (
                <> · updated {new Date(profile.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}</>
              )}
            </span>
          </div>
        )}

        {activeTab === 'chat' && (
          <>
            <div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-4 space-y-4 min-h-[40vh]">
              {messages.length === 0 && (
                <TemplateLauncher disabled={running} onPick={(t: DraftTemplate) => send(t.prompt)} />
              )}
              {messages.map((m) => (
                <ChatBubble key={m.id} msg={m} onAppend={onAppend} onInsertCite={onInsertCite} />
              ))}
            </div>
            <div className="border-t border-border p-3">
              <div className="relative">
                <Textarea
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); }
                  }}
                  placeholder="Ask the assistant to draft or revise…"
                  className="resize-none min-h-[72px] pr-12 text-[14px]"
                  disabled={running}
                />
                <Button size="sm" className="absolute bottom-2 right-2 h-8 w-8 p-0" disabled={!input.trim() || running} onClick={() => void send()}>
                  {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <CornerDownLeft className="h-4 w-4" />}
                </Button>
              </div>
              <div className="text-[10.5px] text-muted-foreground mt-1.5 px-1 font-sans">
                Enter to send · Shift+Enter for a new line{ground ? ' · grounded in the record' : ''}
              </div>
            </div>
          </>
        )}

        {activeTab === 'changes' && (
          <div className="flex-1 overflow-y-auto min-h-[40vh]">
            <MarkupComposer running={redline.running} hasDoc={!!documentText.trim()} ground={ground} onRun={onRunMarkup} onStop={redline.stop} />
            {redline.error && (
              <div className="mx-3 mb-1 rounded-md border border-amber-300 bg-amber-50 px-2.5 py-1.5 text-[11.5px] text-amber-800">
                {redline.error}
              </div>
            )}
            <ChangesPanel
              suggestions={redline.suggestions}
              failed={redline.failed}
              summary={redline.summary}
              meta={redline.meta}
              stats={redline.stats}
              running={redline.running}
              focusedId={focusedSuggestionId}
              onFocus={setFocusedSuggestionId}
              onAccept={onAccept}
              onReject={onReject}
              onAcceptAll={onAcceptAll}
              onRejectAll={onRejectAll}
            />
          </div>
        )}

        {activeTab === 'checks' && (
          <div className="flex-1 overflow-y-auto min-h-[40vh]">
            <ChecksPanel
              document={documentText}
              caseId={caseId}
              matter={matter}
              onJump={() => {
                toast.message('Located in the extracted text', {
                  description: 'Use the canvas search (Ctrl+F in the toolbar) to jump to it in the page.',
                });
              }}
            />
          </div>
        )}
      </Card>
    </div>
  );
}

function MarkupComposer({
  running,
  hasDoc,
  ground,
  onRun,
  onStop,
}: {
  running: boolean;
  hasDoc: boolean;
  ground: boolean;
  onRun: (instruction: string) => void;
  onStop: () => void;
}) {
  const [text, setText] = useState('');
  const fire = (instr: string) => {
    if (!instr.trim()) return;
    onRun(instr.trim());
    setText('');
  };
  return (
    <div className="border-b border-border bg-card/50 px-3 py-2.5">
      <div className="flex items-center gap-1.5 mb-1.5">
        <PenLine className="h-3.5 w-3.5 text-accent" />
        <span className="text-[11px] font-sans font-medium text-foreground/85">Mark up this document</span>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="ml-auto h-6 px-2 text-[10.5px] gap-1 text-muted-foreground">
              <Sparkles className="h-3 w-3" /> Presets <ChevronDown className="h-3 w-3" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-72">
            {MARKUP_PRESETS.map((p) => (
              <DropdownMenuItem key={p.title} className="cursor-pointer text-[12.5px]" disabled={running || !hasDoc} onClick={() => fire(p.instruction)}>
                {p.title}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      <div className="relative">
        <Textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); fire(text); }
          }}
          placeholder='e.g. "Review for consistency with PTO 22 and mark it up"'
          className="resize-none min-h-[56px] pr-11 text-[13px]"
          disabled={running || !hasDoc}
        />
        {running ? (
          <Button size="sm" variant="outline" className="absolute bottom-2 right-2 h-7 w-7 p-0" onClick={onStop} title="Stop">
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          </Button>
        ) : (
          <Button size="sm" className="absolute bottom-2 right-2 h-7 w-7 p-0" disabled={!text.trim() || !hasDoc} onClick={() => fire(text)} title="Run markup pass">
            <CornerDownLeft className="h-3.5 w-3.5" />
          </Button>
        )}
      </div>
      <p className="mt-1 px-0.5 text-[10px] text-muted-foreground/80 font-sans">
        Suggestions land in the page as native tracked changes, verbatim-anchored{ground ? ' · grounded in the record' : ''}.
      </p>
    </div>
  );
}

function ChatBubble({
  msg, onAppend, onInsertCite,
}: {
  msg: ChatMsg;
  onAppend: (t: string) => void;
  onInsertCite: (c: CiteChip, variant: 'short' | 'full' | 'footnote') => void;
}) {
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
  const copyAppendix = () => {
    const lines = citeChips.map((c) => {
      const label = expandLabel(c.order_label || c.title || 'Order');
      const page = c.page ? `, at ${formatPagePin(c.page)}` : '';
      const url = c.pdf_url ? ` <${c.pdf_url}>` : '';
      return `${c.num}. ${label}${page}.${url}`;
    });
    const md = `**Sources**\n\n${lines.join('\n')}\n`;
    navigator.clipboard?.writeText(md).then(() => toast.success('Sources appendix copied'));
  };
  return (
    <div className="space-y-2">
      {msg.grounded === false && !msg.streaming && msg.content && (
        <div className="flex items-center gap-1.5 rounded-md border border-amber-300/70 bg-amber-50/70 px-2.5 py-1.5">
          <AlertTriangle className="h-3 w-3 text-amber-600 shrink-0" />
          <span className="text-[10.5px] font-sans text-amber-800">
            Drafted without record grounding — sources not verified against the record or a research connector.
          </span>
        </div>
      )}
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
            <div className="flex items-center justify-between mb-1.5">
              <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground font-sans">
                Citations <span className="text-muted-foreground/60">({citeChips.length})</span>
              </div>
              <button
                type="button"
                onClick={copyAppendix}
                className="text-[10px] uppercase tracking-[0.1em] text-muted-foreground/80 hover:text-accent font-sans inline-flex items-center gap-1"
                title="Copy a Markdown Sources appendix for the bottom of a brief"
              >
                <Copy className="h-2.5 w-2.5" /> Sources appendix
              </button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              {citeChips.map((c, i) => (
                <CitationChip key={i} c={c} onInsertCite={onInsertCite} />
              ))}
            </div>
          </div>
        )}
      </div>

      {!msg.streaming && msg.content && (
        <div className="flex items-center gap-1.5 px-1">
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px] gap-1" onClick={() => onAppend(msg.content)}>
            <Copy className="h-3 w-3" /> Copy for document
          </Button>
          <Button variant="ghost" size="sm" className="h-6 px-2 text-[11px] gap-1" onClick={copy}>
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} {copied ? 'Copied' : 'Copy'}
          </Button>
        </div>
      )}
    </div>
  );
}

function CitationChip({
  c, onInsertCite,
}: { c: CiteChip; onInsertCite: (c: CiteChip, variant: 'short' | 'full' | 'footnote') => void }) {
  const label = c.order_label ?? c.title ?? 'Source';
  return (
    <span
      className="group inline-flex items-center gap-1 text-[11px] rounded border border-border bg-card hover:border-accent/50 transition overflow-hidden"
      title={c.cited_text ? `"${c.cited_text}"` : undefined}
    >
      {c.pdf_url ? (
        <a href={c.pdf_url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 pl-1.5 pr-1 py-0.5 text-foreground/80 hover:text-foreground">
          <span className="font-sans font-medium tabular-nums text-accent">[{c.num}]</span>
          <span>{label}</span>
          {c.page && <span className="text-muted-foreground tabular-nums">· {formatPagePin(c.page)}</span>}
          <ExternalLink className="h-2.5 w-2.5 opacity-60" />
        </a>
      ) : (
        <span className="inline-flex items-center gap-1 pl-1.5 pr-1 py-0.5 text-foreground/80">
          <span className="font-sans font-medium tabular-nums text-accent">[{c.num}]</span>
          <span>{label}</span>
          {c.page && <span className="text-muted-foreground tabular-nums">· {formatPagePin(c.page)}</span>}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title="Copy this citation"
            className="px-1 py-0.5 border-l border-border text-muted-foreground hover:text-accent hover:bg-accent/5"
          >
            <Plus className="h-2.5 w-2.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60 text-[12px]">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground font-sans">
            Copy for the document
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={() => onInsertCite(c, 'short')} className="flex flex-col items-start gap-0.5">
            <span className="font-medium">Short form</span>
            <span className="font-serif italic text-muted-foreground text-[11px]">{formatShortCite(c).trim()}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onInsertCite(c, 'full')} className="flex flex-col items-start gap-0.5">
            <span className="font-medium">Full citation</span>
            <span className="font-serif italic text-muted-foreground text-[11px] line-clamp-2">{formatFullCite(c).trim()}</span>
          </DropdownMenuItem>
          {c.cited_text && (
            <>
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5 max-w-[14rem]">
                <div className="text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground font-sans mb-1 inline-flex items-center gap-1">
                  <Quote className="h-2.5 w-2.5" /> Cited text
                </div>
                <p className="font-serif italic text-[11px] leading-snug text-foreground/80 line-clamp-4">
                  "{c.cited_text}"
                </p>
              </div>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

function SaveStatus({
  dirty, saving, lastSavedAt, hasActive,
}: {
  dirty: boolean;
  saving: boolean;
  lastSavedAt: number | null;
  hasActive: boolean;
}) {
  const ago = useRelativeTime(lastSavedAt);
  let status: { label: string; cls: string };
  if (saving) status = { label: 'Saving…', cls: 'text-muted-foreground' };
  else if (!hasActive) status = { label: 'No document', cls: 'text-muted-foreground' };
  else if (dirty) status = { label: 'Editing…', cls: 'text-muted-foreground' };
  else if (lastSavedAt) status = { label: `Saved ${ago}`, cls: 'text-muted-foreground' };
  else status = { label: 'Saved', cls: 'text-muted-foreground' };

  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md border border-border bg-card text-[11.5px] font-sans tabular-nums',
        status.cls,
      )}
    >
      {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
      {status.label}
    </span>
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
  docs, activeId, isLoading, query, setQuery, onPick, onNew, onImport, importing,
}: {
  docs: WorkspaceDocument[];
  activeId: string | null;
  isLoading: boolean;
  query: string;
  setQuery: (s: string) => void;
  onPick: (d: WorkspaceDocument) => void;
  onNew: () => void;
  onImport: () => void;
  importing: boolean;
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
        <div className="px-3 py-2.5 border-b border-border bg-card/60 flex items-center gap-1">
          <span className="text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground font-sans">
            {isLoading ? 'Loading…' : `${docs.length} doc${docs.length === 1 ? '' : 's'}`}
          </span>
          <Button
            size="sm"
            variant="ghost"
            className="ml-auto h-7 gap-1 px-1.5 text-[11.5px]"
            onClick={onImport}
            disabled={importing}
            title="Open a .docx from your files"
          >
            {importing ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <FileUp className="h-3.5 w-3.5" />}
          </Button>
          <Button size="sm" variant="ghost" className="h-7 gap-1 px-1.5 text-[11.5px]" onClick={onNew}>
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
              {docs.length === 0 ? (
                <>
                  <p className="mb-2">No documents yet.</p>
                  <p className="text-muted-foreground/80">
                    Open the .docx opposing counsel just sent, or start from a litigation skill.
                  </p>
                </>
              ) : (
                'No matches.'
              )}
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
                    <span className="flex items-center gap-1.5 min-w-0">
                      <span className={cn('truncate text-[12.5px]', active ? 'font-semibold text-foreground' : 'font-medium text-foreground/90')}>
                        {d.title || 'Untitled document'}
                      </span>
                      <span className="shrink-0 rounded border border-[hsl(215_60%_40%)]/30 bg-[hsl(215_60%_40%)]/5 px-1 py-px text-[8.5px] font-sans font-medium uppercase tracking-wide text-[hsl(215_60%_40%)]">
                        docx
                      </span>
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
