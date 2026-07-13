import { useEffect, useMemo, useRef } from 'react';
import { MessageSquareText } from 'lucide-react';
import { cn } from '@/lib/utils';
import { buildSegments, type Suggestion } from '@/lib/redline';

// Inline tracked-changes rendering: the document text with pending suggestions shown as
// Word-style markup — deletions struck in muted red, insertions underlined in the accent,
// comment anchors dotted amber. Spans are clickable and sync with the Changes rail.
// Suggestions that can't be placed inline (anchor drifted, overlap) stay rail-only.

export function RedlineView({
  doc,
  suggestions,
  focusedId,
  onFocus,
}: {
  doc: string;
  suggestions: Suggestion[];
  focusedId: string | null;
  onFocus: (id: string | null) => void;
}) {
  const pending = useMemo(() => suggestions.filter((s) => s.status === 'pending'), [suggestions]);
  const { segments } = useMemo(() => buildSegments(doc, pending), [doc, pending]);
  const spanRefs = useRef(new Map<string, HTMLElement>());

  useEffect(() => {
    if (!focusedId) return;
    const el = spanRefs.current.get(focusedId);
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, [focusedId]);

  const refCb = (id: string) => (el: HTMLElement | null) => {
    if (el) spanRefs.current.set(id, el);
    else spanRefs.current.delete(id);
  };

  return (
    <div className="font-serif text-[15px] leading-[1.75] text-foreground whitespace-pre-wrap break-words">
      {segments.map((seg, i) => {
        switch (seg.kind) {
          case 'text':
            return <span key={i}>{seg.text}</span>;
          case 'del':
            return (
              <span
                key={i}
                ref={refCb(seg.suggestion.id)}
                onClick={() => onFocus(seg.suggestion.id)}
                title={seg.suggestion.rationale || 'Suggested deletion — Claude'}
                className={cn(
                  'cursor-pointer rounded-[2px] bg-red-50 text-red-900/70 line-through decoration-red-700/50 transition-colors duration-150',
                  focusedId === seg.suggestion.id && 'ring-1 ring-red-400 bg-red-100',
                )}
              >
                {seg.text}
              </span>
            );
          case 'ins':
            return (
              <span
                key={i}
                ref={refCb(seg.suggestion.id)}
                onClick={() => onFocus(seg.suggestion.id)}
                title={seg.suggestion.rationale || 'Suggested insertion — Claude'}
                className={cn(
                  'cursor-pointer rounded-[2px] bg-accent/5 text-accent underline decoration-accent/60 decoration-2 underline-offset-[3px] transition-colors duration-150',
                  focusedId === seg.suggestion.id && 'ring-1 ring-accent/60 bg-accent/10',
                )}
              >
                {seg.text}
              </span>
            );
          case 'comment':
            return (
              <span
                key={i}
                ref={refCb(seg.suggestion.id)}
                onClick={() => onFocus(seg.suggestion.id)}
                title={seg.suggestion.text}
                className={cn(
                  'cursor-pointer rounded-[2px] bg-amber-50/70 underline decoration-dotted decoration-amber-600/70 underline-offset-[3px] transition-colors duration-150',
                  focusedId === seg.suggestion.id && 'ring-1 ring-amber-400 bg-amber-100/70',
                )}
              >
                {seg.text}
                <MessageSquareText className="inline h-3 w-3 ml-0.5 -mt-0.5 text-amber-600" aria-label="Comment" />
              </span>
            );
        }
      })}
      {doc.length === 0 && <span className="text-muted-foreground italic text-sm">Nothing to review yet.</span>}
    </div>
  );
}
