import { useEffect, useRef, useState } from 'react';
import { BookOpen, Check, Copy, CornerDownLeft, Loader2, MessageSquarePlus, PenLine, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ClaudeMark } from '@/components/claude-mark';
import { useAiAssist, type AiAssistCitation, type AiAssistChunk, type AiAssistMatter } from '@/lib/useAiAssist';
import { dedupeCitations, formatPagePin } from '@/lib/bluebook';
import { cn } from '@/lib/utils';

// The in-canvas Claude affordance: select text in the Word editor and a small Claude
// mark appears beside the selection; open it to ask grounded questions about the
// passage. Answers are record-grounded (hybrid retrieval over the matter's controlling
// orders) with pin-cited chips — source and page aware, never from thin air.

export interface PopoverAnchor {
  x: number; // px within the word-editor container
  y: number;
  selectionText: string;
}

export function ClaudePopover({
  anchor,
  caseId,
  matter,
  onAddComment,
  onSuggestEdits,
  onClose,
}: {
  anchor: PopoverAnchor | null;
  caseId: string;
  matter: AiAssistMatter;
  onAddComment: (text: string) => void;
  onSuggestEdits: (selectionText: string, instruction: string) => void;
  onClose: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [question, setQuestion] = useState('');
  const [answer, setAnswer] = useState('');
  const [citations, setCitations] = useState<AiAssistCitation[]>([]);
  const [chunks, setChunks] = useState<AiAssistChunk[]>([]);
  const [grounded, setGrounded] = useState<boolean | null>(null);
  const [copied, setCopied] = useState(false);
  const { run, running } = useAiAssist();
  const cardRef = useRef<HTMLDivElement | null>(null);

  // reset when the selection anchor changes
  useEffect(() => {
    setExpanded(false);
    setQuestion('');
    setAnswer('');
    setCitations([]);
    setChunks([]);
    setGrounded(null);
  }, [anchor?.selectionText, anchor?.x, anchor?.y]);

  if (!anchor) return null;

  const ask = async (q: string) => {
    const text = q.trim();
    if (!text || running) return;
    setAnswer('');
    setCitations([]);
    setChunks([]);
    const collected: AiAssistCitation[] = [];
    const result = await run({
      mode: 'draft',
      instruction:
        `${text}\n\nThe question concerns this passage selected in the document being drafted ` +
        `(answer the question about it precisely; cite the record where you state record facts; ` +
        `keep it under 180 words):\n"""\n${anchor.selectionText.slice(0, 4000)}\n"""`,
      document: '',
      ground: true,
      caseId,
      matter,
      onMeta: (m) => setGrounded(m.grounded),
      onText: (delta) => setAnswer((prev) => prev + delta),
      onCitation: (c) => {
        collected.push(c);
        setCitations([...collected]);
      },
      onChunks: (ch) => setChunks(ch),
    });
    if (result?.text) setAnswer(result.text);
    if (result?.citations) setCitations(result.citations);
    if (result?.chunks) setChunks(result.chunks);
  };

  const citeChips = dedupeCitations(citations, chunks);
  const copy = () => {
    navigator.clipboard?.writeText(answer).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  // collapsed: just the mark, floating by the selection
  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        className="absolute z-30 flex h-7 w-7 items-center justify-center rounded-full border border-[#C96442]/35 bg-white shadow-[0_2px_10px_-2px_rgba(201,100,66,0.45)] transition hover:scale-110 hover:border-[#C96442]/60 motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-90 motion-safe:duration-150"
        style={{ left: anchor.x, top: anchor.y }}
        title="Ask Claude about this selection — answers grounded in the record"
      >
        <ClaudeMark className="h-4 w-4" />
      </button>
    );
  }

  return (
    <div
      ref={cardRef}
      className="absolute z-30 w-[380px] max-w-[calc(100%-2rem)] rounded-lg border border-border bg-popover shadow-xl motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-150"
      style={{ left: Math.max(8, Math.min(anchor.x - 40, 9999)), top: anchor.y + 8 }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* header */}
      <div className="flex items-center gap-1.5 border-b border-border/70 px-3 py-2">
        <ClaudeMark className="h-3.5 w-3.5" />
        <span className="text-[12px] font-sans font-medium text-foreground/85">Claude</span>
        <span className="inline-flex items-center gap-1 rounded-full border border-border bg-secondary/50 px-1.5 py-px text-[9.5px] font-sans text-muted-foreground">
          <BookOpen className="h-2.5 w-2.5 text-accent" /> record-grounded
        </span>
        <button
          type="button"
          className="ml-auto rounded p-0.5 text-muted-foreground hover:text-foreground"
          onClick={onClose}
          title="Close"
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* selection excerpt */}
      <div className="border-b border-border/60 bg-secondary/30 px-3 py-1.5">
        <p className="line-clamp-2 font-serif text-[11.5px] italic leading-snug text-muted-foreground">
          “{anchor.selectionText.slice(0, 180)}
          {anchor.selectionText.length > 180 ? '…' : ''}”
        </p>
      </div>

      {/* quick actions (before first question) */}
      {!answer && !running && (
        <div className="flex flex-wrap gap-1 px-3 pt-2">
          {[
            'Explain what this requires',
            'Check this against the record',
            'What deadline applies here?',
          ].map((preset) => (
            <button
              key={preset}
              type="button"
              className="rounded-full border border-border bg-card px-2 py-0.5 text-[10.5px] font-sans text-muted-foreground transition hover:border-accent/40 hover:text-accent"
              onClick={() => {
                setQuestion(preset);
                void ask(preset);
              }}
            >
              {preset}
            </button>
          ))}
          <button
            type="button"
            className="rounded-full border border-[#C96442]/30 bg-[#C96442]/5 px-2 py-0.5 text-[10.5px] font-sans text-[#C96442] transition hover:border-[#C96442]/60"
            onClick={() => {
              onSuggestEdits(anchor.selectionText, 'Improve this passage: precision, flow, and litigation register. Smallest sufficient edits.');
              onClose();
            }}
          >
            <PenLine className="mr-1 inline h-2.5 w-2.5" />
            Suggest edits
          </button>
        </div>
      )}

      {/* answer */}
      {(answer || running) && (
        <div className="max-h-64 overflow-y-auto px-3 py-2">
          <div className="answer-prose font-serif text-[13px] leading-[1.6]">
            {answer ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{answer}</ReactMarkdown>
            ) : (
              <span className="inline-flex items-center gap-2 text-muted-foreground text-[12px]">
                <Loader2 className="h-3 w-3 animate-spin" /> Consulting the record…
              </span>
            )}
          </div>
          {citeChips.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1 border-t border-border/60 pt-1.5">
              {citeChips.map((c, i) => {
                const label = `${c.order_label ?? c.title ?? 'Source'}${c.page ? ` · ${formatPagePin(c.page)}` : ''}`;
                return c.pdf_url ? (
                  <a
                    key={i}
                    href={c.pdf_url}
                    target="_blank"
                    rel="noreferrer"
                    title={c.cited_text ? `"${c.cited_text}"` : undefined}
                    className="rounded border border-accent/40 bg-accent/10 px-1.5 py-px text-[10px] font-sans text-accent hover:border-accent"
                  >
                    [{c.num}] {label}
                  </a>
                ) : (
                  <span
                    key={i}
                    title={c.cited_text ? `"${c.cited_text}"` : undefined}
                    className="rounded border border-accent/40 bg-accent/10 px-1.5 py-px text-[10px] font-sans text-accent"
                  >
                    [{c.num}] {label}
                  </span>
                );
              })}
            </div>
          )}
          {grounded === false && answer && (
            <p className="mt-1.5 text-[10px] font-sans text-amber-700">
              Record retrieval was unavailable for this answer — verify before relying on it.
            </p>
          )}
          {answer && !running && (
            <div className="mt-2 flex items-center gap-1">
              <Button
                variant="ghost"
                size="sm"
                className="h-6 gap-1 px-2 text-[10.5px]"
                onClick={() => {
                  onAddComment(answer);
                  onClose();
                }}
              >
                <MessageSquarePlus className="h-3 w-3" /> Add as comment
              </Button>
              <Button variant="ghost" size="sm" className="h-6 gap-1 px-2 text-[10.5px]" onClick={copy}>
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />} {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          )}
        </div>
      )}

      {/* input */}
      <div className="relative border-t border-border/70 p-2">
        <Textarea
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              void ask(question);
            }
            if (e.key === 'Escape') onClose();
          }}
          placeholder="Ask about this selection…"
          className="min-h-[44px] resize-none pr-9 text-[12.5px]"
          autoFocus
          disabled={running}
        />
        <Button
          size="sm"
          className={cn('absolute bottom-3.5 right-3.5 h-6 w-6 p-0 bg-[#C96442] hover:bg-[#b25538]')}
          disabled={!question.trim() || running}
          onClick={() => void ask(question)}
        >
          {running ? <Loader2 className="h-3 w-3 animate-spin" /> : <CornerDownLeft className="h-3 w-3" />}
        </Button>
      </div>
    </div>
  );
}
