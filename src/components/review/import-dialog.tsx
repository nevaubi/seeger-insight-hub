import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Gavel, Mic, Loader2, Search, Check } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Badge } from '@/components/ui/badge';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  fetchDocketCandidates,
  fetchDepoCandidates,
  importDocketDocument,
  importDeposition,
  runImports,
  type DocketCandidate,
  type DepoCandidate,
} from '@/lib/review-import';
import { cn } from '@/lib/utils';

interface Props {
  caseId: string;
  /** Resolves the target review set, creating one if needed. */
  ensureSet: () => Promise<string>;
  onImported: () => void;
  remaining: number;
}

export function ImportFromMatterDialog({ caseId, ensureSet, onImported, remaining }: Props) {
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<'docket' | 'depositions'>('docket');
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);

  const docket = useQuery({
    queryKey: ['review-import-docket', caseId],
    enabled: open,
    queryFn: () => fetchDocketCandidates(caseId),
    staleTime: 60_000,
  });
  const depos = useQuery({
    queryKey: ['review-import-depos', caseId],
    enabled: open,
    queryFn: () => fetchDepoCandidates(caseId),
    staleTime: 60_000,
  });

  const needle = q.trim().toLowerCase();
  const docketRows = useMemo(() => {
    const rows = docket.data ?? [];
    if (!needle) return rows;
    return rows.filter((o) =>
      `${o.order_type ?? ''} ${o.order_number ?? ''} ${o.canonical_title ?? ''} ${(o.tags ?? []).join(' ')}`
        .toLowerCase()
        .includes(needle),
    );
  }, [docket.data, needle]);
  const depoRows = useMemo(() => {
    const rows = depos.data ?? [];
    if (!needle) return rows;
    return rows.filter((d) =>
      `${d.witness_name ?? ''} ${d.witness_role ?? ''} ${d.filename ?? ''}`.toLowerCase().includes(needle),
    );
  }, [depos.data, needle]);

  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const reset = () => {
    setPicked(new Set());
    setQ('');
  };

  const doImport = async () => {
    const orders = (docket.data ?? []).filter((o) => picked.has(o.id));
    const transcripts = (depos.data ?? []).filter((d) => picked.has(d.id));
    const total = orders.length + transcripts.length;
    if (!total) return;
    if (total > remaining) {
      toast.error(`Only ${remaining} more document${remaining === 1 ? '' : 's'} fit in this review`);
      return;
    }
    setBusy(true);
    try {
      const sid = await ensureSet();
      const tasks = [
        ...orders.map((o: DocketCandidate) => () => importDocketDocument(sid, o)),
        ...transcripts.map((d: DepoCandidate) => () => importDeposition(sid, d)),
      ];
      const res = await runImports(tasks, 4);
      onImported();
      if (res.failed) {
        toast.warning(`Imported ${res.ok} of ${total}`, { description: res.firstError ?? undefined });
      } else {
        toast.success(`Imported ${res.ok} document${res.ok === 1 ? '' : 's'} — ready to extract`);
      }
      setOpen(false);
      reset();
    } catch (e) {
      toast.error('Import failed', { description: (e as Error).message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2">
          <Gavel className="h-4 w-4" /> Add from matter
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Add documents from this matter</DialogTitle>
          <DialogDescription>
            Docket filings and deposition transcripts already carry extracted page text — they enter the grid
            instantly, with no upload or re-OCR.
          </DialogDescription>
        </DialogHeader>

        <Tabs value={tab} onValueChange={(v) => setTab(v as typeof tab)}>
          <div className="flex items-center gap-3">
            <TabsList>
              <TabsTrigger value="docket" className="gap-1.5">
                <Gavel className="h-3.5 w-3.5" /> Docket
              </TabsTrigger>
              <TabsTrigger value="depositions" className="gap-1.5">
                <Mic className="h-3.5 w-3.5" /> Depositions
              </TabsTrigger>
            </TabsList>
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Filter by title, number, tag, or witness…"
                className="h-8 pl-8 text-[13px]"
              />
            </div>
          </div>

          <TabsContent value="docket" className="mt-3">
            <PickList
              loading={docket.isLoading}
              empty="No docket documents with extracted text yet."
              rows={docketRows.map((o) => ({
                id: o.id,
                title: o.canonical_title ?? 'Docket document',
                meta: [
                  o.order_number ? `${(o.order_type ?? '').toUpperCase()} ${o.order_number}` : (o.order_type ?? ''),
                  o.order_date ?? '',
                  o.page_count ? `${o.page_count}p` : '',
                ].filter(Boolean),
              }))}
              picked={picked}
              onToggle={toggle}
            />
          </TabsContent>

          <TabsContent value="depositions" className="mt-3">
            <PickList
              loading={depos.isLoading}
              empty="No transcripts in this matter's deposition library yet."
              rows={depoRows.map((d) => ({
                id: d.id,
                title: d.witness_name ?? d.filename ?? 'Deposition',
                meta: [
                  d.witness_role ?? '',
                  d.deposition_date ?? '',
                  d.page_count ? `${d.page_count}p` : '',
                ].filter(Boolean),
              }))}
              picked={picked}
              onToggle={toggle}
            />
          </TabsContent>
        </Tabs>

        <DialogFooter className="items-center sm:justify-between">
          <span className="text-[11px] text-muted-foreground tabular-nums">
            {picked.size} selected · {remaining} slot{remaining === 1 ? '' : 's'} left
          </span>
          <Button size="sm" className="gap-2" disabled={!picked.size || busy} onClick={() => void doImport()}>
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />}
            Add {picked.size || ''} to review
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PickList({
  rows,
  picked,
  onToggle,
  loading,
  empty,
}: {
  rows: { id: string; title: string; meta: string[] }[];
  picked: Set<string>;
  onToggle: (id: string) => void;
  loading: boolean;
  empty: string;
}) {
  if (loading) {
    return (
      <div className="h-[19rem] flex items-center justify-center text-sm text-muted-foreground gap-2">
        <Loader2 className="h-4 w-4 animate-spin" /> Loading…
      </div>
    );
  }
  if (!rows.length) {
    return <div className="h-[19rem] flex items-center justify-center text-sm text-muted-foreground">{empty}</div>;
  }
  return (
    <div className="h-[19rem] overflow-y-auto rounded-md border border-border divide-y divide-border">
      {rows.map((r) => {
        const on = picked.has(r.id);
        return (
          <button
            key={r.id}
            type="button"
            onClick={() => onToggle(r.id)}
            className={cn(
              'w-full text-left flex items-start gap-3 px-3 py-2 transition-colors',
              on ? 'bg-primary/5' : 'hover:bg-secondary/40',
            )}
          >
            <Checkbox checked={on} className="mt-0.5 pointer-events-none" />
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] text-foreground leading-snug line-clamp-2">{r.title}</span>
              <span className="mt-1 flex flex-wrap items-center gap-1.5">
                {r.meta.map((m, i) => (
                  <Badge key={i} variant="secondary" className="text-[9.5px] font-normal tabular-nums">
                    {m}
                  </Badge>
                ))}
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}
