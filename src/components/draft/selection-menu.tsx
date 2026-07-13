import { useEffect, useRef, useState } from 'react';
import { CornerDownLeft, Loader2, PenLine, Sparkles, Wand2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Switch } from '@/components/ui/switch';
import { cn } from '@/lib/utils';
import { measureSelection } from '@/lib/caret';

// Floating selection menu over the editor textarea (replaces the persistent transform
// bar — dead chrome most of the time). Appears when a selection stabilizes; carries the
// four canonical transforms, a custom instruction, and "Suggest edits" which routes the
// selection through the verified-redline flow instead of overwriting live.

export const TRANSFORMS: { key: string; label: string; instruction: string }[] = [
  { key: 'improve', label: 'Improve', instruction: 'Improve the clarity, precision, and flow of this passage without changing its meaning.' },
  { key: 'formal', label: 'Formalize', instruction: 'Rewrite this passage in a more formal, polished litigation register.' },
  { key: 'concise', label: 'Shorten', instruction: 'Make this passage more concise while preserving every substantive point.' },
  { key: 'expand', label: 'Expand', instruction: 'Expand this passage with appropriate detail and supporting reasoning, matching the surrounding style.' },
];

export function SelectionMenu({
  textareaRef,
  containerRef,
  selection,
  busy,
  directApply,
  onDirectApplyChange,
  onTransform,
  onSuggestEdits,
}: {
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  containerRef: React.RefObject<HTMLDivElement | null>;
  selection: { start: number; end: number } | null;
  busy: boolean;
  directApply: boolean;
  onDirectApplyChange: (v: boolean) => void;
  onTransform: (instruction: string) => void;
  onSuggestEdits: (instruction: string) => void;
}) {
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [customOpen, setCustomOpen] = useState(false);
  const [markupOpen, setMarkupOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);

  // Position when a selection stabilizes; hide while popovers are closed and nothing selected.
  useEffect(() => {
    if (!selection || busy) {
      if (!customOpen && !markupOpen) setPos(null);
      return;
    }
    const t = setTimeout(() => {
      const ta = textareaRef.current;
      const container = containerRef.current;
      if (!ta || !container) return;
      const rect = measureSelection(ta, selection.start, selection.end);
      if (!rect) return setPos(null);
      // textarea offset within the scrollable container
      const taTop = ta.offsetTop;
      const taLeft = ta.offsetLeft;
      const menuW = menuRef.current?.offsetWidth ?? 380;
      const rawLeft = taLeft + rect.left;
      const maxLeft = container.clientWidth - menuW - 8;
      setPos({
        top: Math.max(4, taTop + rect.top - 42),
        left: Math.min(Math.max(8, rawLeft), Math.max(8, maxLeft)),
      });
    }, 140);
    return () => clearTimeout(t);
  }, [selection, busy, textareaRef, containerRef, customOpen, markupOpen]);

  if (!pos || !selection) return null;

  return (
    <div
      ref={menuRef}
      className="absolute z-20 flex items-center gap-1 rounded-lg border border-border bg-popover px-1.5 py-1 shadow-lg motion-safe:animate-in motion-safe:fade-in motion-safe:duration-150"
      style={{ top: pos.top, left: pos.left }}
      onMouseDown={(e) => e.preventDefault()} // keep textarea selection
    >
      <Wand2 className="h-3 w-3 text-accent shrink-0 ml-1" />
      {TRANSFORMS.map((t) => (
        <Button
          key={t.key}
          variant="ghost"
          size="sm"
          className="h-6 px-1.5 text-[11px]"
          disabled={busy}
          onClick={() => onTransform(t.instruction)}
        >
          {t.label}
        </Button>
      ))}

      {/* custom transform */}
      <DropdownMenu open={customOpen} onOpenChange={setCustomOpen}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-6 px-1.5 text-[11px] gap-1" disabled={busy}>
            <Sparkles className="h-3 w-3" /> Custom
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72 p-2">
          <InstructionBox
            placeholder="e.g. Recast in the third person and tighten"
            cta="Apply"
            onRun={(instr) => {
              onTransform(instr);
              setCustomOpen(false);
            }}
          />
          <label className="mt-2 flex items-center justify-between gap-2 px-1 text-[10.5px] text-muted-foreground font-sans cursor-pointer">
            Apply directly (skip suggestion review)
            <Switch checked={directApply} onCheckedChange={onDirectApplyChange} />
          </label>
        </DropdownMenuContent>
      </DropdownMenu>

      <span className="mx-0.5 h-4 w-px bg-border" />

      {/* markup the selection via verified redline */}
      <DropdownMenu open={markupOpen} onOpenChange={setMarkupOpen}>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="sm"
            className={cn('h-6 px-1.5 text-[11px] gap-1 text-accent hover:text-accent')}
            disabled={busy}
          >
            {busy ? <Loader2 className="h-3 w-3 animate-spin" /> : <PenLine className="h-3 w-3" />}
            Suggest edits
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="w-72 p-2">
          <div className="text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground font-sans mb-1.5 px-1">
            Mark up this selection
          </div>
          <InstructionBox
            placeholder="e.g. Tighten and conform to the operative order's defined terms"
            cta="Mark up"
            onRun={(instr) => {
              onSuggestEdits(instr);
              setMarkupOpen(false);
            }}
          />
          <p className="mt-1.5 px-1 text-[10px] leading-snug text-muted-foreground/80">
            Edits arrive as tracked changes — each anchored to text verified to exist in the
            document — for accept/reject review.
          </p>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}

function InstructionBox({
  placeholder,
  cta,
  onRun,
}: {
  placeholder: string;
  cta: string;
  onRun: (instruction: string) => void;
}) {
  const [text, setText] = useState('');
  return (
    <div>
      <Textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={placeholder}
        className="text-[13px] min-h-[64px] resize-none"
        autoFocus
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && text.trim()) {
            e.preventDefault();
            onRun(text.trim());
            setText('');
          }
        }}
      />
      <div className="flex justify-end mt-1.5">
        <Button
          size="sm"
          className="h-6.5 gap-1.5 text-[11px]"
          disabled={!text.trim()}
          onClick={() => {
            onRun(text.trim());
            setText('');
          }}
        >
          {cta} <CornerDownLeft className="h-3 w-3" />
        </Button>
      </div>
    </div>
  );
}
