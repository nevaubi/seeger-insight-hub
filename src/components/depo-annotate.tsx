import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { Highlighter, Gavel, Trash2, StickyNote, Scale } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  ISSUE_TAGS,
  OBJECTION_CODES,
  TAG_COLORS,
  citeLabel,
  estimateMinutes,
  rangesOverlap,
  tagLabel,
  type CiteRange,
  type DepoDesignation,
  type DepoHighlight,
  type DesignationKind,
  type IssueTag,
} from '@/lib/depo-annotations';

// ---------------------------------------------------------------- selection

export interface TranscriptSelection extends CiteRange {
  text: string;
  x: number;
  y: number;
}

function lineOf(node: Node | null): { page: number; line: number } | null {
  let el: HTMLElement | null =
    node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  while (el && !(el.id && el.id.startsWith('line-'))) el = el.parentElement;
  if (!el) return null;
  const m = /^line-(\d+)-(\d+)$/.exec(el.id);
  if (!m) return null;
  return { page: Number(m[1]), line: Number(m[2]) };
}

/** Reads the current DOM text selection inside the transcript and maps it to a page:line span. */
export function useTranscriptSelection(
  containerRef: RefObject<HTMLElement | null>,
): { selection: TranscriptSelection | null; clear: () => void } {
  const [selection, setSelection] = useState<TranscriptSelection | null>(null);

  const clear = useCallback(() => {
    setSelection(null);
    try {
      window.getSelection()?.removeAllRanges();
    } catch {
      /* ignore */
    }
  }, []);

  useEffect(() => {
    const onUp = () => {
      const sel = window.getSelection();
      const container = containerRef.current;
      if (!sel || sel.isCollapsed || !container) {
        setSelection(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) {
        setSelection(null);
        return;
      }
      const a = lineOf(range.startContainer);
      const b = lineOf(range.endContainer);
      if (!a || !b) {
        setSelection(null);
        return;
      }
      const text = sel.toString().replace(/\s+/g, ' ').trim();
      if (!text) {
        setSelection(null);
        return;
      }
      const rect = range.getBoundingClientRect();
      const first = a.page * 1000 + a.line <= b.page * 1000 + b.line ? a : b;
      const last = first === a ? b : a;
      setSelection({
        page_start: first.page,
        line_start: first.line,
        page_end: last.page,
        line_end: last.line,
        text,
        x: rect.left + rect.width / 2,
        y: rect.top,
      });
    };
    document.addEventListener('mouseup', onUp);
    return () => document.removeEventListener('mouseup', onUp);
  }, [containerRef]);

  return { selection, clear };
}

// ------------------------------------------------------------ mark toolbar

export function SelectionToolbar({
  selection,
  onHighlight,
  onDesignate,
  onDismiss,
}: {
  selection: TranscriptSelection;
  onHighlight: (tag: IssueTag) => void;
  onDesignate: (kind: DesignationKind) => void;
  onDismiss: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [tagOpen, setTagOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const top = Math.max(8, selection.y - 46);
  const left = Math.min(Math.max(140, selection.x), window.innerWidth - 150);

  return (
    <div
      ref={ref}
      style={{ top, left }}
      onMouseDown={(e) => e.preventDefault()}
      className="fixed z-50 -translate-x-1/2 animate-in fade-in zoom-in-95 duration-150"
    >
      <div className="flex items-center gap-0.5 rounded-sm border border-border bg-card/95 backdrop-blur px-1 py-1 shadow-lg">
        <span className="px-1.5 font-mono text-[10px] tabular-nums text-muted-foreground">
          {citeLabel(selection)}
        </span>
        <div className="h-4 w-px bg-border" />
        <button
          type="button"
          onClick={() => setTagOpen((v) => !v)}
          className="inline-flex items-center gap-1 rounded-sm px-2 py-1 text-[11px] font-medium hover:bg-secondary"
        >
          <Highlighter className="h-3.5 w-3.5" /> Highlight
        </button>
        <button
          type="button"
          onClick={() => onDesignate('affirmative')}
          className="inline-flex items-center gap-1 rounded-sm px-2 py-1 text-[11px] font-medium hover:bg-secondary"
          title="Designate this passage for trial"
        >
          <Gavel className="h-3.5 w-3.5" /> Designate
        </button>
        <button
          type="button"
          onClick={() => onDesignate('counter')}
          className="inline-flex items-center gap-1 rounded-sm px-2 py-1 text-[11px] font-medium text-muted-foreground hover:bg-secondary hover:text-foreground"
          title="Counter-designate this passage"
        >
          Counter
        </button>
      </div>
      {tagOpen && (
        <div className="mt-1 grid grid-cols-2 gap-0.5 rounded-sm border border-border bg-card/95 backdrop-blur p-1 shadow-lg">
          {ISSUE_TAGS.map((t) => (
            <button
              key={t.value}
              type="button"
              onClick={() => onHighlight(t.value)}
              className="flex items-center gap-1.5 rounded-sm px-2 py-1 text-left text-[11px] hover:bg-secondary"
            >
              <span className={cn('h-2.5 w-2.5 rounded-[2px]', TAG_COLORS[t.value])} />
              {t.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ------------------------------------------------------------- notes panel

export function NotesTab({
  highlights,
  onJump,
  onUpdate,
  onRemove,
}: {
  highlights: DepoHighlight[];
  onJump: (r: CiteRange) => void;
  onUpdate: (id: string, patch: Partial<DepoHighlight>) => void;
  onRemove: (id: string) => void;
}) {
  if (highlights.length === 0) {
    return (
      <div className="rounded-sm border border-dashed border-border px-4 py-8 text-center">
        <StickyNote className="mx-auto h-4 w-4 text-muted-foreground" />
        <p className="mt-2 text-[12.5px] text-muted-foreground">
          Select text in the transcript to highlight it, tag the issue, and add a note.
        </p>
      </div>
    );
  }
  return (
    <div className="space-y-2">
      {highlights.map((h) => (
        <div key={h.id} className="rounded-sm border border-border bg-card p-3">
          <div className="flex items-center gap-2">
            <span className={cn('h-2.5 w-2.5 rounded-[2px] shrink-0', TAG_COLORS[h.tag])} />
            <span className="text-[10px] font-sans font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {tagLabel(h.tag)}
            </span>
            <button
              type="button"
              onClick={() => onJump(h)}
              className="ml-auto font-mono text-[10.5px] tabular-nums text-primary hover:underline"
            >
              {citeLabel(h)}
            </button>
            <button
              type="button"
              onClick={() => onRemove(h.id)}
              aria-label="Delete highlight"
              className="text-muted-foreground hover:text-destructive"
            >
              <Trash2 className="h-3.5 w-3.5" />
            </button>
          </div>
          <blockquote className="mt-2 border-l-2 border-border pl-2.5 font-mono text-[11.5px] leading-5 text-foreground/85 line-clamp-4">
            {h.text}
          </blockquote>
          <Input
            defaultValue={h.note}
            onBlur={(e) => onUpdate(h.id, { note: e.target.value })}
            placeholder="Add a note…"
            className="mt-2 h-7 text-[12px]"
          />
        </div>
      ))}
    </div>
  );
}

// ------------------------------------------------------ designations panel

export function DesignationsTab({
  designations,
  onJump,
  onUpdate,
  onRemove,
}: {
  designations: DepoDesignation[];
  onJump: (r: CiteRange) => void;
  onUpdate: (id: string, patch: Partial<DepoDesignation>) => void;
  onRemove: (id: string) => void;
}) {
  if (designations.length === 0) {
    return (
      <div className="rounded-sm border border-dashed border-border px-4 py-8 text-center">
        <Scale className="mx-auto h-4 w-4 text-muted-foreground" />
        <p className="mt-2 text-[12.5px] text-muted-foreground">
          Select transcript text and choose <span className="font-medium">Designate</span> or{' '}
          <span className="font-medium">Counter</span> to build the designation chart.
        </p>
      </div>
    );
  }

  const affirmative = designations.filter((d) => d.kind === 'affirmative');
  const counter = designations.filter((d) => d.kind === 'counter');
  const minutes = estimateMinutes(designations);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-sm border border-border bg-secondary/40 px-3 py-2 text-[11px] font-sans tabular-nums">
        <span>
          <span className="font-semibold text-foreground">{affirmative.length}</span> affirmative
        </span>
        <span>
          <span className="font-semibold text-foreground">{counter.length}</span> counter
        </span>
        <span className="text-muted-foreground">
          ≈ {minutes.toFixed(1)} min of testimony
        </span>
      </div>

      <div className="space-y-2">
        {designations.map((d) => {
          const conflicts = designations.filter(
            (o) => o.id !== d.id && o.kind !== d.kind && rangesOverlap(o, d),
          );
          return (
            <div key={d.id} className="rounded-sm border border-border bg-card p-3">
              <div className="flex items-center gap-2">
                <span
                  className={cn(
                    'rounded-sm px-1.5 py-0.5 text-[9.5px] font-sans font-semibold uppercase tracking-[0.12em]',
                    d.kind === 'affirmative'
                      ? 'bg-primary/10 text-primary'
                      : 'bg-destructive/10 text-destructive',
                  )}
                >
                  {d.kind === 'affirmative' ? 'Affirmative' : 'Counter'}
                </span>
                {conflicts.length > 0 && (
                  <span className="text-[10px] font-sans text-muted-foreground">
                    overlaps {conflicts.length} {conflicts.length === 1 ? 'span' : 'spans'}
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => onJump(d)}
                  className="ml-auto font-mono text-[10.5px] tabular-nums text-primary hover:underline"
                >
                  {citeLabel(d)}
                </button>
                <button
                  type="button"
                  onClick={() => onRemove(d.id)}
                  aria-label="Delete designation"
                  className="text-muted-foreground hover:text-destructive"
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
              <blockquote className="mt-2 border-l-2 border-border pl-2.5 font-mono text-[11.5px] leading-5 text-foreground/85 line-clamp-3">
                {d.text}
              </blockquote>
              <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
                <Input
                  defaultValue={d.party}
                  onBlur={(e) => onUpdate(d.id, { party: e.target.value })}
                  placeholder="Party"
                  className="h-7 text-[12px]"
                />
                <select
                  value={d.objection}
                  onChange={(e) => onUpdate(d.id, { objection: e.target.value })}
                  className="h-7 rounded-sm border border-input bg-background px-2 text-[12px]"
                  aria-label="Objection code"
                >
                  {OBJECTION_CODES.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
                <Input
                  defaultValue={d.basis}
                  onBlur={(e) => onUpdate(d.id, { basis: e.target.value })}
                  placeholder="Basis / note"
                  className="h-7 text-[12px]"
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

export function ClearAllButton({ onClear, label }: { onClear: () => void; label: string }) {
  return (
    <Button variant="ghost" size="sm" className="h-7 text-[11px]" onClick={onClear}>
      {label}
    </Button>
  );
}
