import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import {
  Loader2,
  Plus,
  Copy,
  Check,
  ExternalLink,
  Quote,
  ChevronDown,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import type { AiAssistCitation, AiAssistChunk } from '@/lib/useAiAssist';

export type CiteChip = {
  num: number;
  order_label: string | null;
  page: string | null;
  title?: string;
  cited_text?: string;
  pdf_url: string | null;
};

export type Proposal = {
  id: string;
  prompt: string;
  content: string;
  citations?: AiAssistCitation[];
  chunks?: AiAssistChunk[];
  streaming?: boolean;
  scopeLabel?: string; // e.g. "on selection" / "in ¶2"
};

export function ProposalCard({
  p,
  onApply,
  onInsertCite,
  formatShortCite,
  formatFullCite,
  expandLabel,
  formatPagePin,
}: {
  p: Proposal;
  onApply: (text: string) => void;
  onInsertCite: (c: CiteChip, variant: 'short' | 'full' | 'footnote') => void;
  formatShortCite: (c: CiteChip) => string;
  formatFullCite: (c: CiteChip) => string;
  expandLabel: (l: string) => string;
  formatPagePin: (p: string) => string;
}) {
  const [copied, setCopied] = useState(false);
  const [expanded, setExpanded] = useState(true);
  const cites = dedupe(p.citations, p.chunks);
  const firstLine = p.content.split('\n').find((l) => l.trim()) ?? '';
  const label = firstLine.replace(/^[#>*_\s-]+/, '').slice(0, 90);

  const copy = () => {
    navigator.clipboard?.writeText(p.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div className="proposal-card group">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-start gap-2 px-3 py-2.5 text-left"
      >
        <div className="mt-0.5 shrink-0">
          {p.streaming ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />
          ) : (
            <ClaudeSpark className="h-3.5 w-3.5" />
          )}
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className="text-[10px] uppercase tracking-[0.12em] font-sans text-muted-foreground truncate">
              {p.scopeLabel ?? 'Claude'}
            </span>
            {cites.length > 0 && (
              <span className="text-[10px] tabular-nums text-muted-foreground/70">
                · {cites.length} cite{cites.length === 1 ? '' : 's'}
              </span>
            )}
          </div>
          <div className="text-[13px] font-serif text-foreground/90 leading-snug line-clamp-2 mt-0.5">
            {label || (p.streaming ? 'Thinking…' : 'Response')}
          </div>
        </div>
        <ChevronDown
          className={cn(
            'h-3.5 w-3.5 text-muted-foreground shrink-0 mt-1 transition-transform',
            expanded && 'rotate-180',
          )}
        />
      </button>

      {expanded && (
        <div className="px-3 pb-3 space-y-2.5">
          <div className="answer-prose text-[13.5px] leading-[1.65] font-serif border-t border-border/60 pt-2.5">
            {p.content ? (
              <ReactMarkdown remarkPlugins={[remarkGfm]}>{p.content}</ReactMarkdown>
            ) : p.streaming ? (
              <span className="text-muted-foreground inline-flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Drafting…
              </span>
            ) : null}
            {p.streaming && p.content && <span className="motion-stream-caret" aria-hidden />}
          </div>

          {cites.length > 0 && (
            <div className="pt-2 border-t border-border/60">
              <div className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground font-sans mb-1.5">
                Citations
              </div>
              <div className="flex flex-wrap gap-1.5">
                {cites.map((c, i) => (
                  <CitationChip
                    key={i}
                    c={c}
                    onInsertCite={onInsertCite}
                    formatShortCite={formatShortCite}
                    formatFullCite={formatFullCite}
                    expandLabel={expandLabel}
                    formatPagePin={formatPagePin}
                  />
                ))}
              </div>
            </div>
          )}

          {!p.streaming && p.content && (
            <div className="flex items-center gap-1.5 pt-1">
              <Button
                size="sm"
                variant="default"
                className="h-7 gap-1.5 text-[11.5px]"
                onClick={() => onApply(p.content)}
              >
                <Plus className="h-3 w-3" /> Apply to document
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 gap-1.5 text-[11.5px]"
                onClick={copy}
              >
                {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
                {copied ? 'Copied' : 'Copy'}
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function CitationChip({
  c,
  onInsertCite,
  formatShortCite,
  formatFullCite,
  expandLabel,
  formatPagePin,
}: {
  c: CiteChip;
  onInsertCite: (c: CiteChip, variant: 'short' | 'full' | 'footnote') => void;
  formatShortCite: (c: CiteChip) => string;
  formatFullCite: (c: CiteChip) => string;
  expandLabel: (l: string) => string;
  formatPagePin: (p: string) => string;
}) {
  const label = c.order_label ?? c.title ?? 'Source';
  const copyBluebook = () => {
    const text = formatShortCite(c).trim();
    navigator.clipboard?.writeText(text).then(() => toast.success('Bluebook cite copied'));
  };
  void expandLabel;
  return (
    <span
      className="group/chip inline-flex items-center gap-1 text-[11px] rounded border border-border bg-card hover:border-accent/50 transition overflow-hidden"
      title={c.cited_text ? `"${c.cited_text}"` : undefined}
    >
      {c.pdf_url ? (
        <a
          href={c.pdf_url}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 pl-1.5 pr-1 py-0.5 text-foreground/80 hover:text-foreground"
        >
          <span className="font-sans font-medium tabular-nums text-accent">[{c.num}]</span>
          <span>{label}</span>
          {c.page && (
            <span className="text-muted-foreground tabular-nums">· {formatPagePin(c.page)}</span>
          )}
          <ExternalLink className="h-2.5 w-2.5 opacity-60" />
        </a>
      ) : (
        <span className="inline-flex items-center gap-1 pl-1.5 pr-1 py-0.5 text-foreground/80">
          <span className="font-sans font-medium tabular-nums text-accent">[{c.num}]</span>
          <span>{label}</span>
          {c.page && (
            <span className="text-muted-foreground tabular-nums">· {formatPagePin(c.page)}</span>
          )}
        </span>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            title="Insert this citation"
            className="px-1 py-0.5 border-l border-border text-muted-foreground hover:text-accent hover:bg-accent/5"
          >
            <Plus className="h-2.5 w-2.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-60 text-[12px]">
          <DropdownMenuLabel className="text-[10px] uppercase tracking-[0.12em] text-muted-foreground font-sans">
            Insert at cursor
          </DropdownMenuLabel>
          <DropdownMenuItem
            onClick={() => onInsertCite(c, 'short')}
            className="flex flex-col items-start gap-0.5"
          >
            <span className="font-medium">Short form</span>
            <span className="font-serif italic text-muted-foreground text-[11px]">
              {formatShortCite(c).trim()}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => onInsertCite(c, 'full')}
            className="flex flex-col items-start gap-0.5"
          >
            <span className="font-medium">Full citation</span>
            <span className="font-serif italic text-muted-foreground text-[11px] line-clamp-2">
              {formatFullCite(c).trim()}
            </span>
          </DropdownMenuItem>
          <DropdownMenuItem
            onClick={() => onInsertCite(c, 'footnote')}
            className="flex flex-col items-start gap-0.5"
          >
            <span className="font-medium">Footnote</span>
            <span className="font-serif italic text-muted-foreground text-[11px]">
              Inline [^n] + definition at doc end
            </span>
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={copyBluebook}>
            <Copy className="h-3 w-3 mr-2" /> Copy Bluebook cite
          </DropdownMenuItem>
          {c.cited_text && (
            <>
              <DropdownMenuSeparator />
              <div className="px-2 py-1.5 max-w-[14rem]">
                <div className="text-[9.5px] uppercase tracking-[0.12em] text-muted-foreground font-sans mb-1 inline-flex items-center gap-1">
                  <Quote className="h-2.5 w-2.5" /> Cited text
                </div>
                <p className="font-serif italic text-[11px] leading-snug text-foreground/80 line-clamp-4">
                  "{c.cited_text}"
                </p>
              </div>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  );
}

function dedupe(citations?: AiAssistCitation[], chunks?: AiAssistChunk[]): CiteChip[] {
  if (!citations?.length) return [];
  const byRef = new Map((chunks ?? []).map((c) => [c.ref, c]));
  const seen = new Map<string, CiteChip>();
  for (const c of citations) {
    const key = `${c.order_label ?? c.title ?? ''}|${c.page ?? ''}`;
    if (seen.has(key)) continue;
    const chunk = c.ref ? byRef.get(c.ref) : undefined;
    seen.set(key, {
      num: c.num,
      order_label: c.order_label,
      page: c.page,
      title: c.title,
      cited_text: c.cited_text,
      pdf_url: chunk?.pdf_url ?? null,
    });
  }
  return Array.from(seen.values());
}

function ClaudeSpark({ className }: { className?: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) return <span className={cn('inline-block rounded-full bg-[#C96442]', className)} />;
  return (
    <img
      src="https://cdn.simpleicons.org/claude/C96442"
      alt=""
      className={className}
      onError={() => setBroken(true)}
    />
  );
}
