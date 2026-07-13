// Word-style track-changes marks for the legal editor.
//
// A "change" is a pair of marks sharing the same `changeId`:
//   • Deletion  — original text, rendered red strikethrough
//   • Insertion — replacement text, rendered green underline
//
// Accept: remove the deletion's TEXT, unwrap the insertion mark.
// Reject: remove the insertion's TEXT, unwrap the deletion mark.
// Regenerate: remove the insertion's text (keep the mark boundary), restream.
//
// Suggestions are session-local. When markdown serializes (autosave/export),
// deletions are dropped and insertions collapse to plain text — i.e. the
// document persists in its "accepted" form. Reloading loses pending diffs,
// which matches the plan's ephemeral-diff design.

import { Mark, mergeAttributes } from '@tiptap/core';
import type { Editor } from '@tiptap/react';

export type ChangeId = string;

const CHANGE_ID_ATTR = 'data-cid';

export const Insertion = Mark.create({
  name: 'insertion',
  inclusive: false,
  excludes: '',
  addAttributes() {
    return {
      changeId: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute(CHANGE_ID_ATTR),
        renderHTML: (attrs) =>
          attrs.changeId ? { [CHANGE_ID_ATTR]: attrs.changeId } : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: 'ins' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['ins', mergeAttributes(HTMLAttributes, { class: 'tc-ins' }), 0];
  },
});

export const Deletion = Mark.create({
  name: 'deletion',
  inclusive: false,
  excludes: '',
  addAttributes() {
    return {
      changeId: {
        default: null,
        parseHTML: (el) => (el as HTMLElement).getAttribute(CHANGE_ID_ATTR),
        renderHTML: (attrs) =>
          attrs.changeId ? { [CHANGE_ID_ATTR]: attrs.changeId } : {},
      },
    };
  },
  parseHTML() {
    return [{ tag: 'del' }];
  },
  renderHTML({ HTMLAttributes }) {
    return ['del', mergeAttributes(HTMLAttributes, { class: 'tc-del' }), 0];
  },
});

// ---------- range helpers ----------

export type MarkRange = { from: number; to: number };

/** Find the contiguous range where the given mark with `changeId` is active. */
export function findMarkRange(
  editor: Editor,
  markName: 'insertion' | 'deletion',
  changeId: ChangeId,
): MarkRange | null {
  const { doc } = editor.state;
  const type = editor.schema.marks[markName];
  if (!type) return null;
  let from: number | null = null;
  let to: number | null = null;
  doc.descendants((node, pos) => {
    if (!node.isText) return true;
    const has = node.marks.some((m) => m.type === type && m.attrs.changeId === changeId);
    if (has) {
      if (from == null) from = pos;
      to = pos + node.nodeSize;
    }
    return true;
  });
  if (from == null || to == null) return null;
  return { from, to };
}

export function findChangeRange(editor: Editor, changeId: ChangeId): MarkRange | null {
  const del = findMarkRange(editor, 'deletion', changeId);
  const ins = findMarkRange(editor, 'insertion', changeId);
  if (!del && !ins) return null;
  const from = Math.min(del?.from ?? Number.MAX_SAFE_INTEGER, ins?.from ?? Number.MAX_SAFE_INTEGER);
  const to = Math.max(del?.to ?? -1, ins?.to ?? -1);
  return { from, to };
}

/** Enumerate every distinct changeId currently in the doc. */
export function listChangeIds(editor: Editor): ChangeId[] {
  const ids = new Set<ChangeId>();
  const insType = editor.schema.marks['insertion'];
  const delType = editor.schema.marks['deletion'];
  editor.state.doc.descendants((node) => {
    if (!node.isText) return true;
    for (const m of node.marks) {
      if ((m.type === insType || m.type === delType) && m.attrs.changeId) {
        ids.add(m.attrs.changeId as ChangeId);
      }
    }
    return true;
  });
  return Array.from(ids);
}

// ---------- commands ----------

export function acceptChange(editor: Editor, changeId: ChangeId): boolean {
  const del = findMarkRange(editor, 'deletion', changeId);
  const ins = findMarkRange(editor, 'insertion', changeId);
  const tr = editor.state.tr;
  // Delete the deletion range first — do it from the higher position to keep
  // positions stable for the second edit.
  const ops: Array<{ kind: 'delete' | 'unmark'; range: MarkRange }> = [];
  if (del) ops.push({ kind: 'delete', range: del });
  if (ins) ops.push({ kind: 'unmark', range: ins });
  ops.sort((a, b) => b.range.from - a.range.from);
  for (const op of ops) {
    if (op.kind === 'delete') {
      tr.delete(op.range.from, op.range.to);
    } else {
      const type = editor.schema.marks['insertion'];
      tr.removeMark(op.range.from, op.range.to, type);
    }
  }
  if (!tr.docChanged) return false;
  editor.view.dispatch(tr);
  return true;
}

export function rejectChange(editor: Editor, changeId: ChangeId): boolean {
  const del = findMarkRange(editor, 'deletion', changeId);
  const ins = findMarkRange(editor, 'insertion', changeId);
  const tr = editor.state.tr;
  const ops: Array<{ kind: 'delete' | 'unmark'; range: MarkRange }> = [];
  if (ins) ops.push({ kind: 'delete', range: ins });
  if (del) ops.push({ kind: 'unmark', range: del });
  ops.sort((a, b) => b.range.from - a.range.from);
  for (const op of ops) {
    if (op.kind === 'delete') {
      tr.delete(op.range.from, op.range.to);
    } else {
      const type = editor.schema.marks['deletion'];
      tr.removeMark(op.range.from, op.range.to, type);
    }
  }
  if (!tr.docChanged) return false;
  editor.view.dispatch(tr);
  return true;
}

export function acceptAll(editor: Editor): number {
  const ids = listChangeIds(editor);
  let n = 0;
  for (const id of ids) if (acceptChange(editor, id)) n++;
  return n;
}

export function rejectAll(editor: Editor): number {
  const ids = listChangeIds(editor);
  let n = 0;
  for (const id of ids) if (rejectChange(editor, id)) n++;
  return n;
}

/** Return the plain text of a mark range (used for diff counters). */
export function markText(editor: Editor, range: MarkRange): string {
  return editor.state.doc.textBetween(range.from, range.to, ' ');
}

export function newChangeId(): ChangeId {
  return 'c' + Math.random().toString(36).slice(2, 9) + Date.now().toString(36).slice(-3);
}
