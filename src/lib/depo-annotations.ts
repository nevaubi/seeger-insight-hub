// Attorney work product for a deposition: manual highlights/notes and trial
// designations. The transcript corpus is read-only, so annotations persist
// locally (per browser) keyed by deposition id. Same shape as a future table,
// so a server-backed store can drop in without touching callers.

import { useCallback, useEffect, useMemo, useState } from 'react';

export type IssueTag =
  | 'causation'
  | 'warning'
  | 'notice'
  | 'design'
  | 'regulatory'
  | 'damages'
  | 'credibility'
  | 'general';

export const ISSUE_TAGS: { value: IssueTag; label: string }[] = [
  { value: 'general', label: 'General' },
  { value: 'causation', label: 'Causation' },
  { value: 'warning', label: 'Warnings / Label' },
  { value: 'notice', label: 'Notice' },
  { value: 'design', label: 'Design / Alternative' },
  { value: 'regulatory', label: 'Regulatory' },
  { value: 'damages', label: 'Damages' },
  { value: 'credibility', label: 'Credibility' },
];

export type DesignationKind = 'affirmative' | 'counter';

export const OBJECTION_CODES: { value: string; label: string }[] = [
  { value: '', label: 'No objection' },
  { value: 'hearsay', label: 'Hearsay (802)' },
  { value: 'relevance', label: 'Relevance (401/402)' },
  { value: '403', label: 'Prejudicial (403)' },
  { value: 'foundation', label: 'Lack of foundation' },
  { value: 'speculation', label: 'Speculation' },
  { value: 'leading', label: 'Leading' },
  { value: 'form', label: 'Form' },
  { value: 'privilege', label: 'Privilege' },
  { value: 'incomplete', label: 'Rule of completeness (106)' },
];

export interface CiteRange {
  page_start: number;
  line_start: number;
  page_end: number;
  line_end: number;
}

export interface DepoHighlight extends CiteRange {
  id: string;
  deposition_id: string;
  text: string;
  note: string;
  tag: IssueTag;
  created_at: string;
}

export interface DepoDesignation extends CiteRange {
  id: string;
  deposition_id: string;
  kind: DesignationKind;
  party: string;
  objection: string;
  basis: string;
  text: string;
  created_at: string;
}

interface Store {
  highlights: DepoHighlight[];
  designations: DepoDesignation[];
}

const KEY = 'depo.annotations.v1';
const EVENT = 'depo-annotations-changed';

function readAll(): Record<string, Store> {
  if (typeof window === 'undefined') return {};
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, Store>) : {};
  } catch {
    return {};
  }
}

function writeAll(next: Record<string, Store>): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* quota — ignore */
  }
  window.dispatchEvent(new CustomEvent(EVENT));
}

const EMPTY: Store = { highlights: [], designations: [] };

export function readDepoStore(depoId: string): Store {
  const all = readAll();
  const s = all[depoId];
  if (!s) return EMPTY;
  return {
    highlights: Array.isArray(s.highlights) ? s.highlights : [],
    designations: Array.isArray(s.designations) ? s.designations : [],
  };
}

function mutate(depoId: string, fn: (s: Store) => Store): void {
  const all = readAll();
  all[depoId] = fn(readDepoStore(depoId));
  writeAll(all);
}

function uid(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

export function citeLabel(r: CiteRange): string {
  const { page_start: p1, line_start: l1, page_end: p2, line_end: l2 } = r;
  if (p1 === p2 && l1 === l2) return `${p1}:${l1}`;
  if (p1 === p2) return `${p1}:${l1}\u2013${l2}`;
  return `${p1}:${l1}\u2013${p2}:${l2}`;
}

/** Rough courtroom read time: ~3 transcript lines per 10 seconds. */
export function estimateMinutes(ranges: CiteRange[], linesPerPage = 25): number {
  const lines = ranges.reduce((acc, r) => {
    const span = (r.page_end - r.page_start) * linesPerPage + (r.line_end - r.line_start) + 1;
    return acc + Math.max(1, span);
  }, 0);
  return Math.round((lines / 3) * 10) / 60;
}

export function rangesOverlap(a: CiteRange, b: CiteRange): boolean {
  const start = (r: CiteRange) => r.page_start * 1000 + r.line_start;
  const end = (r: CiteRange) => r.page_end * 1000 + r.line_end;
  return start(a) <= end(b) && start(b) <= end(a);
}

export function useDepoAnnotations(depoId: string) {
  const [store, setStore] = useState<Store>(EMPTY);

  const sync = useCallback(() => setStore(readDepoStore(depoId)), [depoId]);

  useEffect(() => {
    sync();
    const h = () => sync();
    window.addEventListener(EVENT, h);
    window.addEventListener('storage', h);
    return () => {
      window.removeEventListener(EVENT, h);
      window.removeEventListener('storage', h);
    };
  }, [sync]);

  const addHighlight = useCallback(
    (input: Omit<DepoHighlight, 'id' | 'deposition_id' | 'created_at'>) => {
      const row: DepoHighlight = {
        ...input,
        id: uid(),
        deposition_id: depoId,
        created_at: new Date().toISOString(),
      };
      mutate(depoId, (s) => ({ ...s, highlights: [...s.highlights, row] }));
      return row;
    },
    [depoId],
  );

  const updateHighlight = useCallback(
    (id: string, patch: Partial<DepoHighlight>) => {
      mutate(depoId, (s) => ({
        ...s,
        highlights: s.highlights.map((h) => (h.id === id ? { ...h, ...patch } : h)),
      }));
    },
    [depoId],
  );

  const removeHighlight = useCallback(
    (id: string) => {
      mutate(depoId, (s) => ({ ...s, highlights: s.highlights.filter((h) => h.id !== id) }));
    },
    [depoId],
  );

  const addDesignation = useCallback(
    (input: Omit<DepoDesignation, 'id' | 'deposition_id' | 'created_at'>) => {
      const row: DepoDesignation = {
        ...input,
        id: uid(),
        deposition_id: depoId,
        created_at: new Date().toISOString(),
      };
      mutate(depoId, (s) => ({ ...s, designations: [...s.designations, row] }));
      return row;
    },
    [depoId],
  );

  const updateDesignation = useCallback(
    (id: string, patch: Partial<DepoDesignation>) => {
      mutate(depoId, (s) => ({
        ...s,
        designations: s.designations.map((d) => (d.id === id ? { ...d, ...patch } : d)),
      }));
    },
    [depoId],
  );

  const removeDesignation = useCallback(
    (id: string) => {
      mutate(depoId, (s) => ({ ...s, designations: s.designations.filter((d) => d.id !== id) }));
    },
    [depoId],
  );

  const highlights = useMemo(
    () =>
      [...store.highlights].sort(
        (a, b) => a.page_start - b.page_start || a.line_start - b.line_start,
      ),
    [store.highlights],
  );
  const designations = useMemo(
    () =>
      [...store.designations].sort(
        (a, b) => a.page_start - b.page_start || a.line_start - b.line_start,
      ),
    [store.designations],
  );

  /** Fast membership set of "page-line" keys carrying a highlight. */
  const highlightedLineKeys = useMemo(() => {
    const set = new Map<string, IssueTag>();
    for (const h of highlights) {
      for (let p = h.page_start; p <= h.page_end; p++) {
        const from = p === h.page_start ? h.line_start : 1;
        const to = p === h.page_end ? h.line_end : 40;
        for (let l = from; l <= to; l++) set.set(`${p}-${l}`, h.tag);
      }
    }
    return set;
  }, [highlights]);

  const designatedLineKeys = useMemo(() => {
    const set = new Map<string, DesignationKind>();
    for (const d of designations) {
      for (let p = d.page_start; p <= d.page_end; p++) {
        const from = p === d.page_start ? d.line_start : 1;
        const to = p === d.page_end ? d.line_end : 40;
        for (let l = from; l <= to; l++) set.set(`${p}-${l}`, d.kind);
      }
    }
    return set;
  }, [designations]);

  return {
    highlights,
    designations,
    highlightedLineKeys,
    designatedLineKeys,
    addHighlight,
    updateHighlight,
    removeHighlight,
    addDesignation,
    updateDesignation,
    removeDesignation,
  };
}

export const TAG_COLORS: Record<IssueTag, string> = {
  general: 'bg-amber-300/45',
  causation: 'bg-rose-300/40',
  warning: 'bg-orange-300/40',
  notice: 'bg-sky-300/40',
  design: 'bg-emerald-300/40',
  regulatory: 'bg-violet-300/40',
  damages: 'bg-teal-300/40',
  credibility: 'bg-fuchsia-300/40',
};

export function tagLabel(t: IssueTag): string {
  return ISSUE_TAGS.find((x) => x.value === t)?.label ?? t;
}
