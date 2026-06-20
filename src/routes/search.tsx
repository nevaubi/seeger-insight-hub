import { createFileRoute } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ExternalLink, Search as SearchIcon, Sparkles } from 'lucide-react';
import { AppShell, PageHeader } from '@/components/app-shell';
import { OrderTypeBadge, fmtDate } from '@/components/case-ui';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { supabase, type SearchHit } from '@/lib/supabase';

const EXAMPLES = [
  'threshold proof of use',
  'deposition protocol',
  'third-party litigation funding',
  'common benefit',
];

export const Route = createFileRoute('/search')({
  component: AskTheRecord,
  errorComponent: ({ error }) => (
    <AppShell><div className="p-8 text-sm text-destructive">Failed to load: {error.message}</div></AppShell>
  ),
  notFoundComponent: () => <AppShell><div className="p-8">Not found.</div></AppShell>,
});

function renderSnippet(snippet: string) {
  // Split on <<...>> and wrap inner pieces in <mark>
  const parts: Array<{ text: string; mark: boolean }> = [];
  const re = /<<(.*?)>>/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(snippet)) !== null) {
    if (m.index > last) parts.push({ text: snippet.slice(last, m.index), mark: false });
    parts.push({ text: m[1], mark: true });
    last = re.lastIndex;
  }
  if (last < snippet.length) parts.push({ text: snippet.slice(last), mark: false });
  return parts.map((p, i) =>
    p.mark ? <mark key={i}>{p.text}</mark> : <span key={i}>{p.text}</span>,
  );
}

function AskTheRecord() {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);

  const search = useMutation({
    mutationFn: async (query: string) => {
      const { data, error } = await supabase.rpc('search_pages', { q: query, lim: 30 });
      if (error) throw error;
      return (data ?? []) as SearchHit[];
    },
  });

  const run = (query: string) => {
    const v = query.trim();
    if (!v) return;
    setQ(v);
    setSubmitted(v);
    search.mutate(v);
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    run(q);
  };

  const maxRank = search.data && search.data.length > 0
    ? Math.max(...search.data.map((h) => h.rank))
    : 1;

  return (
    <AppShell>
      <PageHeader
        title="Ask the Record"
        description="Full-text retrieval across every page of every controlling order and filing on the docket. Every result is a real passage with a page-level citation — no summaries, no invention."
      />

      <div className="px-8 py-6 space-y-5">
        <Card className="p-5">
          <form onSubmit={onSubmit} className="flex gap-2 items-center">
            <div className="relative flex-1">
              <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search the orders and filings…"
                className="pl-9 h-11 text-base bg-background"
                autoFocus
              />
            </div>
            <Button type="submit" disabled={search.isPending} className="h-11 px-5 bg-accent text-accent-foreground hover:bg-accent/90">
              {search.isPending ? 'Searching…' : 'Search'}
            </Button>
          </form>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1.5">
              <Sparkles className="h-3 w-3" /> Try
            </span>
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                onClick={() => run(ex)}
                className="text-xs px-2.5 py-1 rounded-full border border-border bg-secondary/60 text-foreground/80 hover:bg-accent hover:text-accent-foreground hover:border-accent transition-colors"
              >
                {ex}
              </button>
            ))}
          </div>
        </Card>

        {search.isError && (
          <Card className="p-4 text-sm text-destructive">
            Search failed: {(search.error as Error).message}
          </Card>
        )}

        {submitted && !search.isPending && search.data && (
          <div className="text-xs text-muted-foreground">
            {search.data.length} passage{search.data.length === 1 ? '' : 's'} for{' '}
            <span className="font-serif italic text-foreground">"{submitted}"</span>
          </div>
        )}

        <div className="space-y-3">
          {search.data?.map((h, i) => {
            const rel = maxRank > 0 ? Math.max(0.1, h.rank / maxRank) : 0;
            return (
              <Card key={`${h.document_id}-${h.page_number}-${i}`} className="p-4">
                <div className="flex items-start gap-3">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      {h.order_type && <OrderTypeBadge type={h.order_type} />}
                      <span className="text-sm font-medium text-foreground">
                        {h.doc_label ?? h.order_title ?? 'Document'}
                      </span>
                      <span className="text-xs text-muted-foreground">· Page {h.page_number}</span>
                      {h.order_date && (
                        <span className="text-xs text-muted-foreground tabular-nums">· {fmtDate(h.order_date)}</span>
                      )}
                    </div>
                    <p className="mt-2 text-[14px] leading-relaxed font-serif text-foreground/90">
                      {renderSnippet(h.snippet)}
                    </p>
                    {h.pdf_url && (
                      <a
                        href={h.pdf_url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-flex items-center gap-1.5 text-xs text-accent hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" /> View source PDF
                      </a>
                    )}
                  </div>
                  <div className="shrink-0 w-16">
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground text-right">Relevance</div>
                    <div className="mt-1 h-1.5 bg-muted rounded overflow-hidden">
                      <div className="h-full bg-accent" style={{ width: `${Math.round(rel * 100)}%` }} />
                    </div>
                    <div className="text-[10px] text-muted-foreground text-right mt-1 tabular-nums">
                      {h.rank.toFixed(3)}
                    </div>
                  </div>
                </div>
              </Card>
            );
          })}

          {submitted && !search.isPending && search.data && search.data.length === 0 && (
            <Card className="p-8 text-center">
              <div className="text-sm text-muted-foreground">No passages matched "{submitted}".</div>
              <div className="text-xs text-muted-foreground mt-1">Try different terms — search uses the actual words in the record.</div>
            </Card>
          )}
        </div>
      </div>
    </AppShell>
  );
}
