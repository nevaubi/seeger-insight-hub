import { useEffect, useMemo, useRef } from 'react';
import {
  AlertTriangle,
  BookOpen,
  Check,
  ChevronDown,
  Loader2,
  MessageSquareText,
  Minus,
  Plus,
  Replace,
  X,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible';
import { cn } from '@/lib/utils';
import {
  FAIL_REASON_LABELS,
  type FailedSuggestion,
  type RedlineOp,
  type Suggestion,
} from '@/lib/redline';
import type { RedlineMeta, RedlineRunStats } from '@/lib/useRedline';
import { TierBadge } from './tier-badge';

// The review rail: every pending AI suggestion as an accept/reject card, resolved items
// collapsed below, and — deliberately visible — the anchors the server REFUSED to apply.
// The failed-anchor count is the trust story; it is never hidden.

const OP_META: Record<RedlineOp, { label: string; icon: typeof Replace; cls: string }> = {
  replace: { label: 'Replace', icon: Replace, cls: 'text-accent border-accent/40 bg-accent/5' },
  delete: { label: 'Delete', icon: Minus, cls: 'text-red-700 border-red-300 bg-red-50' },
  insert_before: { label: 'Insert', icon: Plus, cls: 'text-emerald-700 border-emerald-300 bg-emerald-50' },
  insert_after: { label: 'Insert', icon: Plus, cls: 'text-emerald-700 border-emerald-300 bg-emerald-50' },
  comment: { label: 'Comment', icon: MessageSquareText, cls: 'text-amber-700 border-amber-300 bg-amber-50' },
};

function clip(s: string, n = 160): string {
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

export function ChangesPanel({
  suggestions,
  failed,
  summary,
  meta,
  stats,
  running,
  focusedId,
  onFocus,
  onAccept,
  onReject,
  onAcceptAll,
  onRejectAll,
}: {
  suggestions: Suggestion[];
  failed: FailedSuggestion[];
  summary: string;
  meta: RedlineMeta | null;
  stats: RedlineRunStats | null;
  running: boolean;
  focusedId: string | null;
  onFocus: (id: string | null) => void;
  onAccept: (id: string) => void;
  onReject: (id: string) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
}) {
  const pending = useMemo(() => suggestions.filter((s) => s.status === 'pending'), [suggestions]);
  const resolved = useMemo(() => suggestions.filter((s) => s.status !== 'pending'), [suggestions]);
  const cardRefs = useRef(new Map<string, HTMLDivElement>());

  useEffect(() => {
    if (!focusedId) return;
    const el = cardRefs.current.get(focusedId);
    el?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [focusedId]);

  if (!running && suggestions.length === 0 && failed.length === 0) {
    return (
      <div className="px-4 py-8 text-center">
        <Replace className="h-5 w-5 mx-auto mb-2.5 text-accent/60" strokeWidth={1.75} />
        <p className="font-serif text-[14.5px] text-foreground/85 mb-1">No suggestions yet.</p>
        <p className="text-[11.5px] leading-relaxed text-muted-foreground max-w-[30ch] mx-auto">
          Run a markup pass from the chat (e.g. “review this draft for consistency with PTO 22 and
          mark it up”), or select text and choose <span className="text-foreground/80">Suggest edits</span>.
          Every suggestion is anchored to text verified to exist in this document.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      {/* run header */}
      <div className="flex items-start gap-2 px-1">
        <div className="min-w-0 flex-1">
          <div className="text-[11px] font-sans text-muted-foreground tabular-nums">
            {running ? (
              <span className="inline-flex items-center gap-1.5">
                <Loader2 className="h-3 w-3 animate-spin text-accent" />
                Reviewing · {pending.length} suggestion{pending.length === 1 ? '' : 's'}
                {failed.length > 0 && <span className="text-amber-700"> · {failed.length} anchor{failed.length === 1 ? '' : 's'} failed</span>}
              </span>
            ) : (
              <span>
                {stats?.editCount ?? suggestions.length} suggestion{(stats?.editCount ?? suggestions.length) === 1 ? '' : 's'}
                {(stats?.failedCount ?? failed.length) > 0 && (
                  <span className="text-amber-700"> · {stats?.failedCount ?? failed.length} failed verification</span>
                )}
                {meta?.grounded && <span> · grounded in {meta.passages} record passages</span>}
              </span>
            )}
          </div>
          {summary && <p className="mt-1 text-[12px] leading-snug font-serif text-foreground/80">{clip(summary, 280)}</p>}
        </div>
      </div>

      {/* bulk actions */}
      {pending.length > 0 && (
        <div className="flex items-center gap-1.5 px-1">
          <Button size="sm" variant="outline" className="h-6.5 px-2 text-[11px] gap-1" onClick={onAcceptAll} disabled={running}>
            <Check className="h-3 w-3" /> Accept all
          </Button>
          <Button size="sm" variant="ghost" className="h-6.5 px-2 text-[11px] gap-1 text-muted-foreground" onClick={onRejectAll} disabled={running}>
            <X className="h-3 w-3" /> Dismiss all
          </Button>
          <span className="ml-auto text-[10px] font-sans text-muted-foreground/70">a accept · r reject</span>
        </div>
      )}

      {/* pending cards */}
      <div className="space-y-1.5">
        {pending.map((s) => (
          <SuggestionCard
            key={s.id}
            s={s}
            focused={focusedId === s.id}
            refCb={(el) => {
              if (el) cardRefs.current.set(s.id, el);
              else cardRefs.current.delete(s.id);
            }}
            onFocus={() => onFocus(s.id)}
            onAccept={() => onAccept(s.id)}
            onReject={() => onReject(s.id)}
          />
        ))}
      </div>

      {/* failed anchors — the trust story, always visible */}
      {failed.length > 0 && (
        <div className="mt-1">
          <div className="flex items-center gap-1.5 px-1 mb-1.5">
            <AlertTriangle className="h-3 w-3 text-amber-600" />
            <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground font-sans">
              Not applied — anchor failed verification ({failed.length})
            </span>
          </div>
          <div className="space-y-1">
            {failed.map((f) => (
              <div key={f.id} className="rounded-md border border-amber-200 bg-amber-50/50 px-2.5 py-1.5">
                <div className="text-[10.5px] font-sans text-amber-800">
                  {FAIL_REASON_LABELS[f.reason] ?? f.reason}
                  {f.count != null && f.reason === 'ambiguous_anchor' ? ` (${f.count}×)` : ''}
                </div>
                <div className="mt-0.5 font-serif text-[11.5px] text-foreground/60 line-clamp-2">“{clip(f.anchor, 120)}”</div>
                {f.rationale && <div className="mt-0.5 text-[10.5px] text-muted-foreground italic line-clamp-1">{f.rationale}</div>}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* resolved, collapsed */}
      {resolved.length > 0 && (
        <Collapsible>
          <CollapsibleTrigger className="flex w-full items-center gap-1.5 px-1 py-1 text-[10px] uppercase tracking-[0.12em] text-muted-foreground font-sans hover:text-foreground">
            <ChevronDown className="h-3 w-3" />
            Resolved ({resolved.length})
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="space-y-1 mt-1">
              {resolved.map((s) => {
                const om = OP_META[s.op];
                return (
                  <div key={s.id} className="flex items-center gap-2 rounded-md border border-border/60 bg-card/50 px-2.5 py-1.5 opacity-70">
                    <span className={cn('inline-flex items-center gap-1 rounded border px-1 py-px text-[9.5px] font-sans uppercase tracking-wide', om.cls)}>
                      {om.label}
                    </span>
                    <span className="min-w-0 flex-1 truncate font-serif text-[11.5px] text-foreground/60">“{clip(s.anchor, 60)}”</span>
                    <span className={cn('text-[10px] font-sans', s.status === 'accepted' ? 'text-emerald-700' : 'text-muted-foreground')}>
                      {s.status === 'accepted' ? 'Accepted' : 'Dismissed'}
                    </span>
                  </div>
                );
              })}
            </div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

function SuggestionCard({
  s,
  focused,
  refCb,
  onFocus,
  onAccept,
  onReject,
}: {
  s: Suggestion;
  focused: boolean;
  refCb: (el: HTMLDivElement | null) => void;
  onFocus: () => void;
  onAccept: () => void;
  onReject: () => void;
}) {
  const om = OP_META[s.op];
  const Icon = om.icon;
  return (
    <div
      ref={refCb}
      tabIndex={0}
      role="group"
      onClick={onFocus}
      onKeyDown={(e) => {
        if (e.key === 'a') { e.preventDefault(); onAccept(); }
        else if (e.key === 'r') { e.preventDefault(); onReject(); }
        else if (e.key === 'Enter') { e.preventDefault(); onFocus(); }
      }}
      className={cn(
        'group rounded-md border bg-card px-2.5 py-2 cursor-pointer transition outline-none',
        focused ? 'border-accent ring-1 ring-accent/30' : 'border-border hover:border-accent/40',
        'focus-visible:ring-2 focus-visible:ring-accent/40',
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className={cn('inline-flex items-center gap-1 rounded border px-1.5 py-px text-[9.5px] font-sans font-medium uppercase tracking-wide', om.cls)}>
          <Icon className="h-2.5 w-2.5" /> {om.label}
        </span>
        {s.confidence === 'needs_review' && (
          <span className="rounded border border-amber-400/60 bg-amber-50 px-1 py-px text-[9.5px] font-sans uppercase tracking-wide text-amber-700">
            Needs review
          </span>
        )}
        {s.source === 'transform' && (
          <span className="text-[9.5px] font-sans uppercase tracking-wide text-muted-foreground/70">Selection</span>
        )}
        <span className="ml-auto flex items-center gap-0.5 opacity-0 group-hover:opacity-100 group-focus-within:opacity-100 transition-opacity">
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0 text-emerald-700 hover:text-emerald-800 hover:bg-emerald-50"
            title="Accept (a)"
            onClick={(e) => { e.stopPropagation(); onAccept(); }}
          >
            <Check className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="h-6 w-6 p-0 text-muted-foreground hover:text-red-700 hover:bg-red-50"
            title="Reject (r)"
            onClick={(e) => { e.stopPropagation(); onReject(); }}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </span>
      </div>

      <div className="mt-1.5 font-serif text-[12.5px] leading-snug">
        {s.op !== 'comment' && s.op !== 'insert_before' && s.op !== 'insert_after' && (
          <span className="text-red-800/70 line-through decoration-red-700/40">{clip(s.anchor)}</span>
        )}
        {(s.op === 'insert_before' || s.op === 'insert_after') && (
          <span className="text-foreground/50">“{clip(s.anchor, 60)}”</span>
        )}
        {s.op === 'comment' && <span className="text-foreground/60 underline decoration-dotted decoration-amber-500/70">“{clip(s.anchor, 80)}”</span>}
        {s.op !== 'delete' && s.op !== 'comment' && (
          <>
            {' '}
            <span className="text-accent underline decoration-accent/50 decoration-2 underline-offset-2">{clip(s.text)}</span>
          </>
        )}
        {s.op === 'comment' && (
          <span className="block mt-1 text-[12px] text-amber-900/90 bg-amber-50 border border-amber-200 rounded px-2 py-1">{clip(s.text, 220)}</span>
        )}
      </div>

      {(s.rationale || s.cite) && (
        <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
          {s.rationale && <span className="text-[11px] text-muted-foreground italic leading-snug">{s.rationale}</span>}
          {s.cite && <TierBadge cite={s.cite} />}
        </div>
      )}
    </div>
  );
}

export function GroundingChip({ meta }: { meta: RedlineMeta | null }) {
  if (!meta?.profile) return null;
  const when = meta.profile.updated_at
    ? new Date(meta.profile.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    : null;
  return (
    <span
      className="inline-flex items-center gap-1 rounded-full border border-border bg-card px-2 py-0.5 text-[10px] font-sans text-muted-foreground"
      title="This matter's practice profile was injected into the model's instructions for this run"
    >
      <BookOpen className="h-2.5 w-2.5 text-accent" />
      Playbook consulted{when ? ` · ${when}` : ''}
    </span>
  );
}
