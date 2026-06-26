import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronLeft, ChevronRight, ExternalLink, FileText, CheckCircle2, XCircle, Loader2 } from 'lucide-react';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Button } from '@/components/ui/button';
import { supabase, REVIEW_FILES_BUCKET, type ReviewFile, type ReviewCellCitation } from '@/lib/supabase';
import { cn } from '@/lib/utils';

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  file: ReviewFile | null;
  cellId: string | null;
  citations: ReviewCellCitation[];
  initialPage: number | null;
  initialQuote: string | null;
};

const verdictKey = (cellId: string) => `tabular:verdict:${cellId}`;

function loadVerdict(cellId: string | null): 'verified' | 'wrong' | null {
  if (!cellId || typeof window === 'undefined') return null;
  const v = window.localStorage.getItem(verdictKey(cellId));
  return v === 'verified' || v === 'wrong' ? v : null;
}

function saveVerdict(cellId: string, v: 'verified' | 'wrong' | null) {
  if (v) window.localStorage.setItem(verdictKey(cellId), v);
  else window.localStorage.removeItem(verdictKey(cellId));
}

function highlight(text: string, quote: string | null) {
  if (!quote) return text;
  const needle = quote.trim().slice(0, 200);
  if (!needle) return text;
  // Build a flexible regex: collapse whitespace differences, escape regex chars.
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\s+/g, '\\s+');
  try {
    const re = new RegExp(escaped, 'i');
    const m = text.match(re);
    if (!m) return text;
    const start = m.index ?? 0;
    return (
      <>
        {text.slice(0, start)}
        <mark className="bg-amber-200/70 text-foreground rounded-sm px-0.5">{m[0]}</mark>
        {text.slice(start + m[0].length)}
      </>
    );
  } catch {
    return text;
  }
}

export function SourcePreviewDrawer({ open, onOpenChange, file, cellId, citations, initialPage, initialQuote }: Props) {
  const [page, setPage] = useState<number | null>(initialPage);
  const [quote, setQuote] = useState<string | null>(initialQuote);
  const [verdict, setVerdict] = useState<'verified' | 'wrong' | null>(null);

  useEffect(() => {
    if (open) {
      setPage(initialPage);
      setQuote(initialQuote);
      setVerdict(loadVerdict(cellId));
    }
  }, [open, initialPage, initialQuote, cellId]);

  const { data: pageRow, isLoading } = useQuery({
    queryKey: ['review-file-page', file?.id, page],
    enabled: !!file && page != null,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('review_file_pages')
        .select('text, page_number')
        .eq('review_file_id', file!.id)
        .eq('page_number', page!)
        .maybeSingle();
      if (error) throw error;
      return data as { text: string; page_number: number } | null;
    },
  });

  const totalPages = file?.page_count ?? null;

  const pdfHref = useMemo(() => {
    if (!file) return null;
    const { data } = supabase.storage.from(REVIEW_FILES_BUCKET).getPublicUrl(file.storage_path);
    return data.publicUrl;
  }, [file]);

  const sortedCites = useMemo(
    () => [...citations].sort((a, b) => (a.page_number ?? 0) - (b.page_number ?? 0)),
    [citations],
  );

  const setVerdictSafe = (v: 'verified' | 'wrong' | null) => {
    if (!cellId) return;
    saveVerdict(cellId, v);
    setVerdict(v);
  };

  const goPrev = () => setPage((p) => (p && p > 1 ? p - 1 : p));
  const goNext = () => setPage((p) => (p && totalPages && p < totalPages ? p + 1 : p));

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent side="right" className="w-full sm:max-w-3xl p-0 flex flex-col">
        <SheetHeader className="px-6 py-4 border-b border-border shrink-0">
          <SheetTitle className="font-serif text-base font-semibold flex items-start gap-2">
            <FileText className="h-4 w-4 mt-1 text-muted-foreground shrink-0" strokeWidth={1.5} />
            <span className="truncate">{file?.filename ?? 'Source'}</span>
          </SheetTitle>
          <div className="flex items-center gap-2 text-[12px] text-muted-foreground tabular-nums pt-1">
            <Button variant="ghost" size="icon" className="h-7 w-7" onClick={goPrev} disabled={!page || page <= 1}>
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <span>
              Page {page ?? '—'}
              {totalPages ? ` of ${totalPages}` : ''}
            </span>
            <Button
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              onClick={goNext}
              disabled={!page || !totalPages || page >= totalPages}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
            {pdfHref && (
              <a
                href={pdfHref}
                target="_blank"
                rel="noreferrer"
                className="ml-auto inline-flex items-center gap-1 text-accent hover:underline"
              >
                Open original <ExternalLink className="h-3 w-3" />
              </a>
            )}
          </div>
        </SheetHeader>

        <div className="flex-1 min-h-0 grid grid-cols-[1fr_14rem]">
          {/* Page text */}
          <div className="overflow-y-auto px-6 py-5">
            {isLoading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading page…
              </div>
            ) : pageRow?.text ? (
              <pre className="whitespace-pre-wrap font-serif text-[13.5px] leading-relaxed text-foreground">
                {highlight(pageRow.text, quote)}
              </pre>
            ) : (
              <p className="text-sm text-muted-foreground italic">No transcript available for this page.</p>
            )}
          </div>

          {/* Citation list + verdict */}
          <aside className="border-l border-border bg-secondary/30 overflow-y-auto">
            <div className="p-4 space-y-3">
              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Verify</div>
                <div className="flex gap-1.5">
                  <Button
                    size="sm"
                    variant={verdict === 'verified' ? 'default' : 'outline'}
                    onClick={() => setVerdictSafe(verdict === 'verified' ? null : 'verified')}
                    className="flex-1 gap-1.5"
                  >
                    <CheckCircle2 className="h-3.5 w-3.5" /> Correct
                  </Button>
                  <Button
                    size="sm"
                    variant={verdict === 'wrong' ? 'destructive' : 'outline'}
                    onClick={() => setVerdictSafe(verdict === 'wrong' ? null : 'wrong')}
                    className="flex-1 gap-1.5"
                  >
                    <XCircle className="h-3.5 w-3.5" /> Wrong
                  </Button>
                </div>
              </div>

              <div>
                <div className="text-[10px] uppercase tracking-wider text-muted-foreground mb-2">Citations</div>
                <ul className="space-y-1.5">
                  {sortedCites.length === 0 && (
                    <li className="text-[11px] text-muted-foreground italic">None returned.</li>
                  )}
                  {sortedCites.map((c) => (
                    <li key={c.id}>
                      <button
                        onClick={() => {
                          setPage(c.page_number ?? page);
                          setQuote(c.quote);
                        }}
                        className={cn(
                          'w-full text-left text-[11.5px] rounded-sm px-2 py-1.5 border transition',
                          page === c.page_number
                            ? 'bg-card border-accent/40 text-foreground'
                            : 'bg-background/60 border-transparent hover:border-border text-muted-foreground hover:text-foreground',
                        )}
                      >
                        <div className="tabular-nums font-medium">
                          {c.page_number ? `Page ${c.page_number}` : 'Source'}
                        </div>
                        {c.quote && (
                          <div className="mt-0.5 line-clamp-2 italic font-serif text-foreground/70">“{c.quote}”</div>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          </aside>
        </div>
      </SheetContent>
    </Sheet>
  );
}
