// Floating "Change" action pill that anchors above a pending track-change.
// Rendered inside the editor shell; positioned via editor.view.coordsAtPos.

import { useEffect, useLayoutEffect, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { Check, X, RotateCcw, Loader2 } from 'lucide-react';
import {
  findChangeRange,
  findMarkRange,
  markText,
  type ChangeId,
} from './track-changes';

export type ChangePillProps = {
  editor: Editor | null;
  changeId: ChangeId | null;
  streaming?: boolean;
  onAccept: () => void;
  onReject: () => void;
  onRegenerate?: () => void;
};

function wordCount(s: string): number {
  const t = s.trim();
  if (!t) return 0;
  return t.split(/\s+/).length;
}

export function ChangePill({
  editor,
  changeId,
  streaming,
  onAccept,
  onReject,
  onRegenerate,
}: ChangePillProps) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [diff, setDiff] = useState<{ added: number; removed: number }>({ added: 0, removed: 0 });
  // Bumped on every editor transaction so the pill re-measures while streaming.
  const [tick, force] = useState(0);
  useEffect(() => {
    if (!editor) return;
    const rerender = () => force((n) => n + 1);
    editor.on('transaction', rerender);
    editor.on('selectionUpdate', rerender);
    return () => {
      editor.off('transaction', rerender);
      editor.off('selectionUpdate', rerender);
    };
  }, [editor]);

  useLayoutEffect(() => {
    if (!editor || !changeId) {
      setPos((prev) => (prev === null ? prev : null));
      return;
    }
    const range = findChangeRange(editor, changeId);
    if (!range) {
      setPos((prev) => (prev === null ? prev : null));
      return;
    }
    const view = editor.view;
    const scrollEl = view.dom.closest('.legal-editor-content') as HTMLElement | null;
    if (!scrollEl) return;
    try {
      const coords = view.coordsAtPos(range.from);
      const scrollRect = scrollEl.getBoundingClientRect();
      const top = coords.top - scrollRect.top + scrollEl.scrollTop - 34;
      const left = coords.left - scrollRect.left;
      setPos((prev) => (prev && prev.top === top && prev.left === left ? prev : { top, left }));
    } catch {
      setPos((prev) => (prev === null ? prev : null));
    }
    // Update counts
    const insR = findMarkRange(editor, 'insertion', changeId);
    const delR = findMarkRange(editor, 'deletion', changeId);
    const added = insR ? wordCount(markText(editor, insR)) : 0;
    const removed = delR ? wordCount(markText(editor, delR)) : 0;
    setDiff((prev) => (prev.added === added && prev.removed === removed ? prev : { added, removed }));
  }, [editor, changeId, tick]);


  if (!editor || !changeId || !pos) return null;

  return (
    <div
      className="change-pill"
      style={{ top: pos.top, left: Math.max(pos.left, 12) }}
      role="dialog"
      aria-label="Suggested change"
    >
      <span className="change-pill-diff">
        <span className="change-pill-add">+{diff.added}</span>
        <span className="change-pill-sep">/</span>
        <span className="change-pill-rem">−{diff.removed}</span>
      </span>
      <div className="change-pill-divider" />
      {streaming ? (
        <span className="change-pill-status">
          <Loader2 className="h-3 w-3 animate-spin" />
          Streaming…
        </span>
      ) : (
        <>
          <button
            type="button"
            className="change-pill-btn is-accept"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onAccept}
            title="Accept change (⌘⏎)"
          >
            <Check className="h-3 w-3" />
            Accept
          </button>
          <button
            type="button"
            className="change-pill-btn is-reject"
            onMouseDown={(e) => e.preventDefault()}
            onClick={onReject}
            title="Reject change (⌘⌫)"
          >
            <X className="h-3 w-3" />
            Reject
          </button>
          {onRegenerate && (
            <button
              type="button"
              className="change-pill-btn"
              onMouseDown={(e) => e.preventDefault()}
              onClick={onRegenerate}
              title="Regenerate this change"
            >
              <RotateCcw className="h-3 w-3" />
              Retry
            </button>
          )}
        </>
      )}
    </div>
  );
}
