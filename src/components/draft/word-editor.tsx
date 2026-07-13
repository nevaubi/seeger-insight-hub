import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { SuperDocEditor, type SuperDocRef, type Editor } from '@superdoc-dev/react';
import { superdocFonts } from '@superdoc-dev/fonts';
import '@superdoc-dev/react/style.css';
import {
  AlertTriangle,
  ChevronDown,
  Copy,
  FileSignature,
  Landmark,
  Loader2,
  Mail,
  MessageSquarePlus,
  PenLine,
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
import seegerLogo from '@/assets/seeger-weiss-logo.png.asset.json';
import { ClaudePopover, type PopoverAnchor } from './claude-popover';

// Word mode: the SuperDoc canvas (OOXML-native, real pagination, native tracked changes
// and comments) — now the workspace's only editor. This module is heavy (embedded editor
// runtime) and is ONLY reached through React.lazy from the draft route.

export const CLAUDE_AUTHOR = { name: 'Claude — Insight Hub', email: 'claude@insight-hub.ai' };

export interface WordApplyResult {
  ok: boolean;
  reason?: string;
  changeIds: string[];
  commentId?: string | null;
}

export type InsertWhere = 'cursor' | 'end';

export interface WordEditorApi {
  exportDocx: (name: string) => Promise<void>;
  extractText: () => string;
  applyRedlineEdit: (s: Suggestion) => WordApplyResult;
  decideTracked: (changeIds: string[], decision: 'accept' | 'reject') => void;
  removeComment: (commentId: string) => void;
  insertBlock: (kind: InsertBlockKind) => void;
  applyFont: (family: string) => boolean;
  /** Insert markdown-like text into the doc as HTML. Renders paragraphs, bold, italic, lists, headings. */
  insertMarkdown: (markdown: string, where?: InsertWhere) => boolean;
  /** Insert a plain-text run at the cursor (or end of doc). */
  insertPlain: (text: string, where?: InsertWhere) => boolean;
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

// Absolute URL for images injected into the docx (SuperDoc/OOXML needs an absolute src).
function absoluteAssetUrl(url: string): string {
  if (typeof window === 'undefined') return url;
  return url.startsWith('http') ? url : `${window.location.origin}${url}`;
}

const FONT_SUGGESTIONS = [
  { family: 'Century Schoolbook', why: 'the appellate standard — used by the Supreme Court' },
  { family: 'Garamond', why: 'elegant, compact; strong for long briefs' },
  { family: 'Cambria', why: 'modern serif designed for on-screen reading' },
  { family: 'Georgia', why: 'highly readable at filing sizes' },
  { family: 'Bookman Old Style', why: 'generous counters; favored for readability' },
  { family: 'Times New Roman', why: 'the conservative default many local rules expect' },
];

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Minimal markdown → HTML converter for insertion (paragraphs, headings, bold, italic, lists). */
function markdownToInsertableHtml(md: string): string {
  const lines = md.replace(/\r\n/g, '\n').split('\n');
  const out: string[] = [];
  let listType: 'ul' | 'ol' | null = null;
  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };
  const inline = (s: string) =>
    esc(s)
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<!\*)\*(?!\s)(.+?)\*(?!\*)/g, '<em>$1</em>')
      .replace(/`([^`]+)`/g, '<code>$1</code>');
  for (const raw of lines) {
    const line = raw.trimEnd();
    if (!line.trim()) { closeList(); continue; }
    const h = /^(#{1,4})\s+(.*)/.exec(line);
    if (h) { closeList(); out.push(`<h${h[1].length}>${inline(h[2])}</h${h[1].length}>`); continue; }
    const ol = /^\d+\.\s+(.*)/.exec(line);
    const ul = /^[-*]\s+(.*)/.exec(line);
    if (ol) {
      if (listType !== 'ol') { closeList(); out.push('<ol>'); listType = 'ol'; }
      out.push(`<li>${inline(ol[1])}</li>`);
      continue;
    }
    if (ul) {
      if (listType !== 'ul') { closeList(); out.push('<ul>'); listType = 'ul'; }
      out.push(`<li>${inline(ul[1])}</li>`);
      continue;
    }
    if (/^---+$/.test(line)) { closeList(); out.push('<hr/>'); continue; }
    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  return out.join('');
}

function buildBlockHtml(kind: InsertBlockKind, matter: AiAssistMatter): string {
  switch (kind) {
    case 'letterhead': {
      const logoSrc = absoluteAssetUrl(seegerLogo.url);
      return (
        `<p style="text-align:center;margin:0 0 6pt 0;"><img src="${logoSrc}" alt="Seeger Weiss LLP" style="max-height:64px;width:auto;" /></p>` +
        `<p style="text-align:center;margin:0;"><strong>SEEGER WEISS LLP</strong></p>` +
        `<p style="text-align:center;margin:0;font-variant:small-caps;">Attorneys at Law</p>` +
        `<p style="text-align:center;margin:0 0 8pt 0;font-size:10pt;">55 Challenger Road, Ridgefield Park, NJ 07660 · (973) 639-9100 · seegerweiss.com</p>` +
        `<hr/>`
      );
    }
    case 'caption':
      return (
        `<p style="text-align:center;margin:0;"><strong>UNITED STATES DISTRICT COURT</strong></p>` +
        `<p style="text-align:center;margin:0;"><strong>${esc((matter.court ?? '').toUpperCase() || '[DISTRICT]')}</strong></p>` +
        `<p style="text-align:center;margin:6pt 0 0 0;">${esc(matter.name)} — MDL No. ${esc(String(matter.mdl_number))}</p>` +
        `<p style="text-align:center;margin:0;">Judge ${esc(matter.judge)}</p>` +
        `<p style="text-align:center;margin:0 0 8pt 0;">This Document Relates To: [ALL ACTIONS / CASE NO.]</p>` +
        `<hr/>`
      );
    case 'signature':
      return (
        `<p>Dated: [INSERT DATE]</p>` +
        `<p>Respectfully submitted,</p>` +
        `<p><em>/s/ [ATTORNEY NAME]</em></p>` +
        `<p>[ATTORNEY NAME]</p>` +
        `<p>SEEGER WEISS LLP</p>` +
        `<p>55 Challenger Road, Ridgefield Park, NJ 07660</p>` +
        `<p>(973) 639-9100 · [EMAIL]</p>` +
        `<p><em>Counsel for Plaintiffs — ${esc(matter.short_name)}, MDL No. ${esc(String(matter.mdl_number))}</em></p>`
      );
    case 'certificate':
      return (
        `<p style="text-align:center;"><strong>CERTIFICATE OF SERVICE</strong></p>` +
        `<p>I hereby certify that on [INSERT DATE], I electronically filed the foregoing with the Clerk of Court using the CM/ECF system, which will send notification of such filing to all counsel of record.</p>` +
        `<p><em>/s/ [ATTORNEY NAME]</em></p>`
      );
  }
}

// Right-click context menu — a lightweight local component, positioned at the
// pointer. Not shadcn's DropdownMenu because that wants to own the trigger event.
interface CtxMenuState { x: number; y: number; selectionText: string }

function ContextMenu({
  state, onClose, onAsk, onSuggest, onComment, onCopy,
}: {
  state: CtxMenuState;
  onClose: () => void;
  onAsk: () => void;
  onSuggest: () => void;
  onComment: () => void;
  onCopy: () => void;
}) {
  useEffect(() => {
    const dismiss = () => onClose();
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('mousedown', dismiss);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('keydown', key);
    return () => {
      window.removeEventListener('mousedown', dismiss);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('keydown', key);
    };
  }, [onClose]);
  const vw = window.innerWidth, vh = window.innerHeight;
  const w = 240, h = 200;
  const left = Math.min(state.x, vw - w - 8);
  const top = Math.min(state.y, vh - h - 8);
  return createPortal(
    <div
      data-claude-ui="true"
      className="fixed z-[110] w-60 rounded-md border border-border bg-popover shadow-xl py-1 motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-100"
      style={{ left, top }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <button type="button" onClick={onAsk} className="w-full text-left flex items-center gap-2 px-3 py-1.5 text-[12.5px] hover:bg-secondary/60">
        <ClaudeMark className="h-3.5 w-3.5" /> Ask Claude about this…
        <span className="ml-auto text-[9.5px] text-muted-foreground">⌘K</span>
      </button>
      <button type="button" onClick={onSuggest} className="w-full text-left flex items-center gap-2 px-3 py-1.5 text-[12.5px] hover:bg-secondary/60">
        <PenLine className="h-3.5 w-3.5 text-[#C96442]" /> Suggest edits (redline)
      </button>
      <button type="button" onClick={onComment} className="w-full text-left flex items-center gap-2 px-3 py-1.5 text-[12.5px] hover:bg-secondary/60">
        <MessageSquarePlus className="h-3.5 w-3.5 text-accent" /> Add as comment
      </button>
      <div className="my-1 border-t border-border/70" />
      <button type="button" onClick={onCopy} className="w-full text-left flex items-center gap-2 px-3 py-1.5 text-[12.5px] hover:bg-secondary/60">
        <Copy className="h-3.5 w-3.5 text-muted-foreground" /> Copy
      </button>
    </div>,
    document.body,
  );
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
  const [ctxMenu, setCtxMenu] = useState<CtxMenuState | null>(null);
  const popoverTargetRef = useRef<unknown>(null);
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
    return () => { alive = false; };
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
      try { onTextChange(htmlToText(sd.getHTML())); } catch { /* best-effort */ }
    }, 1200);
  }, [onTextChange]);

  // ---- selection tracking → floating Claude pill ----
  const updatePopoverFromSelection = useCallback((forceOpen = false) => {
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
      if (!shell.contains(range.commonAncestorContainer)) {
        setPopoverAnchor(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      try {
        const doc = (editor as any).doc;
        popoverTargetRef.current = doc?.selection?.current?.()?.target ?? null;
      } catch {
        popoverTargetRef.current = null;
      }
      // viewport-space anchor (top-center of selection)
      setPopoverAnchor({
        x: (rect.left + rect.right) / 2,
        y: rect.top,
        selectionText: text,
        forceOpen,
      });
    }, forceOpen ? 0 : 120);
  }, []);

  useEffect(() => {
    const handler = (e: Event) => {
      // ignore selection changes that happen inside Claude's own UI
      const target = e.target as Node | null;
      const active = document.activeElement as HTMLElement | null;
      if (active?.closest?.('[data-claude-ui="true"]')) return;
      if (target && (target as HTMLElement).closest?.('[data-claude-ui="true"]')) return;
      updatePopoverFromSelection(false);
    };
    document.addEventListener('selectionchange', handler);
    return () => document.removeEventListener('selectionchange', handler);
  }, [updatePopoverFromSelection]);

  // ⌘K / Ctrl-K opens the popover on the current selection
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
        const shell = shellRef.current;
        const sel = window.getSelection();
        if (!shell || !sel || sel.rangeCount === 0 || sel.isCollapsed) return;
        const range = sel.getRangeAt(0);
        if (!shell.contains(range.commonAncestorContainer)) return;
        e.preventDefault();
        updatePopoverFromSelection(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [updatePopoverFromSelection]);

  // Right-click inside the canvas → custom context menu
  useEffect(() => {
    const shell = shellRef.current;
    if (!shell) return;
    const onCtx = (e: MouseEvent) => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? '';
      if (text.length < 4) return; // let the browser show its native menu when nothing is selected
      e.preventDefault();
      // capture the doc-level target NOW so "Add as comment" has something to anchor to
      try {
        const doc = (editorRef.current as any)?.doc;
        popoverTargetRef.current = doc?.selection?.current?.()?.target ?? null;
      } catch { popoverTargetRef.current = null; }
      setCtxMenu({ x: e.clientX, y: e.clientY, selectionText: text });
    };
    shell.addEventListener('contextmenu', onCtx);
    return () => shell.removeEventListener('contextmenu', onCtx);
  }, [ready]);

  // ---- redline apply (unchanged) ----
  const applyRedlineEdit = useCallback((s: Suggestion): WordApplyResult => {
    const editor = editorRef.current;
    if (!editor) return { ok: false, reason: 'editor_not_ready', changeIds: [] };
    const doc = (editor as any).doc;
    let items: any[] = [];
    try {
      const res = doc.query.match({ select: { type: 'text', pattern: s.anchor }, require: 'all', limit: 100 });
      items = res?.items ?? [];
    } catch (e) {
      return { ok: false, reason: `query failed: ${(e as Error).message.slice(0, 60)}`, changeIds: [] };
    }
    if (!items.length) return { ok: false, reason: 'anchor_not_found', changeIds: [] };
    const idx = Math.max(0, (s.occurrence ?? 1) - 1);
    const item = items.length === 1 ? items[0] : items[idx];
    if (!item) return { ok: false, reason: 'occurrence_out_of_range', changeIds: [] };

    const listIds = (): Set<string> => {
      try { return new Set(((doc.trackChanges.list({})?.items ?? []) as any[]).map((c) => String(c.id))); }
      catch { return new Set(); }
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
      try { doc.trackChanges.decide({ decision, target: { kind: 'id', id } }); }
      catch (e) { console.warn('trackChanges.decide failed', id, e); }
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
    } catch (e) { console.warn('comment removal failed', e); }
  }, [scheduleSave]);

  // ---- HTML-based inserts (canonical path through ProseMirror) ----
  const insertHtmlAtCursor = useCallback((html: string): boolean => {
    const editor = editorRef.current;
    if (!editor) return false;
    // Preferred: ProseMirror's insertContent (SuperDoc's stable path)
    try {
      const cmds = (editor as any).commands;
      if (cmds?.focus) cmds.focus();
      if (cmds?.insertContent) {
        const ok = cmds.insertContent(html);
        if (ok !== false) { scheduleSave(); pushText(); return true; }
      }
    } catch (e) {
      console.warn('insertContent failed', e);
    }
    // Fallback: SuperDoc doc.insert with HTML content
    try {
      const doc = (editor as any).doc;
      doc.insert({ content: { html } }, { changeMode: 'direct' });
      scheduleSave(); pushText(); return true;
    } catch (e) {
      console.warn('doc.insert(html) failed', e);
    }
    return false;
  }, [scheduleSave, pushText]);

  const insertHtmlAtStart = useCallback((html: string): boolean => {
    const editor = editorRef.current;
    if (!editor) return false;
    try {
      const cmds = (editor as any).commands;
      if (cmds?.focus) cmds.focus();
      if (cmds?.setTextSelection) cmds.setTextSelection(0);
      if (cmds?.insertContentAt) {
        const ok = cmds.insertContentAt(0, html);
        if (ok !== false) { scheduleSave(); pushText(); return true; }
      }
      if (cmds?.insertContent) {
        const ok = cmds.insertContent(html);
        if (ok !== false) { scheduleSave(); pushText(); return true; }
      }
    } catch (e) {
      console.warn('insert-at-start failed', e);
    }
    return insertHtmlAtCursor(html);
  }, [insertHtmlAtCursor, scheduleSave, pushText]);

  const insertMarkdown = useCallback((markdown: string, where: InsertWhere = 'cursor'): boolean => {
    const html = markdownToInsertableHtml(markdown);
    return where === 'end' ? insertHtmlAtCursor(html) : insertHtmlAtCursor(html);
  }, [insertHtmlAtCursor]);

  const insertPlain = useCallback((text: string, where: InsertWhere = 'cursor'): boolean => {
    const html = text
      .split(/\n{2,}/)
      .map((p) => `<p>${esc(p).replace(/\n/g, '<br/>')}</p>`)
      .join('');
    return where === 'end' ? insertHtmlAtCursor(html) : insertHtmlAtCursor(html);
  }, [insertHtmlAtCursor]);

  const insertBlock = useCallback((kind: InsertBlockKind) => {
    const html = buildBlockHtml(kind, matter);
    const atTop = kind === 'letterhead' || kind === 'caption';
    const ok = atTop ? insertHtmlAtStart(html) : insertHtmlAtCursor(html);
    if (ok) {
      toast.success(
        kind === 'letterhead' ? 'Firm letterhead added' :
        kind === 'caption' ? 'Caption block added' :
        kind === 'signature' ? 'Signature block inserted' : 'Certificate of service inserted',
      );
    } else {
      toast.error(`Couldn't insert the ${kind} block — the editor rejected the content.`);
    }
  }, [insertHtmlAtCursor, insertHtmlAtStart, matter]);

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
      if (applied) toast.success(`Claude set the document font to ${pick.family}`, { description: pick.why });
      else toast.message(`Claude suggests ${pick.family}`, { description: `${pick.why}. Apply it from the toolbar font menu.` });
    } catch (e) {
      toast.error(`Font suggestion failed: ${(e as Error).message.slice(0, 80)}`);
    } finally { setFontBusy(false); }
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
        try { return htmlToText(sd.getHTML()); } catch { return ''; }
      },
      applyRedlineEdit,
      decideTracked,
      removeComment,
      insertBlock,
      applyFont,
      insertMarkdown,
      insertPlain,
    });
    return () => onApi(null);
  }, [ready, onApi, applyRedlineEdit, decideTracked, removeComment, insertBlock, applyFont, insertMarkdown, insertPlain]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (textTimer.current) clearTimeout(textTimer.current);
      if (selectionTimer.current) clearTimeout(selectionTimer.current);
      if (dirtyRef.current) void doSave();
    };
  }, [doSave]);

  const contextMenu = useMemo(() => {
    if (!ctxMenu) return null;
    const closeMenu = () => setCtxMenu(null);
    return (
      <ContextMenu
        state={ctxMenu}
        onClose={closeMenu}
        onAsk={() => { closeMenu(); updatePopoverFromSelection(true); }}
        onSuggest={() => {
          closeMenu();
          onSuggestEdits(ctxMenu.selectionText, 'Improve this passage: precision, flow, and litigation register. Smallest sufficient edits.');
        }}
        onComment={() => {
          closeMenu();
          const note = window.prompt('Add a comment on this selection:', '');
          if (note && note.trim()) addCommentAtCapturedSelection(note.trim());
        }}
        onCopy={() => {
          closeMenu();
          navigator.clipboard?.writeText(ctxMenu.selectionText).then(() => toast.success('Copied'));
        }}
      />
    );
  }, [ctxMenu, updatePopoverFromSelection, onSuggestEdits, addCommentAtCapturedSelection]);

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
      {/* Word-blue accessory strip */}
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
          Select any passage — Claude opens with ⌘K or right-click
        </span>
      </div>

      <div ref={shellRef} className="relative flex-1 min-h-0 overflow-hidden">
        <SuperDocEditor
          ref={ref}
          document={file}
          documentMode="editing"
          user={CLAUDE_AUTHOR}
          fonts={superdocFonts}
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
            try {
              const tb = (ref.current?.getInstance() as any)?.toolbar;
              if (tb?.config) {
                tb.config.hideButtons = false;
                tb.config.responsiveToContainer = true;
                tb.updateToolbarState?.();
                tb.onToolbarResize?.();
              }
            } catch (e) { console.warn('toolbar unhide failed', e); }
          }}
          onEditorCreate={(e) => { editorRef.current = e.editor; }}
          onEditorUpdate={() => { scheduleSave(); pushText(); }}
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
        {contextMenu}
      </div>
    </div>
  );
}
