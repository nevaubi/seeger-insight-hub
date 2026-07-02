import { useCallback, useEffect, useReducer, useRef } from 'react';
import { embedQuery, modelReady } from '@/lib/embed';

// ---- Public types ---------------------------------------------------------

export type Chunk = {
  ref: string;
  order_label?: string | null;
  doc_label?: string | null;
  order_type?: string | null;
  order_number?: string | null;
  order_date?: string | null;
  page_start: number | null;
  page_end: number | null;
  section_label?: string | null;
  affects?: string | null;
  has_deadline?: boolean;
  tags?: string[] | null;
  pdf_url?: string | null;
  score?: number;
  vec_hit?: boolean;
  lex_hit?: boolean;
  // Provenance: neighbor = pulled as adjacent context around a hit; full_order = pulled by
  // read_order (a full order / amendment chain) rather than by semantic search.
  neighbor?: boolean;
  full_order?: boolean;
  parent_ref?: string | null; // for neighbor chunks: the hit they were expanded around
  // External case-law authority (kind: 'caselaw') retrieved via CourtListener. These carry a
  // case citation instead of an order/page, and pdf_url points to courtlistener.com.
  kind?: 'caselaw' | null;
  case_name?: string | null;
  full_citation?: string | null;
  reporter_cite?: string | null;
  court?: string | null;
  case_date?: string | null;
  cite_count?: number | null;
  status?: string | null;
  docket_number?: string | null;
  excerpted?: boolean;
  sentences: string[];
};

export type SearchEvt = {
  round: number;
  keywords: string | null;
  filter: Record<string, unknown>;
  k: number;
  count?: number;
  startedAt?: number;
  endedAt?: number;
};

export type RoundState = {
  round: number;
  textBlocks: { id: string; text: string }[];
  textOrder: string[];
  blockIndex: Record<string, number>;
  stop_reason?: 'tool_use' | 'end_turn';
  startedAt?: number;
  endedAt?: number;
};

export type CitationEvt = {
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
  num: number;
};

export type RoundNote = { round: number; text: string; startedAt?: number; endedAt?: number };

// ---- Planner / verifier / web (v30 additive) -----------------------------

export type PlanFacet = {
  id: string;
  question: string;
  hypothesis: string;
  specialists: string[];
  keywords?: string[];
  court?: string | null;
};

export type PlanEvt = { rationale: string; facets: PlanFacet[] };

export type WebResult = { round: number; title?: string | null; url?: string | null; published?: string | null };

export type VerifyEvt = { unsupported: number; notes: string; model?: string };

// ---- Discriminated SSE event union ---------------------------------------

type SseRound = { type: 'round'; round: number; writer?: boolean };
type SseThinking = { type: 'thinking'; round: number; text: string };
type SseSearch = {
  type: 'search';
  round: number;
  keywords: string | null;
  filter?: Record<string, unknown>;
  k: number;
};
type SseChunks = { type: 'chunks'; round: number; chunks: Chunk[] };
type SseText = { type: 'text'; round: number; block_id: string; text: string };
type SseCitation = {
  type: 'citation';
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
};
type SseRoundEnd = {
  type: 'round_end';
  round: number;
  stop_reason: 'tool_use' | 'end_turn';
};
type SseSearchError = { type: 'search_error'; round: number; message: string };
// Structured router tools (list_orders / lookup_counsel / list_deadlines).
// The edge function emits a start frame ({ tool, args }) followed by a done
// frame ({ tool, count, done: true }) for each structured-tool call, and a
// tool_error frame if the underlying RPC fails (non-fatal: the router/writer
// continue with whatever else was gathered).
type SseTool = {
  type: 'tool';
  round: number;
  tool: string;
  args?: Record<string, unknown>;
  count?: number;
  done?: boolean;
};
type SseToolError = {
  type: 'tool_error';
  round: number;
  tool: string;
  message: string;
};
// Neighbor/sibling expansion: the edge function pulled `count` adjacent passages around the
// round's best hits for surrounding context. Aggregated per round in the UI.
type SseExpand = { type: 'expand'; round: number; source: string; count: number };
type SseError = { type: 'error'; message: string };
type SseDone = { type: 'done' };

export type SynthEvent =
  | SseRound
  | SseThinking
  | SseSearch
  | SseChunks
  | SseText
  | SseCitation
  | SseRoundEnd
  | SseSearchError
  | SseTool
  | SseToolError
  | SseExpand
  | SseError
  | SseDone;

// ---- Reducer state --------------------------------------------------------

export type SynthState = {
  running: boolean;
  embedding: boolean;
  error: string | null;
  submitted: string | null;
  searches: SearchEvt[];
  notes: RoundNote[]; // interim narration from tool_use rounds + structured-tool results
  thinking: Record<number, string>;
  rounds: Record<number, RoundState>;
  currentRound: number | null;
  finalRound: number | null;
  writerRound: number | null; // the round the Opus writer runs in (carries its extended thinking)
  citations: CitationEvt[];
  chunks: Record<string, Chunk>;
  chunkOrder: string[];
  expansions: Record<number, number>; // round -> count of adjacent passages auto-pulled
};

const INITIAL: SynthState = {
  running: false,
  embedding: false,
  error: null,
  submitted: null,
  searches: [],
  notes: [],
  thinking: {},
  rounds: {},
  currentRound: null,
  finalRound: null,
  writerRound: null,
  citations: [],
  chunks: {},
  chunkOrder: [],
  expansions: {},
};

type Action =
  | { kind: 'reset'; q: string }
  | { kind: 'embedding'; on: boolean }
  | { kind: 'error'; msg: string }
  | { kind: 'running'; on: boolean }
  | { kind: 'sse'; evt: SynthEvent; nextCitationNum: () => number };

function ensureRound(rounds: Record<number, RoundState>, round: number): RoundState {
  return (
    rounds[round] ?? {
      round,
      textBlocks: [],
      textOrder: [],
      blockIndex: {},
    }
  );
}

// Human-readable summary of a completed structured-tool call, shown in the
// research trace as a round note.
function describeTool(tool: string, count: number): string {
  switch (tool) {
    case 'list_orders':
      return `Listed ${count} controlling order${count === 1 ? '' : 's'}`;
    case 'lookup_counsel':
      return `Found ${count} counsel record${count === 1 ? '' : 's'}`;
    case 'list_deadlines':
      return `Listed ${count} key date${count === 1 ? '' : 's'}`;
    case 'read_order':
      return `Read ${count} passage${count === 1 ? '' : 's'} of full order text`;
    case 'search_caselaw':
      return `Searched case law — ${count} opinion${count === 1 ? '' : 's'}`;
    default:
      return `${tool} returned ${count} result${count === 1 ? '' : 's'}`;
  }
}

function reducer(state: SynthState, action: Action): SynthState {
  switch (action.kind) {
    case 'reset':
      return { ...INITIAL, submitted: action.q, running: true };
    case 'embedding':
      return { ...state, embedding: action.on };
    case 'error':
      return { ...state, error: action.msg, running: false, embedding: false };
    case 'running':
      return { ...state, running: action.on, embedding: action.on ? state.embedding : false };
    case 'sse': {
      const evt = action.evt;
      switch (evt.type) {
        case 'round': {
          const cur = ensureRound(state.rounds, evt.round);
          return {
            ...state,
            rounds: { ...state.rounds, [evt.round]: cur },
            currentRound: Math.max(state.currentRound ?? -1, evt.round),
            writerRound: evt.writer ? evt.round : state.writerRound,
          };
        }
        case 'thinking':
          return {
            ...state,
            thinking: {
              ...state.thinking,
              [evt.round]: (state.thinking[evt.round] ?? '') + (evt.text ?? ''),
            },
          };
        case 'search':
          return {
            ...state,
            searches: [
              ...state.searches,
              {
                round: evt.round,
                keywords: evt.keywords,
                filter: evt.filter ?? {},
                k: evt.k,
              },
            ],
          };
        case 'chunks': {
          const list = evt.chunks ?? [];
          const nextChunks = { ...state.chunks };
          const additions: string[] = [];
          for (const ch of list) {
            if (!nextChunks[ch.ref]) {
              nextChunks[ch.ref] = ch;
              additions.push(ch.ref);
            }
          }
          // attach count to most recent search of this round
          const nextSearches = [...state.searches];
          for (let i = nextSearches.length - 1; i >= 0; i--) {
            if (nextSearches[i].round === evt.round && nextSearches[i].count === undefined) {
              nextSearches[i] = { ...nextSearches[i], count: list.length };
              break;
            }
          }
          return {
            ...state,
            chunks: nextChunks,
            chunkOrder: [...state.chunkOrder, ...additions],
            searches: nextSearches,
          };
        }
        case 'text': {
          const cur = ensureRound(state.rounds, evt.round);
          const idx = cur.blockIndex[evt.block_id];
          let textBlocks = cur.textBlocks;
          let textOrder = cur.textOrder;
          let blockIndex = cur.blockIndex;
          if (idx === undefined) {
            const newIdx = textBlocks.length;
            textBlocks = [...textBlocks, { id: evt.block_id, text: evt.text ?? '' }];
            textOrder = [...textOrder, evt.block_id];
            blockIndex = { ...blockIndex, [evt.block_id]: newIdx };
          } else {
            textBlocks = textBlocks.slice();
            textBlocks[idx] = {
              ...textBlocks[idx],
              text: textBlocks[idx].text + (evt.text ?? ''),
            };
          }
          return {
            ...state,
            currentRound: Math.max(state.currentRound ?? -1, evt.round),
            rounds: {
              ...state.rounds,
              [evt.round]: { ...cur, textBlocks, textOrder, blockIndex },
            },
          };
        }
        case 'citation': {
          const num = action.nextCitationNum();
          return {
            ...state,
            citations: [...state.citations, { ...evt, num }],
          };
        }
        case 'round_end': {
          const cur = ensureRound(state.rounds, evt.round);
          const updated: RoundState = { ...cur, stop_reason: evt.stop_reason };
          if (evt.stop_reason === 'end_turn') {
            return {
              ...state,
              rounds: { ...state.rounds, [evt.round]: updated },
              finalRound: evt.round,
              currentRound: evt.round,
            };
          }
          // tool_use: move text → notes, drop from rounds, clear currentRound
          const interim = cur.textOrder
            .map((id) => cur.textBlocks[cur.blockIndex[id]]?.text ?? '')
            .join('')
            .trim();
          const nextRounds = { ...state.rounds };
          delete nextRounds[evt.round];
          return {
            ...state,
            rounds: nextRounds,
            currentRound: null,
            notes: interim
              ? [...state.notes, { round: evt.round, text: interim }]
              : state.notes,
          };
        }
        case 'tool': {
          // Structured router tool (list_orders / lookup_counsel / list_deadlines).
          // The done frame carries the result count; surface it as a research
          // note. The start frame only advances the active round.
          if (evt.done) {
            return {
              ...state,
              notes: [
                ...state.notes,
                { round: evt.round, text: describeTool(evt.tool, evt.count ?? 0) },
              ],
            };
          }
          return {
            ...state,
            currentRound: Math.max(state.currentRound ?? -1, evt.round),
          };
        }
        case 'tool_error':
          // Non-fatal: the backend continues with whatever else it gathered, so
          // record this as a note rather than a fatal error.
          return {
            ...state,
            notes: [
              ...state.notes,
              { round: evt.round, text: `${evt.tool} lookup error: ${evt.message}` },
            ],
          };
        case 'expand':
          // Neighbor/sibling expansion: aggregate the adjacent-passage count per round.
          // The chunks themselves arrive via separate `chunks` events (flagged neighbor).
          return {
            ...state,
            expansions: {
              ...state.expansions,
              [evt.round]: (state.expansions[evt.round] ?? 0) + (evt.count ?? 0),
            },
          };
        case 'search_error':
          return { ...state, error: `Search error (round ${evt.round}): ${evt.message}` };
        case 'error':
          return { ...state, error: evt.message ?? 'Unknown error' };
        case 'done':
          return { ...state, running: false, embedding: false };
        default:
          // Unknown/future event type: ignore it rather than returning
          // undefined (which would blank the reducer state and crash render).
          return state;
      }
    }
    default:
      return state;
  }
}

// ---- Hook ----------------------------------------------------------------

export function useSynthesisStream(endpoint: string, anonKey: string) {
  const [state, dispatch] = useReducer(reducer, INITIAL);
  const abortRef = useRef<AbortController | null>(null);
  const citationCounter = useRef(0);

  const ask = useCallback(
    async (
      question: string,
      initialFilter: Record<string, unknown>,
      scope?: {
        case_id?: string;
        document_ids?: string[];
        review_set_id?: string;
        matter?: {
          slug?: string;
          name: string;
          short_name: string;
          mdl_number: string;
          court: string;
          judge: string;
        };
      },
    ) => {
      const v = question.trim();
      if (!v) return;
      abortRef.current?.abort();
      citationCounter.current = 0;
      dispatch({ kind: 'reset', q: v });

      const ctrl = new AbortController();
      abortRef.current = ctrl;
      try {
        // Best-effort client embedding: since legal-synthesis v28 the server generates the
        // query embedding itself (voyage-law-2, 1024-dim) and ignores legacy 384-dim vectors,
        // so a Transformers.js model-load failure must never block the request.
        let emb = '';
        try {
          dispatch({ kind: 'embedding', on: !modelReady() });
          emb = await embedQuery(v);
        } catch {
          emb = '';
        } finally {
          dispatch({ kind: 'embedding', on: false });
        }

        const body: Record<string, unknown> = {
          question: v,
          initial_filter: initialFilter,
        };
        if (emb) body.embedding = emb;
        if (scope?.case_id) body.case_id = scope.case_id;
        if (scope?.matter) body.matter = scope.matter;
        if (scope?.document_ids?.length) body.document_ids = scope.document_ids;
        if (scope?.review_set_id) body.review_set_id = scope.review_set_id;

        const res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: anonKey,
            Authorization: `Bearer ${anonKey}`,
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`Synthesis failed (${res.status})`);

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx: number;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dataLine = frame.split('\n').find((l) => l.startsWith('data:'));
            if (!dataLine) continue;
            const payload = dataLine.slice(5).trim();
            if (!payload) continue;
            let evt: SynthEvent;
            try {
              evt = JSON.parse(payload) as SynthEvent;
            } catch {
              continue;
            }
            dispatch({
              kind: 'sse',
              evt,
              nextCitationNum: () => ++citationCounter.current,
            });
          }
        }
      } catch (e: unknown) {
        const err = e as { name?: string; message?: string };
        if (err?.name !== 'AbortError') dispatch({ kind: 'error', msg: err?.message ?? String(e) });
      } finally {
        dispatch({ kind: 'running', on: false });
      }
    },
    [endpoint, anonKey],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  useEffect(() => () => abortRef.current?.abort(), []);

  return { state, ask, stop };
}
