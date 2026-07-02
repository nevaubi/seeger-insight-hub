import { useCallback, useRef, useState } from 'react';
import { AI_ASSIST_ENDPOINT, SUPABASE_ANON_KEY } from '@/lib/supabase';

// Client for the ai-assist edge function (single-turn transform / draft, SSE).

export type AiAssistCitation = {
  num: number;
  block_id: number;
  ref: string | null;
  order_label: string | null;
  page: string | null;
  cited_text?: string;
  source?: string;
  title?: string;
};

export type AiAssistChunk = {
  ref: string;
  order_label: string | null;
  order_type: string | null;
  order_number: string | null;
  order_date: string | null;
  page_start: number | null;
  page_end: number | null;
  pdf_url: string | null;
};

export type AiAssistMatter = {
  name: string;
  short_name: string;
  mdl_number: string;
  court: string;
  judge: string;
};

export type AiAssistRequest = {
  mode: 'transform' | 'draft' | 'insight';
  instruction: string;
  selection?: string;
  document?: string;
  messages?: { role: 'user' | 'assistant'; content: string }[];
  ground?: boolean;
  caseId: string;
  matter: AiAssistMatter;
  onText?: (delta: string) => void;
  onCitation?: (c: AiAssistCitation) => void;
  onChunks?: (chunks: AiAssistChunk[]) => void;
  onMeta?: (m: { grounded: boolean; passages: number }) => void;
};

export type AiAssistResult = {
  text: string;
  citations: AiAssistCitation[];
  chunks: AiAssistChunk[];
};

export function useAiAssist() {
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async (req: AiAssistRequest): Promise<AiAssistResult | null> => {
    const instruction = req.instruction.trim();
    // insight mode may run with an empty instruction (defaults to "explain this passage")
    // as long as it has a selection; every other mode requires an instruction.
    if (!instruction && req.mode !== 'insight') return null;
    if (req.mode === 'insight' && !req.selection?.trim()) return null;
    abortRef.current?.abort();
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    setError(null);
    setRunning(true);

    const citations: AiAssistCitation[] = [];
    const chunks: AiAssistChunk[] = [];
    let text = '';

    try {
      // Embed the query only when grounding a draft.
      let embedding = '';
      if (req.mode === 'draft' && req.ground) {
        try {
          embedding = await embedQuery(
            instruction + (req.document ? '\n' + req.document.slice(0, 800) : ''),
          );
        } catch {
          /* grounding is best-effort; fall through ungrounded */
        }
      }

      const body: Record<string, unknown> = {
        mode: req.mode,
        instruction,
        selection: req.selection ?? '',
        document: req.document ?? '',
        case_id: req.caseId,
        matter: req.matter,
      };
      if (req.messages?.length) body.messages = req.messages;
      if (req.mode === 'draft' && req.ground && embedding) {
        body.ground = true;
        body.embedding = embedding;
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
      if (!res.ok || !res.body) throw new Error(`AI assist failed (${res.status})`);

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
          let evt: any;
          try { evt = JSON.parse(payload); } catch { continue; }
          switch (evt.type) {
            case 'meta':
              req.onMeta?.({ grounded: !!evt.grounded, passages: evt.passages ?? 0 });
              break;
            case 'chunks':
              if (Array.isArray(evt.chunks)) {
                chunks.push(...evt.chunks);
                req.onChunks?.(evt.chunks);
              }
              break;
            case 'text':
              text += evt.text ?? '';
              req.onText?.(evt.text ?? '');
              break;
            case 'citation': {
              const c: AiAssistCitation = {
                num: evt.num,
                block_id: evt.block_id,
                ref: evt.ref ?? null,
                order_label: evt.order_label ?? null,
                page: evt.page ?? null,
                cited_text: evt.cited_text,
                source: evt.source,
                title: evt.title,
              };
              citations.push(c);
              req.onCitation?.(c);
              break;
            }
            case 'error':
              throw new Error(evt.message ?? 'Unknown error');
            case 'done':
              break;
          }
        }
      }
      return { text, citations, chunks };
    } catch (e: unknown) {
      const err = e as { name?: string; message?: string };
      if (err?.name !== 'AbortError') {
        setError(err?.message ?? String(e));
      }
      return null;
    } finally {
      setRunning(false);
    }
  }, []);

  const stop = useCallback(() => abortRef.current?.abort(), []);

  return { running, error, run, stop };
}
