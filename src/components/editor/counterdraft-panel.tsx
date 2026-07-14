import { useEffect, useMemo, useState } from 'react';
import type { Editor } from '@tiptap/react';
import { Check, ChevronRight, Loader2, RefreshCcw, Sparkles, X, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  COUNTERDRAFT_INSTRUCTION,
  clearCounterdraft,
  loadCounterdraft,
  saveCounterdraft,
  sectionRange,
  type CounterSection,
  type CounterdraftState,
} from '@/lib/counterdraft';

export type SuggestArgs = {
  section: CounterSection;
  from: number;
  to: number;
  selectionText: string;
  instruction: string;
};

export function CounterdraftPanel({
  docId,
  editor,
  onClose,
  onSuggest,
  onDismantle,
}: {
  docId: string;
  editor: Editor | null;
  onClose: () => void;
  /** Streams counter-language into the range as a tracked change. */
  onSuggest: (args: SuggestArgs) => Promise<void>;
  /** Called when the user turns the doc back into a regular draft. */
  onDismantle: () => void;
}) {
  const [state, setState] = useState<CounterdraftState | null>(() => loadCounterdraft(docId));
  const [busyId, setBusyId] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(state?.sections[0]?.id ?? null);
  const [showOriginal, setShowOriginal] = useState<string | null>(null);

  useEffect(() => {
    setState(loadCounterdraft(docId));
    setSelected(null);
    setShowOriginal(null);
  }, [docId]);

  if (!state) {
    return (
      <aside className="hidden lg:flex lg:w-[380px] shrink-0 flex-col border-l border-border bg-card/40">
        <div className="p-4 text-sm text-muted-foreground">This document has no counter-draft data.</div>
      </aside>
    );
  }

  const persist = (next: CounterdraftState) => {
    saveCounterdraft(docId, next);
    setState(next);
  };

  const updateSection = (id: string, patch: Partial<CounterSection>) => {
    persist({
      ...state,
      sections: state.sections.map((s) => (s.id === id ? { ...s, ...patch } : s)),
    });
  };

  const runSuggest = async (sec: CounterSection) => {
    if (!editor) {
      toast.error('Editor not ready');
      return;
    }
    const range = sectionRange(editor, state.sections, state.sections.indexOf(sec));
    if (!range || range.to <= range.from) {
      toast.error(`Could not locate "${sec.heading}" in the document`);
      return;
    }
    const selectionText = editor.state.doc.textBetween(range.from, range.to, '\n', '\n').trim();
    if (!selectionText) {
      toast.error('Section appears empty');
      return;
    }
    setBusyId(sec.id);
    updateSection(sec.id, { status: 'drafting' });
    try {
      await onSuggest({
        section: sec,
        from: range.from,
        to: range.to,
        selectionText,
        instruction: COUNTERDRAFT_INSTRUCTION,
      });
      updateSection(sec.id, { status: 'ready' });
    } catch (e: any) {
      updateSection(sec.id, { status: 'pending' });
      toast.error(`Suggestion failed: ${e?.message ?? String(e)}`);
    } finally {
      setBusyId(null);
    }
  };

  const jumpTo = (sec: CounterSection) => {
    if (!editor) return;
    const range = sectionRange(editor, state.sections, state.sections.indexOf(sec));
    if (!range) {
      toast.error(`Could not locate "${sec.heading}"`);
      return;
    }
    editor.chain().focus().setTextSelection(range.from + 1).scrollIntoView().run();
    setSelected(sec.id);
  };

  const dismantle = () => {
    if (!confirm('Convert this back to a regular document? Counter-draft sections and status will be discarded (tracked changes stay in the editor).')) return;
    clearCounterdraft(docId);
    setState(null);
    onDismantle();
  };

  const counts = useMemo(() => {
    const c = { pending: 0, drafting: 0, ready: 0, accepted: 0, rejected: 0 } as Record<
      CounterSection['status'],
      number
    >;
    for (const s of state.sections) c[s.status]++;
    return c;
  }, [state.sections]);

  return (
    <aside className="hidden lg:flex lg:w-[400px] shrink-0 flex-col border-l border-border bg-card/40 min-h-0">
      <div className="px-4 py-2.5 border-b border-border flex items-center gap-2 shrink-0">
        <Sparkles className="h-3.5 w-3.5 text-accent" />
        <div className="font-serif text-[13.5px] font-semibold">Counter-draft</div>
        <div className="ml-1 text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground font-sans">
          {state.sections.length} sections
        </div>
        <button
          type="button"
          onClick={dismantle}
          className="ml-auto inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground/70 hover:text-destructive hover:bg-secondary"
          title="Remove counter-draft data"
        >
          <Trash2 className="h-3.5 w-3.5" />
        </button>
        <button
          type="button"
          onClick={onClose}
          className="inline-flex h-6 w-6 items-center justify-center rounded-sm text-muted-foreground/70 hover:text-foreground hover:bg-secondary"
          title="Close panel"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      <div className="px-4 py-2 border-b border-border shrink-0 flex items-center gap-3 text-[10.5px] font-sans text-muted-foreground uppercase tracking-[0.12em]">
        <span>{counts.pending} pending</span>
        <span className="text-accent normal-case tracking-normal">{counts.ready} ready</span>
        <span className="text-emerald-700 normal-case tracking-normal">{counts.accepted} accepted</span>
      </div>

      <div className="flex-1 overflow-y-auto min-h-0">
        {state.sections.map((sec, i) => {
          const active = selected === sec.id;
          const busy = busyId === sec.id;
          const showOrig = showOriginal === sec.id;
          return (
            <div
              key={sec.id}
              className={cn(
                'border-b border-border/70 px-4 py-3 transition-colors',
                active ? 'bg-secondary/40' : 'hover:bg-secondary/20',
              )}
            >
              <div className="flex items-start gap-2">
                <button
                  type="button"
                  onClick={() => jumpTo(sec)}
                  className="flex-1 text-left min-w-0"
                  title="Jump to this section"
                >
                  <div className="flex items-center gap-1.5">
                    <span className="text-[10px] font-sans tabular-nums text-muted-foreground w-5">
                      {String(i + 1).padStart(2, '0')}
                    </span>
                    <StatusDot status={sec.status} />
                    <span className="font-serif text-[13px] font-medium leading-snug truncate">
                      {sec.heading}
                    </span>
                  </div>
                </button>
              </div>

              <div className="mt-2 flex items-center gap-1.5">
                <Button
                  size="sm"
                  variant={sec.status === 'ready' ? 'outline' : 'default'}
                  className="h-7 px-2 text-[11.5px]"
                  onClick={() => runSuggest(sec)}
                  disabled={busy}
                >
                  {busy ? (
                    <>
                      <Loader2 className="h-3 w-3 animate-spin mr-1" /> Drafting…
                    </>
                  ) : sec.status === 'ready' ? (
                    <>
                      <RefreshCcw className="h-3 w-3 mr-1" /> Regenerate
                    </>
                  ) : sec.status === 'accepted' ? (
                    <>
                      <Check className="h-3 w-3 mr-1" /> Suggest again
                    </>
                  ) : (
                    <>
                      <Sparkles className="h-3 w-3 mr-1" /> Suggest counter-language
                    </>
                  )}
                </Button>
                {sec.status === 'ready' && (
                  <span className="text-[10.5px] text-muted-foreground font-sans">
                    Accept in the editor
                  </span>
                )}
                <button
                  type="button"
                  onClick={() => setShowOriginal((cur) => (cur === sec.id ? null : sec.id))}
                  className="ml-auto text-[10.5px] font-sans text-muted-foreground hover:text-foreground inline-flex items-center gap-0.5"
                >
                  Original{' '}
                  <ChevronRight
                    className={cn('h-3 w-3 transition-transform', showOrig && 'rotate-90')}
                  />
                </button>
              </div>

              {showOrig && (
                <pre className="mt-2 max-h-40 overflow-auto rounded border border-border bg-background/40 p-2 text-[11.5px] font-mono whitespace-pre-wrap text-muted-foreground">
                  {sec.markdown}
                </pre>
              )}
            </div>
          );
        })}
      </div>

      <div className="p-3 border-t border-border shrink-0 text-[10.5px] font-sans text-muted-foreground leading-snug">
        Suggestions land as tracked changes in the editor — accept or reject each one, or use{' '}
        <span className="font-medium">Accept all</span> in the toolbar.
      </div>
    </aside>
  );
}

function StatusDot({ status }: { status: CounterSection['status'] }) {
  const color =
    status === 'ready'
      ? 'bg-accent'
      : status === 'drafting'
        ? 'bg-amber-500 animate-pulse'
        : status === 'accepted'
          ? 'bg-emerald-500'
          : status === 'rejected'
            ? 'bg-rose-500'
            : 'bg-muted-foreground/40';
  return <span className={cn('inline-block h-1.5 w-1.5 rounded-full shrink-0', color)} />;
}
