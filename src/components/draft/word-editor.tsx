import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { SuperDocEditor, type SuperDocRef, type Editor } from '@superdoc-dev/react';
import { superdocFonts } from '@superdoc-dev/fonts';
import '@superdoc-dev/react/style.css';
import {
  AlertTriangle,
  ChevronDown,
  FileSignature,
  Landmark,
  Loader2,
  Mail,
  ScrollText,
  Type,
} from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { supabase, WORKSPACE_DOCX_BUCKET } from '@/lib/supabase';
import { useAiAssist, type AiAssistMatter } from '@/lib/useAiAssist';
import type { Suggestion } from '@/lib/redline';
import { ClaudeMark } from '@/components/claude-mark';
import { ClaudePopover, type PopoverAnchor } from './claude-popover';

// Word mode: the SuperDoc canvas (OOXML-native, real pagination, native tracked changes
// and comments) — now the workspace's only editor. This module is heavy (embedded editor
// runtime) and is ONLY reached through React.lazy from the draft route.
//
// AI attribution: the SuperDoc instance user is "Claude — Insight Hub". Humans edit
// directly (untracked, as in Word's normal mode); every *tracked change* in the canvas
// comes from the verified redline pipeline, so in-canvas attribution is honest.
//
// The document round-trips losslessly: download from storage → edit → debounced
// export({triggerDownload:false}) → upsert back to storage.

export const CLAUDE_AUTHOR = { name: 'Claude — Insight Hub', email: 'claude@insight-hub.ai' };

export interface WordApplyResult {
  ok: boolean;
  reason?: string;
  changeIds: string[];
  commentId?: string | null;
}

export interface WordEditorApi {
  /** Full-fidelity .docx export via SuperDoc (native download). */
  exportDocx: (name: string) => Promise<void>;
  /** Plain text of the document body (chat grounding context / checks / redline). */
  extractText: () => string;
  /** Apply one verified redline suggestion into the canvas as a native tracked change. */
  applyRedlineEdit: (s: Suggestion) => WordApplyResult;
  /** Accept or reject the tracked changes belonging to a suggestion. */
  decideTracked: (changeIds: string[], decision: 'accept' | 'reject') => void;
  /** Remove a Claude comment (used when a comment suggestion is dismissed). */
  removeComment: (commentId: string) => void;
  /** Insert a document block (letterhead, caption, signature…) built from markdown. */
  insertBlock: (kind: InsertBlockKind) => void;
  /** Apply a document-wide default font. */
  applyFont: (family: string) => boolean;
}

export type InsertBlockKind = 'letterhead' | 'caption' | 'signature' | 'certificate';

function htmlToText(htmlSections: string[]): string {
  const div = document.createElement('div');
  return htmlSections
    .map((h) => {
      div.innerHTML = h;
      return div.textContent ?? '';
    })
    .join('\n\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// Law-appropriate document fonts available from the bundled metric-compatible pack.
const FONT_SUGGESTIONS = [
  { family: 'Century Schoolbook', why: 'the appellate standard — used by the Supreme Court' },
  { family: 'Garamond', why: 'elegant, compact; strong for long briefs' },
  { family: 'Cambria', why: 'modern serif designed for on-screen reading' },
  { family: 'Georgia', why: 'highly readable at filing sizes' },
  { family: 'Bookman Old Style', why: 'generous counters; favored for readability' },
  { family: 'Times New Roman', why: 'the conservative default many local rules expect' },
];

function insertBlockMarkdown(kind: InsertBlockKind, matter: AiAssistMatter): string {
  switch (kind) {
    case 'letterhead':
      return [
        '**SEEGER WEISS LLP**',
        '',
        'ATTORNEYS AT LAW',
        '',
        '55 Challenger Road, Ridgefield Park, NJ 07660 · (973) 639-9100 · seegerweiss.com',
        '',
        '---',
        '',
      ].join('\n');
    case 'caption':
      return [
        `**UNITED STATES DISTRICT COURT**`,
        '',
        `**${(matter.court ?? '').toUpperCase() || '[DISTRICT]'}**`,
        '',
        `${matter.name} — MDL No. ${matter.mdl_number}`,
        '',
        `Judge ${matter.judge}`,
        '',
        'This Document Relates To: [ALL ACTIONS / CASE NO.]',
        '',
        '---',
        '',
      ].join('\n');
    case 'signature':
      return [
        '',
        'Dated: [INSERT DATE]',
        '',
        'Respectfully submitted,',
        '',
        '*/s/ [ATTORNEY NAME]*',
        '',
        '[ATTORNEY NAME]',
        '',
        'SEEGER WEISS LLP',
        '',
        '55 Challenger Road, Ridgefield Park, NJ 07660',
        '',
        '(973) 639-9100 · [EMAIL]',
        '',
        `*Counsel for Plaintiffs — ${matter.short_name}, MDL No. ${matter.mdl_number}*`,
        '',
      ].join('\n');
    case 'certificate':
      return [
        '',
        '**CERTIFICATE OF SERVICE**',
        '',
        'I hereby certify that on [INSERT DATE], I electronically filed the foregoing with the Clerk of Court using the CM/ECF system, which will send notification of such filing to all counsel of record.',
        '',
        '*/s/ [ATTORNEY NAME]*',
        '',
      ].join('\n');
  }
}

export default function WordEditor({
  storagePath,
  caseId,
  matter,
  onSaveStateChange,
  onTextChange,
  onApi,
  onSuggestEdits,
}: {
  storagePath: string;
  caseId: string;
  matter: AiAssistMatter;
  onSaveStateChange: (s: { saving: boolean; lastSavedAt: number | null; dirty: boolean }) => void;
  onTextChange: (text: string) => void;
  onApi: (api: WordEditorApi | null) => void;
  /** Run a verified redline pass scoped to a selection (handled by the draft route). */
  onSuggestEdits: (selectionText: string, instruction: string) => void;
}) {
  const ref = useRef<SuperDocRef | null>(null);
  const editorRef = useRef<Editor | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);
  const [fontBusy, setFontBusy] = useState(false);
  const [popoverAnchor, setPopoverAnchor] = useState<PopoverAnchor | null>(null);
  const popoverTargetRef = useRef<unknown>(null); // captured selection target for comments
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savingRef = useRef(false);
  const dirtyRef = useRef(false);
  const textTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const selectionTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const { run: runAssist } = useAiAssist();

  // ---- load binary ----
  useEffect(() => {
    let alive = true;
    setFile(null);
    setReady(false);
    setLoadError(null);
    (async () => {
      const { data, error } = await supabase.storage.from(WORKSPACE_DOCX_BUCKET).download(storagePath);
      if (!alive) return;
      if (error || !data) {
        setLoadError(error?.message ?? 'Could not download the document');
        return;
      }
      setFile(new File([data], storagePath.split('/').pop() ?? 'document.docx', {
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      }));
    })();
    return () => {
      alive = false;
    };
  }, [storagePath]);

  // ---- autosave ----
  const doSave = useCallback(async () => {
    const sd = ref.current?.getInstance();
    if (!sd || savingRef.current) return;
    savingRef.current = true;
    onSaveStateChange({ saving: true, lastSavedAt: null, dirty: dirtyRef.current });
    try {
      const blob = await sd.export({ triggerDownload: false, exportType: ['docx'], commentsType: 'external' });
      const { error } = await supabase.storage
        .from(WORKSPACE_DOCX_BUCKET)
        .upload(storagePath, blob, { upsert: true, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
      if (error) throw new Error(error.message);
      dirtyRef.current = false;
      onSaveStateChange({ saving: false, lastSavedAt: Date.now(), dirty: false });
    } catch (e) {
      onSaveStateChange({ saving: false, lastSavedAt: null, dirty: true });
      toast.error(`Word autosave failed: ${(e as Error).message}`);
    } finally {
      savingRef.current = false;
    }
  }, [storagePath, onSaveStateChange]);

  const scheduleSave = useCallback(() => {
    dirtyRef.current = true;
    onSaveStateChange({ saving: false, lastSavedAt: null, dirty: true });
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void doSave(), 2500);
  }, [doSave, onSaveStateChange]);

  const pushText = useCallback(() => {
    if (textTimer.current) clearTimeout(textTimer.current);
    textTimer.current = setTimeout(() => {
      const sd = ref.current?.getInstance();
      if (!sd) return;
      try {
        onTextChange(htmlToText(sd.getHTML()));
      } catch {
        /* extraction is best-effort */
      }
    }, 1200);
  }, [onTextChange]);

  // ---- selection tracking → Claude affordance ----
  const updatePopoverFromSelection = useCallback(() => {
    if (selectionTimer.current) clearTimeout(selectionTimer.current);
    selectionTimer.current = setTimeout(() => {
      const shell = shellRef.current;
      const editor = editorRef.current;
      if (!shell || !editor) return;
      const sel = window.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) {
        setPopoverAnchor(null);
        return;
      }
      const text = sel.toString().trim();
      if (text.length < 4 || text.length > 6000) {
        setPopoverAnchor(null);
        return;
      }
      const range = sel.getRangeAt(0);
      // the selection must live inside the canvas shell
      if (!shell.contains(range.commonAncestorContainer)) {
        setPopoverAnchor(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      const shellRect = shell.getBoundingClientRect();
      // capture the portable selection target NOW (clicks later will collapse it)
      try {
        const doc = (editor as any).doc;
        popoverTargetRef.current = doc?.selection?.current?.()?.target ?? null;
      } catch {
        popoverTargetRef.current = null;
      }
      setPopoverAnchor({
        x: Math.min(rect.right - shellRect.left + 6, shell.clientWidth - 44),
        y: Math.max(4, rect.top - shellRect.top + shell.scrollTop - 4),
        selectionText: text,
      });
    }, 250);
  }, []);

  useEffect(() => {
    const handler = () => updatePopoverFromSelection();
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, [updatePopoverFromSelection]);

  // ---- api exposed to the draft route ----
  const applyRedlineEdit = useCallback((s: Suggestion): WordApplyResult => {
    const editor = editorRef.current;
    if (!editor) return { ok: false, reason: 'editor_not_ready', changeIds: [] };
    const doc = (editor as any).doc;
    let items: any[] = [];
    try {
      const res = doc.query.match({
        select: { type: 'text', pattern: s.anchor },
        require: 'all',
        limit: 100,
      });
      items = res?.items ?? [];
    } catch (e) {
      return { ok: false, reason: `query failed: ${(e as Error).message.slice(0, 60)}`, changeIds: [] };
    }
    if (!items.length) return { ok: false, reason: 'anchor_not_found', changeIds: [] };
    const idx = Math.max(0, (s.occurrence ?? 1) - 1);
    const item = items.length === 1 ? items[0] : items[idx];
    if (!item) return { ok: false, reason: 'occurrence_out_of_range', changeIds: [] };

    const listIds = (): Set<string> => {
      try {
        return new Set(((doc.trackChanges.list({})?.items ?? []) as any[]).map((c) => String(c.id)));
      } catch {
        return new Set();
      }
    };
    const before = listIds();

    try {
      if (s.op === 'comment') {
        const receipt = doc.comments.create({ target: item.target, text: s.text });
        const commentId = receipt?.commentId ?? receipt?.id ?? null;
        scheduleSave();
        return { ok: true, changeIds: [], commentId };
      }
      if (s.op === 'replace') {
        doc.replace({ ref: item.handle?.ref, text: s.text }, { changeMode: 'tracked' });
      } else if (s.op === 'delete') {
        doc.delete({ ref: item.handle?.ref }, { changeMode: 'tracked' });
      } else {
        const t = item.target as { start: unknown; end: unknown };
        const point = s.op === 'insert_after' ? t.end : t.start;
        doc.insert({ target: { start: point, end: point }, value: s.text }, { changeMode: 'tracked' });
      }
    } catch (e) {
      return { ok: false, reason: (e as Error).message.slice(0, 80), changeIds: [] };
    }
    const after = ((doc.trackChanges.list({})?.items ?? []) as any[]).map((c) => String(c.id));
    const changeIds = after.filter((id) => !before.has(id));
    scheduleSave();
    pushText();
    return { ok: true, changeIds };
  }, [scheduleSave, pushText]);

  const decideTracked = useCallback((changeIds: string[], decision: 'accept' | 'reject') => {
    const editor = editorRef.current;
    if (!editor) return;
    const doc = (editor as any).doc;
    for (const id of changeIds) {
      try {
        doc.trackChanges.decide({ decision, target: { kind: 'id', id } });
      } catch (e) {
        console.warn('trackChanges.decide failed', id, e);
      }
    }
    scheduleSave();
    pushText();
  }, [scheduleSave, pushText]);

  const removeComment = useCallback((commentId: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    const doc = (editor as any).doc;
    try {
      if (typeof doc.comments.remove === 'function') doc.comments.remove({ commentId });
      else if (typeof doc.comments.delete === 'function') doc.comments.delete({ commentId });
      scheduleSave();
    } catch (e) {
      console.warn('comment removal failed', e);
    }
  }, [scheduleSave]);

  const insertMarkdownBlock = useCallback((markdown: string, where: 'start' | 'cursor') => {
    const editor = editorRef.current;
    if (!editor) throw new Error('Editor not ready');
    const doc = (editor as any).doc;
    const frag = doc.markdownToFragment({ markdown });
    const content = frag?.fragment ?? frag?.content ?? frag;
    if (where === 'start') {
      const first = doc.blocks.list({ limit: 1 })?.items?.[0];
      doc.insert({ content, target: first?.address, placement: 'before' }, { changeMode: 'direct' });
    } else {
      // insert after the block containing the caret (or at end without a selection)
      let address: unknown = undefined;
      try {
        const sel = doc.selection.current();
        const blockId = sel?.target?.segments?.[0]?.blockId ?? sel?.target?.start?.blockId;
        if (blockId) address = { kind: 'block', nodeId: blockId };
      } catch { /* fall through to append */ }
      if (address) doc.insert({ content, target: address, placement: 'after' }, { changeMode: 'direct' });
      else doc.insert({ content }, { changeMode: 'direct' });
    }
  }, []);

  const insertBlock = useCallback((kind: InsertBlockKind) => {
    try {
      insertMarkdownBlock(insertBlockMarkdown(kind, matter), kind === 'letterhead' || kind === 'caption' ? 'start' : 'cursor');
      scheduleSave();
      pushText();
      toast.success(
        kind === 'letterhead' ? 'Firm letterhead added' :
        kind === 'caption' ? 'Caption block added' :
        kind === 'signature' ? 'Signature block inserted' : 'Certificate of service inserted',
      );
    } catch (e) {
      toast.error(`Couldn't insert block: ${(e as Error).message.slice(0, 80)}`);
    }
  }, [insertMarkdownBlock, matter, scheduleSave, pushText]);

  const applyFont = useCallback((family: string): boolean => {
    const editor = editorRef.current;
    if (!editor) return false;
    const doc = (editor as any).doc;
    try {
      doc.styles.apply({ target: { scope: 'docDefaults', channel: 'run' }, patch: { fontFamily: family } });
      scheduleSave();
      return true;
    } catch (e) {
      console.warn('styles.apply docDefaults failed', e);
      return false;
    }
  }, [scheduleSave]);

  const suggestFont = useCallback(async () => {
    const sd = ref.current?.getInstance();
    if (!sd) return;
    setFontBusy(true);
    try {
      const docHead = htmlToText(sd.getHTML()).slice(0, 1200);
      const list = FONT_SUGGESTIONS.map((f) => f.family).join('; ');
      const result = await runAssist({
        mode: 'transform',
        instruction:
          `From this list only — ${list} — pick the single best document font for this filing and reply with the font family name alone, nothing else. Consider document type and audience (federal MDL practice).`,
        selection: docHead || 'A federal court filing in multidistrict litigation.',
        document: '',
        caseId,
        matter,
      });
      const raw = (result?.text ?? '').trim();
      const match = FONT_SUGGESTIONS.find((f) => raw.toLowerCase().includes(f.family.toLowerCase()));
      const pick = match ?? FONT_SUGGESTIONS[0];
      const applied = applyFont(pick.family);
      if (applied) {
        toast.success(`Claude set the document font to ${pick.family}`, { description: pick.why });
      } else {
        toast.message(`Claude suggests ${pick.family}`, {
          description: `${pick.why}. Apply it from the toolbar font menu.`,
        });
      }
    } catch (e) {
      toast.error(`Font suggestion failed: ${(e as Error).message.slice(0, 80)}`);
    } finally {
      setFontBusy(false);
    }
  }, [runAssist, caseId, matter, applyFont]);

  const addCommentAtCapturedSelection = useCallback((text: string) => {
    const editor = editorRef.current;
    if (!editor) return;
    const doc = (editor as any).doc;
    try {
      const target = popoverTargetRef.current;
      if (target) doc.comments.create({ target, text });
      else doc.comments.create({ target: doc.selection.current()?.target, text });
      scheduleSave();
      toast.success('Added as a comment');
    } catch (e) {
      toast.error(`Couldn't add comment: ${(e as Error).message.slice(0, 80)}`);
    }
  }, [scheduleSave]);

  // publish the api
  useEffect(() => {
    if (!ready) return;
    onApi({
      exportDocx: async (name: string) => {
        const sd = ref.current?.getInstance();
        if (!sd) return;
        await sd.export({ exportType: ['docx'], exportedName: name });
      },
      extractText: () => {
        const sd = ref.current?.getInstance();
        if (!sd) return '';
        try {
          return htmlToText(sd.getHTML());
        } catch {
          return '';
        }
      },
      applyRedlineEdit,
      decideTracked,
      removeComment,
      insertBlock,
      applyFont,
    });
    return () => onApi(null);
  }, [ready, onApi, applyRedlineEdit, decideTracked, removeComment, insertBlock, applyFont]);

  // flush pending save on unmount
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (textTimer.current) clearTimeout(textTimer.current);
      if (selectionTimer.current) clearTimeout(selectionTimer.current);
      if (dirtyRef.current) void doSave();
    };
  }, [doSave]);

  if (loadError) {
    return (
      <div className="flex flex-1 items-center justify-center p-8">
        <div className="text-center">
          <AlertTriangle className="h-5 w-5 mx-auto mb-2 text-amber-600" />
          <p className="text-sm text-foreground/80 mb-1">Couldn't open this Word document.</p>
          <p className="text-xs text-muted-foreground">{loadError}</p>
        </div>
      </div>
    );
  }

  if (!file) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin mr-2" /> Opening document…
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0 word-editor-shell">
      {/* Word-blue accessory strip: law inserts + AI design tools */}
      <div className="flex items-center gap-1 border-b border-[hsl(215_45%_86%)] bg-[hsl(215_65%_96%)] px-3 py-1">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="h-6.5 gap-1 px-2 text-[11.5px] text-[hsl(215_55%_32%)] hover:bg-[hsl(215_60%_91%)]">
              <ScrollText className="h-3.5 w-3.5" /> Insert <ChevronDown className="h-3 w-3 opacity-60" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-64">
            <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground font-sans">
              Litigation blocks
            </DropdownMenuLabel>
            <DropdownMenuItem className="gap-2 cursor-pointer" onClick={() => insertBlock('letterhead')}>
              <Landmark className="h-4 w-4 text-accent" /> Firm letterhead <span className="ml-auto text-[9.5px] text-muted-foreground">top of doc</span>
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2 cursor-pointer" onClick={() => insertBlock('caption')}>
              <ScrollText className="h-4 w-4 text-accent" /> Court caption <span className="ml-auto text-[9.5px] text-muted-foreground">top of doc</span>
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem className="gap-2 cursor-pointer" onClick={() => insertBlock('signature')}>
              <FileSignature className="h-4 w-4 text-accent" /> Signature block <span className="ml-auto text-[9.5px] text-muted-foreground">at cursor</span>
            </DropdownMenuItem>
            <DropdownMenuItem className="gap-2 cursor-pointer" onClick={() => insertBlock('certificate')}>
              <Mail className="h-4 w-4 text-accent" /> Certificate of service <span className="ml-auto text-[9.5px] text-muted-foreground">at cursor</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <Button
          variant="ghost"
          size="sm"
          className="h-6.5 gap-1.5 px-2 text-[11.5px] text-[hsl(215_55%_32%)] hover:bg-[hsl(215_60%_91%)]"
          onClick={() => void suggestFont()}
          disabled={fontBusy}
          title="Claude picks a filing-appropriate font and applies it document-wide"
        >
          {fontBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Type className="h-3.5 w-3.5" />}
          Suggest font
        </Button>

        <span className="ml-auto inline-flex items-center gap-1.5 text-[10px] font-sans text-[hsl(215_35%_45%)]">
          <ClaudeMark className="h-3 w-3" />
          AI edits arrive as tracked changes · attributed to Claude
        </span>
      </div>

      <div ref={shellRef} className="relative flex-1 min-h-0 overflow-hidden">
        <SuperDocEditor
          ref={ref}
          document={file}
          documentMode="editing"
          user={CLAUDE_AUTHOR}
          fonts={superdocFonts}
          modules={{
            toolbar: {
              hideButtons: false,
              responsiveToContainer: true,
            },
          }}
          contained
          className="h-full"
          renderLoading={() => (
            <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
              <Loader2 className="h-4 w-4 animate-spin mr-2" /> Rendering…
            </div>
          )}
          onReady={() => {
            setReady(true);
            pushText();
          }}
          onEditorCreate={(e) => {
            editorRef.current = e.editor;
          }}
          onEditorUpdate={() => {
            scheduleSave();
            pushText();
          }}
          onContentError={(e) => {
            setLoadError('This .docx could not be parsed with full fidelity.');
            console.warn('SuperDoc content error', e);
          }}
          onException={(e) => console.warn('SuperDoc exception', e)}
        />

        <ClaudePopover
          anchor={popoverAnchor}
          caseId={caseId}
          matter={matter}
          onAddComment={addCommentAtCapturedSelection}
          onSuggestEdits={onSuggestEdits}
          onClose={() => setPopoverAnchor(null)}
        />
      </div>
    </div>
  );
}
