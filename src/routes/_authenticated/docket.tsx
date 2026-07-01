import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, queryOptions, useQueryClient } from '@tanstack/react-query';
import { useMemo, useState } from 'react';
import {
  RefreshCw,
  ExternalLink,
  Loader2,
  Search as SearchIcon,
  AlertTriangle,
  FileText,
} from 'lucide-react';
import { toast } from 'sonner';
import { AppShell, PageHeader } from '@/components/app-shell';
import { fmtDate } from '@/components/case-ui';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ClaudeBadge } from '@/components/claude-badge';
import {
  supabase,
  RECAP_SYNC_ENDPOINT,
  SUPABASE_ANON_KEY,
  type RecapDocketEntry,
  type RecapSyncState,
  type DocketDigest,
} from '@/lib/supabase';
import { useMatter } from '@/lib/matter-context';

const docketQuery = (caseId: string) =>
  queryOptions({
    queryKey: ['recap-docket', caseId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('v_recap_docket')
        .select('*')
        .eq('case_id', caseId)
        .order('entry_number', { ascending: false, nullsFirst: false })
        .limit(600);
      if (error) throw error;
      return (data ?? []) as RecapDocketEntry[];
    },
  });

const syncStateQuery = (caseId: string) =>
  queryOptions({
    queryKey: ['recap-sync-state', caseId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('recap_sync_state')
        .select('*')
        .eq('case_id', caseId)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as RecapSyncState | null;
    },
  });

export const Route = createFileRoute('/_authenticated/docket')({
  component: DocketPage,
  errorComponent: ({ error }) => (
    <AppShell>
      <div className="p-8 text-sm text-destructive">Failed to load: {error.message}</div>
    </AppShell>
  ),
  notFoundComponent: () => (
    <AppShell>
      <div className="p-8">Not found.</div>
    </AppShell>
  ),
});

function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const secs = Math.max(0, Math.floor((Date.now() - then) / 1000));
  if (secs < 60) return 'just now';
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function clEntryUrl(e: RecapDocketEntry): string | null {
  if (e.cl_docket_id == null) return null;
  if (e.entry_number != null) {
    return `https://www.courtlistener.com/docket/${e.cl_docket_id}/${e.entry_number}/`;
  }
  return `https://www.courtlistener.com/docket/${e.cl_docket_id}/`;
}

function DocketPage() {
  const { currentMatter } = useMatter();
  const caseId = currentMatter.master_case_id;
  const qc = useQueryClient();

  const { data: entries = [], isLoading } = useQuery(docketQuery(caseId));
  const { data: syncState } = useQuery(syncStateQuery(caseId));
  const [q, setQ] = useState('');

  const sync = useMutation({
    mutationFn: async () => {
      const res = await fetch(RECAP_SYNC_ENDPOINT, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        },
        body: JSON.stringify({ case_id: caseId }),
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || body?.ok === false) {
        throw new Error(body?.error || `Sync failed (${res.status})`);
      }
      return body as { new: number; updated: number; fetched: number; total: number };
    },
    onSuccess: (r) => {
      toast.success(
        r.new > 0
          ? `Synced — ${r.new} new ${r.new === 1 ? 'entry' : 'entries'} from CourtListener`
          : 'Docket is up to date with CourtListener',
        { description: `Checked ${r.fetched} recent of ${r.total} total entries` },
      );
      qc.invalidateQueries({ queryKey: ['recap-docket', caseId] });
      qc.invalidateQueries({ queryKey: ['recap-sync-state', caseId] });
    },
    onError: (e: unknown) => {
      toast.error('Docket sync failed', { description: (e as Error).message });
    },
  });

  const rows = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return entries;
    return entries.filter(
      (e) =>
        (e.description ?? '').toLowerCase().includes(term) ||
        String(e.entry_number ?? '').includes(term),
    );
  }, [entries, q]);

  const docketUrl =
    entries[0]?.cl_docket_id != null
      ? `https://www.courtlistener.com/docket/${entries[0].cl_docket_id}/`
      : null;

  return (
    <AppShell>
      <PageHeader
        title="Live Docket"
        description={`Federal docket for ${currentMatter.short_name}, synced from CourtListener (RECAP/PACER). Refresh to pull the latest filings into the record.`}
      >
        <div className="flex flex-col items-end gap-2">
          <button
            type="button"
            onClick={() => sync.mutate()}
            disabled={sync.isPending}
            className="inline-flex items-center gap-2 rounded-sm bg-primary px-3.5 py-2 text-[12px] font-sans font-medium text-primary-foreground hover:brightness-110 disabled:opacity-60 transition focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
          >
            {sync.isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <RefreshCw className="h-3.5 w-3.5" />
            )}
            {sync.isPending ? 'Syncing…' : 'Sync from CourtListener'}
          </button>
          <span className="text-[11px] text-muted-foreground tabular-nums">
            Last synced {relativeTime(syncState?.last_synced_at ?? null)}
          </span>
        </div>
      </PageHeader>

      <div className="px-8 py-6">
        <div className="flex items-center justify-between gap-4 mb-4">
          <div className="relative w-full max-w-md">
            <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter docket entries…"
              className="pl-9"
            />
          </div>
          <div className="flex items-center gap-3 shrink-0 text-[12px] text-muted-foreground tabular-nums">
            <span>
              {rows.length} {rows.length === 1 ? 'entry' : 'entries'}
              {q && entries.length !== rows.length ? ` of ${entries.length}` : ''}
            </span>
            {docketUrl && (
              <a
                href={docketUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-accent hover:underline"
              >
                <ExternalLink className="h-3 w-3" /> Full docket on CourtListener
              </a>
            )}
          </div>
        </div>

        {syncState?.last_error && (
          <div className="mb-4 flex items-start gap-2 rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2 text-[12px] text-destructive">
            <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
            <span>Last sync reported an error: {syncState.last_error}</span>
          </div>
        )}

        {isLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-12 justify-center">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading docket…
          </div>
        ) : rows.length === 0 ? (
          <div className="py-16 text-center text-sm text-muted-foreground">
            {entries.length === 0
              ? 'No docket entries yet. Click “Sync from CourtListener” to pull the live docket.'
              : 'No entries match your filter.'}
          </div>
        ) : (
          <div className="space-y-2">
            {rows.map((e) => {
              const url = clEntryUrl(e);
              return (
                <Card key={e.id} className="p-4 flex gap-4 items-start">
                  <div className="shrink-0 w-14 text-center">
                    <div className="font-serif text-lg font-semibold tabular-nums text-foreground leading-none">
                      {e.entry_number ?? '—'}
                    </div>
                    <div className="text-[9.5px] uppercase tracking-wider text-muted-foreground mt-1">
                      Entry
                    </div>
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap text-[11px] text-muted-foreground">
                      {e.date_filed && (
                        <span className="tabular-nums">Filed {fmtDate(e.date_filed)}</span>
                      )}
                      {e.doc_count > 0 && (
                        <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded border border-border bg-secondary/60">
                          <FileText className="h-2.5 w-2.5" /> {e.doc_count}{' '}
                          {e.doc_count === 1 ? 'document' : 'documents'}
                        </span>
                      )}
                    </div>
                    <p className="mt-1.5 font-serif text-[13.5px] leading-relaxed text-foreground/90">
                      {e.description || <span className="text-muted-foreground italic">No description</span>}
                    </p>
                    {url && (
                      <a
                        href={url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 inline-flex items-center gap-1 text-[11px] text-accent hover:underline"
                      >
                        <ExternalLink className="h-3 w-3" /> View on CourtListener
                      </a>
                    )}
                  </div>
                </Card>
              );
            })}
          </div>
        )}
      </div>
    </AppShell>
  );
}
