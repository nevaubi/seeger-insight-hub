import { createFileRoute } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import {
  ExternalLink,
  Search as SearchIcon,
  Sparkles,
  Loader2,
  ChevronDown,
  ChevronRight,
  BookOpen,
  Brain,
} from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AppShell, PageHeader } from '@/components/app-shell';
import { OrderTypeBadge, fmtDate } from '@/components/case-ui';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { supabase } from '@/lib/supabase';
import { embedQuery, modelReady } from '@/lib/embed';
import { tagLabel } from '@/lib/supabase';

const SUPABASE_URL = 'https://blhcucozljrojnvqosyi.supabase.co';
const SUPABASE_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImJsaGN1Y296bGpyb2pudnFvc3lpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE5MTcyMDYsImV4cCI6MjA5NzQ5MzIwNn0.uwwQT_gnFtcgKD73BdURuSyFVbqXkjBec23dPBUXNO0';
const SYNTH_ENDPOINT = `${SUPABASE_URL}/functions/v1/legal-synthesis`;

const EXAMPLES_SYNTH = [
  'What must plaintiffs do to establish proof of Depo-Provera use, and by when?',
  "What does PTO 22A's Deficiency Exception require?",
  'What are the common-benefit assessment obligations?',
  'What is the Rule 702 / Daubert schedule?',
];
const EXAMPLES_BROWSE = [
  'threshold proof of use',
  'deposition protocol',
  'money from outside investors paying for the lawsuit',
  'common benefit',
];

const ORDER_TYPES = ['Any', 'PTO', 'CMO', 'CBO', 'JPML', 'OTHER'];
const AFFECTS = ['Any', 'plaintiffs', 'defendants', 'leadership', 'all'];

export const Route = createFileRoute('/search')({
  component: AskTheRecord,
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

// ----- types -----

type Chunk = {
  ref: string;
  order_label?: string | null;
  doc_label?: string | null;
  order_type?: string | null;
  order_number?: string | null;
  order_date?: string | null;
  page_start: number;
  page_end: number;
  section_label?: string | null;
  affects?: string | null;
  has_deadline?: boolean;
  tags?: string[] | null;
  pdf_url?: string | null;
  score?: number;
  vec_hit?: boolean;
  lex_hit?: boolean;
  sentences: string[];
};

type SearchEvt = {
  round: number;
  keywords: string | null;
  filter: Record<string, unknown>;
  k: number;
  count?: number;
};

type RoundState = {
  round: number;
  textBlocks: { id: string; text: string }[];
  textOrder: string[]; // block ids in order
  stop_reason?: 'tool_use' | 'end_turn';
};

type CitationEvt = {
  round: number;
  block_id: string;
  ref: string;
  order_label?: string | null;
  page: number;
  sentence_start: number;
  sentence_end: number;
  cited_text?: string;
  source?: string;
  title?: string;
  num: number; // assigned in order of arrival
};

type HybridHit = {
  id: string;
  document_id: string;
  order_id: string | null;
  content: string;
  score: number;
  vec_hit: boolean;
  lex_hit: boolean;
  doc_label: string | null;
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

// ----- filter bar -----

type Filters = {
  orderType: string;
  affects: string;
  hasDeadline: boolean;
  dateFrom: string;
  dateTo: string;
};

function buildFilter(f: Filters) {
  const out: Record<string, unknown> = {};
  if (f.orderType !== 'Any') out.order_type = f.orderType;
  if (f.affects !== 'Any') out.affects = f.affects;
  if (f.hasDeadline) out.has_deadline = true;
  if (f.dateFrom) out.order_date_from = f.dateFrom;
  if (f.dateTo) out.order_date_to = f.dateTo;
  return out;
}

// ----- main component -----

function AskTheRecord() {
  const [mode, setMode] = useState<'synth' | 'browse'>('synth');
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<Filters>({
    orderType: 'Any',
    affects: 'Any',
    hasDeadline: false,
    dateFrom: '',
    dateTo: '',
  });

  return (
    <AppShell>
      <PageHeader
        title="Ask the Record"
        description="Ask in plain English. The assistant searches every controlling order on the docket and answers with grounded, page-level citations."
      />
      <div className="px-8 py-6 space-y-5">
        <Card className="p-5">
          <div className="flex items-center gap-1 mb-4 text-xs">
            <button
              type="button"
              onClick={() => setMode('synth')}
              className={`px-3 py-1.5 rounded-full border transition-colors inline-flex items-center gap-1.5 ${
                mode === 'synth'
                  ? 'bg-accent text-accent-foreground border-accent'
                  : 'border-border bg-secondary/60 text-foreground/80 hover:border-accent/60'
              }`}
            >
              <Brain className="h-3 w-3" /> Ask (synthesized answer)
            </button>
            <button
              type="button"
              onClick={() => setMode('browse')}
              className={`px-3 py-1.5 rounded-full border transition-colors inline-flex items-center gap-1.5 ${
                mode === 'browse'
                  ? 'bg-accent text-accent-foreground border-accent'
                  : 'border-border bg-secondary/60 text-foreground/80 hover:border-accent/60'
              }`}
            >
              <BookOpen className="h-3 w-3" /> Browse passages
            </button>
          </div>

          <FilterBar value={filters} onChange={setFilters} q={q} setQ={setQ} mode={mode} />
        </Card>

        {mode === 'synth' ? (
          <SynthesisPanel q={q} setQ={setQ} filters={filters} />
        ) : (
          <BrowsePanel q={q} setQ={setQ} filters={filters} />
        )}
      </div>
    </AppShell>
  );
}

// ----- filter bar -----

function FilterBar({
  value,
  onChange,
  q,
  setQ,
  mode,
}: {
  value: Filters;
  onChange: (f: Filters) => void;
  q: string;
  setQ: (s: string) => void;
  mode: 'synth' | 'browse';
}) {
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="space-y-4">
      <div className="relative">
        <SearchIcon className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={
            mode === 'synth'
              ? 'Ask the record in plain English…'
              : 'Search the record (keywords or natural language)…'
          }
          className="pl-9 h-11 text-base bg-background"
          autoFocus
        />
      </div>
      <div className="flex flex-wrap items-end gap-3 text-xs">
        <label className="flex flex-col gap-1">
          <span className="uppercase tracking-wider text-muted-foreground text-[10px]">Order type</span>
          <select
            value={value.orderType}
            onChange={(e) => set('orderType', e.target.value)}
            className="h-8 rounded border border-border bg-background px-2 text-foreground"
          >
            {ORDER_TYPES.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="uppercase tracking-wider text-muted-foreground text-[10px]">Affects</span>
          <select
            value={value.affects}
            onChange={(e) => set('affects', e.target.value)}
            className="h-8 rounded border border-border bg-background px-2 text-foreground"
          >
            {AFFECTS.map((o) => (
              <option key={o}>{o}</option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="uppercase tracking-wider text-muted-foreground text-[10px]">From</span>
          <input
            type="date"
            value={value.dateFrom}
            onChange={(e) => set('dateFrom', e.target.value)}
            className="h-8 rounded border border-border bg-background px-2 text-foreground"
          />
        </label>
        <label className="flex flex-col gap-1">
          <span className="uppercase tracking-wider text-muted-foreground text-[10px]">To</span>
          <input
            type="date"
            value={value.dateTo}
            onChange={(e) => set('dateTo', e.target.value)}
            className="h-8 rounded border border-border bg-background px-2 text-foreground"
          />
        </label>
        <label className="flex items-center gap-2 h-8">
          <Checkbox
            checked={value.hasDeadline}
            onCheckedChange={(v) => set('hasDeadline', v === true)}
          />
          <span className="text-foreground/80">Has a deadline</span>
        </label>
      </div>
    </div>
  );
}

// ----- synthesis panel -----

function SynthesisPanel({
  q,
  setQ,
  filters,
}: {
  q: string;
  setQ: (s: string) => void;
  filters: Filters;
}) {
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [embedding, setEmbedding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searches, setSearches] = useState<SearchEvt[]>([]);
  const [thinking, setThinking] = useState<Record<number, string>>({});
  const [rounds, setRounds] = useState<Record<number, RoundState>>({});
  const [finalRound, setFinalRound] = useState<number | null>(null);
  const [citations, setCitations] = useState<CitationEvt[]>([]);
  const [chunks, setChunks] = useState<Record<string, Chunk>>({});
  const [chunkOrder, setChunkOrder] = useState<string[]>([]);
  const [reasoningOpen, setReasoningOpen] = useState(true);
  const [flashRef, setFlashRef] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const citationCounter = useRef(0);

  const reset = () => {
    setSearches([]);
    setThinking({});
    setRounds({});
    setFinalRound(null);
    setCitations([]);
    setChunks({});
    setChunkOrder([]);
    setError(null);
    citationCounter.current = 0;
  };

  const run = useCallback(
    async (query: string) => {
      const v = query.trim();
      if (!v) return;
      abortRef.current?.abort();
      reset();
      setSubmitted(v);
      setRunning(true);
      setReasoningOpen(true);

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        setEmbedding(!modelReady());
        const emb = await embedQuery(v);
        setEmbedding(false);

        const res = await fetch(SYNTH_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_ANON,
            Authorization: `Bearer ${SUPABASE_ANON}`,
          },
          body: JSON.stringify({
            question: v,
            embedding: emb,
            initial_filter: buildFilter(filters),
          }),
          signal: ctrl.signal,
        });

        if (!res.ok || !res.body) {
          throw new Error(`Synthesis failed (${res.status})`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            // pull a data: line
            const dataLine = frame
              .split('\n')
              .find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            const payload = dataLine.slice(5).trim();
            if (!payload) continue;
            let evt: any;
            try {
              evt = JSON.parse(payload);
            } catch {
              continue;
            }
            handleEvent(evt);
          }
        }
      } catch (e: any) {
        if (e?.name !== 'AbortError') setError(e?.message ?? String(e));
      } finally {
        setEmbedding(false);
        setRunning(false);
      }
    },
    [filters],
  );

  const handleEvent = (evt: any) => {
    switch (evt.type) {
      case 'round':
        setRounds((r) => ({
          ...r,
          [evt.round]: r[evt.round] ?? { round: evt.round, textBlocks: [], textOrder: [] },
        }));
        break;
      case 'thinking':
        setThinking((t) => ({ ...t, [evt.round]: (t[evt.round] ?? '') + (evt.text ?? '') }));
        break;
      case 'search':
        setSearches((s) => [
          ...s,
          { round: evt.round, keywords: evt.keywords, filter: evt.filter ?? {}, k: evt.k },
        ]);
        break;
      case 'chunks': {
        const list = (evt.chunks ?? []) as Chunk[];
        setChunks((c) => {
          const next = { ...c };
          for (const ch of list) if (!next[ch.ref]) next[ch.ref] = ch;
          return next;
        });
        setChunkOrder((o) => {
          const seen = new Set(o);
          const add = list.map((c) => c.ref).filter((r) => !seen.has(r));
          return [...o, ...add];
        });
        setSearches((s) => {
          // append count to the most recent search of this round
          const copy = [...s];
          for (let i = copy.length - 1; i >= 0; i--) {
            if (copy[i].round === evt.round && copy[i].count === undefined) {
              copy[i] = { ...copy[i], count: list.length };
              break;
            }
          }
          return copy;
        });
        break;
      }
      case 'text':
        setRounds((r) => {
          const cur = r[evt.round] ?? { round: evt.round, textBlocks: [], textOrder: [] };
          const existing = cur.textBlocks.find((b) => b.id === evt.block_id);
          let blocks = cur.textBlocks;
          let order = cur.textOrder;
          if (existing) {
            blocks = blocks.map((b) =>
              b.id === evt.block_id ? { ...b, text: b.text + (evt.text ?? '') } : b,
            );
          } else {
            blocks = [...blocks, { id: evt.block_id, text: evt.text ?? '' }];
            order = [...order, evt.block_id];
          }
          return { ...r, [evt.round]: { ...cur, textBlocks: blocks, textOrder: order } };
        });
        break;
      case 'citation': {
        citationCounter.current += 1;
        const num = citationCounter.current;
        setCitations((c) => [...c, { ...evt, num }]);
        break;
      }
      case 'round_end':
        setRounds((r) => {
          const cur = r[evt.round] ?? { round: evt.round, textBlocks: [], textOrder: [] };
          return { ...r, [evt.round]: { ...cur, stop_reason: evt.stop_reason } };
        });
        if (evt.stop_reason === 'end_turn') setFinalRound(evt.round);
        break;
      case 'search_error':
        setError(`Search error (round ${evt.round}): ${evt.message}`);
        break;
      case 'error':
        setError(evt.message ?? 'Unknown error');
        break;
      case 'done':
        setRunning(false);
        setReasoningOpen(false);
        break;
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    run(q);
  };

  // collapse reasoning when stream completes
  useEffect(() => {
    if (!running && finalRound != null) setReasoningOpen(false);
  }, [running, finalRound]);

  const scrollToChunk = (ref: string) => {
    const el = document.getElementById(`chunk-${ref}`);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      setFlashRef(ref);
      setTimeout(() => setFlashRef((cur) => (cur === ref ? null : cur)), 1600);
    }
  };

  // citations by block id (within final round) for inline chips
  const citationsByBlock = useMemo(() => {
    const m: Record<string, CitationEvt[]> = {};
    for (const c of citations) {
      if (finalRound != null && c.round !== finalRound) continue;
      (m[c.block_id] ??= []).push(c);
    }
    return m;
  }, [citations, finalRound]);

  // citations grouped by chunk ref (for highlighting sentences)
  const citationsByRef = useMemo(() => {
    const m: Record<string, CitationEvt[]> = {};
    for (const c of citations) (m[c.ref] ??= []).push(c);
    return m;
  }, [citations]);

  const sortedChunkRefs = useMemo(() => {
    // cited first (by first citation num), then the rest in arrival order
    const firstCiteNum: Record<string, number> = {};
    for (const c of citations) {
      if (!(c.ref in firstCiteNum)) firstCiteNum[c.ref] = c.num;
    }
    const cited = chunkOrder.filter((r) => r in firstCiteNum).sort(
      (a, b) => firstCiteNum[a] - firstCiteNum[b],
    );
    const uncited = chunkOrder.filter((r) => !(r in firstCiteNum));
    return [...cited, ...uncited];
  }, [chunkOrder, citations]);

  const finalRoundState = finalRound != null ? rounds[finalRound] : undefined;
  const concatenatedReasoning = useMemo(() => {
    return Object.keys(thinking)
      .map((k) => Number(k))
      .sort((a, b) => a - b)
      .map((r) => ({ round: r, text: thinking[r] }));
  }, [thinking]);

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} className="flex gap-2">
        <Button
          type="submit"
          disabled={running || !q.trim()}
          className="h-10 px-5 bg-accent text-accent-foreground hover:bg-accent/90"
        >
          {running ? (
            <>
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
              Researching…
            </>
          ) : (
            'Ask the record'
          )}
        </Button>
        {running && (
          <Button
            type="button"
            variant="outline"
            className="h-10"
            onClick={() => abortRef.current?.abort()}
          >
            Stop
          </Button>
        )}
      </form>

      {embedding && (
        <Card className="p-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Preparing semantic model (one-time, ~30MB)…
        </Card>
      )}

      {error && (
        <Card className="p-4 text-sm border-destructive/40 bg-destructive/5 text-destructive">
          {error}
        </Card>
      )}

      {!submitted && !running && (
        <Card className="p-6">
          <div className="text-[11px] uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1.5">
            <Sparkles className="h-3 w-3" /> Try a question
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {EXAMPLES_SYNTH.map((ex) => (
              <button
                key={ex}
                type="button"
                onClick={() => {
                  setQ(ex);
                  run(ex);
                }}
                className="text-left text-sm font-serif px-3 py-2 rounded border border-border bg-secondary/40 hover:bg-accent hover:text-accent-foreground hover:border-accent transition-colors max-w-md"
              >
                {ex}
              </button>
            ))}
          </div>
        </Card>
      )}

      {submitted && (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
          {/* LEFT: Answer + reasoning + trace */}
          <div className="lg:col-span-3 space-y-4">
            {/* Reasoning */}
            {concatenatedReasoning.length > 0 && (
              <Card className="p-0 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setReasoningOpen((x) => !x)}
                  className="w-full px-4 py-2.5 flex items-center gap-2 text-xs uppercase tracking-wider text-muted-foreground hover:bg-secondary/50"
                >
                  {reasoningOpen ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                  <Brain className="h-3.5 w-3.5" /> Reasoning
                </button>
                {reasoningOpen && (
                  <div className="px-4 pb-4 space-y-3 border-t border-border">
                    {concatenatedReasoning.map(({ round, text }) => (
                      <div key={round}>
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground mt-2">
                          Round {round}
                        </div>
                        <pre className="whitespace-pre-wrap font-mono text-[12px] leading-relaxed text-foreground/70">
                          {text}
                        </pre>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            )}

            {/* Research trace */}
            {searches.length > 0 && (
              <Card className="p-4">
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
                  Research trace
                </div>
                <ol className="space-y-2">
                  {searches.map((s, i) => (
                    <li key={i} className="text-xs flex flex-wrap items-center gap-2">
                      <span className="font-mono text-muted-foreground">Search {i + 1}</span>
                      {s.keywords && (
                        <span className="font-serif italic text-foreground">"{s.keywords}"</span>
                      )}
                      {Object.entries(s.filter ?? {}).map(([k, v]) => (
                        <span
                          key={k}
                          className="px-1.5 py-0.5 rounded border border-border bg-secondary/60 text-[10px]"
                        >
                          {k}: {String(v)}
                        </span>
                      ))}
                      <span className="text-muted-foreground">
                        · k={s.k}
                        {s.count !== undefined && ` · ${s.count} passages`}
                      </span>
                    </li>
                  ))}
                </ol>
              </Card>
            )}

            {/* Answer */}
            <Card className="p-6">
              <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-3">
                Answer
              </div>
              {!finalRoundState && running && (
                <div className="text-sm text-muted-foreground inline-flex items-center gap-2">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Researching the record…
                </div>
              )}
              {finalRoundState && (
                <AnswerBlocks
                  round={finalRoundState}
                  citationsByBlock={citationsByBlock}
                  onCitationClick={scrollToChunk}
                />
              )}
              {!finalRoundState && !running && submitted && (
                <div className="text-sm text-muted-foreground">No answer produced.</div>
              )}
            </Card>
          </div>

          {/* RIGHT: Evidence */}
          <div className="lg:col-span-2 space-y-3">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground px-1">
              Evidence · {chunkOrder.length} passage{chunkOrder.length === 1 ? '' : 's'}
            </div>
            {sortedChunkRefs.map((ref) => {
              const ch = chunks[ref];
              if (!ch) return null;
              const cites = citationsByRef[ref] ?? [];
              const isCited = cites.length > 0;
              return (
                <EvidenceCard
                  key={ref}
                  chunk={ch}
                  citations={cites}
                  flash={flashRef === ref}
                  cited={isCited}
                />
              );
            })}
            {chunkOrder.length === 0 && !running && (
              <Card className="p-6 text-sm text-muted-foreground">No passages retrieved.</Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ----- answer blocks with inline citation chips -----

function AnswerBlocks({
  round,
  citationsByBlock,
  onCitationClick,
}: {
  round: RoundState;
  citationsByBlock: Record<string, CitationEvt[]>;
  onCitationClick: (ref: string) => void;
}) {
  return (
    <div className="space-y-3">
      {round.textOrder.map((bid) => {
        const block = round.textBlocks.find((b) => b.id === bid);
        if (!block) return null;
        const cites = citationsByBlock[bid] ?? [];
        return (
          <div key={bid} className="font-serif text-[15px] leading-relaxed text-foreground prose-legal">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{block.text}</ReactMarkdown>
            {cites.length > 0 && (
              <span className="inline-flex flex-wrap items-center gap-1 ml-1 align-baseline">
                {cites.map((c) => (
                  <button
                    key={c.num}
                    type="button"
                    onClick={() => onCitationClick(c.ref)}
                    title={`${c.order_label ?? ''} p.${c.page}`}
                    className="inline-flex items-center justify-center min-w-[1.4rem] h-[1.4rem] px-1 rounded-full text-[10.5px] font-sans font-medium bg-accent text-accent-foreground hover:brightness-110 transition cursor-pointer tabular-nums"
                  >
                    {c.num}
                  </button>
                ))}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ----- evidence card -----

function EvidenceCard({
  chunk,
  citations,
  flash,
  cited,
}: {
  chunk: Chunk;
  citations: CitationEvt[];
  flash: boolean;
  cited: boolean;
}) {
  const pageCite =
    chunk.page_start === chunk.page_end
      ? `p.${chunk.page_start}`
      : `p.${chunk.page_start}–${chunk.page_end}`;

  // map sentence index -> citation numbers attached to it
  const sentCites = useMemo(() => {
    const m: Record<number, number[]> = {};
    for (const c of citations) {
      for (let i = c.sentence_start; i < c.sentence_end; i++) {
        (m[i] ??= []).push(c.num);
      }
    }
    return m;
  }, [citations]);

  return (
    <Card
      id={`chunk-${chunk.ref}`}
      className={`p-4 transition-all ${
        cited ? 'border-l-[3px] border-l-accent' : ''
      } ${flash ? 'ring-2 ring-accent shadow-md' : ''}`}
    >
      <div className="flex items-center gap-2 flex-wrap">
        {chunk.order_type ? (
          <OrderTypeBadge type={chunk.order_type} number={chunk.order_number ?? null} />
        ) : (
          <span className="text-sm font-medium text-foreground">
            {chunk.order_label ?? chunk.doc_label ?? 'Document'}
          </span>
        )}
        {chunk.order_type && (chunk.order_label || chunk.doc_label) && (
          <span className="text-sm text-foreground/80 truncate max-w-[16rem]">
            {chunk.order_label ?? chunk.doc_label}
          </span>
        )}
        <span className="text-xs text-muted-foreground">· {pageCite}</span>
        {chunk.order_date && (
          <span className="text-xs text-muted-foreground tabular-nums">
            · {fmtDate(chunk.order_date)}
          </span>
        )}
      </div>
      {chunk.section_label && (
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground mt-1">
          {chunk.section_label}
        </div>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10.5px]">
        {chunk.affects && (
          <span className="px-1.5 py-0.5 rounded border border-border bg-secondary/60 text-muted-foreground">
            affects: {chunk.affects}
          </span>
        )}
        {chunk.has_deadline && (
          <span className="px-1.5 py-0.5 rounded border border-border bg-secondary/60 text-muted-foreground">
            deadline
          </span>
        )}
        {(chunk.tags ?? []).slice(0, 4).map((t) => (
          <span
            key={t}
            className="px-1.5 py-0.5 rounded border border-border bg-secondary/60 text-muted-foreground"
          >
            {tagLabel(t)}
          </span>
        ))}
      </div>
      <div className="mt-3 font-serif text-[14px] leading-relaxed text-foreground/90">
        {chunk.sentences.map((s, i) => {
          const nums = sentCites[i];
          if (nums && nums.length) {
            return (
              <span
                key={i}
                className="bg-accent/15 rounded-sm px-0.5"
                style={{ boxShadow: 'inset 0 -1px 0 hsl(var(--accent) / 0.5)' }}
              >
                {s}
                <span className="inline-flex gap-0.5 ml-1 align-baseline">
                  {nums.map((n) => (
                    <span
                      key={n}
                      className="inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 rounded-full text-[9.5px] font-sans font-medium bg-accent text-accent-foreground tabular-nums"
                    >
                      {n}
                    </span>
                  ))}
                </span>{' '}
              </span>
            );
          }
          return <span key={i}>{s} </span>;
        })}
      </div>
      <div className="mt-3 flex items-center gap-3 text-[11px]">
        {chunk.pdf_url && (
          <a
            href={chunk.pdf_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-accent hover:underline"
          >
            <ExternalLink className="h-3 w-3" /> View source PDF
          </a>
        )}
        {typeof chunk.score === 'number' && (
          <span className="text-muted-foreground tabular-nums ml-auto">
            score {chunk.score.toFixed(3)}
          </span>
        )}
      </div>
    </Card>
  );
}

// ----- browse passages (legacy hybrid) -----

function BrowsePanel({
  q,
  setQ,
  filters,
}: {
  q: string;
  setQ: (s: string) => void;
  filters: Filters;
}) {
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [embedding, setEmbedding] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  const search = useMutation<{ rows: HybridHit[]; notice?: string }, Error, string>({
    mutationFn: async (query) => {
      const filter = buildFilter(filters);
      try {
        setEmbedding(!modelReady());
        const emb = await embedQuery(query);
        setEmbedding(false);
        const { data, error } = await supabase.rpc('hybrid_search', {
          q: query,
          query_embedding: emb,
          filter,
          k: 20,
        });
        if (error) throw error;
        return { rows: (data ?? []) as HybridHit[] };
      } catch {
        setEmbedding(false);
        const { data, error } = await supabase.rpc('search_pages', { q: query, lim: 30 });
        if (error) throw error;
        // shape lexical into HybridHit-ish for rendering
        const rows: HybridHit[] = ((data ?? []) as any[]).map((r) => ({
          id: `${r.document_id}-${r.page_number}`,
          document_id: r.document_id,
          order_id: r.order_id,
          content: String(r.snippet ?? '').replace(/<<|>>/g, ''),
          score: r.rank ?? 0,
          vec_hit: false,
          lex_hit: true,
          doc_label: r.doc_label,
          order_type: r.order_type,
          order_number: null,
          order_date: r.order_date,
          tags: null,
          section_label: null,
          affects: null,
          has_deadline: false,
          page_start: r.page_number,
          page_end: r.page_number,
          pdf_url: r.pdf_url,
        }));
        return { rows, notice: 'Semantic model unavailable — showing keyword results.' };
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

  return (
    <div className="space-y-4">
      <form onSubmit={onSubmit} className="flex gap-2">
        <Button
          type="submit"
          disabled={search.isPending}
          className="h-10 px-5 bg-accent text-accent-foreground hover:bg-accent/90"
        >
          {search.isPending ? 'Searching…' : 'Browse passages'}
        </Button>
      </form>

      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1.5">
          <Sparkles className="h-3 w-3" /> Try
        </span>
        {EXAMPLES_BROWSE.map((ex) => (
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

      {search.isPending && embedding && (
        <Card className="p-4 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Preparing semantic model (one-time, ~30MB)…
        </Card>
      )}

      {search.isError && (
        <Card className="p-4 text-sm text-destructive">
          Search failed: {(search.error as Error).message}
        </Card>
      )}

      {search.data?.notice && (
        <div className="text-xs text-muted-foreground italic">{search.data.notice}</div>
      )}

      {submitted && !search.isPending && search.data && (
        <div className="text-xs text-muted-foreground">
          {search.data.rows.length} passage{search.data.rows.length === 1 ? '' : 's'} for{' '}
          <span className="font-serif italic text-foreground">"{submitted}"</span>
        </div>
      )}

      <div className="space-y-3">
        {search.data?.rows.map((h) => {
          const isExpanded = expanded[h.id];
          const pageCite =
            h.page_start === h.page_end ? `p.${h.page_start}` : `p.${h.page_start}–${h.page_end}`;
          return (
            <Card key={h.id} className="p-4">
              <div className="flex items-center gap-2 flex-wrap">
                {h.order_type ? (
                  <OrderTypeBadge type={h.order_type} number={h.order_number} />
                ) : (
                  <span className="text-sm font-medium text-foreground">
                    {h.doc_label ?? 'Document'}
                  </span>
                )}
                {h.order_type && h.doc_label && (
                  <span className="text-sm text-foreground/80">{h.doc_label}</span>
                )}
                <span className="text-xs text-muted-foreground">· {pageCite}</span>
                {h.order_date && (
                  <span className="text-xs text-muted-foreground tabular-nums">
                    · {fmtDate(h.order_date)}
                  </span>
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
                onClick={() => setExpanded((s) => ({ ...s, [h.id]: !s[h.id] }))}
                className="mt-1 text-xs text-accent hover:underline"
              >
                {isExpanded ? 'Show less' : 'Show more'}
              </button>
              <div className="mt-3 flex flex-wrap items-center gap-2 text-[10.5px] text-muted-foreground">
                <span className="tabular-nums">score {h.score.toFixed(3)}</span>
                {h.vec_hit && (
                  <span className="px-1.5 py-0.5 rounded border border-border bg-secondary/60">
                    semantic
                  </span>
                )}
                {h.lex_hit && (
                  <span className="px-1.5 py-0.5 rounded border border-border bg-secondary/60">
                    keyword
                  </span>
                )}
                {h.affects && (
                  <span className="px-1.5 py-0.5 rounded border border-border bg-secondary/60">
                    affects: {h.affects}
                  </span>
                )}
                {h.has_deadline && (
                  <span className="px-1.5 py-0.5 rounded border border-border bg-secondary/60">
                    deadline
                  </span>
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

        {submitted && !search.isPending && search.data && search.data.rows.length === 0 && (
          <Card className="p-8 text-center">
            <div className="text-sm text-muted-foreground">No passages matched "{submitted}".</div>
            <div className="text-xs text-muted-foreground mt-1">
              Try broader phrasing or remove filters.
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
