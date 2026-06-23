import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { useQuery, queryOptions } from '@tanstack/react-query';
import { useMemo, useState, useEffect } from 'react';
import { ExternalLink, Search as SearchIcon, X, Loader2 } from 'lucide-react';
import { z } from 'zod';
import { AppShell, PageHeader } from '@/components/app-shell';
import { OrderTypeBadge, TagChips, fmtDate } from '@/components/case-ui';
import { Input } from '@/components/ui/input';
import { Card } from '@/components/ui/card';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { supabase, tagLabel, TAG_LABELS, type Order } from '@/lib/supabase';
import { useMatter } from '@/lib/matter-context';
import { cn } from '@/lib/utils';

const ordersQuery = (caseId: string) =>
  queryOptions({
    queryKey: ['orders-all', caseId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_orders')
        .select('*')
        .eq('case_id', caseId)
        .order('order_date', { ascending: false, nullsFirst: false });

      if (error) throw error;
      return (data ?? []) as Order[];
    },
  });

const orderPagesQuery = (documentId: string) =>
  queryOptions({
    queryKey: ['order-pages', documentId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('document_pages')
        .select('page_number, extracted_text')
        .eq('document_id', documentId)
        .order('page_number', { ascending: true });
      if (error) throw error;
      return data ?? [];
    },
  });

const ORDER_TYPES = ['PTO', 'CMO', 'CBO', 'JPML'] as const;

export const Route = createFileRoute('/orders')({
  validateSearch: z.object({ id: z.string().optional() }),
  component: OrdersPage,
  errorComponent: ({ error }) => (
    <AppShell><div className="p-8 text-sm text-destructive">Failed to load: {error.message}</div></AppShell>
  ),
  notFoundComponent: () => <AppShell><div className="p-8">Not found.</div></AppShell>,
});

function OrdersPage() {
  const { currentMatter } = useMatter();
  const { data: orders = [], isLoading } = useQuery(ordersQuery(currentMatter.master_case_id));
  const { id } = Route.useSearch();
  const navigate = useNavigate();

  const [typeFilter, setTypeFilter] = useState<string | null>(null);
  const [tagFilters, setTagFilters] = useState<Set<string>>(new Set());
  const [text, setText] = useState('');

  const allTags = useMemo(() => {
    const s = new Set<string>();
    orders.forEach((o) => o.tags?.forEach((t) => s.add(t)));
    return Array.from(s).sort((a, b) => tagLabel(a).localeCompare(tagLabel(b)));
  }, [orders]);

  const filtered = useMemo(() => {
    const q = text.trim().toLowerCase();
    return orders.filter((o) => {
      if (typeFilter && o.order_type !== typeFilter) return false;
      if (tagFilters.size > 0) {
        const t = o.tags ?? [];
        for (const tag of tagFilters) if (!t.includes(tag)) return false;
      }
      if (q && !o.canonical_title.toLowerCase().includes(q)) return false;
      return true;
    });
  }, [orders, typeFilter, tagFilters, text]);

  const selected = id ? orders.find((o) => o.id === id) ?? null : null;
  const close = () => navigate({ to: '/orders', search: {} });

  return (
    <AppShell>
      <PageHeader
        title="Orders Intelligence"
        description="All controlling orders from the docket — PTOs, CMOs, CBOs, and JPML orders, with tags and full source text."
      />

      <div className="px-8 py-6 space-y-5">
        <Card className="p-4 space-y-4 motion-safe:motion-fade-rise">
          <div className="flex flex-wrap items-center gap-3">
            <div className="relative flex-1 min-w-[260px] max-w-md">
              <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="Filter by title…"
                value={text}
                onChange={(e) => setText(e.target.value)}
                className="pl-9 bg-background"
              />
            </div>
            <div className="flex items-center gap-1.5">
              <button
                onClick={() => setTypeFilter(null)}
                className={cn(
                  'text-xs px-2.5 py-1.5 rounded border transition-colors font-sans',
                  typeFilter === null ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-border text-foreground/70 hover:bg-muted',
                )}
              >
                All types
              </button>
              {ORDER_TYPES.map((t) => (
                <button
                  key={t}
                  onClick={() => setTypeFilter(typeFilter === t ? null : t)}
                  className={cn(
                    'text-xs px-2.5 py-1.5 rounded border font-semibold tracking-[0.08em] transition-colors',
                    typeFilter === t ? 'bg-primary text-primary-foreground border-primary' : 'bg-background border-border text-foreground/70 hover:bg-muted',
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
            <div className="text-[11px] text-muted-foreground ml-auto font-sans tabular-nums inline-flex items-center gap-2">
              {isLoading && <Loader2 className="h-3 w-3 animate-spin" />}
              {filtered.length} of {orders.length} orders
            </div>
          </div>

          <div className="pt-3 border-t border-border">
            <div className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground mb-2 font-sans">Filter by tag</div>
            <div className="flex flex-wrap gap-1.5">
              {allTags.map((t) => {
                const active = tagFilters.has(t);
                return (
                  <button
                    key={t}
                    onClick={() => {
                      const next = new Set(tagFilters);
                      if (active) next.delete(t);
                      else next.add(t);
                      setTagFilters(next);
                    }}
                    className={cn(
                      'text-[11px] px-2 py-0.5 rounded border transition-colors',
                      active
                        ? 'bg-accent text-accent-foreground border-accent'
                        : 'bg-background border-border text-foreground/70 hover:bg-muted',
                    )}
                  >
                    {TAG_LABELS[t] ?? tagLabel(t)}
                  </button>
                );
              })}
              {tagFilters.size > 0 && (
                <button
                  onClick={() => setTagFilters(new Set())}
                  className="text-[11px] px-2 py-0.5 rounded border border-border text-muted-foreground hover:bg-muted inline-flex items-center gap-1"
                >
                  <X className="h-3 w-3" /> Clear
                </button>
              )}
            </div>
          </div>
        </Card>

        <Card className="p-0 overflow-hidden motion-safe:motion-fade-rise">
          <table className="w-full text-sm">
            <thead className="bg-secondary/60 text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground font-sans">
              <tr>
                <th className="text-left px-4 py-3 font-semibold w-28">Order</th>
                <th className="text-left px-4 py-3 font-semibold">Title</th>
                <th className="text-left px-4 py-3 font-semibold w-[26%]">Tags</th>
                <th className="text-right px-4 py-3 font-semibold w-24">Date</th>
                <th className="text-right px-4 py-3 font-semibold w-16">Pages</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((o) => (
                <tr
                  key={o.id}
                  onClick={() => navigate({ to: '/orders', search: { id: o.id } })}
                  className="border-t border-border hover:bg-muted/50 cursor-pointer transition-colors"
                >
                  <td className="px-4 py-4 align-top">
                    <OrderTypeBadge type={o.order_type} number={o.order_number} />
                  </td>
                  <td className="px-4 py-4 align-top">
                    <div className="font-medium text-foreground leading-snug">{o.canonical_title}</div>
                    {o.summary && (
                      <div className="text-xs text-muted-foreground mt-1 line-clamp-2 leading-relaxed">{o.summary}</div>
                    )}
                  </td>
                  <td className="px-4 py-4 align-top"><TagChips tags={o.tags} max={4} /></td>
                  <td className="px-4 py-4 align-top text-right text-muted-foreground tabular-nums font-sans text-xs">
                    {fmtDate(o.order_date)}
                  </td>
                  <td className="px-4 py-4 align-top text-right text-muted-foreground tabular-nums font-sans text-xs">
                    {o.page_count ?? '—'}
                  </td>
                </tr>
              ))}
              {filtered.length === 0 && (
                <tr><td colSpan={5} className="px-4 py-10 text-center text-sm text-muted-foreground">
                  No orders match the current filters.
                </td></tr>
              )}
            </tbody>
          </table>
        </Card>
      </div>

      <Sheet open={!!selected} onOpenChange={(open) => !open && close()}>
        <SheetContent side="right" className="w-full sm:max-w-2xl overflow-y-auto p-0">
          {selected && <OrderDetail order={selected} />}
        </SheetContent>
      </Sheet>
    </AppShell>
  );
}

function OrderDetail({ order }: { order: Order }) {
  const pagesQ = useQuery(orderPagesQuery(order.document_id ?? ''));

  useEffect(() => { /* no-op */ }, [order.id]);

  return (
    <>
      <SheetHeader className="px-6 py-5 border-b border-border bg-card">
        <div className="flex items-center gap-2 mb-2">
          <OrderTypeBadge type={order.order_type} number={order.order_number} />
          <span className="text-xs text-muted-foreground tabular-nums">{fmtDate(order.order_date)}</span>
          {order.page_count != null && (
            <span className="text-xs text-muted-foreground">· {order.page_count} pages</span>
          )}
        </div>
        <SheetTitle className="font-serif text-xl leading-tight text-left">
          {order.canonical_title}
        </SheetTitle>
        <div className="mt-2"><TagChips tags={order.tags} /></div>
        {order.pdf_url && (
          <a
            href={order.pdf_url}
            target="_blank"
            rel="noreferrer"
            className="mt-3 inline-flex items-center gap-1.5 text-sm text-accent hover:underline"
          >
            <ExternalLink className="h-3.5 w-3.5" /> View source PDF
          </a>
        )}
      </SheetHeader>
      <div className="px-6 py-5 space-y-5">
        {order.summary && (
          <div>
            <h3 className="font-serif text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Summary</h3>
            <p className="text-sm leading-relaxed font-serif text-foreground/90">{order.summary}</p>
          </div>
        )}
        <div>
          <h3 className="font-serif text-sm font-semibold uppercase tracking-wider text-muted-foreground mb-1.5">Full order text</h3>
          {!order.document_id ? (
            <p className="text-xs text-muted-foreground italic">No document text available on file.</p>
          ) : pagesQ.isLoading ? (
            <p className="text-xs text-muted-foreground">Loading pages…</p>
          ) : pagesQ.data && pagesQ.data.length > 0 ? (
            <div className="font-serif text-[14px] leading-[1.7] text-foreground/90 space-y-4 max-w-prose">
              {pagesQ.data.map((p: any) => (
                <div key={p.page_number}>
                  <div className="text-[10px] uppercase tracking-widest text-muted-foreground border-b border-border pb-1 mb-2">
                    Page {p.page_number}
                  </div>
                  <div className="whitespace-pre-wrap">{p.extracted_text}</div>
                </div>
              ))}
            </div>
          ) : (
            <p className="text-xs text-muted-foreground italic">No extracted text for this document.</p>
          )}
        </div>
      </div>
    </>
  );
}
