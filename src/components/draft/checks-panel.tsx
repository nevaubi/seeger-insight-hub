import { useCallback, useState } from 'react';
import {
  AlertCircle,
  AlertTriangle,
  BookMarked,
  Braces,
  CheckCircle2,
  ExternalLink,
  Hash,
  Link2,
  ListChecks,
  Loader2,
  Play,
  Scale,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import {
  AI_ASSIST_ENDPOINT,
  CITE_CHECK_ENDPOINT,
  SUPABASE_ANON_KEY,
  type CiteCheckSummary,
} from '@/lib/supabase';
import type { AiAssistMatter } from '@/lib/useAiAssist';

// The Checks tab: bounded document-intelligence passes.
//   Placeholders / Defined terms / Cross-references / Record cites → ai-assist `check`
//   mode (deterministic scans; record cites verified against court_orders/docket_entries).
//   External citations → the cite-check function (CourtListener citation-lookup, eyecite).

export interface CheckFindingRow {
  kind: string;
  state: 'ok' | 'warning' | 'error';
  quote: string;
  start: number | null;
  end: number | null;
  note: string;
  url?: string | null;
}

type CheckKey = 'placeholders' | 'defined_terms' | 'crossrefs' | 'citations' | 'external';

type CheckState =
  | { phase: 'idle' }
  | { phase: 'running' }
  | { phase: 'done'; findings: CheckFindingRow[]; ranAt: number }
  | { phase: 'error'; message: string };

const CHECKS: { key: CheckKey; label: string; desc: string; icon: typeof Braces }[] = [
  { key: 'placeholders', label: 'Placeholders', desc: 'Unresolved [BRACKETED] blanks', icon: Braces },
  { key: 'defined_terms', label: 'Defined terms', desc: 'Unused, redefined, used-before-defined', icon: BookMarked },
  { key: 'crossrefs', label: 'Cross-references', desc: 'Section refs & footnote integrity', icon: Hash },
  { key: 'citations', label: 'Record cites', desc: 'PTO/CMO/Dkt. verified against the register', icon: Scale },
  { key: 'external', label: 'External cites', desc: 'Case law via CourtListener lookup', icon: Link2 },
];

async function runServerCheck(
  checkType: Exclude<CheckKey, 'external'>,
  document: string,
  caseId: string,
  matter: AiAssistMatter,
): Promise<CheckFindingRow[]> {
  const res = await fetch(AI_ASSIST_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ mode: 'check', check_type: checkType, document, case_id: caseId, matter }),
  });
  const data = await res.json();
  if (!res.ok || !data?.ok) throw new Error(data?.error ?? `Check failed (${res.status})`);
  return (data.findings as any[]).map((f) => ({
    kind: f.kind,
    state: f.state,
    quote: f.quote ?? '',
    start: Number.isFinite(f.start) ? f.start : null,
    end: Number.isFinite(f.end) ? f.end : null,
    note: f.note ?? '',
    url: f.pdf_url ?? null,
  }));
}

async function runExternalCheck(document: string): Promise<CheckFindingRow[]> {
  const res = await fetch(CITE_CHECK_ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    },
    body: JSON.stringify({ text: document }),
  });
  const data: CiteCheckSummary & { error?: string } = await res.json();
  if (!res.ok || !data?.ok) throw new Error((data as any)?.error ?? `Citation lookup failed (${res.status})`);
  return (data.results ?? []).map((r) => ({
    kind: 'external_cite',
    state: r.state === 'valid' ? 'ok' : r.state === 'not_found' || r.state === 'invalid' ? 'error' : 'warning',
    quote: r.citation ?? '',
    start: r.start,
    end: r.end,
    note:
      r.state === 'valid'
        ? `Resolves to ${r.case_name ?? 'a reported case'}${r.year ? ` (${r.year})` : ''}.`
        : r.state === 'ambiguous'
          ? `Ambiguous — ${r.match_count} candidate cases matched.`
          : r.state === 'not_found'
            ? 'No matching case found on CourtListener.'
            : r.message || 'Could not be verified.',
    url: r.url,
  }));
}

export function ChecksPanel({
  document,
  caseId,
  matter,
  onJump,
}: {
  document: string;
  caseId: string;
  matter: AiAssistMatter;
  onJump: (start: number, end: number) => void;
}) {
  const [states, setStates] = useState<Record<CheckKey, CheckState>>({
    placeholders: { phase: 'idle' },
    defined_terms: { phase: 'idle' },
    crossrefs: { phase: 'idle' },
    citations: { phase: 'idle' },
    external: { phase: 'idle' },
  });

  const runOne = useCallback(
    async (key: CheckKey) => {
      if (!document.trim()) return;
      setStates((s) => ({ ...s, [key]: { phase: 'running' } }));
      try {
        const findings =
          key === 'external'
            ? await runExternalCheck(document)
            : await runServerCheck(key, document, caseId, matter);
        setStates((s) => ({ ...s, [key]: { phase: 'done', findings, ranAt: Date.now() } }));
      } catch (e) {
        setStates((s) => ({ ...s, [key]: { phase: 'error', message: (e as Error).message } }));
      }
    },
    [document, caseId, matter],
  );

  const runAll = useCallback(() => {
    for (const c of CHECKS) void runOne(c.key);
  }, [runOne]);

  const anyRunning = Object.values(states).some((s) => s.phase === 'running');

  return (
    <div className="flex flex-col gap-2 px-3 py-3">
      <div className="flex items-center gap-2 px-1">
        <span className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground font-sans">
          Document checks
        </span>
        <Button
          size="sm"
          variant="outline"
          className="ml-auto h-6.5 px-2 text-[11px] gap-1"
          onClick={runAll}
          disabled={anyRunning || !document.trim()}
        >
          <ListChecks className="h-3 w-3" /> Run all
        </Button>
      </div>

      {CHECKS.map((c) => {
        const st = states[c.key];
        const Icon = c.icon;
        return (
          <div key={c.key} className="rounded-md border border-border bg-card">
            <div className="flex items-center gap-2 px-2.5 py-2">
              <Icon className="h-3.5 w-3.5 text-accent shrink-0" strokeWidth={1.75} />
              <div className="min-w-0 flex-1">
                <div className="text-[12px] font-sans font-medium text-foreground/90 leading-none">{c.label}</div>
                <div className="text-[10.5px] text-muted-foreground mt-0.5">{c.desc}</div>
              </div>
              {st.phase === 'done' && <ResultPill findings={st.findings} />}
              <Button
                size="sm"
                variant="ghost"
                className="h-6 w-6 p-0 text-muted-foreground hover:text-accent"
                title={`Run ${c.label}`}
                disabled={st.phase === 'running' || !document.trim()}
                onClick={() => runOne(c.key)}
              >
                {st.phase === 'running' ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Play className="h-3.5 w-3.5" />}
              </Button>
            </div>

            {st.phase === 'error' && (
              <div className="border-t border-border px-2.5 py-1.5 text-[11px] text-red-700 bg-red-50/50">{st.message}</div>
            )}
            {st.phase === 'done' && st.findings.length > 0 && (
              <div className="border-t border-border max-h-56 overflow-y-auto">
                {st.findings.map((f, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => f.start != null && f.end != null && onJump(f.start, f.end)}
                    className="flex w-full items-start gap-2 border-b border-border/50 px-2.5 py-1.5 text-left last:border-b-0 hover:bg-secondary/40 transition"
                  >
                    <StateIcon state={f.state} />
                    <span className="min-w-0 flex-1">
                      <span className="block text-[11.5px] leading-snug text-foreground/85">{f.note}</span>
                      {f.quote && (
                        <span className="mt-0.5 block truncate font-serif text-[11px] italic text-muted-foreground">
                          “{f.quote.length > 90 ? f.quote.slice(0, 89) + '…' : f.quote}”
                        </span>
                      )}
                    </span>
                    {f.url && (
                      <a
                        href={f.url}
                        target="_blank"
                        rel="noreferrer"
                        onClick={(e) => e.stopPropagation()}
                        className="text-muted-foreground hover:text-accent shrink-0 mt-0.5"
                        title="Open source"
                      >
                        <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </button>
                ))}
              </div>
            )}
            {st.phase === 'done' && st.findings.length === 0 && (
              <div className="border-t border-border px-2.5 py-1.5 text-[11px] text-emerald-700 bg-emerald-50/40 inline-flex items-center gap-1.5 w-full">
                <CheckCircle2 className="h-3 w-3" /> Clean — nothing flagged.
              </div>
            )}
          </div>
        );
      })}

      <p className="px-1 text-[10px] leading-relaxed text-muted-foreground/80">
        Checks are mechanical passes over this document — placeholder, term, reference, and citation
        integrity. Record cites verify against the matter's synced order register; external cites
        verify existence via CourtListener. Substantive review runs through markup passes in Chat.
      </p>
    </div>
  );
}

function StateIcon({ state }: { state: 'ok' | 'warning' | 'error' }) {
  if (state === 'ok') return <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600 shrink-0 mt-0.5" />;
  if (state === 'warning') return <AlertTriangle className="h-3.5 w-3.5 text-amber-600 shrink-0 mt-0.5" />;
  return <AlertCircle className="h-3.5 w-3.5 text-red-600 shrink-0 mt-0.5" />;
}

function ResultPill({ findings }: { findings: CheckFindingRow[] }) {
  const errors = findings.filter((f) => f.state === 'error').length;
  const warnings = findings.filter((f) => f.state === 'warning').length;
  const oks = findings.filter((f) => f.state === 'ok').length;
  return (
    <span className="flex items-center gap-1 font-sans tabular-nums">
      {errors > 0 && (
        <span className="rounded-full border border-red-300 bg-red-50 px-1.5 py-px text-[10px] text-red-700">{errors}</span>
      )}
      {warnings > 0 && (
        <span className="rounded-full border border-amber-300 bg-amber-50 px-1.5 py-px text-[10px] text-amber-700">{warnings}</span>
      )}
      {oks > 0 && errors === 0 && warnings === 0 && (
        <span className={cn('rounded-full border border-emerald-300 bg-emerald-50 px-1.5 py-px text-[10px] text-emerald-700')}>{oks} ✓</span>
      )}
      {findings.length === 0 && (
        <span className="rounded-full border border-emerald-300 bg-emerald-50 px-1.5 py-px text-[10px] text-emerald-700">clean</span>
      )}
    </span>
  );
}
