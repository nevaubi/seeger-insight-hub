import { useEffect, useState, useCallback } from 'react';
import type { Editor } from '@tiptap/react';

type Placeholder = {
  id: string;
  label: string;
  from: number;
  to: number;
};

const TOKEN_RE = /\[[^\[\]\n]{1,80}\]|\{\{[^{}\n]{1,80}\}\}/g;

function scanPlaceholders(editor: Editor | null): Placeholder[] {
  if (!editor || editor.isDestroyed) return [];
  const out: Placeholder[] = [];
  let i = 0;
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text;
    TOKEN_RE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = TOKEN_RE.exec(text)) !== null) {
      out.push({
        id: `${pos}-${m.index}-${i++}`,
        label: m[0],
        from: pos + m.index,
        to: pos + m.index + m[0].length,
      });
    }
  });
  return out;
}

export function PlaceholderRail({ editor }: { editor: Editor | null }) {
  const [placeholders, setPlaceholders] = useState<Placeholder[]>([]);

  useEffect(() => {
    if (!editor) return;
    let raf = 0;
    const recompute = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setPlaceholders(scanPlaceholders(editor)));
    };
    recompute();
    editor.on('update', recompute);
    editor.on('transaction', recompute);
    return () => {
      cancelAnimationFrame(raf);
      editor.off('update', recompute);
      editor.off('transaction', recompute);
    };
  }, [editor]);

  const jumpTo = useCallback(
    (p: Placeholder) => {
      if (!editor || editor.isDestroyed) return;
      const size = editor.state.doc.content.size;
      const from = Math.min(p.from, size);
      const to = Math.min(p.to, size);
      editor.chain().focus().setTextSelection({ from, to }).run();

      try {
        const view = editor.view;
        const domNode = view.domAtPos(from).node;
        const el = domNode instanceof HTMLElement ? domNode : domNode.parentElement;
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });

        const coords = view.coordsAtPos(from);
        const endCoords = view.coordsAtPos(to);
        const scroller = view.dom.closest('.legal-editor-content') as HTMLElement | null;
        if (!scroller) return;
        const scrollerRect = scroller.getBoundingClientRect();
        const flash = document.createElement('span');
        flash.className = 'placeholder-flash';
        Object.assign(flash.style, {
          position: 'absolute',
          left: `${coords.left - scrollerRect.left + scroller.scrollLeft - 2}px`,
          top: `${coords.top - scrollerRect.top + scroller.scrollTop - 2}px`,
          width: `${Math.max(24, endCoords.right - coords.left) + 4}px`,
          height: `${Math.max(18, coords.bottom - coords.top) + 4}px`,
          pointerEvents: 'none',
          zIndex: '4',
        } as CSSStyleDeclaration);
        if (getComputedStyle(scroller).position === 'static') {
          scroller.style.position = 'relative';
        }
        scroller.appendChild(flash);
        setTimeout(() => flash.remove(), 1500);
      } catch {
        /* ignore transient view failures */
      }
    },
    [editor],
  );

  if (!editor || placeholders.length === 0) return null;

  return (
    <div
      className="placeholder-rail"
      aria-label={`${placeholders.length} unfilled placeholder${placeholders.length === 1 ? '' : 's'}`}
    >
      {placeholders.map((p) => (
        <button
          key={p.id}
          type="button"
          className="placeholder-dot"
          onClick={() => jumpTo(p)}
          title={p.label}
          aria-label={`Jump to ${p.label}`}
        />
      ))}
    </div>
  );
}
