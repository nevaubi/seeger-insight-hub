import { createFileRoute } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { ExternalLink, Search as SearchIcon, Sparkles, Loader2 } from 'lucide-react';
import { AppShell, PageHeader } from '@/components/app-shell';
import { OrderTypeBadge, fmtDate } from '@/components/case-ui';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { supabase } from '@/lib/supabase';
import { embedQuery, modelReady } from '@/lib/embed';

const EXAMPLES = [
  'threshold proof of use',
  'deposition protocol',
  'money from outside investors paying for the lawsuit',
  'common benefit',
];

export const Route = createFileRoute('/search')({
  component: AskTheRecord,
  errorComponent: ({ error }) => (
    <AppShell><div className="p-8 text-sm text-destructive">Failed to load: {error.message}</div></AppShell>
  ),
  notFoundComponent: () => <AppShell><div className="p-8">Not found.</div></AppShell>,
});

type HybridHit = {
  id: string;
  document_id: string;
  order_id: string | null;
  content: string;
  score: number;
  vec_hit: boolean;
  lex_hit: boolean;
  doc_label: string | null;
  doc_source: string | null;
  order_type: string | null;
  order_number: string | null;
  order_date: string | null;
  tags: string[] | null;
  section_label: string | null;
  affects: string | null;
  has_deadline: boolean;
  page_start: number;
  page_end: number;
  pdf_url: string | null;
};

type LexicalFallback = {
  kind: 'lexical';
  document_id: string;
  page_number: number;
  snippet: string;
  rank: number;
  doc_label: string | null;
  order_type: string | null;
  order_title: string | null;
  order_date: string | null;
  pdf_url: string | null;
};

type Results =
  | { mode: 'hybrid'; rows: HybridHit[] }
  | { mode: 'lexical'; rows: LexicalFallback[]; notice: string };

const ORDER_TYPES = ['Any', 'PTO', 'CMO', 'CBO', 'JPML', 'OTHER'];
const AFFECTS = ['Any', 'plaintiffs', 'defendants', 'leadership', 'all'];

function AskTheRecord() {
  const [q, setQ] = useState('');
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [orderType, setOrderType] = useState<string>('Any');
  const [affects, setAffects] = useState<string>('Any');
  const [hasDeadline, setHasDeadline] = useState(false);
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [embedding, setEmbedding] = useState(false);

  const buildFilter = () => {
    const f: Record<string, unknown> = {};
    if (orderType !== 'Any') f.order_type = orderType;
    if (affects !== 'Any') f.affects = affects;
    if (hasDeadline) f.has_deadline = true;
    if (dateFrom) f.order_date_from = dateFrom;
    if (dateTo) f.order_date_to = dateTo;
    return f;
  };

  const search = useMutation<Results, Error, string>({
    mutationFn: async (query: string): Promise<Results> => {
      const filter = buildFilter();
      try {
        setEmbedding(!modelReady());
        const emb = await embedQuery(query);
        setEmbedding(false);
        const { data, error } = await supabase.rpc('hybrid_search', {
          q: query,
          query_embedding: emb,
          filter,
          k: 15,
        });
        if (error) throw error;
        return { mode: 'hybrid', rows: (data ?? []) as HybridHit[] };
      } catch (e) {
        setEmbedding(false);
        // Fallback to lexical
        const { data, error } = await supabase.rpc('search_pages', { q: query, lim: 30 });
        if (error) throw error;
        const rows = ((data ?? []) as any[]).map((r) => ({ kind: 'lexical' as const, ...r }));
        return {
          mode: 'lexical',
          rows,
          notice: 'Semantic model unavailable — showing keyword results.',
        };
      }
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

  const results = search.data;

  return (
    <AppShell>
      <PageHeader
        title="Ask the Record"
        description="Semantic + keyword retrieval across every controlling order and filing on the docket. Every result is a real passage with a page-level citation — no summaries, no invention."
      />

      <div className="px-8 py-6 space-y-5">
        <Card className="p-5">
          <form onSubmit={onSubmit} className="flex gap-2 items-center">
            <div className="relative flex-1">
              <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Ask the record in plain English…"
                className="pl-9 h-11 text-base bg-background"
                autoFocus
              />
            </div>
            <Button
              type="submit"
              disabled={search.isPending}
              className="h-11 px-5 bg-accent text-accent-foreground hover:bg-accent/90"
            >
              {search.isPending ? 'Searching…' : 'Search'}
            </Button>
          </form>

          {/* Filter bar */}
          <div className="mt-4 flex flex-wrap items-end gap-3 text-xs">
            <label className="flex flex-col gap-1">
              <span className="uppercase tracking-wider text-muted-foreground text-[10px]">Order type</span>
              <select
                value={orderType}
                onChange={(e) => setOrderType(e.target.value)}
                className="h-8 rounded border border-border bg-background px-2 text-foreground"
              >
                {ORDER_TYPES.map((o) => <option key={o}>{o}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="uppercase tracking-wider text-muted-foreground text-[10px]">Affects</span>
              <select
                value={affects}
                onChange={(e) => setAffects(e.target.value)}
                className="h-8 rounded border border-border bg-background px-2 text-foreground"
              >
                {AFFECTS.map((o) => <option key={o}>{o}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="uppercase tracking-wider text-muted-foreground text-[10px]">From</span>
              <input
                type="date"
                value={dateFrom}
                onChange={(e) => setDateFrom(e.target.value)}
                className="h-8 rounded border border-border bg-background px-2 text-foreground"
              />
            </label>
            <label className="flex flex-col gap-1">
              <span className="uppercase tracking-wider text-muted-foreground text-[10px]">To</span>
              <input
                type="date"
                value={dateTo}
                onChange={(e) => setDateTo(e.target.value)}
                className="h-8 rounded border border-border bg-background px-2 text-foreground"
              />
            </label>
            <label className="flex items-center gap-2 h-8">
              <Checkbox
                checked={hasDeadline}
                onCheckedChange={(v) => setHasDeadline(v === true)}
              />
              <span className="text-foreground/80">Has a deadline</span>
            </label>
          </div>

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1.5">
              <Sparkles className="h-3 w-3" /> Try
            </span>
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => run(ex)}
                className="text-xs px-2.5 py-1 rounded-full border border-border bg-secondary/60 text-foreground/80 hover:bg-accent hover:text-accent-foreground hover:border-accent transition-colors"
              >
                {ex}
              </button>
            ))}
          </div>
        </Card>

        {search.isPending && embedding && (
          <Card className="p-4 flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading semantic search model (one-time, ~30MB)…
          </Card>
        )}

        {search.isError && (
          <Card className="p-4 text-sm text-destructive">
            Search failed: {(search.error as Error).message}
          </Card>
        )}

        {results?.mode === 'lexical' && (
          <div className="text-xs text-muted-foreground italic">{results.notice}</div>
        )}

        {submitted && !search.isPending && results && (
          <div className="text-xs text-muted-foreground">
            {results.rows.length} passage{results.rows.length === 1 ? '' : 's'} for{' '}
            <span className="font-serif italic text-foreground">"{submitted}"</span>
          </div>
        )}

        <div className="space-y-3">
          {results?.mode === 'hybrid' && results.rows.map((h) => {
            const key = h.id;
            const isExpanded = expanded[key];
            const pageCite = h.page_start === h.page_end
              ? `p.${h.page_start}`
              : `p.${h.page_start}–${h.page_end}`;
            const headerLabel = h.order_type
              ? `${h.order_type}${h.order_number ? ' ' + h.order_number : ''}`
              : (h.doc_label ?? 'Document');
            return (
              <Card key={key} className="p-4">
                <div className="flex items-center gap-2 flex-wrap">
                  {h.order_type ? (
                    <OrderTypeBadge type={h.order_type} number={h.order_number} />
                  ) : (
                    <span className="text-sm font-medium text-foreground">{headerLabel}</span>
                  )}
                  {h.order_type && h.doc_label && (
                    <span className="text-sm text-foreground/80">{h.doc_label}</span>
                  )}
                  <span className="text-xs text-muted-foreground">· {pageCite}</span>
                  {h.order_date && (
                    <span className="text-xs text-muted-foreground tabular-nums">· {fmtDate(h.order_date)}</span>
                  )}
                </div>
                {h.section_label && (
                  <div className="text-[11px] uppercase tracking-wider text-muted-foreground mt-1">
                    {h.section_label}
                  </div>
                )}
                <p
                  className={`mt-2 text-[14px] leading-relaxed font-serif text-foreground/90 whitespace-pre-wrap ${
                    isExpanded ? '' : 'line-clamp-6'
                  }`}
                >
                  {h.content}
                </p>
                <button
                  type="button"
                  onClick={() => setExpanded((s) => ({ ...s, [key]: !s[key] }))}
                  className="mt-1 text-xs text-accent hover:underline"
                >
                  {isExpanded ? 'Show less' : 'Show more'}
                </button>
                <div className="mt-3 flex flex-wrap items-center gap-2 text-[10.5px] text-muted-foreground">
                  <span className="tabular-nums">score {h.score.toFixed(3)}</span>
                  {h.vec_hit && (
                    <span className="px-1.5 py-0.5 rounded border border-border bg-secondary/60">semantic</span>
                  )}
                  {h.lex_hit && (
                    <span className="px-1.5 py-0.5 rounded border border-border bg-secondary/60">keyword</span>
                  )}
                  {h.affects && (
                    <span className="px-1.5 py-0.5 rounded border border-border bg-secondary/60">
                      affects: {h.affects}
                    </span>
                  )}
                  {h.has_deadline && (
                    <span className="px-1.5 py-0.5 rounded border border-border bg-secondary/60">deadline</span>
                  )}
                  {h.pdf_url && (
                    <a
                      href={h.pdf_url}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-auto inline-flex items-center gap-1 text-accent hover:underline"
                    >
                      <ExternalLink className="h-3 w-3" /> View source PDF ↗
                    </a>
                  )}
                </div>
              </Card>
            );
          })}

          {results?.mode === 'lexical' && results.rows.map((h, i) => (
            <Card key={`${h.document_id}-${h.page_number}-${i}`} className="p-4">
              <div className="flex items-center gap-2 flex-wrap">
                {h.order_type && <OrderTypeBadge type={h.order_type} />}
                <span className="text-sm font-medium text-foreground">
                  {h.doc_label ?? h.order_title ?? 'Document'}
                </span>
                <span className="text-xs text-muted-foreground">· p.{h.page_number}</span>
                {h.order_date && (
                  <span className="text-xs text-muted-foreground tabular-nums">· {fmtDate(h.order_date)}</span>
                )}
              </div>
              <p className="mt-2 text-[14px] leading-relaxed font-serif text-foreground/90">
                {h.snippet.replace(/<<|>>/g, '')}
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
            </Card>
          ))}

          {submitted && !search.isPending && results && results.rows.length === 0 && (
            <Card className="p-8 text-center">
              <div className="text-sm text-muted-foreground">No passages matched "{submitted}".</div>
              <div className="text-xs text-muted-foreground mt-1">Try broader phrasing or remove filters.</div>
            </Card>
          )}
        </div>
      </div>
    </AppShell>
  );
}
