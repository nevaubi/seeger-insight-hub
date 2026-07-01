import { createFileRoute } from '@tanstack/react-router';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Loader2, Save } from 'lucide-react';
import { toast } from 'sonner';
import { AppShell, PageHeader } from '@/components/app-shell';
import { Card } from '@/components/ui/card';
import { Textarea } from '@/components/ui/textarea';
import { Button } from '@/components/ui/button';
import { ClaudeBadge } from '@/components/claude-badge';
import { fmtDate } from '@/components/case-ui';
import { supabase, type PracticeProfile } from '@/lib/supabase';
import { useMatter } from '@/lib/matter-context';

export const Route = createFileRoute('/_authenticated/practice-profile')({
  component: PracticeProfilePage,
  errorComponent: ({ error }) => (
    <AppShell>
      <div className="p-8 text-sm text-destructive">Failed to load: {error.message}</div>
    </AppShell>
  ),
  notFoundComponent: () => (
    <AppShell>
      <div className="p-8">Not found.</div>
    </AppShell>
  ),
});

function PracticeProfilePage() {
  const { currentMatter } = useMatter();
  const caseId = currentMatter.master_case_id;
  const qc = useQueryClient();

  const profileQ = useQuery({
    queryKey: ['practice-profile', caseId],
    queryFn: async () => {
      const { data, error } = await supabase
        .from('practice_profiles')
        .select('*')
        .eq('case_id', caseId)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as PracticeProfile | null;
    },
  });

  const placeholder = `# Practice Profile — ${currentMatter.short_name}\n\nStance definitions, issue tags, priorities…`;
  const [draft, setDraft] = useState<string>('');
  const [initialized, setInitialized] = useState(false);

  useEffect(() => {
    if (profileQ.isSuccess && !initialized) {
      setDraft(profileQ.data?.profile_md ?? '');
      setInitialized(true);
    }
  }, [profileQ.isSuccess, profileQ.data, initialized]);

  // Reset when matter changes
  useEffect(() => {
    setInitialized(false);
    setDraft('');
  }, [caseId]);

  const saveM = useMutation({
    mutationFn: async () => {
      const { error } = await supabase
        .from('practice_profiles')
        .upsert(
          {
            case_id: caseId,
            profile_md: draft,
            updated_at: new Date().toISOString(),
          },
          { onConflict: 'case_id' },
        );
      if (error) throw error;
    },
    onSuccess: () => {
      toast.success('Practice profile saved');
      qc.invalidateQueries({ queryKey: ['practice-profile', caseId] });
    },
    onError: (e) => toast.error(e instanceof Error ? e.message : 'Save failed'),
  });

  const updatedAt = profileQ.data?.updated_at;

  return (
    <AppShell>
      <PageHeader
        title="Practice Profile"
        description={`Firm playbook injected into every Claude analysis and question for ${currentMatter.short_name}.`}
      />
      <div className="px-8 py-6 space-y-4 max-w-4xl">
        <Card className="p-5">
          <div className="flex items-center gap-2 mb-3">
            <ClaudeBadge variant="chip" label="Claude Legal — practice profile" />
          </div>
          <p className="text-sm text-muted-foreground leading-relaxed">
            This playbook is injected into every Claude analysis and question for this matter —
            stance definitions, issue-tag vocabulary, review priorities, and house conventions.
            Edits apply to the next analysis run.
          </p>
        </Card>

        <Card className="p-5">
          {profileQ.isLoading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground py-8 justify-center">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading profile…
            </div>
          ) : (
            <>
              <Textarea
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                placeholder={placeholder}
                spellCheck={false}
                className="min-h-[480px] font-mono text-[12.5px] leading-relaxed"
              />
              <div className="mt-3 flex items-center justify-between">
                <div className="text-[11px] text-muted-foreground tabular-nums">
                  {updatedAt ? `Last updated ${fmtDate(updatedAt)}` : 'Not saved yet'}
                </div>
                <Button onClick={() => saveM.mutate()} disabled={saveM.isPending}>
                  {saveM.isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Saving…
                    </>
                  ) : (
                    <>
                      <Save className="mr-2 h-4 w-4" /> Save profile
                    </>
                  )}
                </Button>
              </div>
            </>
          )}
        </Card>
      </div>
    </AppShell>
  );
}
