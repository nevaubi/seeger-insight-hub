import { createFileRoute } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import {
  Children,
  cloneElement,
  isValidElement,
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type ReactNode,
} from 'react';
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
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AppShell, PageHeader } from '@/components/app-shell';
import { OrderTypeBadge, fmtDate } from '@/components/case-ui';
import { Card } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  supabase,
  tagLabel,
  SUPABASE_ANON_KEY,
  SYNTHESIS_ENDPOINT,
} from '@/lib/supabase';
import { embedQuery, modelReady } from '@/lib/embed';
import {
  useSynthesisStream,
  type Chunk,
  type CitationEvt,
  type RoundState,
} from '@/lib/useSynthesisStream';

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

// ----- filters -----

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

// ----- top-level page -----

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
        <div className="flex items-center gap-1 text-xs">
          <ModeButton active={mode === 'synth'} onClick={() => setMode('synth')}>
            <Brain className="h-3 w-3" /> Ask (synthesized answer)
          </ModeButton>
          <ModeButton active={mode === 'browse'} onClick={() => setMode('browse')}>
            <BookOpen className="h-3 w-3" /> Browse passages
          </ModeButton>
        </div>

        {mode === 'synth' ? (
          <SynthesisPanel q={q} setQ={setQ} filters={filters} setFilters={setFilters} />
        ) : (
          <BrowsePanel q={q} setQ={setQ} filters={filters} setFilters={setFilters} />
        )}
      </div>
    </AppShell>
  );
}

function ModeButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`px-3 py-1.5 rounded-full border transition-colors inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent ${
        active
          ? 'bg-accent text-accent-foreground border-accent'
          : 'border-border bg-secondary/60 text-foreground/80 hover:border-accent/60'
      }`}
    >
      {children}
    </button>
  );
}

// ----- filter bar (input + filters) -----

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
          <span className="uppercase tracking-wider text-muted-foreground text-[10px]">
            Order type
          </span>
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
  setFilters,
}: {
  q: string;
  setQ: (s: string) => void;
  filters: Filters;
  setFilters: (f: Filters) => void;
}) {
  const { state, ask, stop } = useSynthesisStream(SYNTHESIS_ENDPOINT, SUPABASE_ANON_KEY);
  const {
    running,
    embedding,
    error,
    submitted,
    searches,
    notes,
    thinking,
    rounds,
    currentRound,
    finalRound,
    citations,
    chunks,
    chunkOrder,
  } = state;

  const [reasoningOpen, setReasoningOpen] = useState(true);
  const [flashRef, setFlashRef] = useState<string | null>(null);
  const reasoningScrollRef = useRef<HTMLDivElement | null>(null);

  // collapse reasoning once we have a final answer & stream is done
  useEffect(() => {
    if (!running && finalRound != null) setReasoningOpen(false);
  }, [running, finalRound]);

  // open reasoning at start of a new query
  useEffect(() => {
    if (running) setReasoningOpen(true);
  }, [submitted, running]);

  // auto-scroll the reasoning panel as new thinking streams in
  useEffect(() => {
    const el = reasoningScrollRef.current;
    if (el && reasoningOpen) el.scrollTop = el.scrollHeight;
  }, [thinking, reasoningOpen]);

  const runQuery = useCallback(
    (query: string) => {
      ask(query, buildFilter(filters));
    },
    [ask, filters],
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    runQuery(q);
  };

  const scrollToChunk = useCallback((ref: string) => {
    const el = document.getElementById(`chunk-${ref}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashRef(ref);
    setTimeout(() => setFlashRef((cur) => (cur === ref ? null : cur)), 1600);
  }, []);

  // citations grouped by chunk ref (for highlighting sentences in evidence)
  const citationsByRef = useMemo(() => {
    const m: Record<string, CitationEvt[]> = {};
    for (const c of citations) (m[c.ref] ??= []).push(c);
    return m;
  }, [citations]);

  // citations grouped by block id (only those that belong to final round)
  const citationsByBlock = useMemo(() => {
    const m: Record<string, CitationEvt[]> = {};
    if (finalRound == null) return m;
    for (const c of citations) {
      if (c.round !== finalRound) continue;
      (m[c.block_id] ??= []).push(c);
    }
    return m;
  }, [citations, finalRound]);

  const sortedChunkRefs = useMemo(() => {
    const firstCiteNum: Record<string, number> = {};
    for (const c of citations) {
      if (!(c.ref in firstCiteNum)) firstCiteNum[c.ref] = c.num;
    }
    const cited = chunkOrder
      .filter((r) => r in firstCiteNum)
      .sort((a, b) => firstCiteNum[a] - firstCiteNum[b]);
    const uncited = chunkOrder.filter((r) => !(r in firstCiteNum));
    return [...cited, ...uncited];
  }, [chunkOrder, citations]);

  const citationByNum = useMemo(() => {
    const m = new Map<number, CitationEvt>();
    for (const c of citations) m.set(c.num, c);
    return m;
  }, [citations]);

  // active (currently rendering) round state
  const activeRound: RoundState | undefined =
    currentRound != null ? rounds[currentRound] : undefined;
  const isFinalActive = currentRound != null && currentRound === finalRound;

  const reasoningRounds = useMemo(
    () =>
      Object.keys(thinking)
        .map((k) => Number(k))
        .sort((a, b) => a - b)
        .map((r) => ({ round: r, text: thinking[r] })),
    [thinking],
  );

  return (
    <form onSubmit={onSubmit} className="space-y-4">
      <Card className="p-5">
        <FilterBar value={filters} onChange={setFilters} q={q} setQ={setQ} mode="synth" />
      </Card>

      <div className="flex gap-2">
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
          <Button type="button" variant="outline" className="h-10" onClick={stop}>
            Stop
          </Button>
        )}
      </div>

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
                  runQuery(ex);
                }}
                className="text-left text-sm font-serif px-3 py-2 rounded border border-border bg-secondary/40 hover:bg-accent hover:text-accent-foreground hover:border-accent transition-colors max-w-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
              >
                {ex}
              </button>
            ))}
          </div>
        </Card>
      )}

      {submitted && (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5 items-start">
          {/* LEFT: Apparatus (small) + Answer (primary) */}
          <div className="lg:col-span-3 space-y-4 min-w-0">
            {/* Reasoning — capped, scroll-locked, secondary */}
            {reasoningRounds.length > 0 && (
              <Card className="p-0 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setReasoningOpen((x) => !x)}
                  className="w-full px-4 py-2 flex items-center gap-2 text-[11px] uppercase tracking-wider text-muted-foreground hover:bg-secondary/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
                >
                  {reasoningOpen ? (
                    <ChevronDown className="h-3.5 w-3.5" />
                  ) : (
                    <ChevronRight className="h-3.5 w-3.5" />
                  )}
                  <Brain className="h-3.5 w-3.5" /> How the assistant searched
                </button>
                {reasoningOpen && (
                  <div
                    ref={reasoningScrollRef}
                    className="px-4 pb-3 pt-1 border-t border-border max-h-[13rem] overflow-y-auto bg-secondary/20"
                  >
                    {reasoningRounds.map(({ round, text }) => (
                      <div key={round} className="pt-2">
                        <div className="text-[10px] uppercase tracking-wider text-muted-foreground/80">
                          Round {round}
                        </div>
                        <div className="whitespace-pre-wrap font-mono text-[11.5px] leading-[1.55] text-foreground/70">
                          {text}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </Card>
            )}

            {/* Research trace — compact, one line per search */}
            {(searches.length > 0 || notes.length > 0) && (
              <Card className="p-4">
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground mb-2">
                  Research trace
                </div>
                <ol className="space-y-1.5">
                  {searches.map((s, i) => (
                    <li key={i} className="text-xs flex flex-wrap items-center gap-2 leading-snug">
                      <span className="font-mono text-muted-foreground tabular-nums">
                        {String(i + 1).padStart(2, '0')}
                      </span>
                      {s.keywords && (
                        <span className="font-serif italic text-foreground">
                          “{s.keywords}”
                        </span>
                      )}
                      {Object.entries(s.filter ?? {}).map(([k, v]) => (
                        <span
                          key={k}
                          className="px-1.5 py-0.5 rounded border border-border bg-secondary/60 text-[10px]"
                        >
                          {k}: {String(v)}
                        </span>
                      ))}
                      <span className="text-muted-foreground ml-auto tabular-nums">
                        {s.count !== undefined ? `${s.count} passages` : `k=${s.k}`}
                      </span>
                    </li>
                  ))}
                  {notes.map((n) => (
                    <li
                      key={`note-${n.round}`}
                      className="text-[11px] text-muted-foreground/80 italic border-l-2 border-border pl-2 mt-1"
                    >
                      Round {n.round} note: {truncate(n.text, 240)}
                    </li>
                  ))}
                </ol>
              </Card>
            )}

            {/* Answer — primary card */}
            <Card className="p-7 shadow-sm border-accent/20">
              <div className="flex items-baseline justify-between mb-3">
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Answer
                </div>
                {running && (
                  <div className="text-[11px] text-muted-foreground inline-flex items-center gap-1.5">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    {currentRound != null && !isFinalActive
                      ? 'Searching the record…'
                      : 'Streaming…'}
                  </div>
                )}
              </div>
              <div className="max-w-[68ch]">
                <AnswerStream
                  activeRound={activeRound}
                  isFinal={isFinalActive}
                  running={running}
                  submitted={!!submitted}
                  citationsByBlock={citationsByBlock}
                  citationByNum={citationByNum}
                  onCitationClick={scrollToChunk}
                />
              </div>
            </Card>
          </div>

          {/* RIGHT: Evidence column — sticky, self-scrolling on lg */}
          <div className="lg:col-span-2 lg:sticky lg:top-6 lg:max-h-[calc(100vh-7rem)] lg:overflow-y-auto pr-1 space-y-3">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground px-1 sticky top-0 bg-background/95 backdrop-blur py-1 z-10">
              Evidence · {chunkOrder.length} passage{chunkOrder.length === 1 ? '' : 's'}
            </div>
            {sortedChunkRefs.map((ref) => {
              const ch = chunks[ref];
              if (!ch) return null;
              const cites = citationsByRef[ref] ?? [];
              return (
                <EvidenceCard
                  key={ref}
                  chunk={ch}
                  citations={cites}
                  flash={flashRef === ref}
                  cited={cites.length > 0}
                />
              );
            })}
            {chunkOrder.length === 0 && !running && (
              <Card className="p-6 text-sm text-muted-foreground">No passages retrieved.</Card>
            )}
          </div>
        </div>
      )}
    </form>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

// ----- Answer rendering: concatenate blocks + inline citation chips -----

const CITE_SENTINEL_RE = /⟦cite:([\d,]+)⟧/g;

function AnswerStream({
  activeRound,
  isFinal,
  running,
  submitted,
  citationsByBlock,
  citationByNum,
  onCitationClick,
}: {
  activeRound: RoundState | undefined;
  isFinal: boolean;
  running: boolean;
  submitted: boolean;
  citationsByBlock: Record<string, CitationEvt[]>;
  citationByNum: Map<number, CitationEvt>;
  onCitationClick: (ref: string) => void;
}) {
  // Build markdown string. Append sentinels only when round is final.
  const markdown = useMemo(() => {
    if (!activeRound) return '';
    const parts: string[] = [];
    for (const id of activeRound.textOrder) {
      const idx = activeRound.blockIndex[id];
      const blk = activeRound.textBlocks[idx];
      if (!blk) continue;
      parts.push(blk.text);
      if (isFinal) {
        const cites = citationsByBlock[id];
        if (cites && cites.length) {
          const nums = cites.map((c) => c.num).join(',');
          // Insert a sentinel attached to the trailing word of this block
          // (no leading newline so it stays inline).
          parts.push(`\u00A0⟦cite:${nums}⟧`);
        }
      }
    }
    return parts.join('');
  }, [activeRound, isFinal, citationsByBlock]);

  const components: Components = useMemo(() => {
    const transform = (children: ReactNode): ReactNode =>
      transformWithCitations(children, citationByNum, onCitationClick);
    return {
      h1: ({ children }) => (
        <h2 className="font-serif text-xl mt-5 mb-2 font-semibold text-foreground">
          {transform(children)}
        </h2>
      ),
      h2: ({ children }) => (
        <h2 className="font-serif text-lg mt-5 mb-2 font-semibold text-foreground">
          {transform(children)}
        </h2>
      ),
      h3: ({ children }) => (
        <h3 className="font-serif text-[15px] mt-4 mb-1.5 font-semibold uppercase tracking-wide text-foreground/90">
          {transform(children)}
        </h3>
      ),
      h4: ({ children }) => (
        <h4 className="font-serif text-sm mt-3 mb-1 font-semibold text-foreground/90">
          {transform(children)}
        </h4>
      ),
      p: ({ children }) => (
        <p className="font-serif text-[15px] leading-[1.7] my-3 text-foreground">
          {transform(children)}
        </p>
      ),
      ul: ({ children }) => (
        <ul className="my-3 ml-5 list-disc space-y-1.5 font-serif text-[15px] leading-[1.65] text-foreground marker:text-muted-foreground">
          {children}
        </ul>
      ),
      ol: ({ children }) => (
        <ol className="my-3 ml-5 list-decimal space-y-1.5 font-serif text-[15px] leading-[1.65] text-foreground marker:text-muted-foreground">
          {children}
        </ol>
      ),
      li: ({ children }) => <li className="pl-1">{transform(children)}</li>,
      strong: ({ children }) => (
        <strong className="font-semibold text-foreground">{transform(children)}</strong>
      ),
      em: ({ children }) => <em className="italic">{transform(children)}</em>,
      blockquote: ({ children }) => (
        <blockquote className="border-l-2 border-accent/50 pl-3 my-3 italic text-foreground/85">
          {children}
        </blockquote>
      ),
      a: ({ children, href }) => (
        <a
          href={href}
          target="_blank"
          rel="noreferrer"
          className="text-accent underline decoration-accent/40 hover:decoration-accent"
        >
          {transform(children)}
        </a>
      ),
      code: ({ children }) => (
        <code className="font-mono text-[13px] px-1 py-0.5 rounded bg-secondary/70">
          {children}
        </code>
      ),
      hr: () => <hr className="my-4 border-border" />,
    };
  }, [citationByNum, onCitationClick]);

  if (!activeRound && running) {
    return (
      <div className="text-sm text-muted-foreground inline-flex items-center gap-2">
        <Loader2 className="h-4 w-4 animate-spin" />
        Researching the record…
      </div>
    );
  }
  if (!activeRound && !running && submitted) {
    return <div className="text-sm text-muted-foreground">No answer produced.</div>;
  }
  if (!markdown) return null;

  return (
    <div className="answer-prose">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {markdown}
      </ReactMarkdown>
    </div>
  );
}

function CitationChip({
  num,
  cite,
  onClick,
}: {
  num: number;
  cite: CitationEvt | undefined;
  onClick: (ref: string) => void;
}) {
  if (!cite) return null;
  const label = `Citation ${num}: ${cite.order_label ?? cite.title ?? 'source'} page ${cite.page}`;
  return (
    <button
      type="button"
      onClick={() => onClick(cite.ref)}
      title={`${cite.order_label ?? ''} p.${cite.page}`}
      aria-label={label}
      className="inline-flex items-center justify-center min-w-[1.4rem] h-[1.4rem] px-1 mx-0.5 rounded-full text-[10.5px] font-sans font-medium bg-accent text-accent-foreground hover:brightness-110 transition cursor-pointer tabular-nums align-baseline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1"
    >
      {num}
    </button>
  );
}

// Walk react-markdown's children, splitting any text node on the cite sentinel
// and replacing matches with inline citation chips. Recurses into elements so
// citations embedded inside <strong>, <em>, <a>, etc. still render correctly.
function transformWithCitations(
  children: ReactNode,
  citationByNum: Map<number, CitationEvt>,
  onClick: (ref: string) => void,
): ReactNode {
  const out: ReactNode[] = [];
  let keyCounter = 0;
  Children.forEach(children, (child) => {
    if (typeof child === 'string') {
      const parts = splitOnSentinel(child);
      for (const p of parts) {
        if (p.kind === 'text') {
          if (p.value) out.push(p.value);
        } else {
          // chip group
          const group: ReactNode[] = [];
          for (const n of p.nums) {
            group.push(
              <CitationChip
                key={`c-${keyCounter++}`}
                num={n}
                cite={citationByNum.get(n)}
                onClick={onClick}
              />,
            );
          }
          out.push(
            <span key={`g-${keyCounter++}`} className="inline-flex items-center align-baseline">
              {group}
            </span>,
          );
        }
      }
    } else if (isValidElement(child)) {
      const props = child.props as { children?: ReactNode };
      out.push(
        cloneElement(
          child,
          { key: `e-${keyCounter++}` },
          transformWithCitations(props.children, citationByNum, onClick),
        ),
      );
    } else {
      out.push(child);
    }
  });
  return out;
}

function splitOnSentinel(
  s: string,
): Array<{ kind: 'text'; value: string } | { kind: 'cites'; nums: number[] }> {
  const result: Array<{ kind: 'text'; value: string } | { kind: 'cites'; nums: number[] }> = [];
  let last = 0;
  for (const m of s.matchAll(CITE_SENTINEL_RE)) {
    const start = m.index ?? 0;
    if (start > last) result.push({ kind: 'text', value: s.slice(last, start) });
    const nums = m[1]
      .split(',')
      .map((n) => Number(n.trim()))
      .filter((n) => Number.isFinite(n));
    result.push({ kind: 'cites', nums });
    last = start + m[0].length;
  }
  if (last < s.length) result.push({ kind: 'text', value: s.slice(last) });
  return result;
}

// ----- evidence card (synthesis mode) -----

const EvidenceCard = memo(function EvidenceCard({
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
      className={`p-4 transition-all ${cited ? 'border-l-[3px] border-l-accent' : ''} ${
        flash ? 'ring-2 ring-accent shadow-md' : ''
      }`}
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
      {chunk.pdf_url && (
        <div className="mt-3 text-[11px]">
          <a
            href={chunk.pdf_url}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-accent hover:underline"
          >
            <ExternalLink className="h-3 w-3" /> View source PDF
          </a>
        </div>
      )}
    </Card>
  );
});

// ----- browse passages (legacy hybrid) -----

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

function BrowsePanel({
  q,
  setQ,
  filters,
  setFilters,
}: {
  q: string;
  setQ: (s: string) => void;
  filters: Filters;
  setFilters: (f: Filters) => void;
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
        const rows: HybridHit[] = ((data ?? []) as Array<Record<string, unknown>>).map((r) => ({
          id: `${r.document_id}-${r.page_number}`,
          document_id: String(r.document_id),
          order_id: (r.order_id as string | null) ?? null,
          content: String(r.snippet ?? '').replace(/<<|>>/g, ''),
          score: (r.rank as number) ?? 0,
          vec_hit: false,
          lex_hit: true,
          doc_label: (r.doc_label as string | null) ?? null,
          order_type: (r.order_type as string | null) ?? null,
          order_number: null,
          order_date: (r.order_date as string | null) ?? null,
          tags: null,
          section_label: null,
          affects: null,
          has_deadline: false,
          page_start: r.page_number as number,
          page_end: r.page_number as number,
          pdf_url: (r.pdf_url as string | null) ?? null,
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
    <form onSubmit={onSubmit} className="space-y-4">
      <Card className="p-5">
        <FilterBar value={filters} onChange={setFilters} q={q} setQ={setQ} mode="browse" />
      </Card>

      <div className="flex gap-2">
        <Button
          type="submit"
          disabled={search.isPending || !q.trim()}
          className="h-10 px-5 bg-accent text-accent-foreground hover:bg-accent/90"
        >
          {search.isPending ? 'Searching…' : 'Browse passages'}
        </Button>
      </div>

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
    </form>
  );
}
