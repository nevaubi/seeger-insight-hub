import { useCallback, useRef, useState } from 'react';
import { AI_ASSIST_ENDPOINT, SUPABASE_ANON_KEY, supabase } from '@/lib/supabase';
import {
  applySuggestion,
  type FailedSuggestion,
  type Suggestion,
  type SuggestionCite,
} from '@/lib/redline';
import type { AiAssistMatter } from '@/lib/useAiAssist';

// Client for ai-assist v12 `redline` mode (SSE) + suggestion lifecycle state.
// Every suggestion arriving through `edit` events was verbatim-verified server-side;
// `edit_failed` events are surfaced in the rail as the trust story, never applied.
//
// State is mirrored in a ref so resolution logic (accept/reject/accept-all) computes
// against the latest snapshot outside React updater functions — updaters must stay
// side-effect-free (StrictMode double-invokes them).

export interface RedlineMeta {
  grounded: boolean;
  passages: number;
  profile: { name: string | null; updated_at: string | null } | null;
}

export interface RedlineRunStats {
  editCount: number;
  failedCount: number;
  protocolErrors: number;
  capped: boolean;
}

export interface RedlineRunOptions {
  instruction: string;
  document: string;
  selection?: { start: number; end: number } | null;
  ground: boolean;
  caseId: string;
  matter: AiAssistMatter;
  documentId?: string | null; // for document_suggestions persistence
}

function parseCite(raw: unknown): SuggestionCite | null {
  if (!raw || typeof raw !== 'object') return null;
  const c = raw as Record<string, unknown>;
  const label = typeof c.label === 'string' ? c.label : '';
  if (!label) return null;
  return {
    label,
    page: typeof c.page === 'string' ? c.page : null,
    tier: c.tier === 'record' ? 'record' : c.tier === 'connector' ? 'connector' : 'model',
    pdf_url: typeof c.pdf_url === 'string' ? c.pdf_url : null,
  };
}

export function useRedline() {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestionsState] = useState<Suggestion[]>([]);
  const [failed, setFailed] = useState<FailedSuggestion[]>([]);
  const [summary, setSummary] = useState('');
  const [meta, setMeta] = useState<RedlineMeta | null>(null);
  const [stats, setStats] = useState<RedlineRunStats | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const suggestionsRef = useRef<Suggestion[]>([]);
  const runContext = useRef<{ runId: string; documentId: string | null; caseId: string } | null>(null);

  const setSuggestions = useCallback((next: Suggestion[]) => {
    suggestionsRef.current = next;
    setSuggestionsState(next);
  }, []);

  const clear = useCallback(() => {
    setSuggestions([]);
    setFailed([]);
    setSummary('');
    setStats(null);
    setError(null);
  }, [setSuggestions]);

  const run = useCallback(
    async (opts: RedlineRunOptions): Promise<boolean> => {
      if (!opts.instruction.trim() || !opts.document.trim()) return false;
      abortRef.current?.abort();
      const ctrl = new AbortController();
      abortRef.current = ctrl;
      const runId = crypto.randomUUID();
      runContext.current = { runId, documentId: opts.documentId ?? null, caseId: opts.caseId };
      setRunning(true);
      setError(null);
      setSuggestions([]);
      setFailed([]);
      setSummary('');
      setStats(null);

      const collected: Suggestion[] = [];
      const collectedFailed: FailedSuggestion[] = [];

      try {
        const body: Record<string, unknown> = {
          mode: 'redline',
          instruction: opts.instruction.trim(),
          document: opts.document,
          ground: opts.ground,
          case_id: opts.caseId,
          matter: opts.matter,
          run_id: runId,
        };
        if (opts.selection && opts.selection.end > opts.selection.start) {
          body.selection_start = opts.selection.start;
          body.selection_end = opts.selection.end;
        }

        const res = await fetch(AI_ASSIST_ENDPOINT, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
        if (!res.ok || !res.body) throw new Error(`Markup request failed (${res.status})`);

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
            let evt: any;
            try {
              evt = JSON.parse(dataLine.slice(5).trim());
            } catch {
              continue;
            }
            switch (evt.type) {
              case 'meta':
                setMeta({
                  grounded: !!evt.grounded,
                  passages: evt.passages ?? 0,
                  profile: evt.profile ?? null,
                });
                break;
              case 'edit': {
                const s: Suggestion = {
                  id: String(evt.id ?? `e${collected.length + 1}`),
                  dbId: crypto.randomUUID(),
                  op: evt.op,
                  anchor: String(evt.anchor ?? ''),
                  occurrence: evt.occurrence ?? null,
                  start: Number(evt.start ?? -1),
                  end: Number(evt.end ?? -1),
                  text: String(evt.text ?? ''),
                  rationale: String(evt.rationale ?? ''),
                  cite: parseCite(evt.cite),
                  confidence: evt.confidence === 'needs_review' ? 'needs_review' : 'high',
                  match_mode: evt.match_mode === 'normalized' ? 'normalized' : 'exact',
                  status: 'pending',
                  source: 'redline',
                };
                collected.push(s);
                setSuggestions([...suggestionsRef.current, s]);
                break;
              }
              case 'edit_failed': {
                const f: FailedSuggestion = {
                  id: String(evt.id ?? `f${collectedFailed.length + 1}`),
                  op: evt.op,
                  anchor: String(evt.anchor ?? ''),
                  reason: String(evt.reason ?? 'unknown'),
                  count: evt.count ?? null,
                  rationale: String(evt.rationale ?? ''),
                  cite: parseCite(evt.cite),
                };
                collectedFailed.push(f);
                setFailed((prev) => [...prev, f]);
                break;
              }
              case 'text':
                setSummary((prev) => (prev ? prev + ' ' : '') + String(evt.text ?? ''));
                break;
              case 'error':
                if (evt.partial) setError(String(evt.message ?? 'Markup interrupted'));
                else throw new Error(evt.message ?? 'Markup failed');
                break;
              case 'done':
                setStats({
                  editCount: evt.edit_count ?? collected.length,
                  failedCount: evt.failed_count ?? collectedFailed.length,
                  protocolErrors: evt.protocol_errors ?? 0,
                  capped: !!evt.capped,
                });
                break;
            }
          }
        }

        // audit trail (fire-and-forget; demo posture)
        persistRun(runContext.current, collected, collectedFailed);
        return collected.length > 0 || collectedFailed.length > 0;
      } catch (e: unknown) {
        const err = e as { name?: string; message?: string };
        if (err?.name !== 'AbortError') setError(err?.message ?? String(e));
        return collected.length > 0;
      } finally {
        setRunning(false);
      }
    },
    [setSuggestions],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  /** Add a client-made suggestion (selection transform routed through the redline flow). */
  const addLocal = useCallback(
    (s: Suggestion) => {
      setSuggestions([...suggestionsRef.current, s]);
      const ctx = runContext.current;
      persistRun(
        ctx && ctx.documentId ? ctx : null,
        [s],
        [],
      );
    },
    [setSuggestions],
  );

  /** Accept or reject one pending suggestion. Returns the updated document text for
   *  accepts (null if the anchor can no longer be located), or `doc` unchanged for rejects. */
  const resolve = useCallback(
    (id: string, status: 'accepted' | 'rejected', doc: string): string | null => {
      const current = suggestionsRef.current;
      const target = current.find((s) => s.id === id && s.status === 'pending');
      if (!target) return doc;
      let nextDoc = doc;
      if (status === 'accepted') {
        const applied = applySuggestion(doc, target);
        if (!applied) return null; // leave pending; caller surfaces the failure
        nextDoc = applied.next;
      }
      persistResolution(target.dbId, status);
      setSuggestions(current.map((s) => (s.id === id ? { ...s, status } : s)));
      return nextDoc;
    },
    [setSuggestions],
  );

  /** Accept every pending suggestion in document order, re-locating each against the
   *  evolving text. Returns the final document and counts. */
  const acceptAll = useCallback(
    (doc: string): { next: string; applied: number; skipped: number } => {
      const current = suggestionsRef.current;
      const pending = current.filter((s) => s.status === 'pending');
      const ordered = [...pending].sort((a, b) => a.start - b.start);
      let text = doc;
      let applied = 0;
      let skipped = 0;
      const resolved = new Set<string>();
      for (const s of ordered) {
        const result = applySuggestion(text, s);
        if (result) {
          text = result.next;
          applied++;
          resolved.add(s.id);
          persistResolution(s.dbId, 'accepted');
        } else {
          skipped++;
        }
      }
      setSuggestions(current.map((s) => (resolved.has(s.id) ? { ...s, status: 'accepted' as const } : s)));
      return { next: text, applied, skipped };
    },
    [setSuggestions],
  );

  const rejectAll = useCallback(() => {
    const current = suggestionsRef.current;
    for (const s of current) {
      if (s.status === 'pending') persistResolution(s.dbId, 'rejected');
    }
    setSuggestions(current.map((s) => (s.status === 'pending' ? { ...s, status: 'rejected' as const } : s)));
  }, [setSuggestions]);

  return {
    running,
    error,
    suggestions,
    failed,
    summary,
    meta,
    stats,
    run,
    stop,
    clear,
    addLocal,
    resolve,
    acceptAll,
    rejectAll,
  };
}

// ---------- fire-and-forget persistence (document_suggestions audit trail) ----------

function persistRun(
  ctx: { runId: string; documentId: string | null; caseId: string } | null,
  suggestions: Suggestion[],
  failed: FailedSuggestion[],
) {
  if (!ctx?.documentId || (suggestions.length === 0 && failed.length === 0)) return;
  const rows = [
    ...suggestions.map((s) => ({
      id: s.dbId,
      document_id: ctx.documentId,
      case_id: ctx.caseId,
      run_id: ctx.runId,
      op: s.op,
      anchor: s.anchor.slice(0, 400),
      occurrence: s.occurrence,
      start_pos: s.start,
      end_pos: s.end,
      new_text: s.text.slice(0, 4000),
      rationale: s.rationale.slice(0, 400),
      cite: s.cite,
      tier: s.cite?.tier ?? null,
      confidence: s.confidence,
      status: 'pending',
    })),
    ...failed.map((f) => ({
      id: crypto.randomUUID(),
      document_id: ctx.documentId,
      case_id: ctx.caseId,
      run_id: ctx.runId,
      op: f.op,
      anchor: f.anchor.slice(0, 400),
      occurrence: null,
      start_pos: null,
      end_pos: null,
      new_text: null,
      rationale: f.rationale.slice(0, 400),
      cite: f.cite,
      tier: f.cite?.tier ?? null,
      confidence: null,
      status: 'failed',
      fail_reason: f.reason,
    })),
  ];
  void supabase
    .from('document_suggestions')
    .insert(rows)
    .then(({ error }: { error: { message: string } | null }) => {
      if (error) console.warn('suggestion audit insert failed:', error.message);
    });
}

function persistResolution(dbId: string, status: 'accepted' | 'rejected') {
  void supabase
    .from('document_suggestions')
    .update({ status, resolved_at: new Date().toISOString() })
    .eq('id', dbId)
    .then(({ error }: { error: { message: string } | null }) => {
      if (error) console.warn('suggestion audit update failed:', error.message);
    });
}
