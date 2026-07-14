// Deposition digest exports (Markdown → DOCX/PDF/CSV).
// Reuses the in-house file-export pipeline; produces one polished digest per
// deposition, with toggleable sections.

import type {
  Deposition,
  DepositionFinding,
  FindingStance,
} from '@/lib/supabase';
import {
  buildDocx,
  downloadBlob,
  downloadCsv,
  exportFilename,
  markdownToBlocks,
  printDocument,
  blocksToHtml,
} from '@/lib/file-export';
import { fmtDate } from '@/components/case-ui';

export interface DigestOptions {
  summary: boolean;
  admissions: boolean;
  chronology: boolean;
  exhibits: boolean;
  quality: boolean;
}

const DEFAULTS: DigestOptions = {
  summary: true,
  admissions: true,
  chronology: true,
  exhibits: true,
  quality: false,
};

function witnessLast(name: string | null | undefined): string {
  if (!name) return 'Witness';
  return name.split(/\s+/).slice(-1)[0] || name;
}

function shortCite(f: Pick<DepositionFinding, 'page_start' | 'line_start' | 'page_end' | 'line_end' | 'cite'>): string {
  if (f.cite) return f.cite;
  const p1 = f.page_start, l1 = f.line_start;
  if (p1 == null || l1 == null) return '';
  const p2 = f.page_end ?? p1;
  const l2 = f.line_end ?? l1;
  if (p1 === p2 && l1 === l2) return `${p1}:${l1}`;
  if (p1 === p2) return `${p1}:${l1}\u2013${l2}`;
  return `${p1}:${l1}\u2013${p2}:${l2}`;
}

function stanceLabel(s: FindingStance | null): string {
  if (!s) return '';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Group findings by finding_type for convenience. */
export function groupFindings(findings: DepositionFinding[]): Record<string, DepositionFinding[]> {
  const out: Record<string, DepositionFinding[]> = {};
  for (const f of findings) (out[f.finding_type] ??= []).push(f);
  return out;
}

/** Build a markdown digest. Pure function — good for preview + export. */
export function buildDigestMarkdown(
  depo: Deposition,
  findings: DepositionFinding[],
  opts: Partial<DigestOptions> = {},
): string {
  const o = { ...DEFAULTS, ...opts };
  const g = groupFindings(findings);
  const witness = depo.witness_name || depo.filename || 'Witness';
  const last = witnessLast(depo.witness_name);
  const lines: string[] = [];

  lines.push(`# ${witness} — Deposition Digest`);
  const subtitle = [
    depo.witness_role,
    depo.party_alignment,
    depo.deposition_date ? `Deposed ${fmtDate(depo.deposition_date)}` : null,
    depo.individual_case_no,
    depo.mdl_number ? `MDL ${depo.mdl_number}` : null,
    depo.page_count != null ? `${depo.page_count} pp` : null,
  ].filter(Boolean).join(' · ');
  if (subtitle) lines.push(`_${subtitle}_`);
  lines.push('');

  if (o.summary) {
    const exec = (g['exec_summary'] ?? [])[0];
    const profile = (g['witness_profile'] ?? [])[0];
    if (exec?.detail || profile?.detail) {
      lines.push('## Executive Summary');
      if (exec?.detail) { lines.push(exec.detail.trim()); lines.push(''); }
      if (profile?.detail) { lines.push(profile.detail.trim()); lines.push(''); }
    }
  }

  if (o.admissions && (g['admission']?.length ?? 0) > 0) {
    lines.push('## Admissions');
    for (const f of g['admission']) {
      const s = shortCite(f);
      const title = f.title?.trim() || 'Admission';
      const stance = stanceLabel(f.stance);
      lines.push(`### ${title}${stance ? ` — _${stance}_` : ''}`);
      if (f.detail) { lines.push(f.detail.trim()); }
      if (f.quote) {
        const bq = f.quote.trim().split('\n').map((l) => `> ${l}`).join('\n');
        lines.push('');
        lines.push(bq);
        if (s) lines.push(`>\n> — ${last} Dep. ${s}`);
      } else if (s) {
        lines.push('');
        lines.push(`_${last} Dep. ${s}_`);
      }
      lines.push('');
    }
  }

  if (o.chronology && (g['chronology']?.length ?? 0) > 0) {
    lines.push('## Chronology');
    for (const f of g['chronology']) {
      const s = shortCite(f);
      const when = (f.data?.date as string | undefined) || (f.data?.when as string | undefined) || '';
      const head = [when || null, f.title].filter(Boolean).join(' — ') || 'Event';
      lines.push(`- **${head}**${f.detail ? ` — ${f.detail.trim()}` : ''}${s ? `  _(${s})_` : ''}`);
    }
    lines.push('');
  }

  if (o.exhibits && (g['exhibit']?.length ?? 0) > 0) {
    lines.push('## Exhibits');
    for (const f of g['exhibit']) {
      const s = shortCite(f);
      const num = (f.data?.exhibit_number as number | string | undefined) ?? '';
      const head = num ? `Ex. ${num}` : (f.title || 'Exhibit');
      lines.push(`- **${head}**${f.title && num ? ` — ${f.title}` : ''}${f.detail ? ` — ${f.detail.trim()}` : ''}${s ? `  _(${s})_` : ''}`);
    }
    lines.push('');
  }

  if (o.quality && (g['quality_note']?.length ?? 0) > 0) {
    lines.push('## Quality Notes');
    for (const f of g['quality_note']) {
      const s = shortCite(f);
      lines.push(`- ${f.detail?.trim() || f.title || 'Note'}${s ? `  _(${s})_` : ''}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

function digestBase(depo: Deposition): string {
  const w = witnessLast(depo.witness_name).toLowerCase();
  return `${w}-deposition-digest`;
}

export function downloadDigestDocx(
  depo: Deposition,
  findings: DepositionFinding[],
  opts?: Partial<DigestOptions>,
): void {
  const md = buildDigestMarkdown(depo, findings, opts);
  const blocks = markdownToBlocks(md);
  downloadBlob(exportFilename(digestBase(depo), 'docx'), buildDocx(blocks));
}

export function downloadDigestMarkdown(
  depo: Deposition,
  findings: DepositionFinding[],
  opts?: Partial<DigestOptions>,
): void {
  const md = buildDigestMarkdown(depo, findings, opts);
  downloadBlob(
    exportFilename(digestBase(depo), 'md'),
    new Blob([md], { type: 'text/markdown;charset=utf-8' }),
  );
}

export function printDigest(
  depo: Deposition,
  findings: DepositionFinding[],
  opts?: Partial<DigestOptions>,
): boolean {
  const md = buildDigestMarkdown(depo, findings, opts);
  const blocks = markdownToBlocks(md);
  const html = blocksToHtml(blocks);
  const meta = [
    depo.deposition_date ? `Deposed ${fmtDate(depo.deposition_date)}` : null,
    depo.individual_case_no,
    depo.mdl_number ? `MDL ${depo.mdl_number}` : null,
  ].filter(Boolean).join(' · ');
  return printDocument({
    title: `${depo.witness_name || 'Deposition'} — Digest`,
    metaLine: meta || undefined,
    bodyHtml: html,
  });
}

/** CSV of admissions with witness, cite, stance, tags. */
export function downloadAdmissionsCsv(
  depo: Deposition,
  findings: DepositionFinding[],
): void {
  const admissions = findings.filter((f) => f.finding_type === 'admission');
  const rows = admissions.map((f) => [
    depo.witness_name || '',
    f.title || '',
    f.detail || '',
    f.quote || '',
    shortCite(f),
    f.stance || '',
    (f.issue_tags || []).join('; '),
    f.confidence != null ? f.confidence : '',
    f.verify_status || '',
    f.review_status || '',
  ]);
  downloadCsv(
    `${witnessLast(depo.witness_name).toLowerCase()}-admissions`,
    ['Witness', 'Title', 'Detail', 'Quote', 'Cite', 'Stance', 'Tags', 'Confidence', 'Verify', 'Review'],
    rows,
  );
}
