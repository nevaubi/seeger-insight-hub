// Markdown ⇄ HTML adapters for the Tiptap legal editor.
// Kept intentionally small: marked for MD→HTML (GFM), turndown for HTML→MD.

import { marked } from 'marked';
import TurndownService from 'turndown';

marked.setOptions({ gfm: true, breaks: false });

const td = new TurndownService({
  headingStyle: 'atx',
  bulletListMarker: '-',
  codeBlockStyle: 'fenced',
  emDelimiter: '*',
  strongDelimiter: '**',
});

// Track-changes serialization: on autosave/export we materialize the
// "accepted" version of pending suggestions — deletions vanish, insertions
// collapse to their plain text. Pending diffs are session-local.
td.addRule('trackChangesDeletion', {
  filter: (node) => node.nodeName === 'DEL',
  replacement: () => '',
});
td.addRule('trackChangesInsertion', {
  filter: (node) => node.nodeName === 'INS',
  replacement: (content) => content,
});

// GFM tables → pipe tables
td.addRule('table', {
  filter: 'table',
  replacement: (_c, node) => {
    const rows = Array.from((node as HTMLElement).querySelectorAll('tr'));
    if (!rows.length) return '';
    const cellText = (el: Element) => (el.textContent ?? '').trim().replace(/\s+/g, ' ');
    const lines: string[] = [];
    rows.forEach((row, idx) => {
      const cells = Array.from(row.querySelectorAll('th,td')).map(cellText);
      lines.push('| ' + cells.join(' | ') + ' |');
      if (idx === 0) lines.push('| ' + cells.map(() => '---').join(' | ') + ' |');
    });
    return '\n' + lines.join('\n') + '\n';
  },
});

export function markdownToHtml(md: string): string {
  if (!md.trim()) return '';
  return marked.parse(md, { async: false }) as string;
}

export function htmlToMarkdown(html: string): string {
  if (!html.trim()) return '';
  return td.turndown(html).trim();
}
