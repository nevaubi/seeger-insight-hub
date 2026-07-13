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
  const [pos, setPos] = useState<
    { top: number; left: number; placement: 'top' | 'bottom' } | null
  >(null);
  const [diff, setDiff] = useState<{ added: number; removed: number }>({ added: 0, removed: 0 });
  const [open, setOpen] = useState(false);
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
      setOpen(false);
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
      const startCoords = view.coordsAtPos(range.from);
      const endCoords = view.coordsAtPos(range.to);
      const scrollRect = scrollEl.getBoundingClientRect();
      const localTopAbove = startCoords.top - scrollRect.top + scrollEl.scrollTop;
      const localTopBelow = endCoords.bottom - scrollRect.top + scrollEl.scrollTop;
      // Flip below if there's less than 44px of room above the diff
      // (relative to the current scroll position, not the doc).
      const viewportOffset = startCoords.top - scrollRect.top;
      const placement: 'top' | 'bottom' = viewportOffset < 44 ? 'bottom' : 'top';
      const top = placement === 'top' ? localTopAbove - 38 : localTopBelow + 10;
      const left = startCoords.left - scrollRect.left;
      setPos((prev) =>
        prev && prev.top === top && prev.left === left && prev.placement === placement
          ? prev
          : { top, left, placement },
      );
    } catch {
      setPos((prev) => (prev === null ? prev : null));
    }
    const insR = findMarkRange(editor, 'insertion', changeId);
    const delR = findMarkRange(editor, 'deletion', changeId);
    const added = insR ? wordCount(markText(editor, insR)) : 0;
    const removed = delR ? wordCount(markText(editor, delR)) : 0;
    setDiff((prev) => (prev.added === added && prev.removed === removed ? prev : { added, removed }));
  }, [editor, changeId, tick]);

  // Fade in shortly after mount so the pill doesn't snap into place.
  useEffect(() => {
    if (!pos) {
      setOpen(false);
      return;
    }
    const id = requestAnimationFrame(() => setOpen(true));
    return () => cancelAnimationFrame(id);
  }, [pos !== null, changeId]);

  if (!editor || !changeId || !pos) return null;

  return (
    <div
      className={`change-pill is-${pos.placement}${open ? ' is-open' : ''}${streaming ? ' is-streaming' : ''}`}
      style={{ top: pos.top, left: Math.max(pos.left, 12) }}
      role="dialog"
      aria-label="Suggested change"
    >
      <span className="change-pill-diff" aria-hidden="true">
        <span className="change-pill-add">
          <span className="change-pill-dot" /> +{diff.added}
        </span>
        <span className="change-pill-rem">
          <span className="change-pill-dot" /> −{diff.removed}
        </span>
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
              className="change-pill-btn is-retry"
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
      <span className="change-pill-arrow" aria-hidden="true" />
    </div>
  );
}

