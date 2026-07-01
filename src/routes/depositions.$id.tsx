import { createFileRoute } from '@tanstack/react-router';
import { AppShell, PageHeader } from '@/components/app-shell';

export const Route = createFileRoute('/depositions/$id')({
  component: DepositionWorkspacePlaceholder,
});

function DepositionWorkspacePlaceholder() {
  const { id } = Route.useParams();
  return (
    <AppShell>
      <PageHeader
        title="Deposition workspace"
        description="Coming soon. The per-deposition analysis view is being built."
      />
      <div className="p-8 font-sans text-sm text-muted-foreground">
        Deposition ID: <span className="font-mono text-foreground">{id}</span>
      </div>
    </AppShell>
  );
}
