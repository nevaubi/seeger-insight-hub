import { ExternalLink, ShieldAlert, ShieldCheck } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { SuggestionCite } from '@/lib/redline';

// The citation trust-tier visual system (used identically in the Changes rail, chat, and
// checks so the language is learned once):
//   record    — verified against the matter's record (solid treatment, click-through)
//   connector — verified through a research connector (outlined)
//   model     — model knowledge only (amber [verify] treatment)

export function TierBadge({ cite, className }: { cite: SuggestionCite; className?: string }) {
  const label = `${cite.label}${cite.page ? `, at ${cite.page}` : ''}`;
  if (cite.tier === 'model') {
    return (
      <span
        className={cn(
          'inline-flex items-center gap-1 rounded border border-amber-500/50 bg-amber-50 px-1.5 py-0.5 text-[10.5px] font-sans text-amber-800',
          className,
        )}
        title="Cited from model knowledge — verify against the record before relying on it"
      >
        <ShieldAlert className="h-2.5 w-2.5" />
        {label}
        <span className="font-semibold tracking-wide">[verify]</span>
      </span>
    );
  }
  const inner = (
    <>
      <ShieldCheck className="h-2.5 w-2.5" />
      {label}
      {cite.pdf_url && <ExternalLink className="h-2.5 w-2.5 opacity-60" />}
    </>
  );
  const cls = cn(
    'inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10.5px] font-sans',
    cite.tier === 'record'
      ? 'border-accent/40 bg-accent/10 text-accent'
      : 'border-border bg-card text-foreground/75',
    className,
  );
  const title =
    cite.tier === 'record'
      ? 'Verified against the matter record'
      : 'Verified through a research connector';
  return cite.pdf_url ? (
    <a href={cite.pdf_url} target="_blank" rel="noreferrer" className={cn(cls, 'hover:border-accent')} title={title}>
      {inner}
    </a>
  ) : (
    <span className={cls} title={title}>
      {inner}
    </span>
  );
}
