import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient, queryOptions } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Plus,
  Save,
  Trash2,
  FileText as FileTextIcon,
  Loader2,
  ChevronDown,
  CornerDownLeft,
  BookOpen,
  ArrowDownToLine,
  Search,
  Sparkles,
  MoreHorizontal,
  Layers,
  ChevronsLeft,
  ChevronsRight,
  X,
  Star,
  Hash,
  Type as TypeIcon,
  ChevronRight,
} from 'lucide-react';
import { toast } from 'sonner';
import { AppShell } from '@/components/app-shell';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
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
import { supabase, type WorkspaceDocument } from '@/lib/supabase';
import { useMatter } from '@/lib/matter-context';
import { useAiAssist } from '@/lib/useAiAssist';
import {
  downloadDocx,
  printDocument,
  blocksToHtml,
  markdownToBlocks,
  downloadBlob,
  exportFilename,
} from '@/lib/file-export';
import { normalizeBluebook } from '@/lib/bluebook';
import {
  DRAFT_TEMPLATES,
  TEMPLATE_CATEGORIES,
  resolveTemplatePrompt,
  buildDefaultVars,
  type DraftTemplate,
  type TemplateCategory,
} from '@/lib/draft-templates';
import {
  FORMAT_PRESETS,
  getPreset,
  type PresetId,
} from '@/lib/format-presets';
import { cn } from '@/lib/utils';
import { LegalEditor } from '@/components/editor/legal-editor';
import type { Editor } from '@tiptap/react';
import { markdownToHtml } from '@/lib/tiptap-markdown';
import { ProposalCard, type Proposal, type CiteChip } from '@/components/editor/proposal-card';
import { VOICE_ACTIONS } from '@/components/editor/voice-actions';
import {
  acceptChange,
  rejectChange,
  acceptAll,
  rejectAll,
  findMarkRange,
  listChangeIds,
  newChangeId,
  type ChangeId,
} from '@/components/editor/track-changes';
import { ChangePill } from '@/components/editor/change-pill';
import { drainDraftQueue } from '@/lib/depo-clipboard';

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

function DraftPage() {
  const { currentMatter } = useMatter();
  const caseId = currentMatter.master_case_id;
  const qc = useQueryClient();
  const { data: docs = [], isLoading } = useQuery(docsQuery(caseId));

  const [activeId, setActiveId] = useState<string | null>(null);
  const [title, setTitle] = useState('Untitled document');
  const [content, setContent] = useState('');
  const [dirty, setDirty] = useState(false);
  const [lastSavedAt, setLastSavedAt] = useState<number | null>(null);
  const [savedTick, setSavedTick] = useState(0);
  const [railOpen, setRailOpen] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    const raw = window.localStorage.getItem('draft.railOpen');
    return raw == null ? true : raw === '1';
  });
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('draft.railOpen', railOpen ? '1' : '0');
    }
  }, [railOpen]);
  const [railQuery, setRailQuery] = useState('');
  const [railMode, setRailMode] = useState<'docs' | 'outline'>('docs');
  const [sidecarOpen, setSidecarOpen] = useState(true);
  const footnoteCounterRef = useRef(0);
  const lastCiteKeyRef = useRef<string | null>(null);
  const cursorRef = useRef<number>(0);
  const editorRef = useRef<Editor | null>(null);

  // Track-changes state
  const [suggestionsOn, setSuggestionsOn] = useState<boolean>(() => {
    if (typeof window === 'undefined') return true;
    return window.localStorage.getItem('draft.suggestions') !== '0';
  });
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('draft.suggestions', suggestionsOn ? '1' : '0');
    }
  }, [suggestionsOn]);
  const [activeChangeId, setActiveChangeId] = useState<ChangeId | null>(null);
  const [changeStreaming, setChangeStreaming] = useState(false);
  const [pendingChangeCount, setPendingChangeCount] = useState(0);
  const lastTransformRef = useRef<{
    instruction: string;
    selectionText: string;
    changeId: ChangeId;
  } | null>(null);

  // Editorial polish state
  const [focusMode, setFocusMode] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('draft.focus') === '1';
  });
  useEffect(() => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('draft.focus', focusMode ? '1' : '0');
    }
  }, [focusMode]);
  // ⌘. keyboard toggle for focus mode
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === '.') {
        e.preventDefault();
        setFocusMode((v) => !v);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Derived: live word count + reading time
  const stats = useMemo(() => {
    const plain = content
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/[#*_>`~[\]()\-!]/g, ' ');
    const words = plain.trim() ? plain.trim().split(/\s+/).length : 0;
    const readMin = Math.max(1, Math.round(words / 220));
    return { words, readMin };
  }, [content]);

  // Track pending suggestion count from the editor
  useEffect(() => {
    const ed = editorRef.current;
    if (!ed) return;
    const update = () => setPendingChangeCount(listChangeIds(ed).length);
    update();
    ed.on('transaction', update);
    return () => {
      ed.off('transaction', update);
    };
  }, [editorRef.current]);


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

  useEffect(() => {
    if (activeId && docs.some((d) => d.id === activeId)) return;
    if (docs.length) loadDoc(docs[0]);
    else {
      setActiveId(null);
      setTitle('Untitled document');
      setContent('');
      setDirty(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docs]);

  const loadDoc = (d: WorkspaceDocument) => {
    setActiveId(d.id);
    setTitle(d.title);
    setContent(d.content);
    setDirty(false);
  };

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

  const newDocument = () => createDoc.mutate({ title: 'Untitled document', content: '' });


  const onContentChange = useCallback((v: string) => {
    setContent(v);
    setDirty(true);
  }, []);

  // autosave
  useEffect(() => {
    if (!dirty || !activeId || saveDoc.isPending) return;
    const t = setTimeout(() => saveDoc.mutate(), 1500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, activeId, title, content]);

  useEffect(() => {
    const id = setInterval(() => setSavedTick((n) => n + 1), 15000);
    return () => clearInterval(id);
  }, []);
  void savedTick;

  // export
  const exportDocx = () => {
    downloadDocx(
      `${currentMatter.short_name}-${title}`.slice(0, 80),
      markdownToBlocks(content || `# ${title}`),
    );
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
    downloadBlob(
      exportFilename(`${currentMatter.short_name}-${title}`, 'md'),
      new Blob([content], { type: 'text/markdown;charset=utf-8' }),
    );
    toast.success('Exported Markdown (.md)');
  };

  const polishBluebook = useCallback(() => {
    if (!content.trim()) {
      toast.error('Nothing to polish yet');
      return;
    }
    const { markdown, report } = normalizeBluebook(content);
    if (markdown === content) {
      toast.success('Citations already Bluebook-clean');
      return;
    }
    setContent(markdown);
    setDirty(true);
    const total = Object.values(report.totals).reduce((a, b) => a + b, 0);
    const bits: string[] = [];
    if (report.totals.reporter) bits.push(`${report.totals.reporter} reporter${report.totals.reporter === 1 ? '' : 's'}`);
    if (report.totals.signal) bits.push(`${report.totals.signal} signal${report.totals.signal === 1 ? '' : 's'}`);
    if (report.totals.id) bits.push(`${report.totals.id} Id.`);
    if (report.totals.short) bits.push(`${report.totals.short} short-form`);
    if (report.totals.pincite) bits.push(`${report.totals.pincite} pincite${report.totals.pincite === 1 ? '' : 's'}`);
    if (report.totals.italic) bits.push(`${report.totals.italic} italics`);
    if (report.totals.smart) bits.push(`${report.totals.smart} smart quote${report.totals.smart === 1 ? '' : 's'}`);
    toast.success(`Bluebook polish · ${total} fix${total === 1 ? '' : 'es'}`, {
      description: bits.join(' · ') || undefined,
    });
  }, [content]);

  const appendToDoc = (text: string) => {
    const next = content ? `${content}\n\n${text}` : text;
    setContent(next);
    setDirty(true);
    toast.success('Appended to document');
  };

  // Drain the cross-page paste queue once per mount (e.g. "Send to Draft" from
  // the depositions workspace). Runs after the editor is ready.
  const drainedRef = useRef(false);
  useEffect(() => {
    if (drainedRef.current) return;
    const queued = drainDraftQueue();
    if (queued.length === 0) return;
    drainedRef.current = true;
    const block = queued.map((q) => q.markdown).join('\n\n');
    setContent((prev) => (prev ? `${prev}\n\n${block}` : block));
    setDirty(true);
    toast.success(`Pasted ${queued.length} item${queued.length === 1 ? '' : 's'} from depositions`);
  }, []);

  const insertCitation = (c: CiteChip, variant: 'short' | 'full' | 'footnote') => {
    const key = citeSourceKey(c);
    if (variant === 'footnote') {
      const n = ++footnoteCounterRef.current;
      const { marker, definition } = formatFootnoteCite(c, n);
      const withMarker = content.trimEnd() + ' ' + marker;
      const withDef = withMarker + `\n\n${definition}\n`;
      setContent(withDef);
      setDirty(true);
      lastCiteKeyRef.current = key;
      toast.success(`Inserted footnote [^${n}]`);
      return;
    }
    const text = variant === 'full' ? formatFullCite(c) : formatShortCite(c);
    lastCiteKeyRef.current = key;
    const next = content.trimEnd() + text;
    setContent(next);
    setDirty(true);
    toast.success('Citation appended');
  };

  const acceptActive = () => {
    const ed = editorRef.current;
    if (!ed || !activeChangeId) return;
    if (acceptChange(ed, activeChangeId)) {
      setActiveChangeId(null);
      setDirty(true);
    }
  };
  const rejectActive = () => {
    const ed = editorRef.current;
    if (!ed || !activeChangeId) return;
    if (rejectChange(ed, activeChangeId)) {
      setActiveChangeId(null);
      setDirty(true);
    }
  };
  const regenerateActive = async () => {
    const ed = editorRef.current;
    const last = lastTransformRef.current;
    if (!ed || !activeChangeId || !last) return;
    // Clear existing insertion, then re-stream into the same change slot.
    const insR = findMarkRange(ed, 'insertion', activeChangeId);
    if (insR) {
      const tr = ed.state.tr.delete(insR.from, insR.to);
      ed.view.dispatch(tr);
    }
    await streamIntoChange(activeChangeId, last.instruction, last.selectionText);
  };

  const handleAcceptAll = () => {
    const ed = editorRef.current;
    if (!ed) return;
    const n = acceptAll(ed);
    if (n) {
      setActiveChangeId(null);
      setDirty(true);
      toast.success(`Accepted ${n} suggestion${n === 1 ? '' : 's'}`);
    }
  };
  const handleRejectAll = () => {
    const ed = editorRef.current;
    if (!ed) return;
    const n = rejectAll(ed);
    if (n) {
      setActiveChangeId(null);
      setDirty(true);
      toast.success(`Rejected ${n} suggestion${n === 1 ? '' : 's'}`);
    }
  };

  return (
    <AppShell>
      {/* Compact top bar — replaces PageHeader, saves ~110px of vertical space */}
      <DocumentBar
        title={title}
        onTitleChange={(v) => {
          setTitle(v);
          setDirty(true);
        }}
        dirty={dirty}
        saving={saveDoc.isPending}
        lastSavedAt={lastSavedAt}
        hasActive={!!activeId}
        onSave={() => saveDoc.mutate()}
        onExportDocx={exportDocx}
        onExportPdf={exportPdf}
        onExportMd={exportMarkdown}
        onPolish={polishBluebook}
        canExport={!!content.trim()}
        onDelete={activeId ? () => deleteDoc.mutate(activeId) : undefined}
        matterShort={currentMatter.short_name}
        mdlNumber={currentMatter.mdl_number}
        railOpen={railOpen}
        onToggleRail={() => setRailOpen((v) => !v)}
        sidecarOpen={sidecarOpen}
        onToggleSidecar={() => setSidecarOpen((v) => !v)}
        docs={docs}
        activeId={activeId}
        isLoading={isLoading}
        onPickDoc={loadDoc}
        onNewDoc={newDocument}
        wordCount={stats.words}
        readMin={stats.readMin}
      />

      <div className="lg:h-[calc(100vh-54px)] lg:flex lg:overflow-hidden">
        <DocumentRail
          open={railOpen}
          onToggle={() => setRailOpen((v) => !v)}
          mode={railMode}
          onModeChange={setRailMode}
          docs={docs}
          activeId={activeId}
          isLoading={isLoading}
          query={railQuery}
          setQuery={setRailQuery}
          onPick={loadDoc}
          onNew={newDocument}
          editor={editorRef.current}
        />

        {/* Editor */}
        <div
          className={cn(
            'lg:flex-1 min-w-0 min-h-0 flex flex-col bg-[color-mix(in_oklab,var(--card)_35%,transparent)] relative',
            focusMode && 'legal-focus-mode',
          )}
        >
          <LegalEditor
            value={content}
            onChange={onContentChange}
            onReady={(ed) => {
              editorRef.current = ed;
            }}
            onAskClaude={({ text, kind }) => {
              setSidecarOpen(true);
              window.dispatchEvent(
                new CustomEvent('legal-ask-claude', { detail: { text, kind } }),
              );
            }}
            onVoiceAction={async (payload) => {
              await runInlineTransform(payload);
            }}
            className="flex-1 min-h-0"
          />
          <ChangePill
            editor={editorRef.current}
            changeId={activeChangeId}
            streaming={changeStreaming}
            onAccept={acceptActive}
            onReject={rejectActive}
            onRegenerate={regenerateActive}
          />
        </div>

        {sidecarOpen && (
          <ClaudeSidecar
            caseId={caseId}
            matter={matterScope}
            documentText={content}
            onAppend={appendToDoc}
            onInsertCite={insertCitation}
            onClose={() => setSidecarOpen(false)}
          />
        )}
      </div>
    </AppShell>
  );

  async function runInlineTransform({
    instruction,
    selectionText,
    from,
    to,
  }: {
    instruction: string;
    selectionText: string;
    from: number;
    to: number;
  }) {
    const editor = editorRef.current;
    if (!editor || !selectionText.trim() || to <= from) {
      toast.error('Highlight text first');
      return;
    }

    // OFF path — direct in-place replacement (previous behavior).
    if (!suggestionsOn) {
      const applyDirect = (buf: string) => {
        const ed = editorRef.current;
        if (!ed) return;
        const scrollEl = document.querySelector<HTMLElement>('.legal-editor-content');
        const top = scrollEl?.scrollTop ?? 0;
        const html = markdownToHtml(buf);
        ed.chain()
          .insertContentAt(
            { from, to: currentDirectEnd },
            html,
            { updateSelection: false, parseOptions: { preserveWhitespace: 'full' } },
          )
          .run();
        currentDirectEnd = from + (ed.state.doc.content.size - directBase);
        if (scrollEl) scrollEl.scrollTop = top;
      };
      const directBase = editor.state.doc.content.size - (to - from);
      let currentDirectEnd = to;
      let acc = '';
      let raf = 0;
      const t = toast.loading('Refining selection…');
      const res = await runAssistDirect({
        mode: 'transform',
        instruction,
        selection: selectionText,
        document: content,
        caseId,
        matter: matterScope,
        onText: (delta) => {
          acc += delta;
          if (!raf) {
            raf = requestAnimationFrame(() => {
              raf = 0;
              applyDirect(acc);
            });
          }
        },
      });
      if (raf) cancelAnimationFrame(raf);
      toast.dismiss(t);
      applyDirect((res?.text ?? acc).trim() || selectionText);
      setDirty(true);
      toast.success('Selection updated');
      return;
    }

    // ON path — create a track-change pair.
    const cid = newChangeId();
    const insMark = editor.schema.marks['insertion'];
    const delMark = editor.schema.marks['deletion'];
    if (!insMark || !delMark) {
      toast.error('Track-changes marks missing');
      return;
    }

    // 1) Wrap the selection with the deletion mark, then collapse the cursor
    //    to the end of the deletion so the streamed insertion appears right
    //    after it. Don't scroll into view.
    const tr = editor.state.tr;
    tr.addMark(from, to, delMark.create({ changeId: cid }));
    editor.view.dispatch(tr);
    editor.commands.setTextSelection(to);

    setActiveChangeId(cid);
    lastTransformRef.current = { instruction, selectionText, changeId: cid };
    await streamIntoChange(cid, instruction, selectionText);
    setDirty(true);
  }

  async function streamIntoChange(
    cid: ChangeId,
    instruction: string,
    selectionText: string,
  ) {
    const editor = editorRef.current;
    if (!editor) return;
    setChangeStreaming(true);
    const t = toast.loading('Refining selection…');
    let acc = '';
    const scrollEl = document.querySelector<HTMLElement>('.legal-editor-content');

    const flush = (buf: string) => {
      const ed = editorRef.current;
      if (!ed) return;
      const top = scrollEl?.scrollTop ?? 0;
      const insR = findMarkRange(ed, 'insertion', cid);
      const delR = findMarkRange(ed, 'deletion', cid);
      // Where should the insertion live? Right after the deletion end, or
      // replace the existing insertion span if one already exists.
      const anchor = insR ?? { from: delR?.to ?? 0, to: delR?.to ?? 0 };
      const escaped = buf
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      const html = `<ins data-cid="${cid}">${escaped}</ins>`;
      ed.chain()
        .insertContentAt(anchor, html, {
          updateSelection: false,
          parseOptions: { preserveWhitespace: 'full' },
        })
        .run();
      if (scrollEl) scrollEl.scrollTop = top;
    };

    let raf = 0;
    const res = await runAssistDirect({
      mode: 'transform',
      instruction,
      selection: selectionText,
      document: content,
      caseId,
      matter: matterScope,
      onText: (delta) => {
        acc += delta;
        if (!raf) {
          raf = requestAnimationFrame(() => {
            raf = 0;
            flush(acc);
          });
        }
      },
    });
    if (raf) cancelAnimationFrame(raf);
    const finalText = (res?.text ?? acc).trim() || selectionText;
    flush(finalText);
    toast.dismiss(t);
    setChangeStreaming(false);
    toast.success('Suggestion ready — accept or reject');
  }
}

// ------- module-local runner so inline transform doesn't need its own hook instance --------

let sharedRunAssist: ReturnType<typeof useAiAssist>['run'] | null = null;
function useShareRunner() {
  const { run } = useAiAssist();
  useEffect(() => {
    sharedRunAssist = run;
  }, [run]);
}
async function runAssistDirect(req: Parameters<NonNullable<typeof sharedRunAssist>>[0]) {
  if (!sharedRunAssist) return null;
  return sharedRunAssist(req);
}

// ============================================================
// Document bar (replaces PageHeader on this route)
// ============================================================

function DocumentBar({
  title,
  onTitleChange,
  dirty,
  saving,
  lastSavedAt,
  hasActive,
  onSave,
  onExportDocx,
  onExportPdf,
  onExportMd,
  onPolish,
  canExport,
  onDelete,
  matterShort,
  mdlNumber,
  railOpen,
  onToggleRail,
  sidecarOpen,
  onToggleSidecar,
  docs,
  activeId,
  isLoading,
  onPickDoc,
  onNewDoc,
  wordCount,
  readMin,
}: {
  title: string;
  onTitleChange: (v: string) => void;
  dirty: boolean;
  saving: boolean;
  lastSavedAt: number | null;
  hasActive: boolean;
  onSave: () => void;
  onExportDocx: () => void;
  onExportPdf: () => void;
  onExportMd: () => void;
  onPolish: () => void;
  canExport: boolean;
  onDelete?: () => void;
  matterShort: string;
  mdlNumber: string;
  railOpen: boolean;
  onToggleRail: () => void;
  sidecarOpen: boolean;
  onToggleSidecar: () => void;
  docs: WorkspaceDocument[];
  activeId: string | null;
  isLoading: boolean;
  onPickDoc: (d: WorkspaceDocument) => void;
  onNewDoc: () => void;
  wordCount: number;
  readMin: number;
}) {
  return (
    <div className="h-[54px] border-b border-border bg-card/70 backdrop-blur-sm px-4 flex items-center gap-2 shrink-0">
      <Button
        variant="ghost"
        size="sm"
        onClick={onToggleRail}
        className="h-8 w-8 p-0 hidden lg:inline-flex"
        title={railOpen ? 'Hide documents' : 'Show documents'}
      >
        <Layers className="h-4 w-4" />
      </Button>
      <div className="lg:hidden">
        <DocumentMenu
          docs={docs}
          activeId={activeId}
          isLoading={isLoading}
          onPick={onPickDoc}
          onNew={onNewDoc}
        />
      </div>

      <div className="hidden md:flex items-center gap-1.5 text-[10.5px] font-sans uppercase tracking-[0.14em] text-muted-foreground px-1.5">
        <span className="text-accent/80">{matterShort}</span>
        <span className="text-muted-foreground/50">·</span>
        <span>MDL {mdlNumber}</span>
      </div>

      <div className="h-5 w-px bg-border mx-1 hidden md:block" />

      <Input
        value={title}
        onChange={(e) => onTitleChange(e.target.value)}
        placeholder="Document title…"
        className="h-8 border-0 shadow-none px-1 font-serif text-[15px] font-semibold focus-visible:ring-0 bg-transparent min-w-[10ch] max-w-[38ch]"
      />

      <div className="ml-auto flex items-center gap-1.5 shrink-0">
        {/* Live counts */}
        <div className="hidden xl:flex items-center gap-2 text-[10.5px] font-sans tabular-nums text-muted-foreground px-1.5">
          <span>{wordCount.toLocaleString()} words</span>
          <span className="text-muted-foreground/50">·</span>
          <span>{readMin} min read</span>
        </div>

        <SaveStatus
          dirty={dirty}
          saving={saving}
          lastSavedAt={lastSavedAt}
          hasActive={hasActive}
          onSave={onSave}
        />

        <Button
          variant="ghost"
          size="sm"
          onClick={onPolish}
          disabled={!canExport}
          className="h-8 gap-1.5 text-muted-foreground hover:text-foreground"
          title="Normalize reporters, signals, Id., pincites, and smart quotes"
        >
          <BookOpen className="h-3.5 w-3.5" /> Bluebook polish
        </Button>


        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="h-8 gap-1.5" disabled={!canExport}>
              <ArrowDownToLine className="h-3.5 w-3.5" /> Export
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            <DropdownMenuItem onClick={onExportDocx} className="gap-2 cursor-pointer">
              <FileTextIcon className="h-4 w-4 text-[hsl(215_60%_40%)]" /> Word (.docx)
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onExportPdf} className="gap-2 cursor-pointer">
              <FileTextIcon className="h-4 w-4 text-muted-foreground" /> Print / PDF
            </DropdownMenuItem>
            <DropdownMenuItem onClick={onExportMd} className="gap-2 cursor-pointer">
              <FileTextIcon className="h-4 w-4 text-muted-foreground" /> Markdown (.md)
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="ghost"
          size="sm"
          onClick={onToggleSidecar}
          className={cn('h-8 gap-1.5', sidecarOpen && 'text-accent')}
          title={sidecarOpen ? 'Hide Claude' : 'Show Claude'}
        >
          <ClaudeLogo className="h-4 w-4" />
          <span className="hidden md:inline">Claude</span>
        </Button>

        {onDelete && (
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-8 w-8 p-0 text-muted-foreground hover:text-destructive"
                title="Delete document"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this document?</AlertDialogTitle>
                <AlertDialogDescription>
                  "{title}" will be permanently removed. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={onDelete}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        )}
      </div>
    </div>
  );
}

function DocumentMenu({
  docs,
  activeId,
  isLoading,
  onPick,
  onNew,
  
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
        <Button variant="outline" size="sm" className="gap-2 max-w-[220px] h-8">
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
            <DropdownMenuItem
              key={d.id}
              onClick={() => onPick(d)}
              className={cn(
                'flex flex-col items-start gap-0.5 cursor-pointer',
                d.id === activeId && 'bg-secondary',
              )}
            >
              <span className="truncate w-full font-medium">
                {d.title || 'Untitled document'}
              </span>
              <span className="text-[10.5px] text-muted-foreground tabular-nums font-sans">
                {new Date(d.updated_at).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                })}
              </span>
            </DropdownMenuItem>
          ))}
          {!isLoading && docs.length === 0 && (
            <div className="px-2 py-3 text-xs text-muted-foreground">
              No documents yet — create one.
            </div>
          )}
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// ============================================================
// Sidecar (proposal cards, composer, quick voice actions)
// ============================================================

function ClaudeSidecar({
  caseId,
  matter,
  documentText,
  onAppend,
  onInsertCite,
  onClose,
}: {
  caseId: string;
  matter: { name: string; short_name: string; mdl_number: string; court: string; judge: string };
  documentText: string;
  onAppend: (text: string) => void;
  onInsertCite: (c: CiteChip, variant: 'short' | 'full' | 'footnote') => void;
  onClose: () => void;
}) {
  useShareRunner();
  const [proposals, setProposals] = useState<Proposal[]>([]);
  const [input, setInput] = useState('');
  const [ground, setGround] = useState(true);
  const { run, running } = useAiAssist();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const idRef = useRef(0);
  const [scopeText, setScopeText] = useState<string | null>(null);
  const [scopeKind, setScopeKind] = useState<'selection' | 'paragraph' | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [proposals]);

  // Wire the editor's "Ask Claude" affordance
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = (e as CustomEvent<{ text: string; kind: 'selection' | 'paragraph' }>).detail;
      if (!detail?.text) return;
      setScopeText(detail.text);
      setScopeKind(detail.kind);
    };
    window.addEventListener('legal-ask-claude', handler);
    return () => window.removeEventListener('legal-ask-claude', handler);
  }, []);

  const send = async (override?: string, opts?: { prependScope?: boolean }) => {
    const raw = (override ?? input).trim();
    if (!raw || running) return;
    if (!override) setInput('');
    let prompt = raw;
    const scope = scopeText;
    if (opts?.prependScope && scope) {
      prompt = `Regarding this ${scopeKind ?? 'passage'}:\n\n"""\n${scope}\n"""\n\n${raw}`;
    }
    const id = `p${idRef.current++}`;
    const scopeLabel = scope
      ? `Claude · on ${scopeKind === 'selection' ? 'selection' : '¶'}`
      : 'Claude';
    setProposals((ps) => [
      ...ps,
      { id, prompt: raw, content: '', streaming: true, scopeLabel },
    ]);
    setScopeText(null);
    setScopeKind(null);

    const result = await run({
      mode: 'draft',
      instruction: prompt,
      document: documentText,
      ground,
      caseId,
      matter,
      onText: (delta) =>
        setProposals((ps) =>
          ps.map((x) => (x.id === id ? { ...x, content: x.content + delta } : x)),
        ),
    });

    setProposals((ps) =>
      ps.map((x) =>
        x.id === id
          ? {
              ...x,
              streaming: false,
              content: result?.text ?? x.content,
              citations: result?.citations,
              chunks: result?.chunks,
            }
          : x,
      ),
    );
  };

  return (
    <aside className="hidden lg:flex lg:w-[520px] xl:w-[560px] shrink-0 flex-col h-full min-h-0 border-l border-border bg-card">
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border bg-card/60 shrink-0">
        <ClaudeLogo className="h-4 w-4" />
        <span className="text-[13px] font-sans font-medium">Claude</span>
        <span className="text-[10px] font-sans uppercase tracking-[0.12em] text-muted-foreground border border-border rounded px-1.5 py-0.5">
          Beta
        </span>
        <label className="ml-auto flex items-center gap-2 text-[11px] text-muted-foreground font-sans cursor-pointer">
          <BookOpen className="h-3.5 w-3.5" /> Ground
          <Switch checked={ground} onCheckedChange={setGround} />
        </label>
        <Button
          variant="ghost"
          size="sm"
          className="h-7 w-7 p-0"
          onClick={onClose}
          title="Close Claude"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-2.5 min-h-0">
        {proposals.length === 0 && (
          <TemplateLauncher
            disabled={running}
            matter={matter}
            onPick={(_t, resolvedPrompt) => send(resolvedPrompt)}
          />

        )}
        {proposals.map((p) => (
          <ProposalCard
            key={p.id}
            p={p}
            onApply={onAppend}
            onInsertCite={onInsertCite}
            formatShortCite={formatShortCite}
            formatFullCite={formatFullCite}
            expandLabel={expandLabel}
            formatPagePin={formatPagePin}
          />
        ))}
      </div>

      <div className="border-t border-border bg-card px-3 py-2.5 shrink-0">
        {scopeText && (
          <div className="mb-2 flex items-start gap-2 rounded-md border border-accent/30 bg-accent/5 px-2 py-1.5">
            <span className="text-[10px] uppercase tracking-[0.12em] font-sans text-accent shrink-0 mt-0.5">
              {scopeKind === 'selection' ? 'Selection' : 'Paragraph'}
            </span>
            <p className="text-[12px] font-serif italic text-foreground/80 line-clamp-2 flex-1">
              "{scopeText}"
            </p>
            <button
              type="button"
              onClick={() => {
                setScopeText(null);
                setScopeKind(null);
              }}
              className="text-muted-foreground hover:text-foreground"
              title="Clear scope"
            >
              <X className="h-3 w-3" />
            </button>
          </div>
        )}
        <div className="relative">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                send(undefined, { prependScope: !!scopeText });
              }
            }}
            placeholder={
              scopeText
                ? 'Ask about the highlighted passage…'
                : 'Ask Claude to draft or revise…'
            }
            className="resize-none min-h-[60px] max-h-[140px] pr-11 text-[13.5px] border-border/70 focus-visible:border-accent/50"
            disabled={running}
          />
          <Button
            size="sm"
            className="absolute bottom-2 right-2 h-7 w-7 p-0"
            disabled={!input.trim() || running}
            onClick={() => send(undefined, { prependScope: !!scopeText })}
          >
            {running ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <CornerDownLeft className="h-3.5 w-3.5" />
            )}
          </Button>
        </div>
        <div className="flex items-center justify-between mt-1.5 px-0.5">
          <span className="text-[10.5px] text-muted-foreground font-sans">
            Enter to send · ⇧Enter newline{ground ? ' · grounded' : ''}
          </span>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-1.5 text-[10.5px] font-sans text-muted-foreground"
                disabled={!scopeText}
                title={scopeText ? 'Apply a voice action to the scoped passage' : 'Highlight text first'}
              >
                <Sparkles className="h-3 w-3" /> Voice
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-56">
              <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.12em] font-sans text-muted-foreground">
                Rewrite scoped passage
              </DropdownMenuLabel>
              {VOICE_ACTIONS.map((a) => {
                const Icon = a.icon;
                return (
                  <DropdownMenuItem
                    key={a.key}
                    onClick={() => {
                      if (!scopeText) return;
                      send(a.instruction, { prependScope: true });
                    }}
                    className="gap-2"
                  >
                    <Icon className="h-3.5 w-3.5 text-accent" />
                    <div className="flex flex-col">
                      <span className="text-[12.5px]">{a.label}</span>
                      <span className="text-[10.5px] text-muted-foreground">{a.hint}</span>
                    </div>
                  </DropdownMenuItem>
                );
              })}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
    </aside>
  );
}

// ============================================================
// Template launcher — search + favorites + recents + preview
// ============================================================

const FAVORITES_KEY = 'draft.templates.favorites';
const RECENTS_KEY = 'draft.templates.recents';

function readIds(key: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function writeIds(key: string, ids: string[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(key, JSON.stringify(ids.slice(0, 20)));
  } catch {
    /* ignore */
  }
}

function TemplateLauncher({
  onPick,
  disabled,
  matter,
}: {
  onPick: (tpl: DraftTemplate, resolvedPrompt: string) => void;
  disabled: boolean;
  matter: { name: string; short_name: string; mdl_number: string; court: string; judge: string };
}) {
  const [query, setQuery] = useState('');
  const [activeCat, setActiveCat] = useState<TemplateCategory | 'All'>('All');
  const [selectedId, setSelectedId] = useState<string | null>(DRAFT_TEMPLATES[0]?.id ?? null);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const [favorites, setFavorites] = useState<string[]>(() => readIds(FAVORITES_KEY));
  const [recents, setRecents] = useState<string[]>(() => readIds(RECENTS_KEY));
  const [userVars, setUserVars] = useState<Record<string, string>>({});

  const defaultVars = useMemo(() => buildDefaultVars(matter), [matter]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return DRAFT_TEMPLATES.filter((t) => {
      if (activeCat !== 'All' && t.category !== activeCat) return false;
      if (!q) return true;
      return (
        t.title.toLowerCase().includes(q) ||
        t.docType.toLowerCase().includes(q) ||
        t.summary.toLowerCase().includes(q) ||
        t.category.toLowerCase().includes(q)
      );
    });
  }, [query, activeCat]);

  const favoriteList = useMemo(
    () =>
      favorites
        .map((id) => DRAFT_TEMPLATES.find((t) => t.id === id))
        .filter((x): x is DraftTemplate => !!x),
    [favorites],
  );
  const recentList = useMemo(
    () =>
      recents
        .map((id) => DRAFT_TEMPLATES.find((t) => t.id === id))
        .filter((x): x is DraftTemplate => !!x)
        .slice(0, 5),
    [recents],
  );

  const selected = useMemo(
    () => DRAFT_TEMPLATES.find((t) => t.id === selectedId) ?? filtered[0] ?? DRAFT_TEMPLATES[0],
    [selectedId, filtered],
  );

  const toggleFavorite = useCallback(
    (id: string) => {
      setFavorites((prev) => {
        const next = prev.includes(id) ? prev.filter((x) => x !== id) : [id, ...prev];
        writeIds(FAVORITES_KEY, next);
        return next;
      });
    },
    [],
  );

  const handlePick = useCallback(
    (tpl: DraftTemplate) => {
      if (disabled || pickedId) return;
      const merged = { ...defaultVars, ...userVars };
      const resolved = resolveTemplatePrompt(tpl, merged);
      setPickedId(tpl.id);
      // Track recents (dedupe, cap at 5).
      setRecents((prev) => {
        const next = [tpl.id, ...prev.filter((x) => x !== tpl.id)].slice(0, 5);
        writeIds(RECENTS_KEY, next);
        return next;
      });
      onPick(tpl, resolved);
    },
    [disabled, pickedId, defaultVars, userVars, onPick],
  );

  const preset = getPreset(selected?.preset);
  const manualVars = (selected?.vars ?? []).filter((v) => v.source === 'user');

  return (
    <div className="py-2 px-1">
      <div className="text-center mb-3 px-2">
        <ClaudeLogo className="h-5 w-5 mx-auto mb-2" />
        <p className="font-serif text-[15px] text-foreground/85">Draft with Claude.</p>
        <p className="text-[11px] leading-relaxed text-muted-foreground mt-0.5">
          Pick a starting form. Formatting auto-applies from the template preset.
        </p>
      </div>

      <div className="relative mb-2.5">
        <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground/70" />
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search templates…"
          className="h-8 pl-7 text-[12px] border-border/70"
        />
      </div>

      <div className="mb-2 flex flex-wrap gap-1">
        {(['All', ...TEMPLATE_CATEGORIES] as const).map((c) => (
          <button
            key={c}
            type="button"
            onClick={() => setActiveCat(c)}
            className={cn(
              'rounded-full px-2 py-0.5 text-[10.5px] font-sans transition border',
              activeCat === c
                ? 'bg-accent/10 border-accent/40 text-accent'
                : 'bg-card border-border text-muted-foreground hover:border-accent/30 hover:text-foreground',
            )}
          >
            {c}
          </button>
        ))}
      </div>

      {/* Favorites & Recents strips */}
      {(favoriteList.length > 0 || recentList.length > 0) && query.trim() === '' && activeCat === 'All' && (
        <div className="mb-2 space-y-1.5">
          {favoriteList.length > 0 && (
            <TemplateStrip
              label="Favorites"
              icon={Star}
              items={favoriteList}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
          {recentList.length > 0 && (
            <TemplateStrip
              label="Recent"
              icon={Hash}
              items={recentList}
              selectedId={selectedId}
              onSelect={setSelectedId}
            />
          )}
        </div>
      )}

      {/* Template list */}
      <div className="space-y-1">
        {filtered.length === 0 && (
          <div className="text-[11.5px] text-muted-foreground italic px-1 py-4 text-center">
            No templates match "{query}"
          </div>
        )}
        {filtered.map((t) => {
          const Icon = t.icon;
          const isSelected = selectedId === t.id;
          const isFav = favorites.includes(t.id);
          return (
            <div
              key={t.id}
              className={cn(
                'group flex items-start gap-2 rounded-md border px-2 py-2 transition cursor-pointer',
                isSelected
                  ? 'border-accent/50 bg-accent/5'
                  : 'border-border/60 bg-card hover:border-accent/30 hover:bg-accent/[0.03]',
              )}
              onClick={() => setSelectedId(t.id)}
            >
              <span className="h-5 w-5 rounded-full bg-accent/10 grid place-items-center shrink-0 mt-0.5">
                <Icon className="h-3 w-3 text-accent" strokeWidth={1.75} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="text-[12.5px] font-sans font-medium text-foreground/90 leading-snug truncate">
                    {t.title}
                  </span>
                  <span className="text-[9.5px] uppercase tracking-[0.09em] text-muted-foreground/70 font-sans shrink-0">
                    {t.docType}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground leading-snug mt-0.5 line-clamp-1">
                  {t.summary}
                </p>
              </div>
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  toggleFavorite(t.id);
                }}
                className={cn(
                  'shrink-0 p-1 rounded transition opacity-0 group-hover:opacity-100',
                  isFav && 'opacity-100 text-amber-500',
                )}
                title={isFav ? 'Unfavorite' : 'Favorite'}
                aria-label={isFav ? 'Unfavorite template' : 'Favorite template'}
              >
                <Star className={cn('h-3 w-3', isFav && 'fill-current')} />
              </button>
            </div>
          );
        })}
      </div>

      {/* Preview + Use button */}
      {selected && (
        <div className="mt-3 rounded-md border border-border/70 bg-card/60 p-2.5">
          <div className="flex items-center gap-1.5 mb-1.5">
            <TypeIcon className="h-3 w-3 text-accent/80" />
            <span className="text-[10px] uppercase tracking-[0.11em] font-sans text-muted-foreground">
              {preset.label}
            </span>
            <span className="text-[10px] text-muted-foreground/60 font-sans truncate">
              · {preset.short}
            </span>
          </div>
          {manualVars.length > 0 && (
            <div className="mb-2 grid grid-cols-1 gap-1.5">
              {manualVars.map((v) => (
                <div key={v.key} className="flex items-center gap-1.5">
                  <label className="text-[10.5px] font-sans text-muted-foreground w-24 shrink-0">
                    {v.label}
                  </label>
                  <Input
                    value={userVars[v.key] ?? ''}
                    onChange={(e) => setUserVars((s) => ({ ...s, [v.key]: e.target.value }))}
                    placeholder={v.placeholder}
                    className="h-6 text-[11.5px] border-border/60 flex-1"
                  />
                </div>
              ))}
            </div>
          )}
          <Button
            size="sm"
            className="w-full h-7 gap-1.5 text-[11.5px]"
            disabled={disabled || !!pickedId}
            onClick={() => handlePick(selected)}
          >
            {pickedId === selected.id ? (
              <>
                <Loader2 className="h-3 w-3 animate-spin" /> Preparing…
              </>
            ) : (
              <>
                <ChevronRight className="h-3 w-3" /> Use "{selected.title}"
              </>
            )}
          </Button>
        </div>
      )}
    </div>
  );
}

function TemplateStrip({
  label,
  icon: Icon,
  items,
  selectedId,
  onSelect,
}: {
  label: string;
  icon: typeof Star;
  items: DraftTemplate[];
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  return (
    <div>
      <div className="flex items-center gap-1 mb-0.5 px-0.5">
        <Icon className="h-2.5 w-2.5 text-muted-foreground/70" />
        <span className="text-[9.5px] uppercase tracking-[0.12em] font-sans text-muted-foreground/70">
          {label}
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {items.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => onSelect(t.id)}
            className={cn(
              'rounded px-1.5 py-0.5 text-[10.5px] font-sans transition border max-w-[180px] truncate',
              selectedId === t.id
                ? 'bg-accent/10 border-accent/40 text-accent'
                : 'bg-card border-border/60 text-foreground/75 hover:border-accent/30',
            )}
            title={t.title}
          >
            {t.title}
          </button>
        ))}
      </div>
    </div>
  );
}



// ============================================================
// Save status & document rail
// ============================================================

function SaveStatus({
  dirty,
  saving,
  lastSavedAt,
  hasActive,
  onSave,
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
  else if (dirty) status = { label: 'Unsaved', cls: 'text-amber-600' };
  else if (lastSavedAt) status = { label: `Saved ${ago}`, cls: 'text-muted-foreground' };
  else status = { label: 'Saved', cls: 'text-muted-foreground' };

  return (
    <button
      type="button"
      onClick={onSave}
      disabled={saving || (!dirty && hasActive)}
      title={dirty ? 'Save now' : 'Up to date'}
      className={cn(
        'inline-flex items-center gap-1.5 h-8 px-2.5 rounded-md text-[11.5px] font-sans tabular-nums transition',
        'hover:text-accent disabled:opacity-70 disabled:cursor-default',
        status.cls,
      )}
    >
      {saving ? (
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
      ) : (
        <Save className="h-3.5 w-3.5" />
      )}
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
  open,
  onToggle,
  mode = 'docs',
  onModeChange,
  docs,
  activeId,
  isLoading,
  query,
  setQuery,
  onPick,
  onNew,
  editor,
}: {
  open: boolean;
  onToggle: () => void;
  mode?: 'docs' | 'outline';
  onModeChange?: (m: 'docs' | 'outline') => void;
  docs: WorkspaceDocument[];
  activeId: string | null;
  isLoading: boolean;
  query: string;
  setQuery: (s: string) => void;
  onPick: (d: WorkspaceDocument) => void;
  onNew: () => void;
  editor?: Editor | null;
}) {

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return docs;
    return docs.filter(
      (d) => d.title.toLowerCase().includes(q) || d.content.toLowerCase().includes(q),
    );
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

  const outline = useMemo(() => {
    if (mode !== 'outline' || !editor) return [] as { level: number; text: string; pos: number }[];
    const items: { level: number; text: string; pos: number }[] = [];
    editor.state.doc.descendants((node, pos) => {
      if (node.type.name === 'heading') {
        items.push({
          level: (node.attrs as { level?: number }).level ?? 2,
          text: node.textContent.trim() || 'Untitled section',
          pos,
        });
      }
    });
    return items;
  }, [mode, editor]);

  if (!open) {
    return (
      <aside className="hidden lg:flex lg:w-8 shrink-0 flex-col items-center h-full min-h-0 border-r border-border bg-card/40">
        <button
          type="button"
          onClick={onToggle}
          className="mt-2 inline-flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-secondary"
          title="Expand documents"
          aria-label="Expand documents"
        >
          <ChevronsRight className="h-3.5 w-3.5" />
        </button>
        <div
          className="mt-4 text-[10px] uppercase tracking-[0.16em] text-muted-foreground/70 font-sans select-none"
          style={{ writingMode: 'vertical-rl', transform: 'rotate(180deg)' }}
        >
          Documents · {docs.length}
        </div>
      </aside>
    );
  }


  return (
    <aside className="hidden lg:flex lg:w-56 shrink-0 flex-col h-full min-h-0 border-r border-border bg-card/40 relative">
      <div className="px-3 py-2 border-b border-border flex items-center gap-2 shrink-0">
        <div className="inline-flex items-center rounded-sm border border-border overflow-hidden">
          <button
            type="button"
            onClick={() => onModeChange?.('docs')}
            className={cn(
              'h-6 px-2 text-[10.5px] uppercase tracking-[0.12em] font-sans',
              mode === 'docs' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Docs
          </button>
          <button
            type="button"
            onClick={() => onModeChange?.('outline')}
            className={cn(
              'h-6 px-2 text-[10.5px] uppercase tracking-[0.12em] font-sans border-l border-border',
              mode === 'outline' ? 'bg-secondary text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            Outline
          </button>
        </div>
        <Button size="sm" variant="ghost" className="ml-auto h-7 gap-1 text-[11.5px]" onClick={onNew}>
          <Plus className="h-3.5 w-3.5" /> New
        </Button>
      </div>
      {mode === 'docs' && (
        <div className="px-2.5 py-2 border-b border-border shrink-0">
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
      )}

      <button
        type="button"
        onClick={onToggle}
        className="absolute top-2 right-1 inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground/60 hover:text-foreground hover:bg-secondary opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
        title="Collapse documents"
        aria-label="Collapse documents"
      >
        <ChevronsLeft className="h-3.5 w-3.5" />
      </button>

      <div className="flex-1 overflow-y-auto min-h-0">
        {mode === 'outline' ? (
          outline.length === 0 ? (
            <div className="p-4 text-[12px] text-muted-foreground">
              No headings yet. Use H1 / H2 / H3 to structure the document.
            </div>
          ) : (
            <div className="py-1.5">
              {outline.map((h, i) => (
                <button
                  key={`${h.pos}-${i}`}
                  type="button"
                  onClick={() => {
                    if (!editor) return;
                    editor.chain().focus().setTextSelection(h.pos + 1).scrollIntoView().run();
                  }}
                  className="w-full text-left px-3 py-1.5 border-l-2 border-transparent hover:bg-secondary/40 hover:border-border transition"
                  style={{ paddingLeft: `${12 + (h.level - 1) * 10}px` }}
                >
                  <span
                    className={cn(
                      'block truncate',
                      h.level === 1
                        ? 'text-[12.5px] font-serif font-semibold text-foreground'
                        : h.level === 2
                          ? 'text-[12px] font-serif text-foreground/90'
                          : 'text-[11.5px] text-muted-foreground',
                    )}
                  >
                    {h.text}
                  </span>
                </button>
              ))}
            </div>
          )
        ) : (
          <>
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
                      <span
                        className={cn(
                          'truncate text-[12.5px]',
                          active
                            ? 'font-semibold text-foreground'
                            : 'font-medium text-foreground/90',
                        )}
                      >
                        {d.title || 'Untitled document'}
                      </span>
                      <span className="text-[10.5px] text-muted-foreground tabular-nums font-sans">
                        {new Date(d.updated_at).toLocaleDateString(undefined, {
                          month: 'short',
                          day: 'numeric',
                          hour: '2-digit',
                          minute: '2-digit',
                        })}
                      </span>
                    </button>
                  );
                })}
              </div>
            ))}
          </>
        )}
      </div>
    </aside>
  );
}


// ============================================================
// Bluebook cite formatting (retained)
// ============================================================

function formatShortCite(c: CiteChip): string {
  const label = c.order_label || c.title || 'Order';
  const page = c.page ? formatPagePin(c.page) : '';
  return page ? ` (${label}, at ${page})` : ` (${label})`;
}

function formatFullCite(c: CiteChip): string {
  const label = c.order_label || 'Order';
  const title = c.title && c.title !== c.order_label ? `, *${stripLabelEcho(c.title, label)}*` : '';
  const page = c.page ? `, at ${formatPagePin(c.page)}` : '';
  return ` (${expandLabel(label)}${title}${page})`;
}

function formatFootnoteCite(c: CiteChip, n: number): { marker: string; definition: string } {
  const label = c.order_label || c.title || 'Order';
  const page = c.page ? `, at ${formatPagePin(c.page)}` : '';
  const url = c.pdf_url ? ` <${c.pdf_url}>` : '';
  return { marker: `[^${n}]`, definition: `[^${n}]: ${expandLabel(label)}${page}.${url}` };
}

function expandLabel(label: string): string {
  const m = label.match(/^(PTO|CMO|CBO|JPML)[-\s]?(\d+)$/i);
  if (!m) return label;
  const kind = m[1].toUpperCase();
  const num = m[2];
  const expanded: Record<string, string> = {
    PTO: 'Pretrial Order No.',
    CMO: 'Case Management Order No.',
    CBO: 'Common Benefit Order No.',
    JPML: 'JPML Transfer Order No.',
  };
  return `${expanded[kind] ?? label} ${num}`;
}

function formatPagePin(page: string): string {
  return page.replace(/^p\.?\s*/i, '').replace(/-/g, '–');
}

function stripLabelEcho(title: string, label: string): string {
  return title.replace(new RegExp(`^${label}[\\s:·—-]+`, 'i'), '').trim() || title;
}

function citeSourceKey(c: CiteChip): string {
  return `${c.order_label ?? ''}|${c.title ?? ''}`;
}

// ============================================================
// Claude logo (compact, degrades gracefully)
// ============================================================

function ClaudeLogo({ className }: { className?: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <MoreHorizontal
        className={cn('text-[#C96442]', className)}
        strokeWidth={2}
        aria-hidden
      />
    );
  }
  return (
    <img
      src="https://cdn.simpleicons.org/claude/C96442"
      alt=""
      className={className}
      onError={() => setBroken(true)}
    />
  );
}
