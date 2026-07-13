import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { BookOpen, Check, Copy, CornerDownLeft, Loader2, MessageSquarePlus, PenLine, X } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { ClaudeMark } from '@/components/claude-mark';
import { useAiAssist, type AiAssistCitation, type AiAssistChunk, type AiAssistMatter } from '@/lib/useAiAssist';
import { dedupeCitations, formatPagePin } from '@/lib/bluebook';
import { cn } from '@/lib/utils';

// The in-canvas Claude affordance: select text in the Word editor and a Claude
// pill appears just above the selection. Both the pill and the expanded card
// are portalled to <body> in viewport coordinates so SuperDoc's overflow-hidden
// canvas can't clip them.

export interface PopoverAnchor {
  /** viewport-space (clientX/Y) of the selection's top-right corner */
  x: number;
  y: number;
  selectionText: string;
  /** if true, open the card directly instead of showing the pill first (⌘K / right-click) */
  forceOpen?: boolean;
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

  // reset when the selection anchor changes; auto-expand when the caller forces it
  useEffect(() => {
    setExpanded(Boolean(anchor?.forceOpen));
    setQuestion('');
    setAnswer('');
    setCitations([]);
    setChunks([]);
    setGrounded(null);
  }, [anchor?.selectionText, anchor?.x, anchor?.y, anchor?.forceOpen]);

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

  // clamp to viewport
  const vw = typeof window === 'undefined' ? 1400 : window.innerWidth;
  const vh = typeof window === 'undefined' ? 900 : window.innerHeight;

  // collapsed: readable pill above the selection
  if (!expanded) {
    const pillW = 128;
    const pillH = 28;
    const left = Math.max(8, Math.min(anchor.x - pillW / 2, vw - pillW - 8));
    // above the selection when there's room, otherwise below
    const above = anchor.y - pillH - 10;
    const top = above > 12 ? above : anchor.y + 22;
    return createPortal(
      <button
        type="button"
        data-claude-ui="true"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setExpanded(true)}
        className="fixed z-[100] flex items-center gap-1.5 rounded-full border border-[#C96442]/40 bg-white pl-2 pr-2.5 py-1 shadow-[0_6px_20px_-6px_rgba(201,100,66,0.55)] transition hover:border-[#C96442] hover:shadow-[0_8px_22px_-6px_rgba(201,100,66,0.7)] motion-safe:animate-in motion-safe:fade-in motion-safe:zoom-in-95 motion-safe:duration-150"
        style={{ left, top, height: pillH }}
        title="Ask Claude about this selection (⌘K)"
      >
        <ClaudeMark className="h-3.5 w-3.5" />
        <span className="text-[11.5px] font-sans font-medium text-foreground/85">Ask Claude</span>
        <kbd className="ml-0.5 rounded border border-border/70 bg-secondary/60 px-1 py-px text-[9px] font-sans text-muted-foreground">⌘K</kbd>
      </button>,
      document.body,
    );
  }

  // expanded card
  const cardW = 380;
  const cardH = 340;
  const left = Math.max(8, Math.min(anchor.x - cardW / 2, vw - cardW - 8));
  const below = anchor.y + 12;
  const top = below + cardH < vh - 8 ? below : Math.max(8, anchor.y - cardH - 12);

  return createPortal(
    <div
      ref={cardRef}
      data-claude-ui="true"
      className="fixed z-[100] w-[380px] max-w-[calc(100vw-1rem)] rounded-lg border border-border bg-popover shadow-2xl motion-safe:animate-in motion-safe:fade-in motion-safe:slide-in-from-top-1 motion-safe:duration-150"
      style={{ left, top }}
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
          title="Close (Esc)"
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
    </div>,
    document.body,
  );
}
