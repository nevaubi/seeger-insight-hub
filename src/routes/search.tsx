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
  ArrowUp,
  Check,
  PenLine,
  SlidersHorizontal,
  Wrench,
  Command as CommandIcon,
  CornerDownLeft,
  Layers,
  GitBranch,
  Download,
  FileText,
  Printer,
} from 'lucide-react';
import ReactMarkdown, { type Components } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AppShell } from '@/components/app-shell';
import { OrderTypeBadge, fmtDate } from '@/components/case-ui';
import { Card } from '@/components/ui/card';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';

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
  type SearchEvt,
} from '@/lib/useSynthesisStream';
import { useSmoothText } from '@/lib/useSmoothText';
import { buildSynthesisDoc } from '@/lib/synthesis-export';
import { downloadDocx, printDocument, blocksToHtml } from '@/lib/file-export';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from '@/components/ui/dropdown-menu';
import { toast } from 'sonner';

import { useMatter, type Matter } from '@/lib/matter-context';

const FALLBACK_EXAMPLES_SYNTH = [
  'What must plaintiffs do to establish proof of use, and by when?',
  'What are the common-benefit assessment obligations?',
  'What is the Rule 702 / Daubert schedule?',
];
const FALLBACK_EXAMPLES_BROWSE = [
  'threshold proof of use',
  'deposition protocol',
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

const DEFAULT_FILTERS: Filters = {
  orderType: 'Any',
  affects: 'Any',
  hasDeadline: false,
  dateFrom: '',
  dateTo: '',
};

function filtersActive(f: Filters): number {
  let n = 0;
  if (f.orderType !== 'Any') n++;
  if (f.affects !== 'Any') n++;
  if (f.hasDeadline) n++;
  if (f.dateFrom) n++;
  if (f.dateTo) n++;
  return n;
}

// ----- top-level page -----

function AskTheRecord() {
  const [mode, setMode] = useState<'synth' | 'browse'>('synth');
  const [q, setQ] = useState('');
  const [filters, setFilters] = useState<Filters>(DEFAULT_FILTERS);

  return (
    <AppShell>
      <div className="px-6 lg:px-10 pt-6 pb-2 flex items-center gap-1 text-xs">
        <ModeButton active={mode === 'synth'} onClick={() => setMode('synth')}>
          <Brain className="h-3 w-3" /> Ask the record
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
    </AppShell>
  );
}

// Lightweight elapsed-time hook — ticks every 100ms while `running` is true,
// snaps to the final elapsed when stopped. Pure presentation.
function useElapsed(running: boolean, resetKey: unknown): number {
  const [ms, setMs] = useState(0);
  const startRef = useRef<number | null>(null);
  useEffect(() => {
    setMs(0);
    startRef.current = null;
  }, [resetKey]);
  useEffect(() => {
    if (!running) return;
    startRef.current = performance.now();
    const id = window.setInterval(() => {
      if (startRef.current != null) setMs(performance.now() - startRef.current);
    }, 100);
    return () => window.clearInterval(id);
  }, [running]);
  return ms;
}

function fmtElapsed(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
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
      className={`px-3 py-1.5 rounded-full border inline-flex items-center gap-1.5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent transition-[background-color,border-color,color] duration-200 ${
        active
          ? 'bg-accent text-accent-foreground border-accent'
          : 'border-border bg-secondary/60 text-foreground/80 hover:border-accent/60'
      }`}
      style={{ transitionTimingFunction: 'var(--ease-out-soft)' }}
    >
      {children}
    </button>
  );
}

// ----- shared composer (hero or docked) -----

function Composer({
  q,
  setQ,
  onSubmit,
  running,
  onStop,
  variant,
  placeholder,
  filters,
  setFilters,
  filtersOpen,
  setFiltersOpen,
  showFilters = false,
}: {
  q: string;
  setQ: (s: string) => void;
  onSubmit: () => void;
  running?: boolean;
  onStop?: () => void;
  variant: 'hero' | 'docked';
  placeholder: string;
  filters: Filters;
  setFilters: (f: Filters) => void;
  filtersOpen: boolean;
  setFiltersOpen: (v: boolean) => void;
  showFilters?: boolean;
}) {

  const inputRef = useRef<HTMLInputElement | null>(null);
  const activeFilterCount = filtersActive(filters);

  useEffect(() => {
    if (variant === 'hero') inputRef.current?.focus();
  }, [variant]);

  return (
    <div className={variant === 'hero' ? 'w-full max-w-2xl mx-auto' : 'w-full max-w-4xl mx-auto'}>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
        className="relative"
      >
        <div
          className="relative flex items-center bg-card rounded-lg border border-border shadow-[0_1px_2px_rgba(15,30,55,0.04)] focus-within:border-accent focus-within:shadow-[0_0_0_3px_color-mix(in_oklab,var(--accent)_18%,transparent)] transition-shadow"
          style={{ transitionDuration: 'var(--dur-base)', transitionTimingFunction: 'var(--ease-out-soft)' }}
        >
          <SearchIcon className="absolute left-4 h-4 w-4 text-muted-foreground pointer-events-none" />
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={placeholder}
            className="flex-1 bg-transparent pl-11 pr-28 h-[52px] text-[15px] font-serif placeholder:text-muted-foreground/70 placeholder:font-sans placeholder:text-[14px] outline-none rounded-lg"
          />
          <div className="absolute right-2 flex items-center gap-1">
            {running && onStop && (
              <button
                type="button"
                onClick={onStop}
                className="h-9 px-3 text-xs rounded-full text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
              >
                Stop
              </button>
            )}
            <button
              type="submit"
              disabled={!q.trim() || running}
              aria-label="Ask the record"
              className="h-9 w-9 inline-flex items-center justify-center rounded-full bg-accent text-accent-foreground hover:brightness-110 disabled:opacity-40 disabled:hover:brightness-100 transition"
            >
              {running ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ArrowUp className="h-4 w-4" />
              )}
            </button>
          </div>
        </div>

        {showFilters && (
          <>
            <div className="mt-2 flex items-center justify-between px-1">
              <button
                type="button"
                onClick={() => setFiltersOpen(!filtersOpen)}
                className="inline-flex items-center gap-1.5 text-[11px] uppercase tracking-wider text-muted-foreground hover:text-foreground transition-colors"
              >
                {filtersOpen ? (
                  <ChevronDown className="h-3 w-3" />
                ) : (
                  <ChevronRight className="h-3 w-3" />
                )}
                <SlidersHorizontal className="h-3 w-3" /> Filters
                {activeFilterCount > 0 && (
                  <span className="ml-1 inline-flex items-center justify-center min-w-[1.1rem] h-[1.1rem] px-1 rounded-full bg-accent/15 text-accent text-[10px] tabular-nums">
                    {activeFilterCount}
                  </span>
                )}
              </button>
            </div>

            {filtersOpen && (
              <div className="mt-2 motion-fade-rise">
                <FilterControls value={filters} onChange={setFilters} />
              </div>
            )}
          </>
        )}

      </form>
    </div>
  );
}

function FilterControls({ value, onChange }: { value: Filters; onChange: (f: Filters) => void }) {
  const set = <K extends keyof Filters>(k: K, v: Filters[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="flex flex-wrap items-end gap-3 text-xs p-3 rounded-lg border border-border bg-secondary/30">
      <label className="flex flex-col gap-1">
        <span className="uppercase tracking-wider text-muted-foreground text-[10px]">Order type</span>
        <select
          value={value.orderType}
          onChange={(e) => set('orderType', e.target.value)}
          className="h-8 rounded border border-border bg-background px-2 text-foreground"
        >
          {ORDER_TYPES.map((o) => <option key={o}>{o}</option>)}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="uppercase tracking-wider text-muted-foreground text-[10px]">Affects</span>
        <select
          value={value.affects}
          onChange={(e) => set('affects', e.target.value)}
          className="h-8 rounded border border-border bg-background px-2 text-foreground"
        >
          {AFFECTS.map((o) => <option key={o}>{o}</option>)}
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
  const { currentMatter } = useMatter();
  const examplesSynth = currentMatter.config?.examples_synth ?? FALLBACK_EXAMPLES_SYNTH;
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
    writerRound,
    citations,
    chunks,
    chunkOrder,
    expansions,
  } = state;

  const [reasoningOpen, setReasoningOpen] = useState(true);
  const [timelineOpen, setTimelineOpen] = useState(true);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [flashRef, setFlashRef] = useState<string | null>(null);
  const reasoningScrollRef = useRef<HTMLDivElement | null>(null);
  const conversationScrollRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const elapsedMs = useElapsed(running, submitted);

  // Phase derivation for the live status pill
  const phase: 'idle' | 'routing' | 'searching' | 'writing' | 'done' = !submitted
    ? 'idle'
    : !running && finalRound != null
      ? 'done'
      : currentRound != null && (currentRound === finalRound || currentRound === writerRound)
        ? 'writing'
        : searches.length === 0
          ? 'routing'
          : 'searching';

  // collapse timeline once the writer (final round) starts streaming output
  useEffect(() => {
    if (currentRound != null && currentRound === finalRound) {
      setTimelineOpen(false);
      setReasoningOpen(false);
    }
  }, [currentRound, finalRound]);

  // open timeline at start of a new query
  useEffect(() => {
    if (running) {
      setReasoningOpen(true);
      setTimelineOpen(true);
    }
  }, [submitted, running]);


  // auto-scroll reasoning panel as new thinking streams
  useEffect(() => {
    const el = reasoningScrollRef.current;
    if (el && reasoningOpen) el.scrollTop = el.scrollHeight;
  }, [thinking, reasoningOpen]);

  // Track whether conversation is scrolled near the bottom
  const handleConversationScroll = useCallback(() => {
    const el = conversationScrollRef.current;
    if (!el) return;
    nearBottomRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight < 80;
  }, []);

  // On new query: jump to top, re-enable auto-scroll
  useEffect(() => {
    const el = conversationScrollRef.current;
    if (!el || !submitted) return;
    el.scrollTop = 0;
    nearBottomRef.current = true;
  }, [submitted]);

  // Auto-scroll to bottom as content streams (only if user is near bottom)
  useEffect(() => {
    const el = conversationScrollRef.current;
    if (!el || !nearBottomRef.current) return;
    el.scrollTop = el.scrollHeight;
  }, [rounds, citations, searches, chunkOrder, thinking, running]);

  const runQuery = useCallback(
    (query: string) => {
      ask(query, buildFilter(filters), {
        case_id: currentMatter.master_case_id,
        matter: {
          name: currentMatter.name,
          short_name: currentMatter.short_name,
          mdl_number: currentMatter.mdl_number,
          court: currentMatter.court,
          judge: currentMatter.judge,
        },
      });
    },
    [ask, filters, currentMatter],
  );


  const scrollToChunk = useCallback((ref: string) => {
    const el = document.getElementById(`chunk-${ref}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    setFlashRef(ref);
    setTimeout(() => setFlashRef((cur) => (cur === ref ? null : cur)), 1600);
  }, []);

  const citationsByRef = useMemo(() => {
    const m: Record<string, CitationEvt[]> = {};
    for (const c of citations) (m[c.ref] ??= []).push(c);
    return m;
  }, [citations]);

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

  // ----- LAUNCHER STATE -----
  if (!submitted && !running) {
    return (
      <div className="px-6 lg:px-10 pb-10">
        <div className="min-h-[calc(100vh-12rem)] flex flex-col items-center justify-center">
          <div className="w-full max-w-2xl text-center mb-8">
            <h1 className="font-serif text-[40px] leading-[1.1] tracking-[-0.02em] text-foreground">
              Ask the record
            </h1>
            <p className="mt-3 text-sm text-muted-foreground">
              Plain-English questions, grounded in every controlling order on the docket — answered with page-level citations.
            </p>
          </div>

          <div className="relative w-full max-w-2xl">
            <div className="composer-halo" aria-hidden />
            <div className="relative">
              <Composer
                q={q}
                setQ={setQ}
                onSubmit={() => runQuery(q)}
                variant="hero"
                placeholder="Ask the record in plain English…"
                filters={filters}
                setFilters={setFilters}
                filtersOpen={filtersOpen}
                setFiltersOpen={setFiltersOpen}
              />

            </div>
          </div>

          <div className="mt-8 w-full max-w-2xl">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1.5 mb-3">
              <Sparkles className="h-3 w-3" /> Try a question
            </div>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-2">
              {examplesSynth.map((ex: string, i: number) => {
                const Icon = i % 3 === 0 ? Brain : i % 3 === 1 ? PenLine : SearchIcon;
                return (
                  <button
                    key={ex}
                    type="button"
                    onClick={() => {
                      setQ(ex);
                      runQuery(ex);
                    }}
                    className="motion-stream-in group text-left text-[13.5px] font-serif italic px-4 py-3 rounded-xl border border-border bg-card/70 text-foreground/85 hover:border-accent/50 hover:text-foreground hover:-translate-y-px hover:shadow-sm transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent flex items-start gap-2.5"
                    style={{
                      animationDelay: `${i * 60}ms`,
                      transitionDuration: 'var(--dur-fast)',
                      transitionTimingFunction: 'var(--ease-out-soft)',
                    }}
                  >
                    <Icon className="h-3.5 w-3.5 mt-1 shrink-0 text-muted-foreground group-hover:text-accent transition-colors" />
                    <span className="flex-1">{ex}</span>
                    <span className="hidden md:inline-flex items-center gap-0.5 mt-0.5 text-[10px] text-muted-foreground/70 opacity-0 group-hover:opacity-100 transition-opacity font-sans not-italic">
                      <CommandIcon className="h-2.5 w-2.5" />
                      <CornerDownLeft className="h-2.5 w-2.5" />
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          {embedding && (
            <div className="mt-6 text-xs text-muted-foreground inline-flex items-center gap-2">
              <Loader2 className="h-3 w-3 animate-spin" />
              Preparing semantic model (one-time, ~30MB)…
            </div>
          )}
          {error && (
            <div className="mt-6 text-sm text-destructive">{error}</div>
          )}
        </div>
      </div>
    );
  }

  // ----- ACTIVE / RESTING STATE -----
  return (
    <div className="px-6 lg:px-10 pb-4 lg:h-[calc(100vh-3.5rem)] lg:flex lg:gap-6 lg:overflow-hidden">
      {/* LEFT: chat pane (conversation scrolls, composer pinned at bottom) */}
      <div className="lg:flex-[3] min-w-0 flex flex-col lg:h-full min-h-[calc(100vh-3.5rem)] lg:min-h-0">
        <div
          ref={conversationScrollRef}
          onScroll={handleConversationScroll}
          className="flex-1 overflow-y-auto pr-1 pt-4 pb-6"
        >
          <div className="max-w-3xl mx-auto space-y-4">
            {/* Conversation header strip */}
            {submitted && (
              <div className="motion-fade-rise flex items-center gap-2 text-[11px] text-muted-foreground border-b border-border/60 pb-2">
                <span className="inline-flex items-center gap-1.5">
                  <span
                    className={`h-1.5 w-1.5 rounded-full ${
                      phase === 'done'
                        ? 'bg-accent'
                        : phase === 'writing'
                          ? 'bg-accent motion-pulse-soft'
                          : phase === 'searching'
                            ? 'bg-gold motion-pulse-soft'
                            : 'bg-muted-foreground motion-pulse-soft'
                    }`}
                    aria-hidden
                  />
                  <span className="uppercase tracking-wider">
                    {phase === 'routing'
                      ? 'Routing'
                      : phase === 'searching'
                        ? 'Searching the record'
                        : phase === 'writing'
                          ? 'Writing the answer'
                          : 'Research complete'}
                  </span>
                </span>
                <span className="text-border" aria-hidden>·</span>
                <span className="tabular-nums">{currentMatter.short_name}</span>
                <span className="text-border" aria-hidden>·</span>
                <span className="tabular-nums">Gemini router · Claude writer</span>
                <span className="ml-auto tabular-nums">
                  {fmtElapsed(elapsedMs)}
                </span>
              </div>
            )}

            {/* User turn */}
            {submitted && (
              <div className="motion-fade-rise">
                <div className="flex items-start gap-3">
                  <div className="mt-0.5 h-6 px-2 shrink-0 rounded-full border border-border bg-secondary/50 text-foreground/70 inline-flex items-center justify-center text-[10.5px] uppercase tracking-wider">
                    You
                  </div>
                  <div className="font-serif text-[18px] leading-snug text-foreground">
                    {submitted}
                  </div>
                </div>
              </div>
            )}

            {embedding && (
              <div className="text-xs text-muted-foreground inline-flex items-center gap-2">
                <Loader2 className="h-3 w-3 animate-spin" />
                Preparing semantic model…
              </div>
            )}
            {error && (
              <Card className="p-4 text-sm border-destructive/40 bg-destructive/5 text-destructive">
                {error}
              </Card>
            )}

            <RunCard
              running={running}
              searches={searches}
              notes={notes}
              currentRound={currentRound}
              finalRound={finalRound}
              chunkOrder={chunkOrder}
              citations={citations}
              timelineOpen={timelineOpen}
              setTimelineOpen={setTimelineOpen}
              reasoningOpen={reasoningOpen}
              setReasoningOpen={setReasoningOpen}
              reasoningRounds={reasoningRounds}
              reasoningScrollRef={reasoningScrollRef}
              expansions={expansions}
              writerRound={writerRound}
              elapsedMs={elapsedMs}
              phase={phase}
            />

            <Card className="p-7 border-border shadow-none motion-fade-rise">
              <div className="flex items-baseline justify-between mb-3">
                <div className="text-[11px] uppercase tracking-wider text-muted-foreground">
                  Answer
                </div>
                {!running && finalRound != null && rounds[finalRound] && (
                  <AnswerExportMenu
                    question={submitted ?? 'Research memorandum'}
                    round={rounds[finalRound]}
                    citations={citations.filter((c) => c.round === finalRound)}
                    matter={currentMatter}
                  />
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
        </div>

        {/* Bottom-pinned composer */}
        <div className="sticky bottom-0 lg:static border-t border-border/60 bg-background/90 backdrop-blur pt-3 pb-3 z-20">
          <Composer
            q={q}
            setQ={setQ}
            onSubmit={() => runQuery(q)}
            running={running}
            onStop={stop}
            variant="docked"
            placeholder="Ask another question…"
            filters={filters}
            setFilters={setFilters}
            filtersOpen={filtersOpen}
            setFiltersOpen={setFiltersOpen}

          />
        </div>
      </div>

      {/* RIGHT: persistent evidence column */}
      <EvidenceColumn
        chunks={chunks}
        sortedChunkRefs={sortedChunkRefs}
        citationsByRef={citationsByRef}
        chunkOrder={chunkOrder}
        running={running}
        flashRef={flashRef}
      />
    </div>
  );
}

function EvidenceColumn({
  chunks,
  sortedChunkRefs,
  citationsByRef,
  chunkOrder,
  running,
  flashRef,
}: {
  chunks: Record<string, Chunk>;
  sortedChunkRefs: string[];
  citationsByRef: Record<string, CitationEvt[]>;
  chunkOrder: string[];
  running: boolean;
  flashRef: string | null;
}) {
  const [view, setView] = useState<'all' | 'cited' | 'uncited'>('all');

  // Neighbor chunks fold under their parent hit. Group them, and drop them from the
  // top-level list so the evidence column shows real hits, not the expansion context.
  const neighborsByParent = useMemo(() => {
    const m: Record<string, string[]> = {};
    for (const ref of chunkOrder) {
      const ch = chunks[ref];
      if (ch?.neighbor && ch.parent_ref && chunks[ch.parent_ref]) {
        (m[ch.parent_ref] ??= []).push(ref);
      }
    }
    return m;
  }, [chunks, chunkOrder]);

  const primaryRefs = useMemo(
    () =>
      sortedChunkRefs.filter((r) => {
        const ch = chunks[r];
        if (!ch) return false;
        // fold a neighbor away only if its parent is actually present as a card
        return !(ch.neighbor && ch.parent_ref && chunks[ch.parent_ref]);
      }),
    [sortedChunkRefs, chunks],
  );
  const neighborCount = chunkOrder.length - primaryRefs.length;

  // A primary counts as "cited" if it OR any of its folded neighbors is cited.
  const refCited = (ref: string) =>
    (citationsByRef[ref]?.length ?? 0) > 0 ||
    (neighborsByParent[ref] ?? []).some((nr) => (citationsByRef[nr]?.length ?? 0) > 0);

  const citedCount = primaryRefs.filter(refCited).length;
  const visible = primaryRefs.filter((r) => {
    if (view === 'cited') return refCited(r);
    if (view === 'uncited') return !refCited(r);
    return true;
  });

  return (
    <div className="lg:flex-[2] lg:h-full flex flex-col min-w-0 overflow-hidden">
      <div className="shrink-0 py-3 border-b border-border bg-background z-10 mb-4 px-1 flex items-center justify-between gap-2">
        <div className="text-[11px] uppercase tracking-wider text-muted-foreground font-semibold">
          Evidence · {primaryRefs.length} passage{primaryRefs.length === 1 ? '' : 's'}
          {neighborCount > 0 && (
            <span className="text-muted-foreground/60 font-normal"> · +{neighborCount} context</span>
          )}
        </div>
        <div className="inline-flex items-center rounded-md border border-border bg-secondary/40 p-0.5 text-[10.5px]">
          {(['all', 'cited', 'uncited'] as const).map((v) => (
            <button
              key={v}
              type="button"
              onClick={() => setView(v)}
              className={`px-2 py-0.5 rounded transition-colors capitalize ${
                view === v
                  ? 'bg-card text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {v}
              {v === 'cited' && citedCount > 0 && (
                <span className="ml-1 tabular-nums opacity-70">{citedCount}</span>
              )}
            </button>
          ))}
        </div>
      </div>
      <div className="flex-1 overflow-y-auto pr-1 space-y-3 pb-6">
        {visible.map((ref) => {
          const ch = chunks[ref];
          if (!ch) return null;
          const cites = citationsByRef[ref] ?? [];
          const neighbors = (neighborsByParent[ref] ?? [])
            .map((nr) => ({ chunk: chunks[nr], citations: citationsByRef[nr] ?? [] }))
            .filter((n): n is { chunk: Chunk; citations: CitationEvt[] } => !!n.chunk);
          return (
            <EvidenceCard
              key={ref}
              chunk={ch}
              citations={cites}
              neighbors={neighbors}
              flash={flashRef === ref}
              flashRef={flashRef}
              cited={cites.length > 0 || neighbors.some((n) => n.citations.length > 0)}
            />
          );
        })}
        {chunkOrder.length === 0 && running && (
          <div className="space-y-3">
            {[0, 1, 2].map((i) => (
              <Card key={i} className="p-4">
                <div className="motion-shimmer h-3 w-1/3 rounded mb-3" />
                <div className="motion-shimmer h-2 w-full rounded mb-2" />
                <div className="motion-shimmer h-2 w-11/12 rounded mb-2" />
                <div className="motion-shimmer h-2 w-4/5 rounded" />
              </Card>
            ))}
          </div>
        )}
        {chunkOrder.length === 0 && !running && (
          <Card className="p-6 text-sm text-muted-foreground">No passages retrieved.</Card>
        )}
        {chunkOrder.length > 0 && visible.length === 0 && (
          <Card className="p-4 text-xs text-muted-foreground">
            No passages match this filter.
          </Card>
        )}
      </div>
    </div>
  );
}


// ----- run card with step timeline -----

function RunCard({
  running,
  searches,
  notes,
  currentRound,
  finalRound,
  chunkOrder,
  citations,
  timelineOpen,
  setTimelineOpen,
  reasoningOpen,
  setReasoningOpen,
  reasoningRounds,
  reasoningScrollRef,
  expansions,
  writerRound,
  elapsedMs,
  phase,
}: {
  running: boolean;
  searches: SearchEvt[];
  notes: { round: number; text: string }[];
  currentRound: number | null;
  finalRound: number | null;
  chunkOrder: string[];
  citations: CitationEvt[];
  timelineOpen: boolean;
  setTimelineOpen: (v: boolean) => void;
  reasoningOpen: boolean;
  setReasoningOpen: (v: boolean) => void;
  reasoningRounds: { round: number; text: string }[];
  reasoningScrollRef: React.MutableRefObject<HTMLDivElement | null>;
  expansions: Record<number, number>;
  writerRound: number | null;
  elapsedMs: number;
  phase: 'idle' | 'routing' | 'searching' | 'writing' | 'done';
}) {
  const done = !running && finalRound != null;
  void done;
  const writerActive = currentRound != null && currentRound === finalRound && running;
  const writerDone = finalRound != null && !running;
  void reasoningOpen;
  void setReasoningOpen;

  // Tool notes come from `tool` SSE frames: structured lookups (list_orders / lookup_counsel /
  // list_deadlines) and read_order are retrievals; everything else is stray interim reasoning.
  const TOOL_PREFIXES = ['Listed ', 'Found ', 'Read ', 'list_orders', 'lookup_counsel', 'list_deadlines'];
  const isToolNote = (t: string) =>
    TOOL_PREFIXES.some((p) => t.startsWith(p)) || / lookup error:/.test(t);
  const toolNotes = useMemo(() => notes.filter((n) => isToolNote(n.text)), [notes]);
  const interimNotes = useMemo(() => notes.filter((n) => !isToolNote(n.text)), [notes]);

  // The trace is grouped BY ROUND: each round leads with the router's streaming reasoning,
  // then the retrievals it drove (full-order reads, searches, neighbor expansion). The writer
  // is appended last; research rounds exclude the writer's final round.
  const researchRounds = useMemo(() => {
    const set = new Set<number>();
    searches.forEach((s) => set.add(s.round));
    toolNotes.forEach((n) => set.add(n.round));
    interimNotes.forEach((n) => set.add(n.round));
    reasoningRounds.forEach(({ round }) => set.add(round));
    Object.keys(expansions).forEach((k) => set.add(Number(k)));
    if (currentRound != null && currentRound !== writerRound && !writerActive) set.add(currentRound);
    // The writer's round (which carries its extended thinking) is rendered as the final step,
    // not as a research round.
    return [...set].filter((r) => r !== finalRound && r !== writerRound).sort((a, b) => a - b);
  }, [searches, toolNotes, interimNotes, reasoningRounds, expansions, currentRound, writerActive, finalRound, writerRound]);

  // The writer's extended-thinking text (streams before the answer, then stays available).
  const writerReasoning = writerRound != null
    ? (reasoningRounds.find((t) => t.round === writerRound)?.text ?? '').trim()
    : '';

  // The single live search = the last one emitted, while still retrieving.
  const lastSearch = searches[searches.length - 1];
  // The writer is "active" once its round is current (covers extended thinking, which streams
  // before the answer text) — finalRound is only set once the answer finishes.
  const writerActiveNow = running && writerRound != null && currentRound === writerRound;
  const writerStatus: 'pending' | 'active' | 'done' = writerDone ? 'done' : (writerActive || writerActiveNow) ? 'active' : 'pending';

  // Smoothly collapse/expand using a grid-rows trick (animates intrinsic height).
  return (
    <div
      className="grid transition-[grid-template-rows,opacity] duration-500 ease-out"
      style={{
        gridTemplateRows: timelineOpen ? '1fr' : '0fr',
        opacity: timelineOpen ? 1 : 0,
      }}
      aria-hidden={!timelineOpen}
    >
      <div className="overflow-hidden" ref={reasoningScrollRef}>
        <ol className="relative pl-5 py-1">
          <div
            className="absolute left-[7px] top-3 bottom-3 w-px bg-gradient-to-b from-border via-border to-transparent"
            aria-hidden
          />
          {researchRounds.map((r, ri) => {
            const reasoning = (reasoningRounds.find((t) => t.round === r)?.text ?? '').trim();
            const rTools = toolNotes.filter((n) => n.round === r);
            const rSearches = searches.filter((s) => s.round === r);
            const rInterim = interimNotes.filter((n) => n.round === r);
            const exp = expansions[r] ?? 0;
            const reasoningStreaming = running && currentRound === r && !writerActive;
            const roundActive = reasoningStreaming || (running && !writerActive && lastSearch?.round === r);
            const hasSteps = rTools.length > 0 || rSearches.length > 0 || rInterim.length > 0 || exp > 0;
            return (
              <li
                key={`round-${r}`}
                className="relative py-2 motion-stream-in"
                style={{ animationDelay: `${Math.min(ri, 8) * 35}ms` }}
              >
                <span
                  className={`absolute -left-[14px] top-[12px] h-2 w-2 rounded-full ring-2 ring-background transition-colors ${
                    roundActive ? 'bg-accent motion-pulse-soft' : 'bg-accent'
                  }`}
                  aria-hidden
                />
                <RoundReasoning round={r} text={reasoning} streaming={reasoningStreaming} />
                {hasSteps && (
                  <div className="mt-2 space-y-2">
                    {rTools.map((n, i) => (
                      <ToolStepRow key={`tool-${r}-${i}`} text={n.text} />
                    ))}
                    {rSearches.map((s, i) => (
                      <SearchStepRow
                        key={`search-${r}-${i}`}
                        search={s}
                        status={running && !writerActive && s === lastSearch ? 'active' : 'done'}
                      />
                    ))}
                    {exp > 0 && <ExpandRow count={exp} />}
                    {rInterim.map((n, i) => (
                      <InterimNoteRow key={`interim-${r}-${i}`} text={n.text} />
                    ))}
                  </div>
                )}
              </li>
            );
          })}
          <li className="relative py-2">
            <span
              className={`absolute -left-[14px] top-[12px] h-2 w-2 rounded-full ring-2 ring-background transition-colors ${
                writerStatus === 'active'
                  ? 'bg-accent motion-pulse-soft'
                  : writerStatus === 'done'
                    ? 'bg-accent'
                    : 'bg-muted-foreground/30'
              }`}
              aria-hidden
            />
            <WriterStepRow status={writerStatus} citations={citations.length} />
            {writerReasoning && (
              <WriterReasoning text={writerReasoning} streaming={writerActiveNow} />
            )}
          </li>
        </ol>
      </div>
    </div>
  );
}


// The router's streamed rationale for a round — shown inline and in full (it is only a
// sentence or three now), with a live caret while it streams, so the reasoning sits directly
// above the retrievals it drove rather than collapsed behind a toggle.
function RoundReasoning({
  round,
  text,
  streaming,
}: {
  round: number;
  text: string;
  streaming: boolean;
}) {
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-1">
        <Brain className="h-3 w-3" />
        <span>Reasoning · round {round}</span>
      </div>
      {text ? (
        <div className="font-serif text-[13.5px] leading-[1.6] text-foreground/80">
          {text}
          {streaming && <span className="motion-stream-caret" aria-hidden />}
        </div>
      ) : streaming ? (
        <div className="inline-flex items-center gap-2 text-[13px] text-muted-foreground/70 italic">
          <span className="inline-block h-1 w-16 rounded motion-shimmer" />
          planning retrieval…
        </div>
      ) : null}
    </div>
  );
}

// The Opus writer's extended-thinking stream, shown under the final "Write" step. It can be
// long, so it's collapsible and scroll-capped; it streams live while the writer reasons,
// then rides the trace's auto-collapse once the answer is done.
function WriterReasoning({ text, streaming }: { text: string; streaming: boolean }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="mt-2">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="group flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground/70 hover:text-foreground transition-colors"
      >
        <Brain className="h-3 w-3" />
        <span>Writer reasoning</span>
        {streaming && <span className="normal-case tracking-normal text-accent/80">· thinking</span>}
        {open ? (
          <ChevronDown className="h-3 w-3 opacity-60 group-hover:opacity-100" />
        ) : (
          <ChevronRight className="h-3 w-3 opacity-60 group-hover:opacity-100" />
        )}
      </button>
      {open && (
        <div className="mt-1 max-h-56 overflow-y-auto whitespace-pre-wrap font-mono text-[11px] leading-[1.55] text-foreground/65 pr-1">
          {text}
          {streaming && <span className="motion-stream-caret" aria-hidden />}
        </div>
      )}
    </div>
  );
}

// Shared layout for a retrieval step: a small kind label + icon, the body, and an optional
// right-aligned meta (count / progress). Keeps searches, reads, and tools visually aligned.
function StepShell({
  icon,
  kind,
  children,
  meta,
}: {
  icon: ReactNode;
  kind: string;
  children: ReactNode;
  meta?: ReactNode;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground/70 mb-0.5 inline-flex items-center gap-1">
          {icon} {kind}
        </div>
        {children}
      </div>
      {meta != null && (
        <div className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap pt-0.5">
          {meta}
        </div>
      )}
    </div>
  );
}


function ToolStepRow({ text }: { text: string }) {
  // read_order IS a retrieval (it returns citable passages); structured lookups are not.
  const isRead = text.startsWith('Read ');
  return (
    <StepShell
      icon={isRead ? <Layers className="h-3 w-3" /> : <Wrench className="h-3 w-3" />}
      kind={isRead ? 'Read full text' : 'Record index'}
      meta={isRead ? undefined : <span className="italic text-muted-foreground/60">no vector search</span>}
    >
      <div className="font-serif italic text-[13.5px] text-foreground/90">{text}</div>
    </StepShell>
  );
}


function SearchStepRow({
  search,
  status,
}: {
  search: SearchEvt;
  status: 'active' | 'done';
}) {
  const label = search.keywords ? `“${search.keywords}”` : 'Semantic search of the record';
  const filterEntries = Object.entries(search.filter ?? {});
  return (
    <StepShell
      icon={<SearchIcon className="h-3 w-3" />}
      kind="Search"
      meta={
        search.count === undefined ? (
          status === 'active' ? (
            <span className="inline-block h-1 w-12 rounded motion-shimmer" />
          ) : (
            `k=${search.k}`
          )
        ) : search.count === 0 ? (
          <span className="italic text-muted-foreground/70">no matches</span>
        ) : (
          `${search.count}/${search.k} chunks`
        )
      }
    >
      <div className="font-serif italic text-[13.5px] text-foreground/90">{label}</div>
      {filterEntries.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {filterEntries.map(([k, v]) => (
            <span
              key={k}
              className="px-1.5 py-0.5 rounded border border-border bg-secondary/50 text-[10px] text-muted-foreground"
            >
              {k}: {String(v)}
            </span>
          ))}
        </div>
      )}
    </StepShell>
  );
}

// Neighbor/sibling expansion line — shows the adjacent passages auto-pulled for context.
function ExpandRow({ count }: { count: number }) {
  return (
    <div className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground/80">
      <GitBranch className="h-3 w-3 text-accent/70" />
      <span>
        +{count} adjacent passage{count === 1 ? '' : 's'} pulled for surrounding context
      </span>
    </div>
  );
}

// Stray interim narration from a tool_use round body (rare).
function InterimNoteRow({ text }: { text: string }) {
  return <div className="font-serif italic text-[13px] text-foreground/70 leading-relaxed">{text}</div>;
}

function WriterStepRow({
  status,
  citations,
}: {
  status: 'pending' | 'active' | 'done';
  citations: number;
}) {
  return (
    <div className="flex items-start gap-3">
      <div className="flex-1 min-w-0">
        <div className="text-[10px] uppercase tracking-wider text-muted-foreground/80 mb-0.5">
          Final · Write
        </div>
        <div className="font-serif italic text-[14px] text-foreground/90 inline-flex items-center gap-1.5">
          <PenLine className="h-3.5 w-3.5 text-muted-foreground" />
          {status === 'done'
            ? 'Answer complete'
            : status === 'active'
            ? 'Writing the answer'
            : 'Writing the answer'}
        </div>
      </div>
      <div className="text-[11px] text-muted-foreground tabular-nums whitespace-nowrap pt-0.5">
        {status === 'done' && `${citations} citation${citations === 1 ? '' : 's'}`}
        {status === 'active' && (
          <span className="inline-block h-1 w-12 rounded motion-shimmer" />
        )}
      </div>
    </div>
  );
}

function truncate(s: string, n: number) {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s;
}

// ----- Answer rendering -----

const CITE_SENTINEL_RE = /⟦cite:([\d,]+)⟧/g;

function AnswerExportMenu({
  question,
  round,
  citations,
  matter,
}: {
  question: string;
  round: RoundState;
  citations: CitationEvt[];
  matter: Matter;
}) {
  const exportMatter = {
    name: matter.name,
    short_name: matter.short_name,
    mdl_number: matter.mdl_number,
    court: matter.court,
    judge: matter.judge,
  };

  const doc = () => buildSynthesisDoc({ question, round, citations, matter: exportMatter });

  const doDocx = () => {
    const d = doc();
    downloadDocx(`${matter.short_name}-${question}`.slice(0, 80), d.blocks);
    toast.success('Exported answer to Word (.docx)');
  };
  const doPrint = () => {
    const d = doc();
    const ok = printDocument({
      title: question,
      metaLine: `<span class="matter">${matter.short_name}</span> · MDL ${matter.mdl_number} · ${matter.court} · ${matter.judge}`,
      // Keep the title heading; drop the italic meta paragraph + its rule (index 1,2)
      // since the print template renders the matter line in its own header.
      bodyHtml: blocksToHtml([d.blocks[0], ...d.blocks.slice(3)]),
    });
    if (!ok) toast.error('Allow pop-ups to print / save as PDF');
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button variant="outline" size="sm" className="gap-2 font-sans h-7 text-xs">
          <Download className="h-3.5 w-3.5" />
          Export
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-52">
        <DropdownMenuItem onClick={doDocx} className="gap-2 cursor-pointer">
          <FileText className="h-4 w-4 text-[hsl(215_60%_40%)]" />
          Word document (.docx)
        </DropdownMenuItem>
        <DropdownMenuItem onClick={doPrint} className="gap-2 cursor-pointer">
          <Printer className="h-4 w-4 text-muted-foreground" />
          Print / Save as PDF
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

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
  const fullMarkdown = useMemo(() => {
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
          parts.push(`\u00A0⟦cite:${nums}⟧`);
        }
      }
    }
    return parts.join('');
  }, [activeRound, isFinal, citationsByBlock]);

  // Smooth-stream the raw markdown (sentinels pass through untouched).
  const smoothMarkdown = useSmoothText(fullMarkdown, running && isFinal, 550);
  const markdown = running && isFinal ? smoothMarkdown : fullMarkdown;

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
      <div className="space-y-2">
        <div className="motion-shimmer h-3 w-11/12 rounded" />
        <div className="motion-shimmer h-3 w-10/12 rounded" />
        <div className="motion-shimmer h-3 w-9/12 rounded" />
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
      {running && isFinal && <span className="motion-stream-caret" aria-hidden />}
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

// ----- evidence card -----

const EvidenceCard = memo(function EvidenceCard({
  chunk,
  citations,
  neighbors = [],
  flash,
  flashRef,
  cited,
}: {
  chunk: Chunk;
  citations: CitationEvt[];
  neighbors?: { chunk: Chunk; citations: CitationEvt[] }[];
  flash: boolean;
  flashRef?: string | null;
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

  const citeNums = useMemo(() => Array.from(new Set(citations.map((c) => c.num))).sort((a, b) => a - b), [citations]);

  return (
    <Card
      id={`chunk-${chunk.ref}`}
      className={`relative p-4 motion-fade-rise transition-shadow ${
        cited ? 'border-l-[3px] border-l-accent' : ''
      } ${flash ? 'motion-ring-pulse' : ''}`}
      style={{ transitionDuration: 'var(--dur-base)' }}
    >
      {citeNums.length > 0 && (
        <div className="absolute -top-2 -right-2 inline-flex items-center gap-0.5 px-1.5 h-5 rounded-full bg-accent text-accent-foreground text-[10px] font-medium font-sans tabular-nums shadow-sm">
          {citeNums.slice(0, 3).map((n, i) => (
            <span key={n}>
              {i > 0 && <span className="opacity-60 mx-0.5">·</span>}
              #{n}
            </span>
          ))}
          {citeNums.length > 3 && <span className="opacity-70 ml-0.5">+{citeNums.length - 3}</span>}
        </div>
      )}
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
        {chunk.neighbor && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-accent/30 bg-accent/10 text-[10px] text-accent/90">
            <GitBranch className="h-2.5 w-2.5" /> context
          </span>
        )}
        {chunk.full_order && (
          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full border border-border bg-secondary/60 text-[10px] text-muted-foreground">
            <Layers className="h-2.5 w-2.5" /> full text
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
      {neighbors.length > 0 && (
        <div className="mt-3 pt-3 border-t border-border/50">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground/60 mb-2 inline-flex items-center gap-1">
            <GitBranch className="h-2.5 w-2.5" /> Surrounding context · {neighbors.length}
          </div>
          <div className="space-y-2 pl-2.5 border-l border-border/40">
            {neighbors.map(({ chunk: n, citations: nc }) => (
              <NeighborPassage key={n.ref} chunk={n} citations={nc} flash={flashRef === n.ref} />
            ))}
          </div>
        </div>
      )}
    </Card>
  );
});

// A folded neighbor passage shown under its parent evidence card — muted when uncited,
// highlighted (with cite badges) when the writer cited it. Carries its own chunk id so a
// citation click can still scroll to it.
function NeighborPassage({
  chunk,
  citations,
  flash,
}: {
  chunk: Chunk;
  citations: CitationEvt[];
  flash: boolean;
}) {
  const page =
    chunk.page_start === chunk.page_end
      ? `p.${chunk.page_start}`
      : `p.${chunk.page_start}–${chunk.page_end}`;
  const cited = citations.length > 0;
  const sentCites = useMemo(() => {
    const m: Record<number, number[]> = {};
    for (const c of citations) for (let i = c.sentence_start; i < c.sentence_end; i++) (m[i] ??= []).push(c.num);
    return m;
  }, [citations]);
  return (
    <div
      id={`chunk-${chunk.ref}`}
      className={`text-[12.5px] leading-relaxed ${cited ? 'text-foreground/85' : 'text-foreground/55'} ${flash ? 'motion-ring-pulse rounded px-1' : ''}`}
    >
      <span className="text-[10px] text-muted-foreground/55 tabular-nums mr-1.5 align-baseline">{page}</span>
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
                    className="inline-flex items-center justify-center min-w-[1rem] h-[1rem] px-1 rounded-full text-[9px] font-sans font-medium bg-accent text-accent-foreground tabular-nums"
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
  );
}

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
  const { currentMatter } = useMatter();
  const examplesBrowse = currentMatter.config?.examples_browse ?? FALLBACK_EXAMPLES_BROWSE;
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [embedding, setEmbedding] = useState(false);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [filtersOpen, setFiltersOpen] = useState(false);

  const search = useMutation<{ rows: HybridHit[]; notice?: string }, Error, string>({
    mutationFn: async (query) => {
      const filter = { ...buildFilter(filters), case_id: currentMatter.master_case_id };
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

  // Launcher state for browse
  if (!submitted) {
    return (
      <div className="px-6 lg:px-10 pb-10">
        <div className="min-h-[calc(100vh-12rem)] flex flex-col items-center justify-center">
          <div className="w-full max-w-2xl text-center mb-8">
            <h1 className="font-serif text-[40px] leading-[1.1] tracking-[-0.02em] text-foreground">
              Browse the record
            </h1>
            <p className="mt-3 text-sm text-muted-foreground">
              Keyword and semantic search across every page of every controlling order.
            </p>
          </div>
          <Composer
            q={q}
            setQ={setQ}
            onSubmit={() => run(q)}
            variant="hero"
            placeholder="Search the record (keywords or natural language)…"
            filters={filters}
            setFilters={setFilters}
            filtersOpen={filtersOpen}
            setFiltersOpen={setFiltersOpen}
            showFilters
          />
          <div className="mt-8 w-full max-w-2xl">
            <div className="text-[11px] uppercase tracking-wider text-muted-foreground inline-flex items-center gap-1.5 mb-3">
              <Sparkles className="h-3 w-3" /> Try
            </div>
            <div className="flex flex-wrap gap-2">
              {examplesBrowse.map((ex: string) => (
                <button
                  key={ex}
                  type="button"
                  onClick={() => run(ex)}
                  className="motion-fade-rise text-xs px-3 py-1.5 rounded-full border border-border bg-card/60 text-foreground/80 hover:border-accent/60 hover:text-foreground transition-colors"
                >
                  {ex}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="px-6 lg:px-10 pb-4 lg:h-[calc(100vh-3.5rem)] flex flex-col min-h-[calc(100vh-3.5rem)]">
      <div className="flex-1 overflow-y-auto pr-1 pt-6 pb-6">
        <div className="max-w-3xl mx-auto">
          {search.isPending && embedding && (
            <Card className="p-4 flex items-center gap-2 text-sm text-muted-foreground mb-3">
              <Loader2 className="h-4 w-4 animate-spin" />
              Preparing semantic model (one-time, ~30MB)…
            </Card>
          )}

          {search.isError && (
            <Card className="p-4 text-sm text-destructive mb-3">
              Search failed: {(search.error as Error).message}
            </Card>
          )}

          {search.data?.notice && (
            <div className="text-xs text-muted-foreground italic mb-2">{search.data.notice}</div>
          )}

          {submitted && !search.isPending && search.data && (
            <div className="text-xs text-muted-foreground mb-3">
              {search.data.rows.length} passage{search.data.rows.length === 1 ? '' : 's'} for{' '}
              <span className="font-serif italic text-foreground">"{submitted}"</span>
            </div>
          )}

          {search.isPending && (
            <div className="space-y-3">
              {[0, 1, 2].map((i) => (
                <Card key={i} className="p-4">
                  <div className="motion-shimmer h-3 w-1/3 rounded mb-3" />
                  <div className="motion-shimmer h-2 w-full rounded mb-2" />
                  <div className="motion-shimmer h-2 w-11/12 rounded mb-2" />
                  <div className="motion-shimmer h-2 w-9/12 rounded" />
                </Card>
              ))}
            </div>
          )}

          <div className="space-y-3">
            {search.data?.rows.map((h) => {
              const isExpanded = expanded[h.id];
              const pageCite =
                h.page_start === h.page_end ? `p.${h.page_start}` : `p.${h.page_start}–${h.page_end}`;
              return (
                <Card key={h.id} className="p-4 motion-fade-rise">
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
      </div>

      {/* Bottom-pinned composer */}
      <div className="sticky bottom-0 lg:static border-t border-border/60 bg-background/90 backdrop-blur pt-3 pb-3 z-20">
        <Composer
          q={q}
          setQ={setQ}
          onSubmit={() => run(q)}
          running={search.isPending}
          variant="docked"
          placeholder="Search the record…"
          filters={filters}
          setFilters={setFilters}
          filtersOpen={filtersOpen}
          setFiltersOpen={setFiltersOpen}
            showFilters
        />
      </div>
    </div>
  );
}

