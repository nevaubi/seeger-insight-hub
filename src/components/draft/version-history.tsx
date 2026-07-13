import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Camera, GitCompare, History, Loader2, RotateCcw } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { supabase, type DocumentVersion } from '@/lib/supabase';
import { diffStats, diffWords } from '@/lib/diff';

// Version history for a workspace document: snapshots on demand and before markup
// passes, restore with a safety snapshot, and a word-level compare view — the "what
// changed since the version we circulated" answer.

export async function snapshotVersion(opts: {
  documentId: string;
  caseId: string;
  content: string;
  label: string;
}): Promise<void> {
  const words = opts.content.trim() ? opts.content.trim().split(/\s+/).length : 0;
  const { error } = await supabase.from('document_versions').insert({
    document_id: opts.documentId,
    case_id: opts.caseId,
    label: opts.label.slice(0, 120),
    content: opts.content,
    word_count: words,
    author: 'workspace',
  });
  if (error) throw new Error(error.message);
}

export function VersionHistory({
  documentId,
  caseId,
  currentContent,
  onRestore,
}: {
  documentId: string | null;
  caseId: string;
  currentContent: string;
  onRestore: (content: string) => void;
}) {
  const qc = useQueryClient();
  const [compareWith, setCompareWith] = useState<DocumentVersion | null>(null);

  const { data: versions = [], isLoading } = useQuery({
    queryKey: ['document-versions', documentId],
    enabled: !!documentId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from('document_versions')
        .select('*')
        .eq('document_id', documentId!)
        .order('created_at', { ascending: false })
        .limit(30);
      if (error) throw error;
      return (data ?? []) as DocumentVersion[];
    },
  });

  const snapshot = useMutation({
    mutationFn: async (label: string) => {
      if (!documentId) throw new Error('Save the document first');
      await snapshotVersion({ documentId, caseId, content: currentContent, label });
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ['document-versions', documentId] });
      toast.success('Version saved');
    },
    onError: (e: Error) => toast.error(`Could not save version: ${e.message}`),
  });

  const restore = useMutation({
    mutationFn: async (v: DocumentVersion) => {
      if (!documentId) throw new Error('No document');
      // safety snapshot of what's on screen before replacing it
      await snapshotVersion({ documentId, caseId, content: currentContent, label: 'Before restore' });
      return v;
    },
    onSuccess: (v) => {
      onRestore(v.content);
      qc.invalidateQueries({ queryKey: ['document-versions', documentId] });
      toast.success(`Restored “${v.label ?? 'version'}”`);
    },
    onError: (e: Error) => toast.error(`Restore failed: ${e.message}`),
  });

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="sm" className="h-8 gap-1.5 px-2" title="Version history" disabled={!documentId}>
            <History className="h-4 w-4" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-80">
          <DropdownMenuItem
            className="gap-2 cursor-pointer font-medium"
            onClick={() => snapshot.mutate(`Manual snapshot`)}
            disabled={!documentId || snapshot.isPending}
          >
            {snapshot.isPending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Camera className="h-4 w-4" />}
            Save current as version
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuLabel className="text-[10.5px] uppercase tracking-[0.12em] text-muted-foreground font-sans">
            {isLoading ? 'Loading…' : `${versions.length} version${versions.length === 1 ? '' : 's'}`}
          </DropdownMenuLabel>
          <div className="max-h-80 overflow-y-auto">
            {versions.map((v) => (
              <div key={v.id} className="flex items-center gap-1 px-2 py-1.5 hover:bg-secondary/50 rounded-sm">
                <div className="min-w-0 flex-1">
                  <div className="truncate text-[12.5px] font-medium">{v.label || 'Version'}</div>
                  <div className="text-[10.5px] text-muted-foreground tabular-nums font-sans">
                    {new Date(v.created_at).toLocaleString(undefined, {
                      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
                    })}
                    {v.word_count != null && ` · ${v.word_count} words`}
                  </div>
                </div>
                <Button
                  variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground hover:text-accent"
                  title="Compare with current"
                  onClick={() => setCompareWith(v)}
                >
                  <GitCompare className="h-3.5 w-3.5" />
                </Button>
                <Button
                  variant="ghost" size="sm" className="h-6 w-6 p-0 text-muted-foreground hover:text-accent"
                  title="Restore this version"
                  disabled={restore.isPending}
                  onClick={() => restore.mutate(v)}
                >
                  <RotateCcw className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
            {!isLoading && versions.length === 0 && (
              <div className="px-2 py-3 text-xs text-muted-foreground">
                No versions yet — one is captured automatically before each markup pass.
              </div>
            )}
          </div>
        </DropdownMenuContent>
      </DropdownMenu>

      <CompareDialog version={compareWith} current={currentContent} onClose={() => setCompareWith(null)} />
    </>
  );
}

function CompareDialog({
  version,
  current,
  onClose,
}: {
  version: DocumentVersion | null;
  current: string;
  onClose: () => void;
}) {
  const parts = useMemo(
    () => (version ? diffWords(version.content, current) : []),
    [version, current],
  );
  const stats = useMemo(() => diffStats(parts), [parts]);
  return (
    <Dialog open={!!version} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle className="font-serif">
            Compare: “{version?.label ?? 'version'}” → current
          </DialogTitle>
          <DialogDescription className="font-sans text-[12px] tabular-nums">
            {version &&
              new Date(version.created_at).toLocaleString(undefined, {
                month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
              })}
            {' · '}
            <span className="text-accent">+{stats.added} words</span>
            {' · '}
            <span className="text-red-700">−{stats.deleted} words</span>
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-[60vh] overflow-y-auto rounded-md border border-border bg-card px-5 py-4">
          <div className="font-serif text-[13.5px] leading-[1.7] whitespace-pre-wrap break-words">
            {parts.map((p, i) =>
              p.kind === 'same' ? (
                <span key={i}>{p.text}</span>
              ) : p.kind === 'add' ? (
                <span key={i} className="bg-accent/10 text-accent underline decoration-accent/50 underline-offset-2 rounded-[2px]">
                  {p.text}
                </span>
              ) : (
                <span key={i} className="bg-red-50 text-red-900/70 line-through decoration-red-700/40 rounded-[2px]">
                  {p.text}
                </span>
              ),
            )}
            {parts.length === 0 && <span className="text-muted-foreground italic">No differences.</span>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
