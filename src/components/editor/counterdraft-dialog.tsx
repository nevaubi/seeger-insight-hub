import { useCallback, useRef, useState } from 'react';
import { FileUp, Loader2, Sparkles, X } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { importDocx } from '@/lib/docx-import';
import { sectionize, type CounterdraftState } from '@/lib/counterdraft';

type Tab = 'upload' | 'paste';

export type CounterdraftDraft = {
  title: string;
  markdown: string;
  state: CounterdraftState;
};

export function CounterdraftDialog({
  open,
  onOpenChange,
  onCreate,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  onCreate: (draft: CounterdraftDraft) => Promise<void> | void;
}) {
  const [tab, setTab] = useState<Tab>('upload');
  const [file, setFile] = useState<File | null>(null);
  const [pasted, setPasted] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement | null>(null);

  const reset = useCallback(() => {
    setFile(null);
    setPasted('');
    setTitle('');
    setTab('upload');
  }, []);

  const close = () => {
    if (busy) return;
    reset();
    onOpenChange(false);
  };

  const submit = async () => {
    setBusy(true);
    try {
      let markdown = '';
      let source: 'docx' | 'text' = 'text';
      let derivedTitle: string | null = null;

      if (tab === 'upload') {
        if (!file) {
          toast.error('Pick a .docx file first');
          return;
        }
        source = 'docx';
        const res = await importDocx(file, file.name);
        markdown = res.markdown;
        derivedTitle = res.title;
        if (res.warnings.length) {
          toast.message('Import notes', { description: res.warnings.join(' ') });
        }
      } else {
        source = 'text';
        markdown = pasted.trim();
        if (!markdown) {
          toast.error('Paste the opposing draft first');
          return;
        }
      }

      const sections = sectionize(markdown);
      if (!sections.length) {
        toast.error('Could not detect any sections');
        return;
      }
      const finalTitle =
        (title.trim() || derivedTitle || file?.name?.replace(/\.docx$/i, '') || 'Opposing draft').slice(0, 120);

      const state: CounterdraftState = {
        version: 1,
        source,
        originalTitle: derivedTitle,
        originalMarkdown: markdown,
        sections,
        createdAt: Date.now(),
      };
      await onCreate({ title: `Counter to: ${finalTitle}`, markdown, state });
      reset();
      onOpenChange(false);
    } catch (e: any) {
      toast.error(`Import failed: ${e?.message ?? String(e)}`);
    } finally {
      setBusy(false);
    }
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 backdrop-blur-sm"
      onClick={close}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[min(640px,calc(100vw-32px))] rounded-lg border border-border bg-card shadow-xl"
      >
        <div className="flex items-center gap-2 px-5 py-3 border-b border-border">
          <Sparkles className="h-4 w-4 text-accent" />
          <div className="font-serif text-[15px] font-semibold">Counter opposing draft</div>
          <button
            type="button"
            onClick={close}
            className="ml-auto inline-flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground hover:text-foreground hover:bg-secondary"
            aria-label="Close"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="px-5 pt-3 flex items-center gap-1">
          <TabBtn active={tab === 'upload'} onClick={() => setTab('upload')}>
            Upload .docx
          </TabBtn>
          <TabBtn active={tab === 'paste'} onClick={() => setTab('paste')}>
            Paste text
          </TabBtn>
        </div>

        <div className="p-5 space-y-3">
          {tab === 'upload' ? (
            <>
              <input
                ref={inputRef}
                type="file"
                accept=".docx,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setFile(f);
                  if (f && !title) setTitle(f.name.replace(/\.docx$/i, ''));
                }}
              />
              <button
                type="button"
                onClick={() => inputRef.current?.click()}
                className="w-full rounded-md border border-dashed border-border bg-background/40 hover:bg-secondary/50 transition p-6 flex flex-col items-center justify-center gap-2 text-center"
              >
                <FileUp className="h-6 w-6 text-muted-foreground" />
                <div className="text-[13px] font-medium">
                  {file ? file.name : 'Drop or choose a .docx'}
                </div>
                <div className="text-[11.5px] text-muted-foreground">
                  Headings, lists, and tables are preserved. Images and comments are dropped.
                </div>
              </button>
            </>
          ) : (
            <Textarea
              value={pasted}
              onChange={(e) => setPasted(e.target.value)}
              placeholder="Paste the opposing draft here…"
              className="min-h-[220px] font-mono text-[12.5px]"
            />
          )}

          <div>
            <label className="text-[10.5px] uppercase tracking-[0.14em] text-muted-foreground font-sans">
              Original title
            </label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="e.g. Defendants' Motion to Dismiss"
              className="mt-1 h-9"
            />
            <div className="mt-1 text-[11px] text-muted-foreground">
              Your working document will be titled{' '}
              <span className="font-serif italic">
                Counter to: {(title || 'Opposing draft').slice(0, 80)}
              </span>
              .
            </div>
          </div>
        </div>

        <div className="px-5 py-3 border-t border-border flex items-center justify-end gap-2">
          <Button variant="ghost" size="sm" onClick={close} disabled={busy}>
            Cancel
          </Button>
          <Button size="sm" onClick={submit} disabled={busy}>
            {busy ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> Importing…
              </>
            ) : (
              'Create counter-draft'
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        'h-8 px-3 text-[12px] font-sans rounded-t-md border-b-2 -mb-px transition ' +
        (active
          ? 'border-accent text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground')
      }
    >
      {children}
    </button>
  );
}
