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
  MessageSquareText,
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
import { supabase, type WorkspaceDocument } from '@/lib/supabase';
import { useMatter } from '@/lib/matter-context';
import {
  useAiAssist,
  type AiAssistCitation,
  type AiAssistChunk,
  type AiAssistMatter,
  type AiAssistMeta,
} from '@/lib/useAiAssist';
import { useRedline } from '@/lib/useRedline';
import {
  occurrenceAt,
  scanPlaceholdersLocal,
  type PlaceholderHit,
  type Suggestion,
} from '@/lib/redline';
import {
  downloadDocx,
  printDocument,
  blocksToHtml,
  markdownToBlocks,
  downloadBlob,
  exportFilename,
} from '@/lib/file-export';
import { importDocx } from '@/lib/docx-import';
import {
  dedupeCitations,
  expandLabel,
  formatFootnoteCite,
  formatFullCite,
  formatPagePin,
  formatShortCite,
  citeSourceKey,
  type CiteChip,
} from '@/lib/bluebook';
import { cn } from '@/lib/utils';
import { ChangesPanel } from '@/components/draft/changes-panel';
import { ChecksPanel } from '@/components/draft/checks-panel';
import { RedlineView } from '@/components/draft/redline-view';
import { SelectionMenu, TRANSFORMS } from '@/components/draft/selection-menu';
import { CommandPalette, type PaletteTemplate } from '@/components/draft/command-palette';
import { VersionHistory, snapshotVersion } from '@/components/draft/version-history';
import { TierBadge } from '@/components/draft/tier-badge';
import {
  DRAFT_TEMPLATES,
  MARKUP_PRESETS,
  TemplateLauncher,
  type DraftTemplate,
} from '@/components/draft/templates';

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
  /** grounding state of the run that produced this assistant message */
  grounded?: boolean;
};

type ViewMode = 'edit' | 'review' | 'preview';
type AssistantTab = 'chat' | 'changes' | 'checks';

const DIRECT_APPLY_KEY = 'draft.directApplyTransforms';

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
  const [viewMode, setViewMode] = useState<ViewMode>('edit');
  const [selection, setSelection] = useState<{ start: number; end: number } | null>(null);
  const [transforming, setTransforming] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [savedTick, setSavedTick] = useState(0);
  const [railOpen, setRailOpen] = useState(true);
  const [railQuery, setRailQuery] = useState('');
  const [ground, setGround] = useState(true);
  const [activeTab, setActiveTab] = useState<AssistantTab>('chat');
  const [focusedSuggestionId, setFocusedSuggestionId] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [directApply, setDirectApply] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem(DIRECT_APPLY_KEY) === '1';
  });
  const [placeholderGate, setPlaceholderGate] = useState<{
    hits: PlaceholderHit[];
    action: 'docx' | 'pdf' | 'md';
  } | null>(null);
  const [importing, setImporting] = useState(false);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const editorScrollRef = useRef<HTMLDivElement | null>(null);
  const importInputRef = useRef<HTMLInputElement | null>(null);
  const assistantApiRef = useRef<{ send: (text: string) => void } | null>(null);
  const cursorRef = useRef<number>(0);
  const footnoteCounterRef = useRef<number>(0);
  const lastCiteKeyRef = useRef<string | null>(null);

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
    setViewMode('edit');
    setFocusedSuggestionId(null);
    redline.clear();
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
    onError: (e: Error) => toast.error(`Could not create document: ${e.message}`),
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
    onError: (e: Error) => toast.error(`Save failed: ${e.message}`),
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

  const newDocument = () => {
    createDoc.mutate({ title: 'Untitled document', content: '' });
  };

  // ---- .docx import (zero-dependency zip reader → markdown) ----
  const onImportFile = async (file: File) => {
    setImporting(true);
    try {
      const result = await importDocx(file, file.name);
      createDoc.mutate({ title: result.title || file.name.replace(/\.docx$/i, ''), content: result.markdown });
      toast.success(`Imported “${file.name}”`);
      for (const w of result.warnings) toast.message('Import note', { description: w });
    } catch (e) {
      toast.error(`Could not import: ${(e as Error).message}`);
    } finally {
      setImporting(false);
      if (importInputRef.current) importInputRef.current.value = '';
    }
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

  // auto-grow the textarea to its content (page scrolls, textarea doesn't)
  useEffect(() => {
    if (viewMode !== 'edit') return;
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.max(el.scrollHeight, 480)}px`;
  }, [content, viewMode]);

  // suggestions arriving → surface the review surfaces
  const hadSuggestions = useRef(0);
  useEffect(() => {
    if (redline.suggestions.length > 0 && hadSuggestions.current === 0) {
      setViewMode('review');
      setActiveTab('changes');
    }
    hadSuggestions.current = redline.suggestions.length;
  }, [redline.suggestions.length]);

  const syncSelection = () => {
    const el = textareaRef.current;
    if (!el) return;
    cursorRef.current = el.selectionStart;
    const start = el.selectionStart;
    const end = el.selectionEnd;
    if (end > start) setSelection({ start, end });
    else setSelection(null);
  };

  // ---- selection transforms ----
  const { run: runAssist } = useAiAssist();

  const setDirectApplyPersist = (v: boolean) => {
    setDirectApply(v);
    try { window.localStorage.setItem(DIRECT_APPLY_KEY, v ? '1' : '0'); } catch { /* private mode */ }
  };

  const runTransform = async (instruction: string) => {
    const el = textareaRef.current;
    if (!el || !selection) return;
    const { start, end } = selection;
    const selected = content.slice(start, end);
    if (!selected.trim()) return;
    setTransforming(true);

    if (directApply) {
      // legacy behavior: stream the replacement straight into the document
      const before = content.slice(0, start);
      const after = content.slice(end);
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
      const newEnd = before.length + finalText.length;
      requestAnimationFrame(() => {
        el.focus();
        el.setSelectionRange(before.length, newEnd);
        setSelection({ start: before.length, end: newEnd });
      });
      if (result) toast.success('Selection updated');
      return;
    }

    // suggestion flow: the rewrite arrives as a reviewable tracked change
    const result = await runAssist({
      mode: 'transform',
      instruction,
      selection: selected,
      document: content,
      caseId,
      matter: matterScope,
    });
    setTransforming(false);
    const finalText = result?.text?.trim();
    if (!finalText) {
      toast.error('The transform produced no text — try again.');
      return;
    }
    if (finalText === selected.trim()) {
      toast.message('No change suggested', { description: 'The passage already reads as requested.' });
      return;
    }
    const s: Suggestion = {
      id: `t${Date.now().toString(36)}`,
      dbId: crypto.randomUUID(),
      op: 'replace',
      anchor: selected,
      occurrence: occurrenceAt(content, selected, start),
      start,
      end,
      text: finalText,
      rationale: TRANSFORMS.find((t) => t.instruction === instruction)?.label
        ? `${TRANSFORMS.find((t) => t.instruction === instruction)!.label} (selection transform)`
        : instruction.slice(0, 120),
      cite: null,
      confidence: 'high',
      match_mode: 'exact',
      status: 'pending',
      source: 'transform',
    };
    redline.addLocal(s);
    setFocusedSuggestionId(s.id);
    setViewMode('review');
    setActiveTab('changes');
    toast.success('Suggestion ready for review');
  };

  // ---- markup passes (verified redline) ----
  const runMarkup = async (instruction: string, scope: { start: number; end: number } | null) => {
    if (!content.trim()) {
      toast.error('Nothing to review yet — the document is empty.');
      return;
    }
    if (activeId) {
      // snapshot before the pass so "what did the machine change" is always answerable
      snapshotVersion({ documentId: activeId, caseId, content, label: 'Before markup pass' }).catch(() => {});
      qc.invalidateQueries({ queryKey: ['document-versions', activeId] });
    }
    setActiveTab('changes');
    const ok = await redline.run({
      instruction,
      document: content,
      selection: scope,
      ground,
      caseId,
      matter: matterScope,
      documentId: activeId,
    });
    if (!ok && !redline.error) toast.message('No suggestions', { description: 'The reviewer found nothing to change for that instruction.' });
  };

  // ---- suggestion resolution ----
  const acceptSuggestion = (id: string) => {
    const next = redline.resolve(id, 'accepted', content);
    if (next === null) {
      toast.error('Could not locate that anchor anymore — the text may have changed. Dismiss the suggestion or undo your edit.');
      return;
    }
    if (next !== content) {
      setContent(next);
      setDirty(true);
    }
    setFocusedSuggestionId(null);
  };

  const rejectSuggestion = (id: string) => {
    redline.resolve(id, 'rejected', content);
    setFocusedSuggestionId(null);
  };

  const acceptAllSuggestions = () => {
    const { next, applied, skipped } = redline.acceptAll(content);
    if (applied > 0) {
      setContent(next);
      setDirty(true);
      toast.success(`Accepted ${applied} suggestion${applied === 1 ? '' : 's'}${skipped ? ` · ${skipped} could not be located` : ''}`);
    } else if (skipped > 0) {
      toast.error('None of the pending suggestions could be located — the document has changed too much.');
    }
  };

  const rejectAllSuggestions = () => {
    redline.rejectAll();
    toast.message('Suggestions dismissed');
  };

  // ---- export (placeholder gate first) ----
  const doExport = (action: 'docx' | 'pdf' | 'md') => {
    if (action === 'docx') {
      downloadDocx(`${currentMatter.short_name}-${title}`.slice(0, 80), markdownToBlocks(content || `# ${title}`));
      toast.success('Exported to Word (.docx)');
    } else if (action === 'pdf') {
      const ok = printDocument({
        title: title || 'Document',
        metaLine: `<span class="matter">${currentMatter.short_name}</span> · MDL ${currentMatter.mdl_number}`,
        bodyHtml: blocksToHtml(markdownToBlocks(content || `# ${title}`)),
      });
      if (!ok) toast.error('Allow pop-ups to print / save as PDF');
    } else {
      downloadBlob(exportFilename(`${currentMatter.short_name}-${title}`, 'md'), new Blob([content], { type: 'text/markdown;charset=utf-8' }));
      toast.success('Exported Markdown (.md)');
    }
  };

  const guardedExport = (action: 'docx' | 'pdf' | 'md') => {
    const hits = scanPlaceholdersLocal(content);
    if (hits.length > 0) setPlaceholderGate({ hits, action });
    else doExport(action);
  };

  // ---- insertion from chat ----
  const appendToDoc = (text: string) => {
    const next = content ? `${content}\n\n${text}` : text;
    setContent(next);
    setDirty(true);
    toast.success('Appended to document');
  };

  // Insert a citation in one of three Bluebook forms; auto-substitute *Id.* on repeats.
  const insertCitation = (c: CiteChip, variant: 'short' | 'full' | 'footnote') => {
    const key = citeSourceKey(c);
    if (variant === 'footnote') {
      const n = ++footnoteCounterRef.current;
      const { marker, definition } = formatFootnoteCite(c, n);
      const pos = Math.min(cursorRef.current, content.length);
      const withMarker = content.slice(0, pos) + marker + content.slice(pos);
      const withDef = withMarker.trimEnd() + `\n\n${definition}\n`;
      setContent(withDef);
      setDirty(true);
      lastCiteKeyRef.current = key;
      requestAnimationFrame(() => {
        const el = textareaRef.current;
        if (el) {
          const newPos = pos + marker.length;
          el.focus();
          el.setSelectionRange(newPos, newPos);
          cursorRef.current = newPos;
        }
      });
      toast.success(`Inserted footnote [^${n}]`);
      return;
    }
    let text: string;
    if (lastCiteKeyRef.current === key) {
      const pos = Math.min(cursorRef.current, content.length);
      const tail = content.slice(Math.max(0, pos - 4), pos);
      if (/[).”"]\s*$/.test(tail) || /\)\s*\.?\s*$/.test(tail)) {
        text = c.page ? ` (*Id.* at ${formatPagePin(c.page)})` : ' (*Id.*)';
      } else {
        text = variant === 'full' ? formatFullCite(c) : formatShortCite(c);
      }
    } else {
      text = variant === 'full' ? formatFullCite(c) : formatShortCite(c);
    }
    lastCiteKeyRef.current = key;
    const pos = Math.min(cursorRef.current, content.length);
    const next = content.slice(0, pos) + text + content.slice(pos);
    setContent(next);
    setDirty(true);
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(pos + text.length, pos + text.length);
        cursorRef.current = pos + text.length;
      }
    });
    toast.success('Citation inserted');
  };

  // jump from a check finding into the editor at a character range
  const jumpToRange = (start: number, end: number) => {
    setViewMode('edit');
    requestAnimationFrame(() => {
      const el = textareaRef.current;
      if (!el) return;
      el.focus();
      el.setSelectionRange(start, Math.min(end, el.value.length));
      cursorRef.current = start;
      setSelection({ start, end: Math.min(end, el.value.length) });
      // nudge the browser to scroll the caret into view
      el.blur();
      el.focus();
    });
  };

  const paletteTemplates: PaletteTemplate[] = useMemo(
    () => [
      ...MARKUP_PRESETS.map((m) => ({ title: m.title, category: 'Markup', prompt: m.instruction })),
      ...DRAFT_TEMPLATES.map((t) => ({ title: t.title, category: t.category, prompt: t.prompt })),
    ],
    [],
  );

  const wordCount = useMemo(() => (content.trim() ? content.trim().split(/\s+/).length : 0), [content]);

  return (
    <AppShell>
      <PageHeader
        title="Drafting Workspace"
        description="Draft with an assistant grounded in the matter's record. AI edits arrive as tracked changes — every suggestion anchored to text verified to exist in the document."
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
            dirty={dirty}
            saving={saveDoc.isPending}
            lastSavedAt={lastSavedAt}
            hasActive={!!activeId}
            onSave={() => saveDoc.mutate()}
          />
          <VersionHistory
            documentId={activeId}
            caseId={caseId}
            currentContent={content}
            onRestore={(c) => {
              setContent(c);
              setDirty(true);
              setViewMode('edit');
            }}
          />

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="sm" className="gap-2" disabled={!content.trim()}>
                <ArrowDownToLine className="h-4 w-4" /> Export
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuItem onClick={() => guardedExport('docx')} className="gap-2 cursor-pointer"><FileTextIcon className="h-4 w-4 text-[hsl(215_60%_40%)]" /> Word document (.docx)</DropdownMenuItem>
              <DropdownMenuItem onClick={() => guardedExport('pdf')} className="gap-2 cursor-pointer"><FileTextIcon className="h-4 w-4 text-muted-foreground" /> Print / Save as PDF</DropdownMenuItem>
              <DropdownMenuItem onClick={() => guardedExport('md')} className="gap-2 cursor-pointer"><FileTextIcon className="h-4 w-4 text-muted-foreground" /> Markdown (.md)</DropdownMenuItem>
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
            onImport={() => importInputRef.current?.click()}
            importing={importing}
          />
        )}

        {/* EDITOR */}
        <div className="lg:flex-[3] min-w-0 flex flex-col mb-5 lg:mb-0">
          <Card className="p-0 flex flex-col flex-1 overflow-hidden bg-secondary/25">
            {/* editor toolbar */}
            <div className="flex items-center gap-3 px-4 py-2.5 border-b border-border bg-card">
              <Input
                value={title}
                onChange={(e) => { setTitle(e.target.value); setDirty(true); }}
                placeholder="Document title…"
                className="h-8 border-0 shadow-none px-0 font-serif text-base font-semibold focus-visible:ring-0 bg-transparent"
              />
              <div className="ml-auto flex items-center gap-1.5 shrink-0">
                <span className="text-[11px] text-muted-foreground tabular-nums font-sans mr-1">{wordCount} words</span>
                <Button variant={viewMode === 'edit' ? 'secondary' : 'ghost'} size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setViewMode('edit')}>
                  <Pencil className="h-3.5 w-3.5" /> Edit
                </Button>
                <Button
                  variant={viewMode === 'review' ? 'secondary' : 'ghost'}
                  size="sm"
                  className="h-7 gap-1.5 text-xs relative"
                  onClick={() => setViewMode('review')}
                >
                  <FileDiff className="h-3.5 w-3.5" /> Review
                  {pendingSuggestions.length > 0 && (
                    <span className="ml-0.5 rounded-full bg-accent text-accent-foreground px-1.5 py-px text-[10px] font-sans tabular-nums leading-[1.4]">
                      {pendingSuggestions.length}
                    </span>
                  )}
                </Button>
                <Button variant={viewMode === 'preview' ? 'secondary' : 'ghost'} size="sm" className="h-7 gap-1.5 text-xs" onClick={() => setViewMode('preview')}>
                  <Eye className="h-3.5 w-3.5" /> Preview
                </Button>
              </div>
            </div>

            {/* the page */}
            <div ref={editorScrollRef} className="relative flex-1 overflow-y-auto">
              <div className="mx-auto my-5 w-[min(100%-2rem,54rem)] min-h-[70%] rounded-sm border border-border/70 bg-card px-8 py-8 lg:px-14 lg:py-12 shadow-[0_1px_2px_rgba(23,37,60,0.06),0_10px_30px_-18px_rgba(23,37,60,0.35)]">
                {viewMode === 'preview' && (
                  <div className="answer-prose max-w-none font-serif">
                    {content.trim() ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{content}</ReactMarkdown>
                    ) : (
                      <p className="text-sm text-muted-foreground italic">Nothing to preview yet.</p>
                    )}
                  </div>
                )}
                {viewMode === 'review' && (
                  <RedlineView
                    doc={content}
                    suggestions={redline.suggestions}
                    focusedId={focusedSuggestionId}
                    onFocus={(id) => {
                      setFocusedSuggestionId(id);
                      setActiveTab('changes');
                    }}
                  />
                )}
                {viewMode === 'edit' && (
                  <Textarea
                    ref={textareaRef}
                    value={content}
                    onChange={(e) => onContentChange(e.target.value)}
                    onSelect={syncSelection}
                    onKeyUp={syncSelection}
                    onClick={syncSelection}
                    placeholder={docs.length === 0 && !content
                      ? 'Start writing, open a .docx from the record, or draft from a litigation skill…'
                      : 'Start writing, or ask the assistant to draft a section for you…'}
                    className="w-full resize-none overflow-hidden border-0 shadow-none focus-visible:ring-0 rounded-none font-serif text-[15px] leading-[1.75] p-0 bg-transparent min-h-[60vh]"
                    spellCheck
                  />
                )}
              </div>

              {/* floating selection menu (edit mode only) */}
              {viewMode === 'edit' && (
                <SelectionMenu
                  textareaRef={textareaRef}
                  containerRef={editorScrollRef}
                  selection={selection}
                  busy={transforming || redline.running}
                  directApply={directApply}
                  onDirectApplyChange={setDirectApplyPersist}
                  onTransform={runTransform}
                  onSuggestEdits={(instr) => runMarkup(instr, selection)}
                />
              )}
            </div>
          </Card>
        </div>

        {/* ASSISTANT */}
        <AssistantPane
          caseId={caseId}
          matter={matterScope}
          documentText={content}
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
          onRunMarkup={(instr) => runMarkup(instr, null)}
          onAppend={appendToDoc}
          onInsertCite={insertCitation}
          onJumpTo={jumpToRange}
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
        onPickDoc={loadDoc}
        onNew={newDocument}
        onImport={() => importInputRef.current?.click()}
        onRunTemplate={(t) => {
          if (t.category === 'Markup') void runMarkup(t.prompt, null);
          else {
            setActiveTab('chat');
            assistantApiRef.current?.send(t.prompt);
          }
        }}
        onToggleGround={() => setGround((g) => !g)}
        onExportDocx={() => guardedExport('docx')}
        onExportPdf={() => guardedExport('pdf')}
        onExportMd={() => guardedExport('md')}
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
              These blanks are still in the document. Filings shouldn't leave the building with
              placeholders — jump to each one, or export anyway.
            </DialogDescription>
          </DialogHeader>
          <div className="max-h-56 overflow-y-auto rounded-md border border-border">
            {placeholderGate?.hits.map((h, i) => (
              <button
                key={i}
                type="button"
                className="flex w-full items-center gap-2 border-b border-border/50 px-3 py-1.5 text-left last:border-b-0 hover:bg-secondary/40"
                onClick={() => {
                  setPlaceholderGate(null);
                  jumpToRange(h.start, h.end);
                }}
              >
                <span className="font-mono text-[12px] text-amber-800">{h.quote}</span>
              </button>
            ))}
          </div>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setPlaceholderGate(null)}>Keep editing</Button>
            <Button
              variant="outline"
              onClick={() => {
                const g = placeholderGate;
                setPlaceholderGate(null);
                if (g) doExport(g.action);
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
        accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) void onImportFile(f);
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
  onJumpTo,
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
  onJumpTo: (start: number, end: number) => void;
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

        {/* playbook chip — visible proof the practice profile was consulted */}
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
            <ChecksPanel document={documentText} caseId={caseId} matter={matter} onJump={onJumpTo} />
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
        Suggestions arrive as tracked changes, verbatim-anchored{ground ? ' · grounded in the record' : ''}.
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
      {/* reviewer note — the citation-trust mechanic when grounding was off */}
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

function CitationChip({
  c, onInsertCite,
}: { c: CiteChip; onInsertCite: (c: CiteChip, variant: 'short' | 'full' | 'footnote') => void }) {
  const label = c.order_label ?? c.title ?? 'Source';
  const copyBluebook = () => {
    const text = formatShortCite(c).trim();
    navigator.clipboard?.writeText(text).then(() => toast.success('Bluebook cite copied'));
  };
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
            title="Insert this citation"
            className="px-1 py-0.5 border-l border-border text-muted-foreground hover:text-accent hover:bg-accent/5"
          >
            <Plus className="h-2.5 w-2.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60 text-[12px]">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground font-sans">
            Insert at cursor
          </DropdownMenuLabel>
          <DropdownMenuItem onClick={() => onInsertCite(c, 'short')} className="flex flex-col items-start gap-0.5">
            <span className="font-medium">Short form</span>
            <span className="font-serif italic text-muted-foreground text-[11px]">{formatShortCite(c).trim()}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onInsertCite(c, 'full')} className="flex flex-col items-start gap-0.5">
            <span className="font-medium">Full citation</span>
            <span className="font-serif italic text-muted-foreground text-[11px] line-clamp-2">{formatFullCite(c).trim()}</span>
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => onInsertCite(c, 'footnote')} className="flex flex-col items-start gap-0.5">
            <span className="font-medium">Footnote</span>
            <span className="font-serif italic text-muted-foreground text-[11px]">Inline [^n] + definition at doc end</span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={copyBluebook}>
            <Copy className="h-3 w-3 mr-2" /> Copy Bluebook cite
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
                    Start from a litigation skill, or open the .docx opposing counsel just sent.
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
