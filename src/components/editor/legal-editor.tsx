import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import { BubbleMenu } from '@tiptap/react/menus';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import Typography from '@tiptap/extension-typography';
import Underline from '@tiptap/extension-underline';
import Link from '@tiptap/extension-link';
import Highlight from '@tiptap/extension-highlight';
import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';
import { Extension } from '@tiptap/react';
import { Loader2, MessageSquarePlus } from 'lucide-react';
import { cn } from '@/lib/utils';
import { htmlToMarkdown, markdownToHtml } from '@/lib/tiptap-markdown';
import { VOICE_ACTIONS } from './voice-actions';

/**
 * Signals from the editor to its host page.
 * - onChange: markdown string (debounced serialisation)
 * - onAskClaude: user asked Claude about a specific selection or paragraph
 */
export type VoiceActionPayload = {
  instruction: string;
  selectionText: string;
  from: number;
  to: number;
};

export type LegalEditorProps = {
  value: string;
  onChange: (markdown: string) => void;
  onAskClaude: (payload: { text: string; kind: 'selection' | 'paragraph' }) => void;
  onVoiceAction: (payload: VoiceActionPayload) => void | Promise<void>;
  onReady?: (editor: Editor) => void;
  running?: boolean;
  className?: string;
};

// Hovered-paragraph decoration → adds a class we style in CSS so the gutter
// button shows on the paragraph the cursor is over.
const HoverParagraphExtension = Extension.create({
  name: 'hoverParagraph',
  addProseMirrorPlugins() {
    const key = new PluginKey('hoverParagraph');
    return [
      new Plugin({
        key,
        state: {
          init: () => ({ pos: null as number | null }),
          apply: (tr, prev) => {
            const meta = tr.getMeta(key);
            if (meta && typeof meta.pos === 'number') return { pos: meta.pos };
            if (meta && meta.pos === null) return { pos: null };
            return prev;
          },
        },
        props: {
          decorations(state) {
            const s = key.getState(state) as { pos: number | null };
            if (s?.pos == null) return null;
            const $pos = state.doc.resolve(Math.min(s.pos, state.doc.content.size - 1));
            const depth = $pos.depth;
            if (depth < 1) return null;
            const start = $pos.before(1);
            const node = state.doc.nodeAt(start);
            if (!node) return null;
            return DecorationSet.create(state.doc, [
              Decoration.node(start, start + node.nodeSize, { class: 'is-hovered' }),
            ]);
          },
          handleDOMEvents: {
            mousemove(view, event) {
              const pos = view.posAtCoords({ left: event.clientX, top: event.clientY });
              if (!pos) return false;
              view.dispatch(view.state.tr.setMeta(key, { pos: pos.pos }));
              return false;
            },
            mouseleave(view) {
              view.dispatch(view.state.tr.setMeta(key, { pos: null }));
              return false;
            },
          },
        },
      }),
    ];
  },
});

export function LegalEditor({
  value,
  onChange,
  onAskClaude,
  onVoiceAction,
  running,
  className,
}: LegalEditorProps) {
  const [editor, setEditor] = useState<Editor | null>(null);
  const lastMdRef = useRef(value);

  const extensions = useMemo(
    () => [
      StarterKit.configure({
        heading: { levels: [1, 2, 3, 4] },
        codeBlock: { HTMLAttributes: { class: 'legal-codeblock' } },
      }),
      Placeholder.configure({
        placeholder: 'Start writing, or ask Claude to draft a section for you…',
      }),
      Typography,
      Underline,
      Link.configure({ openOnClick: true, HTMLAttributes: { rel: 'noreferrer', target: '_blank' } }),
      Highlight.configure({ multicolor: false }),
      HoverParagraphExtension,
    ],
    [],
  );

  const instance = useEditor({
    extensions,
    content: markdownToHtml(value),
    editorProps: {
      attributes: {
        class: 'legal-prose focus:outline-none',
        spellcheck: 'true',
      },
    },
    onUpdate: ({ editor: ed }) => {
      const html = ed.getHTML();
      const md = htmlToMarkdown(html);
      lastMdRef.current = md;
      onChange(md);
    },
    immediatelyRender: false,
  });

  useEffect(() => setEditor(instance), [instance]);

  // Reconcile external value changes (e.g. picking a different document).
  useEffect(() => {
    if (!instance) return;
    if (value === lastMdRef.current) return;
    const html = markdownToHtml(value);
    instance.commands.setContent(html, { emitUpdate: false });
    lastMdRef.current = value;
  }, [value, instance]);

  const askOnParagraph = useCallback(() => {
    if (!editor) return;
    const { state } = editor;
    const $from = state.selection.$from;
    const start = $from.before(1);
    const end = $from.after(1);
    const text = state.doc.textBetween(start, end, '\n').trim();
    if (text) onAskClaude({ text, kind: 'paragraph' });
  }, [editor, onAskClaude]);

  const selectionText = useCallback(() => {
    if (!editor) return '';
    const { from, to } = editor.state.selection;
    return editor.state.doc.textBetween(from, to, '\n').trim();
  }, [editor]);

  return (
    <div className={cn('legal-editor-shell', className)}>
      {editor && (
        <>
          <BubbleMenu
            editor={editor}
            options={{ placement: 'top' }}
            shouldShow={({ from, to }: { from: number; to: number }) => to > from}
            className="bubble-menu"
          >
            <div className="flex items-center gap-0.5 rounded-md border border-border bg-popover shadow-sm px-1 py-1">
              {VOICE_ACTIONS.slice(0, 5).map((a) => {
                const Icon = a.icon;
                return (
                  <button
                    key={a.key}
                    type="button"
                    onClick={() => {
                      const sel = selectionText();
                      if (sel) onVoiceAction(a.instruction, sel);
                    }}
                    title={`${a.label} — ${a.hint}`}
                    className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11.5px] font-sans text-foreground/80 hover:bg-secondary hover:text-foreground transition-colors"
                    disabled={running}
                  >
                    <Icon className="h-3 w-3" />
                    {a.label}
                  </button>
                );
              })}
              <div className="mx-0.5 h-4 w-px bg-border" />
              <button
                type="button"
                onClick={() => {
                  const sel = selectionText();
                  if (sel) onAskClaude({ text: sel, kind: 'selection' });
                }}
                className="inline-flex items-center gap-1 rounded px-2 py-1 text-[11.5px] font-sans font-medium text-accent hover:bg-accent/10 transition-colors"
                title="Ask Claude about this selection"
                disabled={running}
              >
                <ClaudeMark className="h-3 w-3" />
                Ask Claude
              </button>
              {running && <Loader2 className="h-3 w-3 animate-spin text-accent ml-1" />}
            </div>
          </BubbleMenu>

          {/* Gutter Ask-Claude marker on hovered paragraph */}
          <button
            type="button"
            onClick={askOnParagraph}
            className="legal-gutter-mark"
            aria-label="Ask Claude about this paragraph"
            title="Ask Claude about this paragraph"
          >
            <ClaudeMark className="h-3.5 w-3.5" />
            <MessageSquarePlus className="h-3 w-3 text-muted-foreground" />
          </button>
        </>
      )}

      <EditorContent editor={editor} className="legal-editor-content" />
    </div>
  );
}

function ClaudeMark({ className }: { className?: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <span className={cn('inline-block rounded-full bg-[#C96442]', className)} />;
  return (
    <img
      src="https://cdn.simpleicons.org/claude/C96442"
      alt=""
      className={className}
      onError={() => setBroken(true)}
    />
  );
}
