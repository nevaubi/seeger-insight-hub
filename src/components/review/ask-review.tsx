import { useEffect, useMemo, useState } from 'react';
import { Send, Sparkles, Loader2, X } from 'lucide-react';
import { useSynthesisStream } from '@/lib/useSynthesisStream';
import { SYNTHESIS_ENDPOINT, SUPABASE_ANON_KEY, type ReviewFile } from '@/lib/supabase';
import { useMatter } from '@/lib/matter-context';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

type Props = {
  reviewSetId: string;
  files: ReviewFile[];
};

const RECENTS_KEY = (setId: string) => `tabular:recents:${setId}`;

function loadRecents(setId: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    return JSON.parse(window.localStorage.getItem(RECENTS_KEY(setId)) ?? '[]');
  } catch {
    return [];
  }
}
function saveRecents(setId: string, list: string[]) {
  window.localStorage.setItem(RECENTS_KEY(setId), JSON.stringify(list.slice(0, 5)));
}

export function AskReview({ reviewSetId, files }: Props) {
  const { currentMatter } = useMatter();
  const { state, ask, stop } = useSynthesisStream(SYNTHESIS_ENDPOINT, SUPABASE_ANON_KEY);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [recents, setRecents] = useState<string[]>(() => loadRecents(reviewSetId));

  useEffect(() => {
    setRecents(loadRecents(reviewSetId));
  }, [reviewSetId]);

  const readyFiles = useMemo(() => files.filter((f) => f.status === 'ready'), [files]);
  const fileIds = useMemo(() => readyFiles.map((f) => f.id), [readyFiles]);

  const submit = (text?: string) => {
    const v = (text ?? q).trim();
    if (!v || readyFiles.length === 0) return;
    setQ(v);
    setOpen(true);
    ask(v, {}, {
      case_id: currentMatter.master_case_id,
      review_set_id: reviewSetId,
      document_ids: fileIds,
    });
    const next = [v, ...recents.filter((r) => r !== v)].slice(0, 5);
    setRecents(next);
    saveRecents(reviewSetId, next);
  };

  const text = Object.values(state.rounds)
    .sort((a, b) => a.round - b.round)
    .flatMap((r) => r.textOrder.map((id) => r.textBlocks.find((b) => b.id === id)?.text ?? ''))
    .join('\n\n')
    .trim();


  return (
    <div className="mb-5 rounded-md border border-border bg-card">
      <form
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        className="flex items-center gap-2 px-3 py-2"
      >
        <Sparkles className="h-4 w-4 text-accent shrink-0" strokeWidth={1.5} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={
            readyFiles.length === 0
              ? 'Upload documents to ask cross-document questions…'
              : `Ask across these ${readyFiles.length} document${readyFiles.length === 1 ? '' : 's'}…`
          }
          disabled={readyFiles.length === 0}
          className="flex-1 bg-transparent text-sm placeholder:text-muted-foreground focus:outline-none disabled:cursor-not-allowed"
        />
        {state.running ? (
          <Button type="button" size="sm" variant="outline" onClick={() => stop()} className="gap-1.5">
            <Loader2 className="h-3.5 w-3.5 animate-spin" /> Stop
          </Button>
        ) : (
          <Button
            type="submit"
            size="sm"
            disabled={!q.trim() || readyFiles.length === 0}
            className="gap-1.5"
          >
            <Send className="h-3.5 w-3.5" /> Ask
          </Button>
        )}
      </form>

      {recents.length > 0 && !open && (
        <div className="px-3 pb-2 flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] uppercase tracking-wider text-muted-foreground">Recent</span>
          {recents.map((r) => (
            <button
              key={r}
              onClick={() => submit(r)}
              className="text-[11px] px-2 py-0.5 rounded-sm border border-border bg-secondary/40 hover:bg-secondary transition truncate max-w-[18rem]"
              title={r}
            >
              {r}
            </button>
          ))}
        </div>
      )}

      {open && (
        <div className="border-t border-border px-4 py-4 relative">
          <button
            onClick={() => setOpen(false)}
            className="absolute top-2 right-2 text-muted-foreground hover:text-foreground"
            aria-label="Close answer"
          >
            <X className="h-3.5 w-3.5" />
          </button>
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">
            {state.running ? 'Thinking…' : 'Answer'}
          </div>
          <div className="font-serif text-[14px] leading-relaxed text-foreground whitespace-pre-wrap min-h-[2rem]">
            {text || (
              <span className="text-muted-foreground italic">
                {state.running ? 'Searching the documents in this review…' : 'No answer yet.'}
              </span>
            )}
            {state.running && <span className="ml-1 inline-block w-1.5 h-3.5 bg-accent/70 animate-pulse align-middle" />}
          </div>
          {state.error && <div className="mt-2 text-[12px] text-destructive">{state.error}</div>}
        </div>
      )}

      <div className={cn('hidden', open && 'block')} />
    </div>
  );
}
