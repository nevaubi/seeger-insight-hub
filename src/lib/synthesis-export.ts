// Turn a completed synthesis answer (the writer round + its citations) into an
// exportable document: a memo body with inline [n] citation markers and a Sources
// appendix. Consumed by search.tsx to produce .docx and print-to-PDF output.

import { markdownToBlocks, type DocBlock, type Run } from './file-export';
import type { CitationEvt, RoundState } from './useSynthesisStream';

export type ExportMatter = {
  name: string;
  short_name: string;
  mdl_number: string;
  court: string;
  judge: string;
};

const today = () =>
  new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

/** Reassemble the writer's answer markdown, replacing per-block citation sentinels
 *  with inline [n] / [n, m] markers placed where the citation was emitted. */
function answerMarkdown(round: RoundState, citations: CitationEvt[]): string {
  const byBlock: Record<string, CitationEvt[]> = {};
  for (const c of citations) (byBlock[c.block_id] ??= []).push(c);
  const parts: string[] = [];
  for (const id of round.textOrder) {
    const blk = round.textBlocks[round.blockIndex[id]];
    if (!blk) continue;
    parts.push(blk.text);
    const cites = byBlock[id];
    if (cites && cites.length) {
      const nums = cites.map((c) => c.num).sort((a, b) => a - b).join(', ');
      parts.push(` [${nums}]`);
    }
  }
  return parts.join('').trim();
}

const truncate = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

/** Build the Sources appendix as DocBlocks (one entry per unique citation number). */
function sourceBlocks(citations: CitationEvt[]): DocBlock[] {
  const seen = new Set<number>();
  const ordered = [...citations]
    .sort((a, b) => a.num - b.num)
    .filter((c) => (seen.has(c.num) ? false : (seen.add(c.num), true)));
  if (!ordered.length) return [];

  const blocks: DocBlock[] = [
    { type: 'rule' },
    { type: 'heading', level: 2, runs: [{ text: 'Sources' }] },
  ];
  for (const c of ordered) {
    const label = c.order_label || c.title || c.source || c.ref;
    const runs: Run[] = [{ text: `[${c.num}] `, bold: true }, { text: String(label) }];
    if (c.page) runs.push({ text: ` — p. ${c.page}` });
    blocks.push({ type: 'paragraph', runs });
    const quote = (c.cited_text ?? '').replace(/\s+/g, ' ').trim();
    if (quote) {
      blocks.push({ type: 'paragraph', runs: [{ text: `“${truncate(quote, 320)}”`, italic: true }] });
    }
  }
  return blocks;
}

export type SynthesisDoc = {
  title: string;
  metaLine: string;
  blocks: DocBlock[];
};

/** Compose the full exportable document model (title + meta + answer + sources). */
export function buildSynthesisDoc(input: {
  question: string;
  round: RoundState;
  citations: CitationEvt[]; // already filtered to the writer/final round
  matter: ExportMatter;
}): SynthesisDoc {
  const { question, round, citations, matter } = input;
  const date = today();
  const metaLine = `${matter.short_name} · MDL ${matter.mdl_number} · ${matter.court} · ${matter.judge} · ${date}`;

  const blocks: DocBlock[] = [
    { type: 'heading', level: 1, runs: [{ text: question }] },
    { type: 'paragraph', runs: [{ text: metaLine, italic: true }] },
    { type: 'rule' },
    ...markdownToBlocks(answerMarkdown(round, citations)),
    ...sourceBlocks(citations),
  ];

  return { title: question, metaLine, blocks };
}
